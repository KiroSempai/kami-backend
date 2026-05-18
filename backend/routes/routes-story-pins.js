// ═══════════════════════════════════════════════════════════════════════════════
// 📌 KAMI — routes-story-pins.js
// "Story Pins": posts destacados temporales en el perfil del usuario.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');

// GET /api/story-pins/:mangaId/:chapterNum/:pageIndex — get pins for a page
router.get('/:mangaId/:chapterNum/:pageIndex', async (req, res) => {
  try {
    const { mangaId, chapterNum, pageIndex } = req.params;
    let userId = null;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) {
        const decoded = await verifyToken(token);
        userId = decoded.userId;
      }
    } catch {}

    // Fetch pins (excluding deleted) with user info
    const result = await pool.query(`
      SELECT
        sp.id, sp.user_id, sp.x, sp.y, sp.message, sp.visibility,
        sp.emoji, sp.likes, sp.created_at,
        u.username, u.avatar,
        CASE WHEN pl.user_id IS NOT NULL THEN true ELSE false END AS liked_by_me
      FROM story_pins sp
      JOIN users u ON u.id = sp.user_id
      LEFT JOIN pin_likes pl ON pl.pin_id = sp.id AND pl.user_id = $5
      WHERE sp.manga_id = $1
        AND sp.chapter_number = $2
        AND sp.page_index = $3
        AND sp.deleted_at IS NULL
        AND (
          sp.visibility = 'public'
          OR (sp.visibility = 'friends' AND $4 = true)
          OR sp.user_id = $5
        )
      ORDER BY sp.created_at ASC
    `, [mangaId, parseInt(chapterNum), parseInt(pageIndex), !!userId, userId || '']);

    res.json({ pins: result.rows });
  } catch (err) {
    console.error('Error fetching story pins:', err);
    res.status(500).json({ error: 'Error al obtener pins' });
  }
});

// POST /api/story-pins — create a pin
router.post('/', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Debes iniciar sesión' });
    const decoded = await verifyToken(token);
    const userId = decoded.userId;

    const { mangaId, chapterNumber, pageIndex, x, y, message, visibility, emoji } = req.body;

    if (!mangaId || chapterNumber === undefined || pageIndex === undefined || x === undefined || y === undefined) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    if (message && message.length > 180) {
      return res.status(400).json({ error: 'Mensaje demasiado largo (max 180 caracteres)' });
    }

    const result = await pool.query(`
      INSERT INTO story_pins (user_id, manga_id, chapter_number, page_index, x, y, message, visibility, emoji)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, x, y, message, visibility, emoji, likes, created_at
    `, [userId, mangaId, parseInt(chapterNumber), parseInt(pageIndex),
        parseFloat(x), parseFloat(y), message || '', visibility || 'public', emoji || null]);

    const pin = result.rows[0];
    // Return user info too
    const userResult = await pool.query('SELECT username, avatar FROM users WHERE id = $1', [userId]);

    res.status(201).json({
      success: true,
      pin: {
        ...pin,
        user_id: userId,
        username: userResult.rows[0]?.username || 'Anónimo',
        avatar: userResult.rows[0]?.avatar || '',
        liked_by_me: false,
      }
    });
  } catch (err) {
    console.error('Error creating story pin:', err);
    res.status(500).json({ error: 'Error al crear pin' });
  }
});

// PUT /api/story-pins/:id — update pin message/visibility
router.put('/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Debes iniciar sesión' });
    const decoded = await verifyToken(token);

    const { id } = req.params;
    const { message, visibility } = req.body;

    if (message && message.length > 180) {
      return res.status(400).json({ error: 'Mensaje demasiado largo (max 180 caracteres)' });
    }

    const result = await pool.query(`
      UPDATE story_pins SET
        message = COALESCE($1, message),
        visibility = COALESCE($2, visibility)
      WHERE id = $3 AND user_id = $4 AND deleted_at IS NULL
      RETURNING id, message, visibility, emoji, likes
    `, [message !== undefined ? message : null, visibility || null, id, decoded.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pin no encontrado o no tienes permiso' });
    }

    res.json({ success: true, pin: result.rows[0] });
  } catch (err) {
    console.error('Error updating story pin:', err);
    res.status(500).json({ error: 'Error al actualizar pin' });
  }
});

// DELETE /api/story-pins/:id — soft delete (owner or admin)
router.delete('/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Debes iniciar sesión' });
    const decoded = await verifyToken(token);

    // Check if user is admin
    const user = await pool.query('SELECT role FROM users WHERE id = $1', [decoded.userId]);
    const isAdmin = user.rows[0]?.role === 'admin';

    const result = await pool.query(
      isAdmin
        ? 'UPDATE story_pins SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL RETURNING id'
        : 'UPDATE story_pins SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id',
      isAdmin ? [req.params.id] : [req.params.id, decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pin no encontrado o no tienes permiso' });
    }

    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('Error deleting story pin:', err);
    res.status(500).json({ error: 'Error al eliminar pin' });
  }
});

// POST /api/story-pins/:id/like — toggle like
router.post('/:id/like', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Debes iniciar sesión' });
    const decoded = await verifyToken(token);
    const userId = decoded.userId;
    const pinId = parseInt(req.params.id);

    // Check if already liked
    const existing = await pool.query(
      'SELECT id FROM pin_likes WHERE pin_id = $1 AND user_id = $2',
      [pinId, userId]
    );

    let liked;
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM pin_likes WHERE pin_id = $1 AND user_id = $2', [pinId, userId]);
      await pool.query('UPDATE story_pins SET likes = GREATEST(likes - 1, 0) WHERE id = $1', [pinId]);
      liked = false;
    } else {
      await pool.query('INSERT INTO pin_likes (pin_id, user_id) VALUES ($1, $2)', [pinId, userId]);
      await pool.query('UPDATE story_pins SET likes = likes + 1 WHERE id = $1', [pinId]);
      liked = true;
    }

    const count = await pool.query('SELECT likes FROM story_pins WHERE id = $1', [pinId]);
    res.json({ success: true, liked, likes: count.rows[0]?.likes || 0 });
  } catch (err) {
    console.error('Error toggling pin like:', err);
    res.status(500).json({ error: 'Error al dar like' });
  }
});

module.exports = router;
