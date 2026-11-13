// ═══════════════════════════════════════════════════════════════════════════════
// ⚙️ KamiTales — routes-settings.js
// Ajustes de la cuenta. Montado en /api/settings.
//
//   GET  /                → datos de la cuenta, plan y calidades de imagen permitidas
//   PUT  /quality         { quality }   → calidad de imagen del lector de cómics
//   POST /logout-all      → cierra la sesión en todos los dispositivos (devuelve un token nuevo)
//   GET  /export          → descarga de tus datos en JSON
// ═══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { verifyToken, signToken, forgetSessionCache } = require('../config');
const getRole = require('../getRole');
const { getAllowedQualities, setUserQuality } = require('../image-settings');
const { hasColumn } = require('../schema');
const notifyPrefs = require('../notify-prefs');
const bcrypt = require('bcryptjs');

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Inicia sesión para ver tus ajustes.' });
  try { req.user = await verifyToken(token); next(); }
  catch { res.status(401).json({ error: 'Tu sesión ha caducado. Vuelve a iniciar sesión.' }); }
}
router.use(auth);

const PREMIUM_TIERS = ['silver', 'gold'];
function planOf(u) {
  const active = !!(u.premium_expires_at && new Date(u.premium_expires_at) > new Date());
  // El plan solo cuenta mientras la fecha siga vigente: un nivel sin fecha activa no da Premium.
  const tier = !active ? 'free' : (PREMIUM_TIERS.includes(u.subscription_tier) ? u.subscription_tier : 'silver');
  const staff = !!u.is_owner || !!u.is_admin;
  return { tier, active, expiresAt: u.premium_expires_at, isPremium: active || staff, viaStaff: staff && !active };
}

router.get('/', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const role = getRole(u);
    res.json({
      user: {
        id: u.id, username: u.username, email: u.email, avatar: u.avatar || '', country: u.country || '',
        createdAt: u.created_at, role, isOwner: !!u.is_owner,
        hasPassword: !!u.password, googleLinked: !!u.google_id,
        securityChangedAt: u.password_changed_at,
      },
      plan: planOf(u),
      quality: { selected: u.image_quality || '1080', allowed: getAllowedQualities((planOf(u).active && u.subscription_tier) || (u.is_admin ? 'admin' : 'user')) },
      notifications: { available: await hasColumn('users', 'notification_prefs'), prefs: await notifyPrefs.getPrefs(u.id) },
      deletion: { available: await hasColumn('users', 'deleted_at'), blockedBy: u.is_owner ? 'owner' : ((await hasColumn('mangas', 'created_by')) && (await pool.query('SELECT 1 FROM mangas WHERE created_by = $1 LIMIT 1', [u.id])).rows.length ? 'works' : null) },
    });
  } catch (e) {
    console.error('[ajustes] get:', e.message);
    res.status(500).json({ error: 'No se pudieron cargar tus ajustes.' });
  }
});

router.put('/quality', async (req, res) => {
  try {
    const q = String(req.body?.quality || '');
    const r = await pool.query('SELECT subscription_tier, is_admin FROM users WHERE id = $1', [req.user.userId]);
    const u = r.rows[0]; if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const allowed = getAllowedQualities((planOf(u).active && u.subscription_tier) || (u.is_admin ? 'admin' : 'user'));
    if (!allowed.includes(q)) return res.status(403).json({ error: q === 'master' ? 'La calidad Master es para Premium.' : 'Calidad no válida.' });
    await setUserQuality(req.user.userId, q);
    res.json({ success: true, quality: q });
  } catch (e) {
    console.error('[ajustes] quality:', e.message);
    res.status(500).json({ error: 'No se pudo guardar la calidad.' });
  }
});

const logoutLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera unos minutos.' } });
// Marca la fecha de seguridad: todos los tokens emitidos antes dejan de valer (ver verifyToken en config.js)
router.post('/logout-all', logoutLimiter, async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, username, email', [req.user.userId]);
    const u = r.rows[0]; if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    forgetSessionCache(u.id);
    // Token nuevo un segundo después, para que esta sesión siga abierta
    await new Promise(ok => setTimeout(ok, 1100));
    res.json({ success: true, token: signToken({ userId: u.id, username: u.username, email: u.email }), message: 'Se ha cerrado la sesión en todos los demás dispositivos.' });
  } catch (e) {
    console.error('[ajustes] logout-all:', e.message);
    res.status(500).json({ error: 'No se pudo cerrar las sesiones.' });
  }
});

const exportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Ya has descargado tus datos varias veces. Prueba dentro de una hora.' } });
router.get('/export', exportLimiter, async (req, res) => {
  const id = req.user.userId;
  const q = async (sql) => { try { return (await pool.query(sql, [id])).rows; } catch { return []; } };
  try {
    const [user] = await q('SELECT id, username, email, bio, country, favorite_genres, emoji, created_at, premium_expires_at, subscription_tier, image_quality FROM users WHERE id = $1');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const data = {
      exportedAt: new Date().toISOString(),
      service: 'KamiTales',
      account: user,
      library: await q('SELECT l.manga_id, m.title, l.status, l.is_favorite, l.score, l.progress, l.notes, l.added_at, l.updated_at FROM user_manga_library l LEFT JOIN mangas m ON m.id = l.manga_id WHERE l.user_id = $1 ORDER BY l.updated_at DESC'),
      readingProgress: await q('SELECT r.manga_id, m.title, r.last_chapter, r.last_page, r.last_percent, r.updated_at FROM user_reading r LEFT JOIN mangas m ON m.id = r.manga_id WHERE r.user_id = $1 ORDER BY r.updated_at DESC'),
      chapterComments: await q('SELECT manga_id, chapter_number, paragraph_id, text, is_spoiler, created_at FROM chapter_comments WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC'),
      posts: await q('SELECT id, manga_id, content, media_url, chapter_number, is_spoiler, parent_id, created_at FROM feed_posts WHERE user_id = $1 ORDER BY created_at DESC'),
      following: await q('SELECT u.username, f.created_at FROM user_follows f JOIN users u ON u.id = f.following_id WHERE f.follower_id = $1'),
      followers: await q('SELECT u.username, f.created_at FROM user_follows f JOIN users u ON u.id = f.follower_id WHERE f.following_id = $1'),
      works: await q('SELECT id, title, type, status, created_at FROM mangas WHERE created_by = $1'),
    };
    res.setHeader('Content-Disposition', `attachment; filename="kamitales-${encodeURIComponent(user.username)}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (e) {
    console.error('[ajustes] export:', e.message);
    res.status(500).json({ error: 'No se pudieron exportar tus datos.' });
  }
});

// ── Preferencias de notificaciones ───────────────────────────────
router.put('/notifications', async (req, res) => {
  try {
    if (!(await hasColumn('users', 'notification_prefs'))) return res.status(503).json({ error: 'Las preferencias de notificaciones aún no están activadas en el servidor.' });
    const body = req.body || {}, prefs = {};
    for (const k of notifyPrefs.KEYS) if (typeof body[k] === 'boolean') prefs[k] = body[k];
    if (!Object.keys(prefs).length) return res.status(400).json({ error: 'Nada que guardar.' });
    const r = await pool.query("UPDATE users SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING notification_prefs", [JSON.stringify(prefs), req.user.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    notifyPrefs.forget(req.user.userId);
    res.json({ success: true, prefs: await notifyPrefs.getPrefs(req.user.userId) });
  } catch (e) {
    console.error('[ajustes] notificaciones:', e.message);
    res.status(500).json({ error: 'No se pudieron guardar las preferencias.' });
  }
});

// ── Eliminar la cuenta ───────────────────────────────────────────
// Irreversible: se borran biblioteca, progreso, seguidores, amistades y reacciones;
// los comentarios y publicaciones se vacían; la cuenta se anonimiza y no puede volver a entrar.
const deleteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera una hora.' } });
router.post('/delete', deleteLimiter, async (req, res) => {
  const id = req.user.userId;
  try {
    if (!(await hasColumn('users', 'deleted_at'))) return res.status(503).json({ error: 'La eliminación de cuentas aún no está activada en el servidor.' });
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    const u = r.rows[0];
    if (!u || u.deleted_at) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (u.is_owner) return res.status(403).json({ error: 'La cuenta propietaria no se puede eliminar.' });
    const { password, confirm, username } = req.body || {};
    if (String(confirm || '').trim().toUpperCase() !== 'ELIMINAR') return res.status(400).json({ error: 'Escribe ELIMINAR para confirmar.' });
    if (password) {
      const okPw = await bcrypt.compare(String(password), u.password || '').catch(() => false);
      if (!okPw) return res.status(401).json({ error: 'La contraseña no es correcta.' });
    } else if (u.google_id) {
      // Cuentas de Google sin contraseña propia: se confirma con el nombre de usuario
      if (String(username || '').trim().toLowerCase() !== String(u.username).toLowerCase()) return res.status(400).json({ error: 'Escribe tu nombre de usuario para confirmar.' });
    } else {
      return res.status(401).json({ error: 'Escribe tu contraseña para confirmar.' });
    }
    if ((await hasColumn('mangas', 'created_by')) && (await pool.query('SELECT 1 FROM mangas WHERE created_by = $1 LIMIT 1', [id])).rows.length) {
      return res.status(409).json({ error: 'Tienes obras publicadas. Escríbenos para traspasarlas o retirarlas antes de eliminar la cuenta.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const step = async (sql) => { await client.query('SAVEPOINT s'); try { await client.query(sql, [id]); await client.query('RELEASE SAVEPOINT s'); } catch (e) { await client.query('ROLLBACK TO SAVEPOINT s'); console.warn('[ajustes] eliminar, paso omitido:', e.message.slice(0, 120)); } };
      await step('DELETE FROM user_manga_library WHERE user_id = $1');
      await step('DELETE FROM user_reading WHERE user_id = $1');
      await step('DELETE FROM user_follows WHERE follower_id = $1 OR following_id = $1');
      await step('DELETE FROM user_friends WHERE user_id = $1 OR friend_id = $1');
      await step('DELETE FROM feed_interactions WHERE user_id = $1');
      await step('DELETE FROM chapter_reactions WHERE user_id = $1');
      await step('DELETE FROM feed_notifications WHERE user_id = $1 OR actor_id = $1');
      await step('DELETE FROM notifications WHERE user_id = $1');
      await step("UPDATE chapter_comments SET text = '', deleted_at = COALESCE(deleted_at, NOW()) WHERE user_id = $1");
      await step("UPDATE feed_posts SET content = '', media_url = NULL WHERE user_id = $1");
      const tag = String(id).replace(/-/g, '').slice(0, 10);
      await client.query(
        `UPDATE users SET username = $2, email = $3, password = '!cuenta-eliminada', google_id = NULL,
           avatar = '', banner = '', bio = '', country = '', emoji = '', favorite_genres = '{}',
           notification_prefs = '{}'::jsonb, deleted_at = NOW(), password_changed_at = NOW(), updated_at = NOW()
         WHERE id = $1`, [id, 'eliminada-' + tag, 'eliminada+' + tag + '@kamitales.invalid']);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    forgetSessionCache(id); notifyPrefs.forget(id);
    res.json({ success: true, message: 'Tu cuenta se ha eliminado.' });
  } catch (e) {
    console.error('[ajustes] eliminar:', e.message);
    res.status(500).json({ error: 'No se pudo eliminar la cuenta. No se ha borrado nada.' });
  }
});

module.exports = router;
