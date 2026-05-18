// ═══════════════════════════════════════════════════════════════════════════════
// 🤝 KAMI — routes-friends.js
// Gestión de amistades: solicitudes, aceptar, rechazar, listar.
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

// GET /api/friends — lista de amigos
router.get('/', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.avatar
       FROM user_friends f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = $1 AND f.status = 'accepted'
       UNION
       SELECT u.id, u.username, u.avatar
       FROM user_friends f JOIN users u ON u.id = f.user_id
       WHERE f.friend_id = $1 AND f.status = 'accepted'`,
      [req.user.userId]
    );
    res.json({ friends: r.rows });
  } catch (err) {
    console.error('[friends] Error:', err.message);
    res.status(500).json({ error: 'Error al obtener amigos' });
  }
});

// POST /api/friends/add — agregar amigo (por username)
router.post('/add', auth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username requerido' });

    const user = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.rows[0].id === req.user.userId) return res.status(400).json({ error: 'No puedes agregarte a ti mismo' });

    await pool.query(
      'INSERT INTO user_friends (user_id, friend_id, status) VALUES ($1, $2, $3) ON CONFLICT (user_id, friend_id) DO NOTHING',
      [req.user.userId, user.rows[0].id, 'accepted']
    );

    res.json({ success: true, message: 'Amigo agregado' });
  } catch (err) {
    console.error('[friends] Error:', err.message);
    res.status(500).json({ error: 'Error al agregar amigo' });
  }
});

// DELETE /api/friends/:friendId — eliminar amigo
router.delete('/:friendId', auth, async (req, res) => {
  try {
    const { friendId } = req.params;
    await pool.query(
      'DELETE FROM user_friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.user.userId, friendId]
    );
    res.json({ success: true, message: 'Amigo eliminado' });
  } catch (err) {
    console.error('[friends] Error:', err.message);
    res.status(500).json({ error: 'Error al eliminar amigo' });
  }
});

module.exports = router;
