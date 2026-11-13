// ═══════════════════════════════════════════════════════════════════════════════
// 📌 KAMI — routes-story-pins.js
// "Story Pins": posts destacados temporales en el perfil del usuario.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');
const { requireAuth, requireNotBanned } = require('../middleware/auth');

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

// Reglas comunes de los StoryPins
const EMOJIS = ['💀', '😭', '🔥', '❤️', '😂', '😮', '👀', '✨'];
const VIS = ['public', 'friends', 'private'];
const clamp01 = v => Math.max(0, Math.min(1, Number(v)));
const cleanMsg = m => String(m == null ? '' : m).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

// POST /api/story-pins — crear un pin
router.post('/', requireAuth, requireNotBanned, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { mangaId, chapterNumber, pageIndex, x, y } = req.body || {};
    const message = cleanMsg(req.body?.message);
    const emoji = EMOJIS.includes(req.body?.emoji) ? req.body.emoji : null;
    const visibility = VIS.includes(req.body?.visibility) ? req.body.visibility : 'public';
    const ch = parseInt(chapterNumber, 10), pg = parseInt(pageIndex, 10);
    if (!mangaId || !Number.isFinite(ch) || !Number.isFinite(pg) || pg < 0 || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      return res.status(400).json({ error: 'Faltan datos del pin.' });
    }
    if (!message && !emoji) return res.status(400).json({ error: 'Escribe un mensaje o elige una reacción.' });
    if (message.length > 180) return res.status(400).json({ error: 'El mensaje puede tener 180 caracteres como máximo.' });

    // Freno al spam: 20 pines cada 10 minutos por cuenta
    const recent = await pool.query("SELECT COUNT(*)::int AS n FROM story_pins WHERE user_id = $1 AND created_at > NOW() - INTERVAL '10 minutes'", [userId]);
    if (recent.rows[0].n >= 20) return res.status(429).json({ error: 'Has dejado muchos pines seguidos. Espera unos minutos.' });

    const result = await pool.query(
      `INSERT INTO story_pins (user_id, manga_id, chapter_number, page_index, x, y, message, visibility, emoji)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, x, y, message, visibility, emoji, likes, created_at`,
      [userId, String(mangaId).slice(0, 64), ch, pg, clamp01(x), clamp01(y), message, visibility, emoji]
    );
    const u = await pool.query('SELECT username, avatar FROM users WHERE id = $1', [userId]);
    res.status(201).json({ success: true, pin: { ...result.rows[0], user_id: userId, username: u.rows[0]?.username || 'Anónimo', avatar: u.rows[0]?.avatar || '', liked_by_me: false } });
  } catch (err) {
    console.error('[story-pins] crear:', err.message);
    res.status(500).json({ error: 'No se pudo crear el pin.' });
  }
});

// PUT /api/story-pins/:id — editar el mensaje (solo quien lo creó)
router.put('/:id', requireAuth, requireNotBanned, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const message = req.body?.message !== undefined ? cleanMsg(req.body.message) : null;
    const visibility = VIS.includes(req.body?.visibility) ? req.body.visibility : null;
    if (message !== null && message.length > 180) return res.status(400).json({ error: 'El mensaje puede tener 180 caracteres como máximo.' });
    const result = await pool.query(
      `UPDATE story_pins SET message = COALESCE($1, message), visibility = COALESCE($2, visibility)
       WHERE id = $3 AND user_id = $4 AND deleted_at IS NULL AND (COALESCE($1, message) <> '' OR emoji IS NOT NULL)
       RETURNING id, message, visibility, emoji, likes`,
      [message, visibility, id, req.user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No puedes editar este pin (o se quedaría vacío).' });
    res.json({ success: true, pin: result.rows[0] });
  } catch (err) {
    console.error('[story-pins] editar:', err.message);
    res.status(500).json({ error: 'No se pudo editar el pin.' });
  }
});

// DELETE /api/story-pins/:id — borrado suave (quien lo creó o administración)
router.delete('/:id', requireAuth, requireNotBanned, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const admin = ['admin', 'moderator'].includes(req.user.role);
    const result = await pool.query(
      admin
        ? 'UPDATE story_pins SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL RETURNING id'
        : 'UPDATE story_pins SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id',
      admin ? [id] : [id, req.user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No puedes borrar este pin.' });
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('[story-pins] borrar:', err.message);
    res.status(500).json({ error: 'No se pudo borrar el pin.' });
  }
});

// POST /api/story-pins/:id/like — dar o quitar «me gusta»
router.post('/:id/like', requireAuth, requireNotBanned, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.userId, pinId = parseInt(req.params.id, 10);
    await client.query('BEGIN');
    const pin = await client.query('SELECT id FROM story_pins WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [pinId]);
    if (!pin.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Este pin ya no existe.' }); }
    const del = await client.query('DELETE FROM pin_likes WHERE pin_id = $1 AND user_id = $2 RETURNING pin_id', [pinId, userId]);
    let liked = false;
    if (!del.rows.length) { await client.query('INSERT INTO pin_likes (pin_id, user_id) VALUES ($1, $2)', [pinId, userId]); liked = true; }
    const r = await client.query('UPDATE story_pins SET likes = (SELECT COUNT(*) FROM pin_likes WHERE pin_id = $1) WHERE id = $1 RETURNING likes', [pinId]);
    await client.query('COMMIT');
    res.json({ success: true, liked, likes: r.rows[0].likes });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[story-pins] me gusta:', err.message);
    res.status(500).json({ error: 'No se pudo dar me gusta.' });
  } finally { client.release(); }
});

module.exports = router;
