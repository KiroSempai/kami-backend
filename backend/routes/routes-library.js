// ═══════════════════════════════════════════════════════════════════════════════
// 📚 KAMI — routes-library.js
// Biblioteca personal del usuario: mangas en lista (leyendo, completado, etc.).
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');

const STATUS_MAP = {
  reading: 'Leyendo',
  continuing: 'Continuando',
  planned: 'Pendientes',
  favorite: 'Favoritos',
  completed: 'Terminados',
  dropped: 'Abandonados',
  rereading: 'Releyendo',
};

const STATUS_REVERSE = {
  leyendo: 'reading',
  continuando: 'continuing',
  pendientes: 'planned',
  favoritos: 'favorite',
  terminados: 'completed',
  abandonados: 'dropped',
  releyendo: 'rereading',
};

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = await verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

router.use(authMiddleware);

// GET /api/library - biblioteca agrupada por estado
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, m.title, m.cover, m.type, m.genres, m.total_chapters, m.rating
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.user_id = $1
       ORDER BY l.updated_at DESC`,
      [req.user.userId]
    );

    const grouped = {
      reading: [],
      continuing: [],
      planned: [],
      favorite: [],
      completed: [],
      dropped: [],
      rereading: [],
    };

    for (const row of result.rows) {
      const entry = formatEntry(row);
      grouped[row.status] = grouped[row.status] || [];
      grouped[row.status].push(entry);
    }

    res.json({
      library: grouped,
      total: result.rows.length,
    });
  } catch (err) {
    console.error('Error obteniendo biblioteca:', err);
    res.status(500).json({ error: 'Error al obtener biblioteca' });
  }
});

// POST /api/library/update - agregar o cambiar estado (UPSERT)
router.post('/update', async (req, res) => {
  try {
    const { manga_id, status } = req.body;
    if (!manga_id || !status) {
      return res.status(400).json({ error: 'manga_id y status son requeridos' });
    }

    const dbStatus = STATUS_REVERSE[status] || status;

    const validStatuses = ['reading', 'continuing', 'planned', 'favorite', 'completed', 'dropped', 'rereading'];
    if (!validStatuses.includes(dbStatus)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const existing = await pool.query(
      'SELECT id, status, is_favorite FROM user_manga_library WHERE user_id = $1 AND manga_id = $2',
      [req.user.userId, manga_id]
    );

    if (existing.rows.length > 0) {
      const oldStatus = existing.rows[0].status;
      await pool.query(
        `UPDATE user_manga_library SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2 AND manga_id = $3`,
        [dbStatus, req.user.userId, manga_id]
      );
      if (oldStatus !== dbStatus) {
        await pool.query(
          `INSERT INTO user_tracking (user_id, action_type, manga_id, metadata)
           VALUES ($1, 'library_status_change', $2, $3)`,
          [req.user.userId, manga_id, JSON.stringify({ from: oldStatus, to: dbStatus })]
        ).catch(() => {});
        try {
          await pool.query(
            `INSERT INTO activity_feed (user_id, action_type, manga_id, metadata)
             VALUES ($1, 'library_status_change', $2, $3)`,
            [req.user.userId, manga_id, JSON.stringify({ from: oldStatus, to: dbStatus })]
          );
        } catch {}
      }

      const updated = await pool.query(
        `SELECT l.*, m.title, m.cover, m.type, m.genres, m.total_chapters, m.rating
         FROM user_manga_library l
         JOIN mangas m ON m.id = l.manga_id
         WHERE l.user_id = $1 AND l.manga_id = $2`,
        [req.user.userId, manga_id]
      );

      return res.json({
        success: true,
        message: `Movido a ${STATUS_MAP[dbStatus] || dbStatus}`,
        manga: formatEntry(updated.rows[0]),
      });
    }

    const insertResult = await pool.query(
      `INSERT INTO user_manga_library (user_id, manga_id, status)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [req.user.userId, manga_id, dbStatus]
    );

    // Auto-track manga_started
    await pool.query(
      `INSERT INTO user_tracking (user_id, action_type, manga_id)
       SELECT $1, 'manga_started', $2
       WHERE NOT EXISTS (SELECT 1 FROM user_tracking WHERE user_id = $1 AND action_type = 'manga_started' AND manga_id = $2)`,
      [req.user.userId, manga_id]
    ).catch(() => {});

    try {
      await pool.query(
        `INSERT INTO activity_feed (user_id, action_type, manga_id, metadata)
         VALUES ($1, 'manga_started', $2, $3)`,
        [req.user.userId, manga_id, JSON.stringify({ status: dbStatus })]
      );
    } catch {}

    const newEntry = await pool.query(
      `SELECT l.*, m.title, m.cover, m.type, m.genres, m.total_chapters, m.rating
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.id = $1`,
      [insertResult.rows[0].id]
    );

    res.json({
      success: true,
      message: `Añadido a ${STATUS_MAP[dbStatus] || dbStatus}`,
      manga: formatEntry(newEntry.rows[0]),
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'El manga ya está en tu biblioteca' });
    }
    console.error('Error actualizando biblioteca:', err);
    res.status(500).json({ error: 'Error al actualizar biblioteca' });
  }
});

// GET /api/library/continue - top 5 para continuar leyendo
router.get('/continue', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, m.title, m.cover, m.type, m.genres, m.total_chapters, m.rating
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.user_id = $1 AND l.status IN ('reading', 'continuing', 'rereading')
       ORDER BY l.updated_at DESC
       LIMIT 5`,
      [req.user.userId]
    );

    res.json({
      continuing: result.rows.map(r => ({
        ...formatEntry(r),
        nextChapter: (r.progress || 0) + 1,
      })),
      total: result.rows.length,
    });
  } catch (err) {
    console.error('Error obteniendo continuación:', err);
    res.status(500).json({ error: 'Error al obtener continuación' });
  }
});

// PUT /api/library/:mangaId - actualizar progreso/puntuación
router.put('/:mangaId', async (req, res) => {
  try {
    const { mangaId } = req.params;
    const { progress, score, notes, status } = req.body;

    const updates = [];
    const values = [];
    let paramIdx = 1;

    if (progress !== undefined) {
      updates.push(`progress = $${paramIdx++}`);
      values.push(progress);
    }
    if (score !== undefined) {
      updates.push(`score = $${paramIdx++}`);
      values.push(score);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${paramIdx++}`);
      values.push(notes);
    }
    if (status) {
      const dbStatus = STATUS_REVERSE[status] || status;
      updates.push(`status = $${paramIdx++}`);
      values.push(dbStatus);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.user.userId, mangaId);

    const result = await pool.query(
      `UPDATE user_manga_library SET ${updates.join(', ')}
       WHERE user_id = $${paramIdx++} AND manga_id = $${paramIdx}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Manga no encontrado en tu biblioteca' });
    }

    const full = await pool.query(
      `SELECT l.*, m.title, m.cover, m.type, m.genres, m.total_chapters, m.rating
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.id = $1`,
      [result.rows[0].id]
    );

    res.json({
      success: true,
      message: 'Progreso guardado',
      manga: formatEntry(full.rows[0]),
    });
  } catch (err) {
    console.error('Error actualizando manga:', err);
    res.status(500).json({ error: 'Error al actualizar manga' });
  }
});

// POST /api/library/:mangaId/favorite - toggle favorito
router.post('/:mangaId/favorite', async (req, res) => {
  try {
    const { mangaId } = req.params;

    const result = await pool.query(
      `UPDATE user_manga_library
       SET is_favorite = NOT is_favorite, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND manga_id = $2
       RETURNING is_favorite`,
      [req.user.userId, mangaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Manga no encontrado en tu biblioteca' });
    }

    res.json({
      success: true,
      is_favorite: result.rows[0].is_favorite,
      message: result.rows[0].is_favorite ? 'Añadido a favoritos' : 'Eliminado de favoritos',
    });
  } catch (err) {
    console.error('Error toggling favorito:', err);
    res.status(500).json({ error: 'Error al cambiar favorito' });
  }
});

// DELETE /api/library/:mangaId - eliminar de biblioteca
router.delete('/:mangaId', async (req, res) => {
  try {
    const { mangaId } = req.params;
    const result = await pool.query(
      'DELETE FROM user_manga_library WHERE user_id = $1 AND manga_id = $2 RETURNING id',
      [req.user.userId, mangaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Manga no encontrado en tu biblioteca' });
    }

    // Resetear tracking de capítulos de este manga
    await pool.query(
      "DELETE FROM user_tracking WHERE user_id = $1 AND manga_id = $2 AND action_type = 'chapter_read'",
      [req.user.userId, mangaId]
    ).catch(() => {});

    await pool.query(
      `INSERT INTO user_tracking (user_id, action_type, manga_id, metadata)
       VALUES ($1, 'library_remove', $2, '{}')`,
      [req.user.userId, mangaId]
    ).catch(() => {});

    // Cascade: si borra el manga, sale de la comunidad asociada
    await pool.query(
      "DELETE FROM community_members WHERE user_id = $1 AND community_id IN (SELECT id FROM communities WHERE manga_id = $2)",
      [req.user.userId, mangaId]
    ).catch(() => {});

    res.json({ success: true, message: 'Eliminado de tu biblioteca' });
  } catch (err) {
    console.error('Error eliminando manga:', err);
    res.status(500).json({ error: 'Error al eliminar manga' });
  }
});

// GET /api/library/sync - cambios desde última sincronización
router.get('/sync', async (req, res) => {
  try {
    const { lastSync } = req.query;
    const since = lastSync ? new Date(lastSync) : new Date(0);

    const result = await pool.query(
      `SELECT l.*, m.title, m.cover
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.user_id = $1 AND l.updated_at > $2
       ORDER BY l.updated_at DESC`,
      [req.user.userId, since]
    );

    res.json({
      success: true,
      lastSync: new Date(),
      hasChanges: result.rows.length > 0,
      changes: result.rows.map(formatEntry),
      totalMangas: result.rows.length,
    });
  } catch (err) {
    console.error('Error sincronizando:', err);
    res.status(500).json({ error: 'Error al sincronizar' });
  }
});

// GET /api/library/check/:mangaId - obtener estado de un manga
router.get('/check/:mangaId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.status, l.is_favorite, l.score, l.progress,
              m.title, m.cover, m.total_chapters
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.user_id = $1 AND l.manga_id = $2`,
      [req.user.userId, req.params.mangaId]
    );

    if (result.rows.length === 0) {
      return res.json({ inLibrary: false });
    }

    res.json({
      inLibrary: true,
      ...result.rows[0],
    });
  } catch (err) {
    console.error('Error checking manga:', err);
    res.status(500).json({ error: 'Error al consultar manga' });
  }
});

function formatEntry(row) {
  return {
    id: row.id,
    mangaId: row.manga_id,
    title: row.title,
    cover: row.cover || '',
    type: row.type || '',
    genres: row.genres || [],
    totalChapters: row.total_chapters || 0,
    rating: row.rating || 0,
    status: row.status,
    isFavorite: row.is_favorite || false,
    score: row.score || 0,
    progress: row.progress || 0,
    notes: row.notes || '',
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

// 🚪 [GET] /api/library/:mangaId/progress — Progreso del usuario en un manga específico
// 👤 Permiso: auth
// 📤 Respuesta: { progress: number, status: string }
router.get('/:mangaId/progress', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ progress: 0, status: null });
    const decoded = require('../config').verifyToken(token);
    const r = await pool.query(
      'SELECT progress, status FROM user_manga_library WHERE user_id = $1 AND manga_id = $2',
      [decoded.userId, req.params.mangaId]
    );
    if (r.rows.length === 0) return res.json({ progress: 0, status: null });
    res.json({ progress: r.rows[0].progress || 0, status: r.rows[0].status });
  } catch (e) {
    res.json({ progress: 0, status: null });
  }
});

module.exports = router;
