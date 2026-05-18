// ═══════════════════════════════════════════════════════════════════════════════
// 💬 KAMI — routes-comments.js
// Comentarios en páginas de capítulos del lector.
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

// GET /api/comments/:mangaId/:chapterNum
router.get('/:mangaId/:chapterNum', auth, async (req, res) => {
  try {
    const { mangaId, chapterNum } = req.params;
    const result = await pool.query(
      `SELECT c.id, c.text, c.created_at, u.username, u.avatar
       FROM chapter_comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.manga_id = $1 AND c.chapter_number = $2
       ORDER BY c.created_at ASC`,
      [mangaId, parseInt(chapterNum)]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    console.error('[comments] Error:', err.message);
    res.status(500).json({ error: 'Error al obtener comentarios' });
  }
});

// POST /api/comments/:mangaId/:chapterNum
router.post('/:mangaId/:chapterNum', auth, async (req, res) => {
  try {
    const { mangaId, chapterNum } = req.params;
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'El comentario no puede estar vacío' });

    const result = await pool.query(
      `INSERT INTO chapter_comments (manga_id, chapter_number, user_id, text)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [mangaId, parseInt(chapterNum), req.user.userId, text.trim()]
    );

    const user = await pool.query('SELECT username, avatar FROM users WHERE id = $1', [req.user.userId]);
    res.status(201).json({
      success: true,
      comment: {
        id: result.rows[0].id,
        text: text.trim(),
        created_at: result.rows[0].created_at,
        username: user.rows[0].username,
        avatar: user.rows[0].avatar,
      },
    });
  } catch (err) {
    console.error('[comments] Error:', err.message);
    res.status(500).json({ error: 'Error al crear comentario' });
  }
});

module.exports = router;
