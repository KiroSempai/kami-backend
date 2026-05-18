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

    // Chapters completed
    const chaptersDone = await pool.query(
      `SELECT COUNT(*) AS count FROM user_tracking WHERE user_id = $1 AND action_type = 'chapter_read'`,
      [userId]
    );

    // Total reading time (minutes)
    const timeSpent = await pool.query(
      `SELECT COALESCE(SUM((metadata->>'minutes')::INTEGER), 0) AS total FROM user_tracking WHERE user_id = $1 AND action_type = 'chapter_read'`,
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
  // Get distinct reading days in descending order
  const days = await pool.query(
    `SELECT activity_date FROM user_daily_activity
     WHERE user_id = $1 ORDER BY activity_date DESC`,
    [userId]
  );

  if (days.rows.length === 0) return { current: 0, max: 0 };

  let current = 0;
  let max = 0;
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < days.rows.length; i++) {
    const d = new Date(days.rows[i].activity_date);
    if (i === 0) {
      // Check if streak includes today or yesterday
      const diff = Math.floor((today - d) / 86400000);
      if (diff > 1) break;
      streak = 1;
      if (diff === 0) current = 1;
    } else {
      const prev = new Date(days.rows[i - 1].activity_date);
      const diff = Math.floor((prev - d) / 86400000);
      if (diff === 1) {
        streak++;
        if (i === days.rows.length - 1) { current = streak; }
      } else {
        if (current === 0 && i > 1) current = streak;
        max = Math.max(max, streak);
        streak = 1;
      }
    }
  }
  max = Math.max(max, streak);
  if (current === 0) current = streak;

  return { current, max };
}

function calculateDaysSince(userId) {
  return 30; // approximate
}

function calculateChaptersPerDay(total, userId) {
  return total > 0 ? Math.round((total / 30) * 10) / 10 : 0;
}

module.exports = router;
