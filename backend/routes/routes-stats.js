// ═══════════════════════════════════════════════════════════════════════════════
// 📈 KAMI — routes-stats.js
// Estadísticas de lectura: seguimiento de capítulos leídos, tiempo, progreso.
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

// POST /api/track — registrar acción (con dedup)
router.post('/', auth, async (req, res) => {
  try {
    const { action_type, manga_id, chapter_id, metadata } = req.body;
    if (!action_type) return res.status(400).json({ error: 'action_type requerido' });

    // Dedup check for chapter_read
    if (action_type === 'chapter_read' && chapter_id) {
      const existing = await pool.query(
        'SELECT id FROM user_tracking WHERE user_id = $1 AND action_type = $2 AND chapter_id = $3 AND manga_id = $4',
        [req.user.userId, 'chapter_read', chapter_id, manga_id]
      );
      if (existing.rows.length > 0) return res.json({ success: true, tracked: false, message: 'Ya registrado' });
    }

    // Dedup check for manga_started
    if (action_type === 'manga_started') {
      const existing = await pool.query(
        'SELECT id FROM user_tracking WHERE user_id = $1 AND action_type = $2 AND manga_id = $3',
        [req.user.userId, 'manga_started', manga_id]
      );
      if (existing.rows.length > 0) return res.json({ success: true, tracked: false, message: 'Ya registrado' });
    }

    // Dedup for daily_login (once per day)
    if (action_type === 'daily_login') {
      const today = new Date().toISOString().split('T')[0];
      const existing = await pool.query(
        'SELECT id FROM user_tracking WHERE user_id = $1 AND action_type = $2 AND created_at::date = $3',
        [req.user.userId, 'daily_login', today]
      );
      if (existing.rows.length > 0) return res.json({ success: true, tracked: false });
    }

    await pool.query(
      `INSERT INTO user_tracking (user_id, action_type, manga_id, chapter_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, action_type, manga_id || null, chapter_id || null, metadata ? JSON.stringify(metadata) : '{}']
    );

    // Log to activity feed for social
    if (['chapter_read', 'manga_started', 'manga_completed', 'rating', 'comment'].includes(action_type)) {
      try {
        await pool.query(
          `INSERT INTO activity_feed (user_id, action_type, manga_id, chapter_number, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.userId, action_type, manga_id || null, null, '{}']
        );
      } catch {}
    }

    // Log para future analysis
    console.log('[TRACK]', JSON.stringify({
      userId: req.user.userId,
      action_type,
      manga_id,
      chapter_id,
      metadata,
      time: new Date().toISOString(),
    }));

    // Update daily activity
    if (action_type === 'chapter_read') {
      await pool.query(
        `INSERT INTO user_daily_activity (user_id, activity_date, chapters_read)
         VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (user_id, activity_date) DO UPDATE SET chapters_read = user_daily_activity.chapters_read + 1`,
        [req.user.userId]
      );
    }

    res.json({ success: true, tracked: true });
  } catch (err) {
    console.error('Error en track:', err);
    res.status(500).json({ error: 'Error al registrar' });
  }
});

// GET /api/stats/:username — estadísticas completas del usuario
router.get('/:username', async (req, res) => {
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userId = userResult.rows[0].id;

    // Titles read (distinct manga in tracking + library)
    const titlesRead = await pool.query(
      `SELECT COUNT(DISTINCT manga_id) AS count FROM user_tracking WHERE user_id = $1 AND action_type = 'manga_started'`,
      [userId]
    );

    // Chapters completed (suma del progreso en biblioteca — no se duplica ni se infla)
    const chaptersDone = await pool.query(
      `SELECT COALESCE(SUM(progress), 0) AS count FROM user_manga_library WHERE user_id = $1`,
      [userId]
    );

    // Total reading time (minutos estimados desde progreso de biblioteca)
    const timeSpent = await pool.query(
      `SELECT COALESCE(SUM(progress * 5), 0) AS total FROM user_manga_library WHERE user_id = $1`,
      [userId]
    );

    // Streak
    const streak = await calculateStreak(userId);

    // Favorite genres from library
    const favGenres = await pool.query(
      `SELECT unnest(m.genres) AS genre, COUNT(*) AS count
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.user_id = $1 AND l.status IN ('reading', 'completed', 'rereading', 'favorite')
       GROUP BY genre ORDER BY count DESC LIMIT 6`,
      [userId]
    );

    // Top mangas by tracking (chapters read)
    const topMangas = await pool.query(
      `SELECT m.id, m.title, m.cover, m.genres, m.total_chapters, COUNT(*) AS chapters_read,
              COALESCE(SUM((t.metadata->>'minutes')::INTEGER), 0) AS total_minutes
       FROM user_tracking t
       JOIN mangas m ON m.id = t.manga_id
       WHERE t.user_id = $1 AND t.action_type = 'chapter_read' AND t.manga_id IS NOT NULL
       GROUP BY m.id, m.title, m.cover, m.genres, m.total_chapters
       ORDER BY total_minutes DESC LIMIT 5`,
      [userId]
    );

    // Weekly data (last 7 days)
    const weekly = await pool.query(
      `SELECT activity_date, chapters_read, minutes_read
       FROM user_daily_activity
       WHERE user_id = $1 AND activity_date >= CURRENT_DATE - 7
       ORDER BY activity_date ASC`,
      [userId]
    );

    // Reading days (for heatmap, last 365)
    const readingDays = await pool.query(
      `SELECT activity_date, chapters_read
       FROM user_daily_activity
       WHERE user_id = $1 AND activity_date >= CURRENT_DATE - 365
       ORDER BY activity_date ASC`,
      [userId]
    );

    // Monthly stats
    const mangasPerMonth = await pool.query(
      `SELECT COUNT(*) AS count FROM user_tracking
       WHERE user_id = $1 AND action_type = 'manga_started'
       AND created_at >= NOW() - INTERVAL '30 days'`,
      [userId]
    );

    let followersCount = 0, followingCount = 0;
    try {
      const followersResult = await pool.query(
        'SELECT COUNT(*) AS count FROM user_follows WHERE following_id = $1',
        [userId]
      );
      followersCount = parseInt(followersResult.rows[0].count);
      const followingResult = await pool.query(
        'SELECT COUNT(*) AS count FROM user_follows WHERE follower_id = $1',
        [userId]
      );
      followingCount = parseInt(followingResult.rows[0].count);
    } catch {} // Tabla user_follows aún no existe

    const totalMinutes = parseInt(timeSpent.rows[0].total) || 0;
    const hoursTotal = (totalMinutes / 60);
    const hoursPerWeek = hoursTotal > 0 ? (hoursTotal / (calculateDaysSince(userId) || 1) * 7) : 0;

    res.json({
      stats: {
        titlesRead: parseInt(titlesRead.rows[0].count) || 0,
        chaptersCompleted: parseInt(chaptersDone.rows[0].count) || 0,
        hoursRead: Math.round(hoursTotal * 10) / 10,
        hoursPerWeek: Math.round(hoursPerWeek * 10) / 10,
        chaptersPerDay: calculateChaptersPerDay(parseInt(chaptersDone.rows[0].count) || 0, userId),
        mangasPerMonth: parseInt(mangasPerMonth.rows[0].count) || 0,
        currentStreak: streak.current,
        maxStreak: streak.max,
        followers: followersCount,
        following: followingCount,
      },
      favoriteGenres: favGenres.rows.map(r => ({ name: r.genre, count: parseInt(r.count) })),
      topMangas: topMangas.rows.map(r => ({
        id: r.id, title: r.title, cover: r.cover, genres: r.genres,
        totalChapters: r.total_chapters, chaptersRead: parseInt(r.chapters_read),
        minutesRead: parseInt(r.total_minutes),
      })),
      weeklyData: weekly.rows.map(r => ({
        day: new Date(r.activity_date).toLocaleDateString('es-ES', { weekday: 'short' }),
        chapters: r.chapters_read,
      })),
      readingDays: readingDays.rows.map(r => ({
        date: r.activity_date,
        chapters: r.chapters_read,
      })),
    });
  } catch (err) {
    console.error('Error en stats:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

async function calculateStreak(userId) {
  const result = await pool.query(
    `SELECT DISTINCT activity_date FROM user_daily_activity
     WHERE user_id = $1 ORDER BY activity_date DESC`,
    [userId]
  );
  const days = result.rows.map(r => {
    const d = new Date(r.activity_date);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  if (days.length === 0) return { current: 0, max: 0 };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Racha actual: cuenta desde hoy hacia atrás
  let current = 0;
  const diffFirst = Math.round((today - days[0]) / 86400000);
  if (diffFirst <= 1) { // hoy o ayer
    current = 1;
    for (let i = 1; i < days.length; i++) {
      const diff = Math.round((days[i - 1] - days[i]) / 86400000);
      if (diff === 1) current++;
      else break;
    }
  }

  // Racha máxima: la secuencia más larga en todo el historial
  let max = current;
  let temp = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round((days[i - 1] - days[i]) / 86400000);
    if (diff === 1) {
      temp++;
      if (temp > max) max = temp;
    } else {
      temp = 1;
    }
  }

  return { current, max };
}

function calculateDaysSince(userId) {
  return 30; // approximate
}

function calculateChaptersPerDay(total, userId) {
  return total > 0 ? Math.round((total / 30) * 10) / 10 : 0;
}

// 🚪 [POST] /api/track (root — acciones genéricas)
// 👤 Permiso: auth
// 📥 Body: { action_type, manga_id?, chapter_id?, metadata? }
// 📝 Registra acciones genéricas (login, vista, rating, library) en user_tracking
//      Si es daily_login, también actualiza user_daily_activity para la racha
router.post('/', auth, async (req, res) => {
  const userId = req.user.userId;
  const { action_type, manga_id, chapter_id, metadata } = req.body;
  if (!action_type) return res.status(400).json({ error: 'action_type requerido' });
  try {
    await pool.query(
      `INSERT INTO user_tracking (user_id, manga_id, action_type, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, manga_id || null, action_type, JSON.stringify(metadata || {})]
    );
    // Si es un login diario, sumar a la racha en user_daily_activity
    if (action_type === 'daily_login') {
      await pool.query(
        `INSERT INTO user_daily_activity (user_id, activity_date, minutes_read, chapters_read)
         VALUES ($1, CURRENT_DATE, 0, 0)
         ON CONFLICT (user_id, activity_date) DO NOTHING`,
        [userId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[track] Error en acción genérica:', err.message);
    res.status(500).json({ error: 'Error al registrar acción' });
  }
});

// 🚪 [POST] /api/stats/track
// 👤 Permiso: auth
// 📥 Body: { manga_id, chapter_number, minutes?: number (default 5) }
// 📝 Registra lectura en cascada: user_tracking + user_manga_library + user_daily_activity
router.post('/track', auth, async (req, res) => {
  const userId = req.user.userId;
  const { manga_id, chapter_number, minutes = 5 } = req.body;

  if (!manga_id || !chapter_number) {
    return res.status(400).json({ error: 'Faltan manga_id o chapter_number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert en user_tracking
    await client.query(
      `INSERT INTO user_tracking (user_id, manga_id, action_type, metadata, created_at)
       VALUES ($1, $2, 'chapter_read', $3, NOW())`,
      [userId, manga_id, JSON.stringify({ minutes, chapter: chapter_number })]
    );

    // 2. Actualizar progreso en biblioteca (solo si el nuevo capítulo es mayor)
    await client.query(
      `UPDATE user_manga_library
       SET progress = $1, updated_at = NOW()
       WHERE user_id = $2 AND manga_id = $3 AND progress < $1`,
      [chapter_number, userId, manga_id]
    );

    // 3. UPSERT en user_daily_activity para heatmap
    await client.query(
      `INSERT INTO user_daily_activity (user_id, activity_date, minutes_read, chapters_read)
       VALUES ($1, CURRENT_DATE, $2, 1)
       ON CONFLICT (user_id, activity_date)
       DO UPDATE SET
         minutes_read = user_daily_activity.minutes_read + $2,
         chapters_read = user_daily_activity.chapters_read + 1`,
      [userId, minutes]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `Capítulo ${chapter_number} trackeado.` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[track] Error:', err.message);
    res.status(500).json({ error: 'Error al trackear lectura' });
  } finally {
    client.release();
  }
});

// 🚪 [POST] /api/stats/reset — Reinicia tracking de capítulos del usuario actual
// 👤 Permiso: auth
// 📝 Elimina todos los chapter_read del usuario y resetea el progreso en biblioteca
router.post('/reset', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    await pool.query(
      "DELETE FROM user_tracking WHERE user_id = $1 AND action_type = 'chapter_read'",
      [userId]
    );
    await pool.query(
      "DELETE FROM user_daily_activity WHERE user_id = $1",
      [userId]
    );
    res.json({ success: true, message: 'Tracking de capítulos reiniciado' });
  } catch (err) {
    console.error('[reset] Error:', err.message);
    res.status(500).json({ error: 'Error al reiniciar tracking' });
  }
});

// 🚪 [GET] /api/stats/history/:userId — Historial de actividad del usuario
// 👤 Permiso: público
// 📤 Respuesta: { entries: [{ id, manga_id, action_type, metadata, created_at, manga_title, manga_cover }] }
// 📝 Últimas 50 acciones del usuario (lecturas, cambios de estado, ratings)
router.get('/history/:userId', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT ut.id, ut.manga_id, ut.chapter_id, ut.action_type, ut.metadata, ut.created_at,
             m.title AS manga_title, m.cover AS manga_cover
      FROM user_tracking ut
      LEFT JOIN mangas m ON m.id = ut.manga_id
      WHERE ut.user_id = $1
      ORDER BY ut.created_at DESC
      LIMIT 50
    `, [req.params.userId]);
    res.json({ entries: r.rows });
  } catch (err) {
    console.error('[history] Error:', err.message);
    res.status(500).json({ error: 'Error al cargar historial' });
  }
});

module.exports = router;
