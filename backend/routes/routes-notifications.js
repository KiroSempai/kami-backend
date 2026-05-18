const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');

router.use(async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = await verifyToken(token); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
});

// GET /api/notifications — obtener notificaciones del usuario
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, title, message, is_read, link, created_at
       FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.userId]
    );
    const unread = await pool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
      [req.user.userId]
    );
    res.json({ notifications: result.rows, unreadCount: parseInt(unread.rows[0].count) });
  } catch (err) {
    console.error('Error en notif GET:', err);
    res.status(500).json({ error: 'Error al obtener notificaciones' });
  }
});

// POST /api/notifications/read/:id — marcar como leída
router.post('/read/:id', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error en notif read:', err);
    res.status(500).json({ error: 'Error al marcar' });
  }
});

// POST /api/notifications/read-all — marcar todas como leídas
router.post('/read-all', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
      [req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error en notif read-all:', err);
    res.status(500).json({ error: 'Error al marcar todas' });
  }
});

// GET /api/notifications/unread-count — solo el contador (ligero)
router.get('/unread-count', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
      [req.user.userId]
    );
    res.json({ unreadCount: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Error en notif count:', err);
    res.status(500).json({ error: 'Error al contar' });
  }
});

module.exports = router;
