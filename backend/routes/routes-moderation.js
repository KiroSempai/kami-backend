// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️ KAMI — routes-moderation.js
// Moderación de contenido: reportes, acciones sobre usuarios y posts.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const getRole = require('../getRole');
const { verifyToken } = require('../config');

const MOD_ROLES = ['admin', 'moderator', 'company'];
const ADMIN_ROLES = ['admin'];

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = await verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

async function requireMod(req, res, next) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  const role = getRole(r.rows[0]);
  if (!MOD_ROLES.includes(role)) return res.status(403).json({ error: 'No tienes permisos de moderación' });
  req.moderator = r.rows[0];
  req.moderatorRole = role;
  next();
}

async function requireAdmin(req, res, next) {
  await requireMod(req, res, () => {
    if (!ADMIN_ROLES.includes(req.moderatorRole)) return res.status(403).json({ error: 'Solo administradores' });
    next();
  });
}

// ── Obtener datos de moderación de un usuario ──
router.get('/user/:userId', auth, requireMod, async (req, res) => {
  try {
    const target = await pool.query(
      `SELECT id, username, is_banned, strikes, muted_until, company_verified, is_admin FROM users WHERE id = $1`,
      [req.params.userId]
    );
    if (target.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = target.rows[0];
    if (user.is_admin && req.moderatorRole !== 'admin') return res.status(403).json({ error: 'No puedes moderar a un administrador' });

    const logs = await pool.query(
      `SELECT ml.*, mu.username AS moderator_name
       FROM moderation_logs ml
       LEFT JOIN users mu ON mu.id = ml.moderator_user_id
       WHERE ml.target_user_id = $1
       ORDER BY ml.created_at DESC LIMIT 50`,
      [req.params.userId]
    );

    res.json({
      user: { id: user.id, username: user.username, isBanned: user.is_banned, strikes: user.strikes, mutedUntil: user.muted_until },
      history: logs.rows.map(r => ({
        id: r.id, actionType: r.action_type, reason: r.reason,
        durationSeconds: r.duration_seconds, moderatorName: r.moderator_name,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('Error en mod/user:', err);
    res.status(500).json({ error: 'Error al obtener datos' });
  }
});

// ── Banear / desbanear ──
router.post('/ban', auth, requireMod, async (req, res) => {
  try {
    const { targetUserId, reason, durationSeconds } = req.body;
    if (!targetUserId || !reason) return res.status(400).json({ error: 'Usuario y motivo requeridos' });

    const target = await pool.query('SELECT id, is_admin FROM users WHERE id = $1', [targetUserId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.rows[0].is_admin && req.moderatorRole !== 'admin') return res.status(403).json({ error: 'No puedes banear a un admin' });

    const isPerma = !durationSeconds || durationSeconds <= 0;
    await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [targetUserId]);

    // Record IP if available
    const ip = await pool.query('SELECT last_ip FROM users WHERE id = $1', [targetUserId]);
    if (ip.rows[0]?.last_ip) {
      await pool.query(
        `INSERT INTO banned_ips (ip_address, user_id, reason) VALUES ($1, $2, $3) ON CONFLICT (ip_address) DO NOTHING`,
        [ip.rows[0].last_ip, targetUserId, reason]
      );
    }

    await pool.query(
      `INSERT INTO moderation_logs (target_user_id, moderator_user_id, action_type, reason, duration_seconds)
       VALUES ($1, $2, $3, $4, $5)`,
      [targetUserId, req.user.userId, isPerma ? 'ban_permanent' : 'ban_temporary', reason, durationSeconds || null]
    );

    await createNotification(targetUserId, 'ban', 'Has sido baneado', `Razón: ${reason}${isPerma ? '' : ` · Duración: ${formatDuration(durationSeconds)}`}`);
    await createAppealThread(targetUserId, `Apelación de ${isPerma ? 'baneo permanente' : 'baneo temporal'}`, reason);

    res.json({ success: true, message: isPerma ? 'Baneo permanente aplicado' : `Baneo temporal aplicado (${formatDuration(durationSeconds)})` });
  } catch (err) {
    console.error('Error en mod/ban:', err);
    res.status(500).json({ error: 'Error al banear' });
  }
});

// ── Desbanear ──
router.post('/unban', auth, requireMod, async (req, res) => {
  try {
    const { targetUserId, reason } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'Usuario requerido' });

    await pool.query('UPDATE users SET is_banned = FALSE WHERE id = $1', [targetUserId]);
    await pool.query(
      `INSERT INTO moderation_logs (target_user_id, moderator_user_id, action_type, reason)
       VALUES ($1, $2, 'unban', $3)`,
      [targetUserId, req.user.userId, reason || 'Sin motivo']
    );
    await createNotification(targetUserId, 'info', 'Has sido desbaneado', reason || 'Un moderador te ha desbaneado.');

    res.json({ success: true, message: 'Usuario desbaneado' });
  } catch (err) {
    console.error('Error en mod/unban:', err);
    res.status(500).json({ error: 'Error al desbanear' });
  }
});

// ── Añadir strike ──
router.post('/strike', auth, requireMod, async (req, res) => {
  try {
    const { targetUserId, reason } = req.body;
    if (!targetUserId || !reason) return res.status(400).json({ error: 'Usuario y motivo requeridos' });

    const target = await pool.query('SELECT id, strikes, is_admin FROM users WHERE id = $1', [targetUserId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.rows[0].is_admin && req.moderatorRole !== 'admin') return res.status(403).json({ error: 'No puedes sancionar a un admin' });

    const newStrikes = (target.rows[0].strikes || 0) + 1;
    await pool.query('UPDATE users SET strikes = $1 WHERE id = $2', [newStrikes, targetUserId]);
    await pool.query(
      `INSERT INTO moderation_logs (target_user_id, moderator_user_id, action_type, reason)
       VALUES ($1, $2, 'strike', $3)`,
      [targetUserId, req.user.userId, reason]
    );
    await createNotification(targetUserId, 'warning', `Strike ${newStrikes}/3`, `Razón: ${reason}${newStrikes >= 3 ? ' · Has alcanzado 3 strikes.' : ''}`);
    await createAppealThread(targetUserId, `Apelación de strike ${newStrikes}/3`, reason);

    // Auto-ban at 3 strikes
    if (newStrikes >= 3) {
      await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [targetUserId]);
      await pool.query(
        `INSERT INTO moderation_logs (target_user_id, moderator_user_id, action_type, reason, duration_seconds)
         VALUES ($1, $2, 'ban_permanent', $3, NULL)`,
        [targetUserId, req.user.userId, 'Auto-ban por alcanzar 3 strikes']
      );
      await createAppealThread(targetUserId, 'Apelación de auto-ban por strikes', 'Has alcanzado 3 strikes.');
    }

    res.json({ success: true, strikes: newStrikes, autoBanned: newStrikes >= 3 });
  } catch (err) {
    console.error('Error en mod/strike:', err);
    res.status(500).json({ error: 'Error al añadir strike' });
  }
});

// ── Limpiar strikes ──
router.post('/clear-strikes', auth, requireMod, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'Usuario requerido' });
    await pool.query('UPDATE users SET strikes = 0 WHERE id = $1', [targetUserId]);
    await pool.query(
      `INSERT INTO moderation_logs (target_user_id, moderator_user_id, action_type, reason)
       VALUES ($1, $2, 'clear_strikes', 'Strikes limpiados manualmente')`,
      [targetUserId, req.user.userId]
    );
    res.json({ success: true, message: 'Strikes limpiados' });
  } catch (err) {
    console.error('Error en mod/clear-strikes:', err);
    res.status(500).json({ error: 'Error al limpiar strikes' });
  }
});

// ── Mute / silenciar ──
router.post('/mute', auth, requireMod, async (req, res) => {
  try {
    const { targetUserId, durationSeconds, reason } = req.body;
    if (!targetUserId || !durationSeconds || !reason) return res.status(400).json({ error: 'Usuario, duración y motivo requeridos' });

    const mutedUntil = new Date(Date.now() + durationSeconds * 1000);
    await pool.query('UPDATE users SET muted_until = $1 WHERE id = $2', [mutedUntil, targetUserId]);
    await pool.query(
      `INSERT INTO moderation_logs (target_user_id, moderator_user_id, action_type, reason, duration_seconds)
       VALUES ($1, $2, 'mute', $3, $4)`,
      [targetUserId, req.user.userId, reason, durationSeconds]
    );
    await createNotification(targetUserId, 'mute', 'Has sido silenciado', `Razón: ${reason} · Duración: ${formatDuration(durationSeconds)}`);
    await createAppealThread(targetUserId, 'Apelación de silencio', `${reason} (${formatDuration(durationSeconds)})`);

    res.json({ success: true, message: `Usuario silenciado por ${formatDuration(durationSeconds)}` });
  } catch (err) {
    console.error('Error en mod/mute:', err);
    res.status(500).json({ error: 'Error al silenciar' });
  }
});

// ── Enviar warning/aviso ──
router.post('/warn', auth, requireMod, async (req, res) => {
  try {
    const { targetUserId, message } = req.body;
    if (!targetUserId || !message) return res.status(400).json({ error: 'Usuario y mensaje requeridos' });

    await pool.query(
      `INSERT INTO moderation_logs (target_user_id, moderator_user_id, action_type, reason)
       VALUES ($1, $2, 'warning', $3)`,
      [targetUserId, req.user.userId, message]
    );
    await createNotification(targetUserId, 'warning', 'Aviso de moderación', message);

    res.json({ success: true, message: 'Aviso enviado' });
  } catch (err) {
    console.error('Error en mod/warn:', err);
    res.status(500).json({ error: 'Error al enviar aviso' });
  }
});

// ── Historial de moderación (para admin overview) ──
router.get('/history', auth, requireMod, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ml.*, tu.username AS target_name, mu.username AS moderator_name
       FROM moderation_logs ml
       LEFT JOIN users tu ON tu.id = ml.target_user_id
       LEFT JOIN users mu ON mu.id = ml.moderator_user_id
       ORDER BY ml.created_at DESC LIMIT 100`
    );
    res.json({ logs: result.rows });
  } catch (err) {
    console.error('Error en mod/history:', err);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// ── Helpers ──
async function createNotification(userId, type, title, message) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message) VALUES ($1, $2, $3, $4)`,
      [userId, type, title, message]
    );
  } catch {}
}

async function createAppealThread(userId, subject, reason) {
  try {
    const existing = await pool.query(
      `SELECT id FROM message_threads WHERE user_id = $1 AND status IN ('open', 'pending') AND subject = $2`,
      [userId, subject]
    );
    if (existing.rows.length > 0) return;

    await pool.query(
      `INSERT INTO message_threads (user_id, subject, status) VALUES ($1, $2, 'open')`,
      [userId, subject]
    );
  } catch {}
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return 'permanente';
  const units = [
    [31536000, 'año'], [2592000, 'mes'], [604800, 'semana'],
    [86400, 'día'], [3600, 'hora'], [60, 'minuto'],
  ];
  for (const [s, label] of units) {
    if (seconds >= s) {
      const v = Math.floor(seconds / s);
      return `${v} ${label}${v > 1 ? 's' : ''}`;
    }
  }
  return `${seconds} segundos`;
}

module.exports = router;
