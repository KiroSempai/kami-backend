const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');

// Auth middleware
async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = await verifyToken(token); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// Obtener lista de amigos del usuario
async function getFriendIds(userId) {
  const r = await pool.query(
    `SELECT friend_id FROM user_friends WHERE user_id = $1 AND status = 'accepted'
     UNION SELECT user_id FROM user_friends WHERE friend_id = $1 AND status = 'accepted'`,
    [userId]
  );
  return r.rows.map(row => row.friend_id);
}

// GET /api/annotations/:mangaId/:chapter/:page — solo amigos + propias
router.get('/:mangaId/:chapter/:page', auth, async (req, res) => {
  try {
    const { mangaId, chapter, page } = req.params;
    const friendIds = await getFriendIds(req.user.userId);
    friendIds.push(req.user.userId);

    const result = await pool.query(
      `SELECT a.id, a.user_id, a.region, a.note_text, a.color, a.created_at,
              u.username, u.avatar
       FROM page_annotations a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.manga_id = $1 AND a.chapter_number = $2 AND a.page_number = $3
         AND a.user_id = ANY($4::varchar[])
       ORDER BY a.created_at ASC`,
      [mangaId, parseInt(chapter), parseInt(page), friendIds]
    );

    res.json({ annotations: result.rows });
  } catch (err) {
    console.error('[annotations] Error:', err.message);
    res.status(500).json({ error: 'Error al obtener anotaciones' });
  }
});

// POST /api/annotations — crear nota
router.post('/', auth, async (req, res) => {
  try {
    const { mangaId, chapterNumber, pageNumber, region, noteText, color } = req.body;
    if (!mangaId || chapterNumber === undefined || pageNumber === undefined || !region) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const result = await pool.query(
      `INSERT INTO page_annotations (manga_id, chapter_number, page_number, user_id, region, note_text, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [mangaId, parseInt(chapterNumber), parseInt(pageNumber), req.user.userId, JSON.stringify(region), noteText || '', color || '#f5c842']
    );

    res.status(201).json({ success: true, annotation: result.rows[0] });
  } catch (err) {
    console.error('[annotations] Error:', err.message);
    res.status(500).json({ error: 'Error al crear anotación' });
  }
});

// PUT /api/annotations/:id — editar (solo dueño)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { noteText, region, color } = req.body;

    const check = await pool.query('SELECT user_id FROM page_annotations WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Anotación no encontrada' });
    if (check.rows[0].user_id !== req.user.userId) return res.status(403).json({ error: 'No eres el dueño de esta anotación' });

    await pool.query(
      `UPDATE page_annotations SET
         note_text = COALESCE($1, note_text),
         region = COALESCE($2, region),
         color = COALESCE($3, color),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [noteText !== undefined ? noteText : null, region ? JSON.stringify(region) : null, color || null, id]
    );

    res.json({ success: true, message: 'Anotación actualizada' });
  } catch (err) {
    console.error('[annotations] Error:', err.message);
    res.status(500).json({ error: 'Error al actualizar anotación' });
  }
});

// DELETE /api/annotations/:id — eliminar (solo dueño)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query('SELECT user_id FROM page_annotations WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Anotación no encontrada' });
    if (check.rows[0].user_id !== req.user.userId) return res.status(403).json({ error: 'No eres el dueño' });

    await pool.query('DELETE FROM page_annotations WHERE id = $1', [id]);
    res.json({ success: true, message: 'Anotación eliminada' });
  } catch (err) {
    console.error('[annotations] Error:', err.message);
    res.status(500).json({ error: 'Error al eliminar anotación' });
  }
});

module.exports = router;
