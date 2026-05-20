// ═══════════════════════════════════════════════════════════════════════════════
// 💬 KAMI — routes-dms.js
// Mensajes Directos: conversaciones 1-a-1 con WebSocket en tiempo real
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = await verifyToken(token); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// Helper: verificar que el usuario es participante de la conversación
async function isParticipant(conversationId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM dm_conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  return r.rows.length > 0;
}

// 🚪 [GET] /api/dms — Listar conversaciones del usuario
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const r = await pool.query(`
      SELECT dc.id, dc.last_message_at,
             (SELECT u2.username FROM dm_conversation_participants cp2
              JOIN users u2 ON u2.id = cp2.user_id
              WHERE cp2.conversation_id = dc.id AND cp2.user_id != $1
              LIMIT 1) AS other_username,
             (SELECT u2.avatar FROM dm_conversation_participants cp2
              JOIN users u2 ON u2.id = cp2.user_id
              WHERE cp2.conversation_id = dc.id AND cp2.user_id != $1
              LIMIT 1) AS other_avatar,
             (SELECT u2.id FROM dm_conversation_participants cp2
              JOIN users u2 ON u2.id = cp2.user_id
              WHERE cp2.conversation_id = dc.id AND cp2.user_id != $1
              LIMIT 1) AS other_id,
             (SELECT dm.message FROM dm_messages dm
              WHERE dm.conversation_id = dc.id
              ORDER BY dm.created_at DESC LIMIT 1) AS last_message,
             (SELECT dm.created_at FROM dm_messages dm
              WHERE dm.conversation_id = dc.id
              ORDER BY dm.created_at DESC LIMIT 1) AS last_message_at2,
             (dc.last_message_at > COALESCE(cp.last_read_at, '1970-01-01')) AS has_unread
      FROM dm_conversations dc
      JOIN dm_conversation_participants cp ON cp.conversation_id = dc.id AND cp.user_id = $1
      ORDER BY dc.last_message_at DESC
    `, [userId]);

    res.json({ success: true, conversations: r.rows });
  } catch (err) {
    console.error('[dms] Error listing:', err.message);
    res.status(500).json({ error: 'Error al listar conversaciones' });
  }
});

// 🚪 [POST] /api/dms — Crear/obtener DM existente con otro usuario
router.post('/', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { recipient_id } = req.body;
    if (!recipient_id) return res.status(400).json({ error: 'recipient_id requerido' });
    if (recipient_id === userId) return res.status(400).json({ error: 'No puedes enviarte mensajes a ti mismo' });

    // Verificar que el destinatario existe
    const target = await pool.query('SELECT id, username FROM users WHERE id = $1', [recipient_id]);
    if (!target.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Buscar si ya existe conversación entre ambos
    const existing = await pool.query(`
      SELECT dc.id FROM dm_conversations dc
      WHERE (
        SELECT COUNT(*) FROM dm_conversation_participants cp
        WHERE cp.conversation_id = dc.id AND cp.user_id IN ($1, $2)
      ) = 2
      AND (
        SELECT COUNT(*) FROM dm_conversation_participants cp
        WHERE cp.conversation_id = dc.id
      ) = 2
      LIMIT 1
    `, [userId, recipient_id]);

    if (existing.rows.length) {
      return res.json({ success: true, conversation_id: existing.rows[0].id, is_new: false });
    }

    // Crear nueva conversación
    const conv = await pool.query(
      'INSERT INTO dm_conversations DEFAULT VALUES RETURNING id'
    );
    const convId = conv.rows[0].id;

    await pool.query(
      'INSERT INTO dm_conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
      [convId, userId, recipient_id]
    );

    res.json({ success: true, conversation_id: convId, is_new: true });
  } catch (err) {
    console.error('[dms] Error creating:', err.message);
    res.status(500).json({ error: 'Error al crear conversación' });
  }
});

// 🚪 [GET] /api/dms/:id — Obtener mensajes de una conversación
router.get('/:id', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const convId = parseInt(req.params.id);
    if (!convId) return res.status(400).json({ error: 'ID inválido' });

    if (!(await isParticipant(convId, userId)))
      return res.status(403).json({ error: 'No eres participante' });

    const r = await pool.query(`
      SELECT dm.id, dm.message, dm.created_at, dm.sender_id,
             u.username, u.avatar
      FROM dm_messages dm
      LEFT JOIN users u ON u.id = dm.sender_id
      WHERE dm.conversation_id = $1
      ORDER BY dm.created_at ASC LIMIT 100
    `, [convId]);

    // Obtener info del otro participante
    const other = await pool.query(`
      SELECT u.id, u.username, u.avatar, u.created_at FROM users u
      JOIN dm_conversation_participants cp ON cp.user_id = u.id
      WHERE cp.conversation_id = $1 AND cp.user_id != $2 LIMIT 1
    `, [convId, userId]);

    // Obtener last_read_at del otro participante (para mostrar "Leído"/"Enviado")
    const otherRead = await pool.query(`
      SELECT cp.last_read_at FROM dm_conversation_participants cp
      WHERE cp.conversation_id = $1 AND cp.user_id != $2 LIMIT 1
    `, [convId, userId]);

    res.json({
      success: true,
      messages: r.rows,
      other: { ...(other.rows[0] || {}), last_read_at: otherRead.rows[0]?.last_read_at || null },
    });
  } catch (err) {
    console.error('[dms] Error getting messages:', err.message);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

// 🚪 [POST] /api/dms/:id — Enviar mensaje
router.post('/:id', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const convId = parseInt(req.params.id);
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Mensaje requerido' });
    if (!convId) return res.status(400).json({ error: 'ID inválido' });

    if (!(await isParticipant(convId, userId)))
      return res.status(403).json({ error: 'No eres participante' });

    const msg = await pool.query(
      'INSERT INTO dm_messages (conversation_id, sender_id, message) VALUES ($1, $2, $3) RETURNING id, created_at',
      [convId, userId, message.trim()]
    );

    await pool.query(
      'UPDATE dm_conversations SET last_message_at = NOW() WHERE id = $1',
      [convId]
    );

    // WebSocket: notificar a todos los participantes
    if (global.io) {
      const participants = await pool.query(
        'SELECT user_id FROM dm_conversation_participants WHERE conversation_id = $1 AND user_id != $2',
        [convId, userId]
      );
      const sender = await pool.query(
        'SELECT username, avatar FROM users WHERE id = $1', [userId]
      );
      const payload = {
        conversation_id: convId,
        message_id: msg.rows[0].id,
        message: message.trim(),
        sender_id: userId,
        username: sender.rows[0]?.username || 'Anónimo',
        avatar: sender.rows[0]?.avatar || null,
        created_at: msg.rows[0].created_at,
      };
      participants.rows.forEach(p => {
        global.io.to('dm:' + p.user_id).emit('new-dm', payload);
      });
    }

    res.json({ success: true, message_id: msg.rows[0].id, created_at: msg.rows[0].created_at });
  } catch (err) {
    console.error('[dms] Error sending:', err.message);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

// 🚪 [POST] /api/dms/:id/read — Marcar conversación como leída
router.post('/:id/read', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const convId = parseInt(req.params.id);
    if (!convId) return res.status(400).json({ error: 'ID inválido' });

    await pool.query(
      'UPDATE dm_conversation_participants SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2',
      [convId, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[dms] Error marking read:', err.message);
    res.status(500).json({ error: 'Error al marcar como leído' });
  }
});

// 🚪 [GET] /api/dms/unread — Contar no leídos (para badge)
router.get('/unread/count', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const r = await pool.query(`
      SELECT COUNT(*) AS total FROM dm_conversations dc
      JOIN dm_conversation_participants cp ON cp.conversation_id = dc.id
      WHERE cp.user_id = $1 AND dc.last_message_at > COALESCE(cp.last_read_at, '1970-01-01')
    `, [userId]);

    res.json({ success: true, unread_count: parseInt(r.rows[0].total) });
  } catch (err) {
    console.error('[dms] Error unread:', err.message);
    res.status(500).json({ error: 'Error al contar no leídos' });
  }
});

module.exports = router;
