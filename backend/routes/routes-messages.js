const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const getRole = require('../getRole');
const { verifyToken } = require('../config');

const MOD_ROLES = ['admin', 'moderator', 'company'];

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = await verifyToken(token); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

async function getUserRole(userId) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (r.rows.length === 0) return null;
  return getRole(r.rows[0]);
}

// GET /api/messages — hilos del usuario o todos (mods)
router.get('/', auth, async (req, res) => {
  try {
    const role = await getUserRole(req.user.userId);
    const isMod = MOD_ROLES.includes(role);

    let threads;
    if (isMod) {
      threads = await pool.query(
        `SELECT t.*, u.username AS user_name, m.username AS mod_name,
                (SELECT COUNT(*) FROM messages WHERE thread_id = t.id AND is_read = FALSE AND sender_id != $1) AS unread
         FROM message_threads t
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN users m ON m.id = t.assigned_moderator_id
         ORDER BY t.updated_at DESC`,
        [req.user.userId]
      );
    } else {
      threads = await pool.query(
        `SELECT t.*, u.username AS user_name, m.username AS mod_name,
                (SELECT COUNT(*) FROM messages WHERE thread_id = t.id AND is_read = FALSE AND sender_id != $1) AS unread
         FROM message_threads t
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN users m ON m.id = t.assigned_moderator_id
         WHERE t.user_id = $1
         ORDER BY t.updated_at DESC`,
        [req.user.userId]
      );
    }

    res.json({ threads: threads.rows });
  } catch (err) {
    console.error('Error en messages GET:', err);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

// POST /api/messages — crear hilo
router.post('/', auth, async (req, res) => {
  try {
    const { subject } = req.body;
    if (!subject) return res.status(400).json({ error: 'Asunto requerido' });

    const result = await pool.query(
      `INSERT INTO message_threads (user_id, subject) VALUES ($1, $2) RETURNING *`,
      [req.user.userId, subject]
    );

    res.json({ success: true, thread: result.rows[0] });
  } catch (err) {
    console.error('Error creando hilo:', err);
    res.status(500).json({ error: 'Error al crear hilo' });
  }
});

// GET /api/messages/:threadId — mensajes de un hilo
router.get('/:threadId', auth, async (req, res) => {
  try {
    const thread = await pool.query('SELECT * FROM message_threads WHERE id = $1', [req.params.threadId]);
    if (thread.rows.length === 0) return res.status(404).json({ error: 'Hilo no encontrado' });

    const role = await getUserRole(req.user.userId);
    const isMod = MOD_ROLES.includes(role);

    if (thread.rows[0].user_id !== req.user.userId && !isMod) {
      return res.status(403).json({ error: 'No tienes acceso a este hilo' });
    }

    const msgs = await pool.query(
      `SELECT m.*,
              CASE WHEN m.is_staff = TRUE THEN 'Staff' ELSE u.username END AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.thread_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.threadId]
    );

    // Mark as read if viewer is not the sender
    await pool.query(
      `UPDATE messages SET is_read = TRUE WHERE thread_id = $1 AND sender_id != $2 AND is_read = FALSE`,
      [req.params.threadId, req.user.userId]
    );

    res.json({ thread: thread.rows[0], messages: msgs.rows });
  } catch (err) {
    console.error('Error en messages/:id GET:', err);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

// POST /api/messages/:threadId — enviar mensaje en hilo
router.post('/:threadId', auth, async (req, res) => {
  try {
    const { message, as_staff } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensaje requerido' });

    const thread = await pool.query('SELECT * FROM message_threads WHERE id = $1', [req.params.threadId]);
    if (thread.rows.length === 0) return res.status(404).json({ error: 'Hilo no encontrado' });

    const role = await getUserRole(req.user.userId);
    const isMod = MOD_ROLES.includes(role);

    if (thread.rows[0].user_id !== req.user.userId && !isMod) {
      return res.status(403).json({ error: 'No tienes acceso a este hilo' });
    }

    const canBeStaff = isMod && role !== 'company';
    const useStaff = canBeStaff && as_staff === true;

    const result = await pool.query(
      `INSERT INTO messages (thread_id, sender_id, message, is_staff) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.threadId, req.user.userId, message, useStaff]
    );

    await pool.query('UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [req.params.threadId]);

    // Notify the other party
    const notifyUserId = isMod ? thread.rows[0].user_id : (thread.rows[0].assigned_moderator_id || thread.rows[0].user_id);
    if (notifyUserId && notifyUserId !== req.user.userId) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, link) VALUES ($1, 'info', 'Nuevo mensaje', $2, '/messages?thread=${req.params.threadId}')`,
        [notifyUserId, thread.rows[0].subject]
      );
    }

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

// PATCH /api/messages/:threadId/status — cambiar estado
router.patch('/:threadId/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['open', 'pending', 'resolved', 'closed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Estado inválido' });

    const role = await getUserRole(req.user.userId);
    if (!MOD_ROLES.includes(role)) return res.status(403).json({ error: 'Solo moderación' });

    await pool.query('UPDATE message_threads SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, req.params.threadId]);

    res.json({ success: true, status });
  } catch (err) {
    console.error('Error actualizando estado:', err);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

// POST /api/messages/:threadId/assign — asignar moderador
router.post('/:threadId/assign', auth, async (req, res) => {
  try {
    const role = await getUserRole(req.user.userId);
    if (!MOD_ROLES.includes(role)) return res.status(403).json({ error: 'Solo moderación' });

    await pool.query('UPDATE message_threads SET assigned_moderator_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [req.user.userId, req.params.threadId]);

    res.json({ success: true, message: 'Hilo asignado' });
  } catch (err) {
    console.error('Error asignando hilo:', err);
    res.status(500).json({ error: 'Error al asignar' });
  }
});

// GET /api/messages/unread/count — contador mensajes no leídos
router.get('/unread/count', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM messages m
       JOIN message_threads t ON t.id = m.thread_id
       WHERE m.sender_id != $1 AND m.is_read = FALSE AND (t.user_id = $1 OR t.assigned_moderator_id = $1)`,
      [req.user.userId]
    );
    res.json({ unreadCount: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Error en unread count:', err);
    res.status(500).json({ error: 'Error' });
  }
});

module.exports = router;
