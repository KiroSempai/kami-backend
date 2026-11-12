// ═══════════════════════════════════════════════════════════════════════════════
// ⚙️ KamiTales — routes-settings.js
// Ajustes de la cuenta. Montado en /api/settings.
//
//   GET  /                → datos de la cuenta, plan y calidades de imagen permitidas
//   PUT  /quality         { quality }   → calidad de imagen del lector de cómics
//   POST /logout-all      → cierra la sesión en todos los dispositivos (devuelve un token nuevo)
//   GET  /export          → descarga de tus datos en JSON
// ═══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { verifyToken, signToken, forgetSessionCache } = require('../config');
const getRole = require('../getRole');
const { getAllowedQualities, setUserQuality } = require('../image-settings');

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Inicia sesión para ver tus ajustes.' });
  try { req.user = await verifyToken(token); next(); }
  catch { res.status(401).json({ error: 'Tu sesión ha caducado. Vuelve a iniciar sesión.' }); }
}
router.use(auth);

const PREMIUM_TIERS = ['silver', 'gold'];
function planOf(u) {
  const active = !!(u.premium_expires_at && new Date(u.premium_expires_at) > new Date());
  const tier = PREMIUM_TIERS.includes(u.subscription_tier) ? u.subscription_tier : (active ? 'silver' : 'free');
  const staff = !!u.is_owner || !!u.is_admin;
  return { tier, active, expiresAt: u.premium_expires_at, isPremium: active || PREMIUM_TIERS.includes(u.subscription_tier) || staff, viaStaff: staff && !active };
}

router.get('/', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const role = getRole(u);
    res.json({
      user: {
        id: u.id, username: u.username, email: u.email, avatar: u.avatar || '', country: u.country || '',
        createdAt: u.created_at, role, isOwner: !!u.is_owner,
        hasPassword: !!u.password, googleLinked: !!u.google_id,
        securityChangedAt: u.password_changed_at,
      },
      plan: planOf(u),
      quality: { selected: u.image_quality || '1080', allowed: getAllowedQualities(u.subscription_tier || (u.is_admin ? 'admin' : 'user')) },
    });
  } catch (e) {
    console.error('[ajustes] get:', e.message);
    res.status(500).json({ error: 'No se pudieron cargar tus ajustes.' });
  }
});

router.put('/quality', async (req, res) => {
  try {
    const q = String(req.body?.quality || '');
    const r = await pool.query('SELECT subscription_tier, is_admin FROM users WHERE id = $1', [req.user.userId]);
    const u = r.rows[0]; if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const allowed = getAllowedQualities(u.subscription_tier || (u.is_admin ? 'admin' : 'user'));
    if (!allowed.includes(q)) return res.status(403).json({ error: q === 'master' ? 'La calidad Master es para Premium.' : 'Calidad no válida.' });
    await setUserQuality(req.user.userId, q);
    res.json({ success: true, quality: q });
  } catch (e) {
    console.error('[ajustes] quality:', e.message);
    res.status(500).json({ error: 'No se pudo guardar la calidad.' });
  }
});

const logoutLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera unos minutos.' } });
// Marca la fecha de seguridad: todos los tokens emitidos antes dejan de valer (ver verifyToken en config.js)
router.post('/logout-all', logoutLimiter, async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, username, email', [req.user.userId]);
    const u = r.rows[0]; if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    forgetSessionCache(u.id);
    // Token nuevo un segundo después, para que esta sesión siga abierta
    await new Promise(ok => setTimeout(ok, 1100));
    res.json({ success: true, token: signToken({ userId: u.id, username: u.username, email: u.email }), message: 'Se ha cerrado la sesión en todos los demás dispositivos.' });
  } catch (e) {
    console.error('[ajustes] logout-all:', e.message);
    res.status(500).json({ error: 'No se pudo cerrar las sesiones.' });
  }
});

const exportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Ya has descargado tus datos varias veces. Prueba dentro de una hora.' } });
router.get('/export', exportLimiter, async (req, res) => {
  const id = req.user.userId;
  const q = async (sql) => { try { return (await pool.query(sql, [id])).rows; } catch { return []; } };
  try {
    const [user] = await q('SELECT id, username, email, bio, country, favorite_genres, emoji, created_at, premium_expires_at, subscription_tier, image_quality FROM users WHERE id = $1');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const data = {
      exportedAt: new Date().toISOString(),
      service: 'KamiTales',
      account: user,
      library: await q('SELECT l.manga_id, m.title, l.status, l.is_favorite, l.score, l.progress, l.notes, l.added_at, l.updated_at FROM user_manga_library l LEFT JOIN mangas m ON m.id = l.manga_id WHERE l.user_id = $1 ORDER BY l.updated_at DESC'),
      readingProgress: await q('SELECT r.manga_id, m.title, r.last_chapter, r.last_page, r.last_percent, r.updated_at FROM user_reading r LEFT JOIN mangas m ON m.id = r.manga_id WHERE r.user_id = $1 ORDER BY r.updated_at DESC'),
      chapterComments: await q('SELECT manga_id, chapter_number, paragraph_id, text, is_spoiler, created_at FROM chapter_comments WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC'),
      posts: await q('SELECT id, manga_id, content, media_url, chapter_number, is_spoiler, parent_id, created_at FROM feed_posts WHERE user_id = $1 ORDER BY created_at DESC'),
      following: await q('SELECT u.username, f.created_at FROM user_follows f JOIN users u ON u.id = f.following_id WHERE f.follower_id = $1'),
      followers: await q('SELECT u.username, f.created_at FROM user_follows f JOIN users u ON u.id = f.follower_id WHERE f.following_id = $1'),
      works: await q('SELECT id, title, type, status, created_at FROM mangas WHERE created_by = $1'),
    };
    res.setHeader('Content-Disposition', `attachment; filename="kamitales-${encodeURIComponent(user.username)}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (e) {
    console.error('[ajustes] export:', e.message);
    res.status(500).json({ error: 'No se pudieron exportar tus datos.' });
  }
});

module.exports = router;
