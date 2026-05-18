// KAMI — Routes: Admin (rangos, moderación)
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');

async function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = await verifyToken(token);
    const r = await pool.query("SELECT role FROM user_with_role WHERE id = $1", [req.user.userId]);
    if (r.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Se requiere rol admin' });
    next();
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// POST /api/admin/set-role — Cambiar rol de un usuario
router.post('/set-role', adminAuth, async (req, res) => {
  try {
    const { user_id, role } = req.body;
    if (!user_id || !role) return res.status(400).json({ error: 'user_id y role requeridos' });

    const validRoles = ['creator', 'company', 'user'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rol inválido. Válidos: creator, company, user' });

    if (role === 'creator') {
      await pool.query('UPDATE users SET is_creator = true, company_verified = false WHERE id = $1', [user_id]);
    } else if (role === 'company') {
      await pool.query('UPDATE users SET company_verified = true, is_creator = false WHERE id = $1', [user_id]);
    } else {
      await pool.query('UPDATE users SET is_creator = false, company_verified = false WHERE id = $1', [user_id]);
    }
    res.json({ success: true, message: 'Rol actualizado' });
  } catch (err) {
    console.error('[admin] Error:', err.message);
    res.status(500).json({ error: 'Error al actualizar rol' });
  }
});

module.exports = router;
