const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');
const getRole = require('../getRole');

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = await verifyToken(token); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

async function optionalAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) req.user = await verifyToken(token);
  } catch {}
  next();
}

// GET /api/social/:username/profile
router.get('/:username/profile', optionalAuth, async (req, res) => {
  try {
    const { username } = req.params;

    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userResult.rows[0];
    const role = getRole(user);

    let followersCount = 0, followingCount = 0, isFollowing = false;
    try {
      const followersResult = await pool.query(
        'SELECT COUNT(*) AS count FROM user_follows WHERE following_id = $1',
        [user.id]
      );
      followersCount = parseInt(followersResult.rows[0].count);
      const followingResult = await pool.query(
        'SELECT COUNT(*) AS count FROM user_follows WHERE follower_id = $1',
        [user.id]
      );
      followingCount = parseInt(followingResult.rows[0].count);

      if (req.user) {
        const followCheck = await pool.query(
          'SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = $2',
          [req.user.userId, user.id]
        );
        isFollowing = followCheck.rows.length > 0;
      }
    } catch {
      // Tabla user_follows aún no existe
    }

    const isFriend = req.user ? (
      await pool.query(
        `SELECT 1 FROM user_friends WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)) AND status = 'accepted'`,
        [req.user.userId, user.id]
      )
    ).rows.length > 0 : false;

    res.json({
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        banner: user.banner,
        bio: user.bio || '',
        country: user.country || '',
        favoriteGenres: user.favorite_genres || [],
        emoji: user.emoji || '',
        createdAt: user.created_at,
        role: role,
        isVerified: user.company_verified || false,
        isPremium: user.premium_expires_at && new Date(user.premium_expires_at) > new Date(),
      },
      counts: {
        followers: followersCount,
        following: followingCount,
        titlesRead: 0,
        chaptersCompleted: 0,
      },
      isFollowing,
      isFriend,
      canEdit: req.user?.userId === user.id,
    });
  } catch (err) {
    console.error('[social] Error en profile:', err);
    res.status(500).json({ error: 'Error al obtener perfil social' });
  }
});

// GET /api/social/:username/library
router.get('/:username/library', async (req, res) => {
  try {
    const { username } = req.params;
    const { state } = req.query;

    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userId = userResult.rows[0].id;

    let query = `SELECT l.status, l.score, l.progress, l.is_favorite, l.updated_at,
                        m.id AS manga_id, m.title, m.cover, m.type, m.genres, m.total_chapters, m.rating
                 FROM user_manga_library l
                 JOIN mangas m ON m.id = l.manga_id
                 WHERE l.user_id = $1`;
    const params = [userId];

    if (state) {
      const stateMap = {
        leyendo: 'reading', continuando: 'continuing', pendientes: 'planned',
        favoritos: 'favorite', terminados: 'completed', abandonados: 'dropped', releyendo: 'rereading',
      };
      query += ' AND l.status = $2';
      params.push(stateMap[state] || state);
    }

    query += ' ORDER BY l.updated_at DESC';
    const result = await pool.query(query, params);

    res.json({
      username,
      totalMangas: result.rows.length,
      mangas: result.rows.map(r => ({
        mangaId: r.manga_id,
        title: r.title,
        cover: r.cover,
        type: r.type,
        genres: r.genres,
        totalChapters: r.total_chapters,
        rating: r.rating,
        status: r.status,
        score: r.score,
        progress: r.progress,
        isFavorite: r.is_favorite,
        lastReadAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('[social] Error en library:', err);
    res.status(500).json({ error: 'Error al obtener biblioteca' });
  }
});

// GET /api/social/:username/stats
router.get('/:username/stats', async (req, res) => {
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userId = userResult.rows[0].id;

    const titlesRead = await pool.query(
      `SELECT COUNT(DISTINCT manga_id) AS count FROM user_tracking WHERE user_id = $1 AND action_type = 'manga_started'`,
      [userId]
    );

    const chaptersDone = await pool.query(
      `SELECT COUNT(*) AS count FROM user_tracking WHERE user_id = $1 AND action_type = 'chapter_read'`,
      [userId]
    );

    const timeSpent = await pool.query(
      `SELECT COALESCE(SUM((metadata->>'minutes')::INTEGER), 0) AS total FROM user_tracking WHERE user_id = $1 AND action_type = 'chapter_read'`,
      [userId]
    );

    const streak = await calculateStreak(userId);

    const favGenres = await pool.query(
      `SELECT unnest(m.genres) AS genre, COUNT(*) AS count
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.user_id = $1 AND l.status IN ('reading', 'completed', 'rereading', 'favorite')
       GROUP BY genre ORDER BY count DESC LIMIT 6`,
      [userId]
    );

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

    const weekly = await pool.query(
      `SELECT activity_date, chapters_read
       FROM user_daily_activity
       WHERE user_id = $1 AND activity_date >= CURRENT_DATE - 7
       ORDER BY activity_date ASC`,
      [userId]
    );

    const readingDays = await pool.query(
      `SELECT activity_date, chapters_read
       FROM user_daily_activity
       WHERE user_id = $1 AND activity_date >= CURRENT_DATE - 365
       ORDER BY activity_date ASC`,
      [userId]
    );

    const mangasPerMonth = await pool.query(
      `SELECT COUNT(*) AS count FROM user_tracking
       WHERE user_id = $1 AND action_type = 'manga_started'
       AND created_at >= NOW() - INTERVAL '30 days'`,
      [userId]
    );

    const totalMinutes = parseInt(timeSpent.rows[0].total) || 0;
    const hoursTotal = (totalMinutes / 60);
    const hoursPerWeek = hoursTotal > 0 ? (hoursTotal / 30 * 7) : 0;

    res.json({
      stats: {
        titlesRead: parseInt(titlesRead.rows[0].count) || 0,
        chaptersCompleted: parseInt(chaptersDone.rows[0].count) || 0,
        hoursRead: Math.round(hoursTotal * 10) / 10,
        hoursPerWeek: Math.round(hoursPerWeek * 10) / 10,
        chaptersPerDay: Math.round((parseInt(chaptersDone.rows[0].count) || 0) / 30 * 10) / 10,
        mangasPerMonth: parseInt(mangasPerMonth.rows[0].count) || 0,
        currentStreak: streak.current,
        maxStreak: streak.max,
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
    console.error('[social] Error en stats:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

async function calculateStreak(userId) {
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

// GET /api/social/:username/activity
router.get('/:username/activity', async (req, res) => {
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userId = userResult.rows[0].id;

    const { limit = 20, offset = 0 } = req.query;

    const activity = await pool.query(
      `SELECT a.*, m.title AS manga_title, m.cover AS manga_cover
       FROM activity_feed a
       LEFT JOIN mangas m ON m.id = a.manga_id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) AS count FROM activity_feed WHERE user_id = $1',
      [userId]
    );

    res.json({
      activity: activity.rows.map(a => ({
        id: a.id,
        actionType: a.action_type,
        mangaId: a.manga_id,
        mangaTitle: a.manga_title,
        mangaCover: a.manga_cover,
        chapterNumber: a.chapter_number,
        metadata: a.metadata,
        createdAt: a.created_at,
      })),
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    console.error('[social] Error en activity:', err);
    res.status(500).json({ error: 'Error al obtener actividad' });
  }
});

// POST /api/social/activity — registrar acción pública
router.post('/activity', auth, async (req, res) => {
  try {
    const { action_type, manga_id, chapter_number, metadata } = req.body;
    if (!action_type) return res.status(400).json({ error: 'action_type requerido' });

    await pool.query(
      `INSERT INTO activity_feed (user_id, action_type, manga_id, chapter_number, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, action_type, manga_id || null, chapter_number || null, metadata ? JSON.stringify(metadata) : '{}']
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[social] Error registrando actividad:', err);
    res.status(500).json({ error: 'Error al registrar actividad' });
  }
});

// POST /api/social/follow — Toggle follow/unfollow
router.post('/follow', auth, async (req, res) => {
  try {
    const followerId = req.user.userId;
    const { following_id } = req.body;
    if (!following_id) return res.status(400).json({ error: 'following_id requerido' });
    if (followerId === following_id) return res.status(400).json({ error: 'No puedes seguirte a ti mismo' });

    const target = await pool.query('SELECT id, username FROM users WHERE id = $1', [following_id]);
    if (!target.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const existing = await pool.query(
      'SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, following_id]
    );

    if (existing.rows.length > 0) {
      // Ya lo sigue → Unfollow
      await pool.query('DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2', [followerId, following_id]);
      // Limpiar notificación fantasma
      await pool.query(
        `DELETE FROM feed_notifications WHERE actor_id = $1 AND user_id = $2 AND notification_type = 'follow'`,
        [followerId, following_id]
      );
      return res.json({ success: true, following: false, message: 'Dejaste de seguir a ' + target.rows[0].username });
    } else {
      // No lo sigue → Follow
      await pool.query(
        'INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)',
        [followerId, following_id]
      );
      // Notificar al usuario seguido
      await pool.query(
        `INSERT INTO feed_notifications (user_id, actor_id, post_id, notification_type)
         VALUES ($1, $2, NULL, 'follow')
         ON CONFLICT DO NOTHING`,
        [following_id, followerId]
      );
      return res.json({ success: true, following: true, message: 'Ahora sigues a ' + target.rows[0].username });
    }
  } catch (err) {
    console.error('[social] Error en follow:', err);
    res.status(500).json({ error: 'Error al procesar follow' });
  }
});

// DELETE /api/social/follow/:userId
router.delete('/follow/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2 RETURNING id',
      [req.user.userId, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No seguías a este usuario' });
    res.json({ success: true, message: 'Dejaste de seguir al usuario' });
  } catch (err) {
    console.error('[social] Error en unfollow:', err);
    res.status(500).json({ error: 'Error al dejar de seguir' });
  }
});

// GET /api/social/:username/followers
router.get('/:username/followers', async (req, res) => {
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userId = userResult.rows[0].id;

    const followers = await pool.query(
      `SELECT u.id, u.username, u.avatar, u.bio, u.favorite_genres, f.created_at AS followed_at
       FROM user_follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = $1
       ORDER BY f.created_at DESC`,
      [userId]
    );

    res.json({
      username: req.params.username,
      followers: followers.rows.map(r => ({
        id: r.id,
        username: r.username,
        avatar: r.avatar,
        bio: r.bio,
        favoriteGenres: r.favorite_genres,
        followedAt: r.followed_at,
      })),
      total: followers.rows.length,
    });
  } catch (err) {
    console.error('[social] Error en followers:', err);
    res.status(500).json({ error: 'Error al obtener seguidores' });
  }
});

// GET /api/social/:username/following
router.get('/:username/following', async (req, res) => {
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userId = userResult.rows[0].id;

    const following = await pool.query(
      `SELECT u.id, u.username, u.avatar, u.bio, u.favorite_genres, f.created_at AS followed_at
       FROM user_follows f
       JOIN users u ON u.id = f.following_id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC`,
      [userId]
    );

    res.json({
      username: req.params.username,
      following: following.rows.map(r => ({
        id: r.id,
        username: r.username,
        avatar: r.avatar,
        bio: r.bio,
        favoriteGenres: r.favorite_genres,
        followedAt: r.followed_at,
      })),
      total: following.rows.length,
    });
  } catch (err) {
    console.error('[social] Error en following:', err);
    res.status(500).json({ error: 'Error al obtener seguidos' });
  }
});

// GET /api/social/suggestions — recomendaciones de usuarios
router.get('/suggestions', optionalAuth, async (req, res) => {
  try {
    if (!req.user) return res.json({ suggestions: [] });

    const userId = req.user.userId;

    // Get current user's favorite genres
    const myGenres = await pool.query(
      `SELECT DISTINCT unnest(m.genres) AS genre
       FROM user_manga_library l
       JOIN mangas m ON m.id = l.manga_id
       WHERE l.user_id = $1 AND l.is_favorite = true`,
      [userId]
    );

    if (myGenres.rows.length === 0) {
      return res.json({ suggestions: [] });
    }

    const genreList = myGenres.rows.map(r => r.genre);
    const placeholders = genreList.map((_, i) => '$' + (i + 3)).join(', ');

    // Find users with similar genre tastes, excluding self and already-followed
    const suggestions = await pool.query(
      `SELECT u.id, u.username, u.avatar, u.bio, u.favorite_genres,
              COUNT(*) AS common_genres
       FROM users u
       JOIN user_manga_library l ON l.user_id = u.id
       JOIN mangas m ON m.id = l.manga_id
       WHERE u.id != $1
         AND u.is_banned = false
         AND NOT EXISTS (SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = u.id)
         AND m.genres && $2::text[]
       GROUP BY u.id, u.username, u.avatar, u.bio, u.favorite_genres
       ORDER BY common_genres DESC
       LIMIT 10`,
      [userId, genreList]
    );

    res.json({
      suggestions: suggestions.rows.map(r => ({
        id: r.id,
        username: r.username,
        avatar: r.avatar,
        bio: r.bio,
        favoriteGenres: r.favorite_genres,
        commonGenres: parseInt(r.common_genres),
      })),
    });
  } catch (err) {
    console.error('[social] Error en suggestions:', err);
    res.status(500).json({ error: 'Error al obtener sugerencias' });
  }
});

// GET /api/social/feed — feed de actividad de amigos y seguidos
router.get('/feed', auth, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const feed = await pool.query(
      `SELECT a.*, u.username, u.avatar, m.title AS manga_title, m.cover AS manga_cover
       FROM activity_feed a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN mangas m ON m.id = a.manga_id
       WHERE a.user_id IN (
           SELECT following_id FROM user_follows WHERE follower_id = $1
           UNION
           SELECT friend_id FROM user_friends WHERE user_id = $1 AND status = 'accepted'
           UNION
           SELECT user_id FROM user_friends WHERE friend_id = $1 AND status = 'accepted'
       )
       ORDER BY a.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.userId, parseInt(limit), parseInt(offset)]
    );

    res.json({
      feed: feed.rows.map(a => ({
        id: a.id,
        userId: a.user_id,
        username: a.username,
        userAvatar: a.avatar,
        actionType: a.action_type,
        mangaId: a.manga_id,
        mangaTitle: a.manga_title,
        mangaCover: a.manga_cover,
        chapterNumber: a.chapter_number,
        metadata: a.metadata,
        createdAt: a.created_at,
      })),
    });
  } catch (err) {
    console.error('[social] Error en feed:', err);
    res.status(500).json({ error: 'Error al obtener feed' });
  }
});

module.exports = router;
