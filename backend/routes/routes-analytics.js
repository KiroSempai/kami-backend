const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const getRole = require('../getRole');
const { verifyToken } = require('../config');

const ADMIN_ROLES = ['admin'];

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = await verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

async function requireAdmin(req, res, next) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  const role = getRole(r.rows[0]);
  if (!ADMIN_ROLES.includes(role)) return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// ── TAB 1: GENERAL ──
router.get('/general', auth, requireAdmin, async (req, res) => {
  try {
    const days = 30;
    const totalUsers = await pool.query('SELECT COUNT(*) AS c FROM users');
    const activeToday = await pool.query("SELECT COUNT(DISTINCT user_id) AS c FROM user_daily_activity WHERE activity_date = CURRENT_DATE");
    const newToday = await pool.query("SELECT COUNT(*) AS c FROM users WHERE created_at::date = CURRENT_DATE");
    const premium = await pool.query("SELECT COUNT(*) AS c FROM users WHERE premium_expires_at > NOW()");
    const totalActions = await pool.query('SELECT COUNT(*) AS c FROM user_tracking');
    const actionsToday = await pool.query("SELECT COUNT(*) AS c FROM user_tracking WHERE created_at::date = CURRENT_DATE");
    const totalChapters = await pool.query("SELECT COUNT(*) AS c FROM user_tracking WHERE action_type = 'chapter_read'");
    const dau = await pool.query("SELECT COUNT(DISTINCT user_id) AS c FROM user_tracking WHERE created_at::date = CURRENT_DATE");
    const wau = await pool.query("SELECT COUNT(DISTINCT user_id) AS c FROM user_tracking WHERE created_at >= CURRENT_DATE - 7");
    const mau = await pool.query("SELECT COUNT(DISTINCT user_id) AS c FROM user_tracking WHERE created_at >= CURRENT_DATE - 30");

    // Datos reales: actividad diaria (últimos 30 días)
    const dailyActivity = await pool.query(`
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM user_tracking WHERE created_at >= CURRENT_DATE - $1
      GROUP BY DATE(created_at) ORDER BY date
    `, [days]);

    // Datos reales: registros diarios (últimos 30 días)
    const dailyRegs = await pool.query(`
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM users WHERE created_at >= CURRENT_DATE - $1
      GROUP BY DATE(created_at) ORDER BY date
    `, [days]);

    // Datos reales: roles desde la vista user_with_role
    const roles = await pool.query(`
      SELECT role, COUNT(*) AS count FROM user_with_role GROUP BY role
    `);

    res.json({
      totalUsers: parseInt(totalUsers.rows[0].c) || 0,
      activeToday: parseInt(activeToday.rows[0].c) || 0,
      newToday: parseInt(newToday.rows[0].c) || 0,
      premium: parseInt(premium.rows[0].c) || 0,
      totalActions: parseInt(totalActions.rows[0].c) || 0,
      actionsToday: parseInt(actionsToday.rows[0].c) || 0,
      totalChapters: parseInt(totalChapters.rows[0].c) || 0,
      dau: parseInt(dau.rows[0].c) || 0,
      wau: parseInt(wau.rows[0].c) || 0,
      mau: parseInt(mau.rows[0].c) || 0,
      dailyActivity: dailyActivity.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
      dailyRegistrations: dailyRegs.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
      roles: roles.rows.map(r => ({ role: r.role, count: parseInt(r.count) })),
    });
  } catch (err) {
    console.error('[analytics] Error en general:', err);
    res.status(500).json({ error: 'Error al obtener datos generales' });
  }
});

// ── TAB 2: PATRONES GLOBALES ──
router.get('/global-patterns', auth, requireAdmin, async (req, res) => {
  try {
    const avgChaptersPerDay = await pool.query("SELECT COALESCE(AVG(chapters_read),0) AS avg FROM user_daily_activity WHERE activity_date >= CURRENT_DATE - 30");
    const topGenres = await pool.query(`
      SELECT unnest(m.genres) AS genre, COUNT(*) AS count
      FROM user_manga_library l JOIN mangas m ON m.id = l.manga_id
      GROUP BY genre ORDER BY count DESC LIMIT 6
    `);
    const topMangasByTime = await pool.query(`
      SELECT m.id, m.title, m.cover, SUM((t.metadata->>'minutes')::INTEGER) AS total_minutes,
             COUNT(*) AS total_reads, m.rating
      FROM user_tracking t JOIN mangas m ON m.id = t.manga_id
      WHERE t.action_type = 'chapter_read' AND t.manga_id IS NOT NULL
      GROUP BY m.id, m.title, m.cover, m.rating
      ORDER BY total_minutes DESC LIMIT 10
    `);
    const topMangasByReads = await pool.query(`
      SELECT m.id, m.title, COUNT(*) AS reads
      FROM user_tracking t JOIN mangas m ON m.id = t.manga_id
      WHERE t.action_type = 'chapter_read' AND t.manga_id IS NOT NULL
      GROUP BY m.id, m.title ORDER BY reads DESC LIMIT 10
    `);
    const topRated = await pool.query('SELECT id, title, rating, total_ratings FROM mangas WHERE total_ratings > 0 ORDER BY rating DESC LIMIT 10');
    const ratingDist = await pool.query('SELECT rating, COUNT(*) AS count FROM user_ratings GROUP BY rating ORDER BY rating');
    const hourActivity = await pool.query("SELECT EXTRACT(HOUR FROM created_at) AS hour, COUNT(*) AS count FROM user_tracking WHERE action_type = 'chapter_read' GROUP BY hour ORDER BY hour");
    const typeDistribution = await pool.query("SELECT action_type, COUNT(*) AS count FROM user_tracking GROUP BY action_type ORDER BY count DESC");
    const favType = await pool.query(`
      SELECT m.type, COUNT(*) AS count
      FROM user_manga_library l JOIN mangas m ON m.id = l.manga_id
      GROUP BY m.type ORDER BY count DESC
    `);

    res.json({
      avgChaptersPerDay: parseFloat(avgChaptersPerDay.rows[0].avg.toFixed(1)) || 0,
      topGenres: topGenres.rows.map(r => ({ name: r.genre, count: parseInt(r.count) })),
      topMangasByTime: topMangasByTime.rows.map(r => ({ id: r.id, title: r.title, cover: r.cover, totalMinutes: parseInt(r.total_minutes) || 0, totalReads: parseInt(r.total_reads) || 0, rating: parseFloat(r.rating) || 0 })),
      topMangasByReads: topMangasByReads.rows.map(r => ({ id: r.id, title: r.title, reads: parseInt(r.reads) })),
      topRated: topRated.rows.map(r => ({ id: r.id, title: r.title, rating: parseFloat(r.rating), totalRatings: parseInt(r.total_ratings) })),
      ratingDistribution: ratingDist.rows.map(r => ({ rating: parseFloat(r.rating), count: parseInt(r.count) })),
      hourActivity: hourActivity.rows.map(r => ({ hour: parseInt(r.hour), count: parseInt(r.count) })),
      typeDistribution: typeDistribution.rows.map(r => ({ actionType: r.action_type, count: parseInt(r.count) })),
      favoriteType: favType.rows.map(r => ({ type: r.type, count: parseInt(r.count) })),
    });
  } catch (err) {
    console.error('[analytics] Error en global-patterns:', err);
    res.status(500).json({ error: 'Error al obtener patrones globales' });
  }
});

// ── TAB 3: CRECIMIENTO DE USUARIOS ──
router.get('/user-growth', auth, requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const dailyRegs = await pool.query(`
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM users WHERE created_at >= CURRENT_DATE - $1
      GROUP BY DATE(created_at) ORDER BY date
    `, [days]);
    const dauData = await pool.query(`
      SELECT activity_date AS date, COUNT(DISTINCT user_id) AS count
      FROM user_daily_activity WHERE activity_date >= CURRENT_DATE - $1
      GROUP BY activity_date ORDER BY date
    `, [days]);
    const regSource = await pool.query("SELECT CASE WHEN google_id IS NOT NULL THEN 'google' ELSE 'email' END AS source, COUNT(*) AS count FROM users GROUP BY source");
    const totalUsers = await pool.query('SELECT COUNT(*) AS c FROM users');
    const inactive = await pool.query("SELECT COUNT(*) AS c FROM users WHERE id NOT IN (SELECT DISTINCT user_id FROM user_tracking WHERE created_at >= CURRENT_DATE - 30)");

    res.json({
      dailyRegistrations: dailyRegs.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
      dailyActiveUsers: dauData.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
      registrationSource: regSource.rows.map(r => ({ source: r.source, count: parseInt(r.count) })),
      totalUsers: parseInt(totalUsers.rows[0].c) || 0,
      inactiveUsers: parseInt(inactive.rows[0].c) || 0,
    });
  } catch (err) {
    console.error('[analytics] Error en user-growth:', err);
    res.status(500).json({ error: 'Error al obtener crecimiento' });
  }
});

// ── TAB 4: NEGOCIO & DINERO ──
router.get('/business', auth, requireAdmin, async (req, res) => {
  try {
    const premiumCount = await pool.query("SELECT COUNT(*) AS c FROM users WHERE premium_expires_at > NOW()");
    const byTier = await pool.query("SELECT subscription_tier, COUNT(*) AS count FROM users WHERE premium_expires_at > NOW() GROUP BY subscription_tier");
    const expiringSoon = await pool.query("SELECT COUNT(*) AS c FROM users WHERE premium_expires_at BETWEEN NOW() AND NOW() + INTERVAL '30 days'");
    const topEngagement = await pool.query(`
      SELECT m.id, m.title, m.cover, COUNT(*) AS interactions,
             COALESCE(SUM((t.metadata->>'minutes')::INTEGER), 0) AS total_minutes
      FROM user_tracking t JOIN mangas m ON m.id = t.manga_id
      WHERE t.action_type = 'chapter_read' AND t.manga_id IS NOT NULL
      GROUP BY m.id, m.title, m.cover ORDER BY interactions DESC LIMIT 10
    `);
    const mostAdded = await pool.query(`
      SELECT m.id, m.title, COUNT(*) AS adds
      FROM user_manga_library l JOIN mangas m ON m.id = l.manga_id
      GROUP BY m.id, m.title ORDER BY adds DESC LIMIT 10
    `);
    const mostViewed = await pool.query(`
      SELECT m.id, m.title, COUNT(*) AS views
      FROM manga_views v JOIN mangas m ON m.id = v.manga_id
      GROUP BY m.id, m.title ORDER BY views DESC LIMIT 10
    `);

    const total = parseInt(premiumCount.rows[0].c) || 0;
    const totalUsersQ = await pool.query('SELECT COUNT(*) AS c FROM users');
    const totalUsers = parseInt(totalUsersQ.rows[0].c) || 1;

    res.json({
      premiumTotal: total,
      premiumByTier: byTier.rows.map(r => ({ tier: r.subscription_tier || 'unknown', count: parseInt(r.count) })),
      premiumConversion: parseFloat(((total / totalUsers) * 100).toFixed(2)),
      expiringSoon: parseInt(expiringSoon.rows[0].c) || 0,
      topEngagement: topEngagement.rows.map(r => ({ id: r.id, title: r.title, cover: r.cover, interactions: parseInt(r.interactions), totalMinutes: parseInt(r.total_minutes) })),
      mostAddedToLibrary: mostAdded.rows.map(r => ({ id: r.id, title: r.title, adds: parseInt(r.adds) })),
      mostViewed: mostViewed.rows.map(r => ({ id: r.id, title: r.title, views: parseInt(r.views) })),
    });
  } catch (err) {
    console.error('[analytics] Error en business:', err);
    res.status(500).json({ error: 'Error al obtener datos de negocio' });
  }
});

// ── TAB 5: CRECIMIENTO PREMIUM (mensual) ──
router.get('/premium-growth', auth, requireAdmin, async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const growth = await pool.query(`
      SELECT date, total_premium, new_premium, expired_premium, silver_count, gold_count
      FROM premium_daily_stats
      ORDER BY date DESC LIMIT $1
    `, [months]);
    res.json({
      growth: growth.rows.reverse().map(r => ({
        date: r.date,
        total: parseInt(r.total_premium) || 0,
        new: parseInt(r.new_premium) || 0,
        expired: parseInt(r.expired_premium) || 0,
        silver: parseInt(r.silver_count) || 0,
        gold: parseInt(r.gold_count) || 0,
      })),
    });
  } catch (err) {
    console.error('[analytics] Error en premium-growth:', err);
    res.status(500).json({ error: 'Error al obtener crecimiento premium' });
  }
});

// ── TAB 6: TIMELINE DE ACCIONES ──
router.get('/timeline', auth, requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const typeFilter = req.query.type || 'all';

    let whereClause = "created_at >= CURRENT_DATE - $1";
    const params = [days];
    if (typeFilter !== 'all') {
      whereClause += " AND action_type = $2";
      params.push(typeFilter);
    }

    const timeline = await pool.query(`
      SELECT DATE(created_at) AS date, action_type, COUNT(*) AS count
      FROM user_tracking WHERE ${whereClause}
      GROUP BY DATE(created_at), action_type ORDER BY date
    `, params);

    const todayCount = await pool.query("SELECT COUNT(*) AS c FROM user_tracking WHERE created_at::date = CURRENT_DATE", []);
    const yesterdayCount = await pool.query("SELECT COUNT(*) AS c FROM user_tracking WHERE created_at::date = CURRENT_DATE - 1", []);
    const monthCount = await pool.query("SELECT COUNT(*) AS c FROM user_tracking WHERE created_at >= CURRENT_DATE - 30", []);
    const typeDist = await pool.query("SELECT action_type, COUNT(*) AS count FROM user_tracking GROUP BY action_type ORDER BY count DESC");

    res.json({
      timeline: timeline.rows.map(r => ({ date: r.date, actionType: r.action_type, count: parseInt(r.count) })),
      actionsToday: parseInt(todayCount.rows[0].c) || 0,
      actionsYesterday: parseInt(yesterdayCount.rows[0].c) || 0,
      actionsThisMonth: parseInt(monthCount.rows[0].c) || 0,
      typeDistribution: typeDist.rows.map(r => ({ actionType: r.action_type, count: parseInt(r.count) })),
    });
  } catch (err) {
    console.error('[analytics] Error en timeline:', err);
    res.status(500).json({ error: 'Error al obtener timeline' });
  }
});

// ── Actividad reciente (tabla compartida con Timeline) ──
router.get('/recent', auth, requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const recent = await pool.query(`
      SELECT t.id, t.action_type, t.manga_id, t.chapter_id, t.metadata, t.created_at,
             u.username, u.avatar,
             m.title AS manga_title, m.cover AS manga_cover
      FROM user_tracking t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN mangas m ON m.id = t.manga_id
      ORDER BY t.created_at DESC LIMIT $1
    `, [limit]);

    res.json({
      recent: recent.rows.map(r => ({
        id: r.id,
        username: r.username,
        avatar: r.avatar,
        actionType: r.action_type,
        mangaId: r.manga_id,
        mangaTitle: r.manga_title,
        mangaCover: r.manga_cover,
        chapterId: r.chapter_id,
        metadata: r.metadata,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[analytics] Error en recent:', err);
    res.status(500).json({ error: 'Error al obtener actividad reciente' });
  }
});

module.exports = router;
