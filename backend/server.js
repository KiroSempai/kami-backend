// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 KAMI — server.js
// ═══════════════════════════════════════════════════════════════════════════════
// Punto de entrada del servidor. Inicializa Express, monta rutas API,
// sirve las vistas HTML, configura WebSocket (Socket.io) y el caché
// de interacciones (Redis opcional / memoria).
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

// Valores por defecto para Supabase Storage (Render no siempre sincroniza env vars)
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = 'https://bojubfastavgvqkogjnj.supabase.co';
if (!process.env.SUPABASE_SERVICE_KEY) process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJvanViZmFzdGF2Z3Zxa29nam5qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODg3MzQyMSwiZXhwIjoyMDk0NDQ5NDIxfQ.zk3HoIXv6fcA-ZdXIipbeBjWPicImHXqjlW1A5e5niQ';

// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️ Validación de variables de entorno críticas al arranque
// ═══════════════════════════════════════════════════════════════════════════════

const REQUIRED_ENV = ['JWT_SECRET', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = REQUIRED_ENV.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`FATAL: Variables de entorno faltantes en .env: ${missing.join(', ')}`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📦 Dependencias
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');

// ═══════════════════════════════════════════════════════════════════════════════
// 🔄 Caché de interacciones (memoria + Redis opcional)
// ═══════════════════════════════════════════════════════════════════════════════
// Sirve para evitar escribir a PostgreSQL en cada like/repost/reply.
// Los contadores se acumulan en memoria y se consolidan cada 10s.

global.interactionCache = { likes: 0, reposts: 0, replies: 0 };
global.interactionDeltas = new Map(); // clave: postId → valor: { likes, reposts, replies }
global.io = null;

let redis = null;
try {
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null });
    redis.on('error', () => { redis = null; });
    console.log('✅ Redis conectado');
  }
} catch (e) {
  // Redis no disponible — el caché cae a memoria
}

// Adaptador de caché: usa Redis si está disponible, si no, retorna null (cae en memory cache)
global.cache = {
  async get(key) {
    if (redis) return redis.get(key);
    return null;
  },
  async setex(key, ttl, val) {
    if (redis) return redis.setex(key, ttl, val);
  },
  async incr(key) {
    if (redis) return redis.incr(key);
  },
};

// ─── Consolidación rápida cada 10 segundos ───
// Toma los deltas acumulados en memoria y los escribe a PostgreSQL.
setInterval(async () => {
  if (global.interactionDeltas.size === 0) return;
  const entries = [...global.interactionDeltas.entries()];
  global.interactionDeltas.clear();
  for (const [postId, delta] of entries) {
    try {
      await pool.query(
        `UPDATE feed_posts SET
          like_count = GREATEST(COALESCE(like_count,0) + $1, 0),
          repost_count = GREATEST(COALESCE(repost_count,0) + $2, 0),
          reply_count = GREATEST(COALESCE(reply_count,0) + $3, 0)
        WHERE id = $4`,
        [delta.likes || 0, delta.reposts || 0, delta.replies || 0, postId]
      );
    } catch (e) {
      // Ignorar errores de consolidación parcial
    }
  }
}, 10000);

// ─── Sincronización completa cada 5 minutos ───
// Recalcula contadores desde feed_interactions para corregir desviaciones.
setInterval(async () => {
  try {
    await pool.query(`
      UPDATE feed_posts fp SET
        like_count = (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like'),
        repost_count = (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost'),
        reply_count = (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'reply')
    `);
  } catch (e) {
    // Silencioso para no contaminar logs
  }
}, 300000);

// ═══════════════════════════════════════════════════════════════════════════════
// 📄 Generar db.js si no existe (por si el deploy no lo incluye)
// ═══════════════════════════════════════════════════════════════════════════════

const dbModulePath = path.join(__dirname, 'db.js');
if (!fs.existsSync(dbModulePath)) {
  fs.writeFileSync(dbModulePath, `require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST     || 'localhost',
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT) || 5432,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
`);
  console.log('📄 db.js generado automáticamente');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🗄️ Conexión a PostgreSQL
// ═══════════════════════════════════════════════════════════════════════════════

const { pool } = require('./db');

pool.connect()
  .then(client => {
    console.log('✅ PostgreSQL conectado');
    client.release();
    // Al reiniciar, sincroniza contadores desde feed_interactions
    pool.query(`
      UPDATE feed_posts fp SET
        like_count = (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like'),
        repost_count = (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost'),
        reply_count = (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'reply')
    `).catch(() => {});
  })
  .catch(err => {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
    console.error('   Revisa las variables DB_* en tu .env');
  });

// ═══════════════════════════════════════════════════════════════════════════════
// 📦 Importación de rutas API
// ═══════════════════════════════════════════════════════════════════════════════

const authRoutes         = require('./routes/routes-auth');
const profileRoutes      = require('./routes/routes-profile');
const libraryRoutes      = require('./routes/routes-library');
const mangaRoutes        = require('./routes/routes-manga');
const chapterRoutes      = require('./routes/routes-chapters');
const premiumRoutes      = require('./routes/routes-premium');
const moderationRoutes   = require('./routes/routes-moderation');
const notificationRoutes = require('./routes/routes-notifications');
const messageRoutes      = require('./routes/routes-messages');
const statsRoutes        = require('./routes/routes-stats');
const analyticsRoutes    = require('./routes/routes-analytics');
const analyticsScheduler = require('./analytics/scheduler');
const imageRoutes        = require('./routes/routes-images');
const previewRoutes      = require('./routes/routes-preview');
const annotationRoutes   = require('./routes/routes-annotations');
const friendRoutes       = require('./routes/routes-friends');
const commentRoutes      = require('./routes/routes-comments');
const storyPinRoutes     = require('./routes/routes-story-pins');
const socialRoutes = require('./routes/routes-social');
const dmRoutes = require('./routes/routes-dms');
const feedRoutes         = require('./routes/routes-feed');
const communityRoutes    = require('./routes/routes-communities');
const adminRoutes        = require('./routes/routes-admin');
const novelRoutes        = require('./routes/routes-novel');
const studioRoutes       = require('./routes/routes-studio');
const passwordRoutes     = require('./routes/routes-password');
const settingsRoutes     = require('./routes/routes-settings');

// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 App Express
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Health checks para Render ───────────────────────────────────────────────
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// (Eliminado /db-test: exponía errores internos de la base de datos.)

// ─── Middleware global ───────────────────────────────────────────────────────
// ─── Orígenes permitidos y cabeceras de seguridad ───────────────────────────
// La web y la API comparten origen, así que no hace falta abrir CORS a todos.
// Para permitir otro dominio (app móvil, panel externo): ALLOWED_ORIGINS=https://a.com,https://b.com
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
function originAllowed(origin) {
  if (!origin) return true;                                   // misma página, curl, apps nativas
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && process.env.NODE_ENV !== 'production') return true;
  return false;
}
app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Mismo origen: el navegador manda Origin igual al host; se permite siempre
  if (origin && origin.replace(/^https?:\/\//, '') === req.headers.host) return next();
  if (!originAllowed(origin)) return res.status(403).json({ error: 'Origen no permitido.' });
  next();
});
app.use(cors({ origin: (origin, cb) => cb(null, originAllowed(origin) ? (origin || true) : false), credentials: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '1mb' })); // las fotos de perfil van como data URL comprimida
// Al terminar cada petición se borran los archivos subidos que la ruta no se haya llevado
// (errores, validaciones fallidas, capítulo repetido…). Si ya se movieron, no pasa nada.
app.use((req, res, next) => {
  res.on('finish', () => {
    const files = [].concat(req.file || [], Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat());
    files.forEach(f => { if (f && f.path) fs.unlink(f.path, () => {}); });
  });
  next();
});
app.use(express.urlencoded({ extended: true }));

// ─── IP Ban middleware ───────────────────────────────────────────────────────
// Verifica en memoria caché (1 min TTL) si la IP está baneada.
// Solo aplica a rutas /api/* (excepto webhook de premium).
const ipBanCache = new Map();
const IP_BAN_TTL = 60_000;

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/premium/webhook') return next();

  const clientIp = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    '0.0.0.0'
  ).replace(/^::ffff:/, '');

  const cached = ipBanCache.get(clientIp);
  if (cached !== undefined) {
    if (cached) return res.status(403).json({ error: 'Acceso denegado. Esta IP ha sido bloqueada.' });
    return next();
  }

  try {
    const result = await pool.query('SELECT 1 FROM banned_ips WHERE ip_address = $1', [clientIp]);
    const banned = result.rows.length > 0;
    ipBanCache.set(clientIp, banned);
    setTimeout(() => ipBanCache.delete(clientIp), IP_BAN_TTL);
    if (banned) return res.status(403).json({ error: 'Acceso denegado. Esta IP ha sido bloqueada.' });
  } catch {
    // Si falla la query, permitir el paso
  }

  next();
});

// ─── Forzar no-cache en respuestas HTML ─────────────────────────────────────
app.use((req, res, next) => {
  if (req.accepts('html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// ─── Cache buster automático para HTML ──────────────────────────────────────
// Intercepta sendFile para archivos .html y reemplaza ?v=XX por timestamp actual.
// Así los recursos CSS/JS referenciados se invalidan en cada solicitud.
(function attachCacheBuster() {
  const origSendFile = express.response.sendFile;
  express.response.sendFile = function (filePath, options, callback) {
    if (typeof filePath === 'string' && filePath.endsWith('.html') && this.req) {
      const res = this;
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
          if (callback) return callback(err);
          return res.status(500).send('Error reading file');
        }
        const modified = data.replace(/\?v=\d+/g, `?v=${Date.now()}`);
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(modified);
      });
      return;
    }
    origSendFile.call(this, filePath, options, callback);
  };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// 📄 Rutas de páginas HTML (KamiTales)
// Una página responsive por pantalla. Las URL antiguas redirigen (301) a las
// nuevas conservando la query, para no romper enlaces ni marcadores.
// ═══════════════════════════════════════════════════════════════════════════════
const PUB = path.join(__dirname, 'public');
const page = (file) => (req, res) => res.sendFile(path.join(PUB, file));
function noCache(req, res, next) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
}
const qs = (req) => { const i = req.originalUrl.indexOf('?'); return i >= 0 ? req.originalUrl.slice(i) : ''; };
const moved = (to) => (req, res) => res.redirect(301, (typeof to === 'function' ? to(req) : to) + qs(req));

// Redirecciones de las URL y archivos antiguos (antes de express.static)
const OLD = {
  '/inicio-mangoteca': '/', '/mangoteca': '/', '/index.html': '/comunidad', '/inicio-mangoteca.html': '/',
  '/login': '/acceder', '/login.html': '/acceder', '/register': '/registro', '/register.html': '/registro',
  '/settings': '/ajustes', '/account': '/ajustes', '/settings.html': '/ajustes',
  '/messages': '/mensajes', '/messages.html': '/mensajes',
  '/add-manga': '/estudio/nueva', '/add-manga.html': '/estudio/nueva',
  '/menu-edit': '/estudio', '/menu-edit.html': '/estudio',
  '/premium/success': '/premium/exito', '/admin/analytics': '/admin/analiticas',
  '/manga-view.html': '/', '/reader.html': '/',
};
for (const [from, to] of Object.entries(OLD)) app.get(from, moved(to));
app.get('/manga/:id/upload-chapter', moved(r => `/obra/${encodeURIComponent(r.params.id)}/nuevo-capitulo`));
app.get('/manga/:id/edit', moved(r => `/obra/${encodeURIComponent(r.params.id)}/editar`));
app.get('/manga/:id', moved(r => `/obra/${encodeURIComponent(r.params.id)}`));
app.get('/reader/:id/:cap', moved(r => `/leer/${encodeURIComponent(r.params.id)}/${encodeURIComponent(r.params.cap)}`));
app.get('/profile/:username', moved(r => `/perfil/${encodeURIComponent(r.params.username)}`));
app.get('/perfil-editor/:username', moved(r => `/perfil-editar/${encodeURIComponent(r.params.username)}`));

// Páginas
app.get('/',                         page('explorar.html'));
app.get('/explorar',                 page('explorar.html'));
app.get('/comunidad',                page('comunidad.html'));
app.get('/acceder',                  page('acceder.html'));
app.get('/registro',                 page('registro.html'));
app.get('/recuperar',                page('recuperar.html'));
app.get('/restablecer',              page('restablecer.html'));
app.get('/perfil',                   noCache, page('perfil.html'));
app.get('/perfil/:username',         noCache, page('perfil.html'));
app.get('/perfil-editar/:username',  page('perfil-editar.html'));
app.get('/ajustes',                  page('ajustes.html'));
app.get('/biblioteca',               page('biblioteca.html'));
app.get('/generos',                  page('generos.html'));
app.get('/buscar',                   page('buscar.html'));
app.get('/estudio',                  page('estudio.html'));
app.get('/estudio/nueva',            page('obra-nueva.html'));
app.get('/obra/:id',                 page('obra.html'));
app.get('/obra/:id/editar',          page('obra-editar.html'));
app.get('/obra/:id/nuevo-capitulo',  page('capitulo-nuevo.html'));
// El lector depende del tipo de obra: texto para novelas, páginas para cómics
app.get('/leer/:id/:cap', async (req, res) => {
  let file = 'lector.html';
  try {
    const r = await pool.query('SELECT type FROM mangas WHERE id = $1', [req.params.id]);
    if (r.rows[0]?.type === 'novel') file = 'lector-novela.html';
  } catch { /* sin base: lector de cómic */ }
  res.sendFile(path.join(PUB, file));
});
app.get('/obra/:id/escribir',        page('escribir.html'));
app.get('/obra/:id/escribir/:num',   page('escribir.html'));
app.get('/premium',                  page('premium.html'));
app.get('/premium/exito',            page('premium-exito.html'));
app.get('/mensajes',                 page('mensajes.html'));
app.get('/admin/analiticas',         page('admin-analiticas.html'));
app.get('/design',                   page('design.html'));
app.get('/preview',                  page('preview.html'));

// ─── Archivos estáticos ──────────────────────────────────────────────────────
app.use(express.static(PUB, {
  maxAge: '7d',
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));
app.use('/assets', express.static(path.join(PUB, 'assets'), { maxAge: '365d', immutable: true }));

// ═══════════════════════════════════════════════════════════════════════════════
// 🌐 Rutas API
// ═══════════════════════════════════════════════════════════════════════════════

app.use('/api/auth',         authRoutes);
app.use('/api/auth',         passwordRoutes);
app.use('/api/settings',     settingsRoutes);
app.use('/api/profile',      profileRoutes);
app.use('/api/library',      libraryRoutes);
app.use('/api/manga',        mangaRoutes);
app.use('/api/chapters',     chapterRoutes);
app.use('/api/premium',      premiumRoutes);
app.use('/api/moderation',   moderationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/messages',     messageRoutes);
app.use('/api/track',        statsRoutes);
app.use('/api/stats',        statsRoutes);
app.use('/api/analytics',    analyticsRoutes);
app.use('/api/image',        imageRoutes);
app.use('/api/preview',      previewRoutes);
app.use('/api/upload',      previewRoutes);
app.use('/api/annotations',  annotationRoutes);
app.use('/api/friends',      friendRoutes);
app.use('/api/comments',     commentRoutes);
app.use('/api/story-pins',   storyPinRoutes);
app.use('/api/social',       socialRoutes);
app.use('/api/feed',         feedRoutes);
app.use('/api/communities',  communityRoutes);
app.use('/api/dms',          dmRoutes);
app.use('/api/admin',        adminRoutes);
app.use('/api/novel',        novelRoutes);
app.use('/api/studio',       studioRoutes);

// Rutas sueltas que no encajan en los groups anteriores

// ═══════════════════════════════════════════════════════════════════════════════
// 404 — Fallback
// ═══════════════════════════════════════════════════════════════════════════════

app.use((req, res) => {
  res.status(404).json({
    error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error handler global
// ═══════════════════════════════════════════════════════════════════════════════

app.use((err, req, res, _next) => {
  console.error('Error no controlado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🟢 Arranque del servidor
// ═══════════════════════════════════════════════════════════════════════════════

const { cleanExpiredTokens } = require('./config');

// Limpieza periódica de tokens revocados expirados (cada hora)
setInterval(cleanExpiredTokens, 60 * 60 * 1000);
cleanExpiredTokens();

// Iniciar procesadores de analytics
analyticsScheduler.start();

// Crear servidor HTTP y montar Socket.io
const server = http.createServer(app);
global.io = new Server(server, { cors: { origin: (origin, cb) => cb(null, originAllowed(origin)), methods: ['GET', 'POST'] } });

// Canales de WebSocket para tiempo real (posts, chat, DMs)
global.io.on('connection', (socket) => {
  socket.on('join-post', (postId) => {
    socket.join(`post:${postId}`);
  });
  socket.on('leave-post', (postId) => {
    socket.leave(`post:${postId}`);
  });
  socket.on('join-dm', (userId) => {
    if (userId) socket.join('dm:' + userId);
  });
  socket.on('leave-dm', (userId) => {
    if (userId) socket.leave('dm:' + userId);
  });
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   KamiTales — servidor en marcha          ║
║   http://localhost:${PORT}               ║
╠══════════════════════════════════════════╣
║  GET /              → index.html         ║
║  GET /register      → register.html      ║
║  GET /login         → login.html         ║
║  GET /profile/:u    → perfil.html        ║
║  GET /account       → settings.html      ║
║  GET /biblioteca    → biblioteca.html    ║
║  GET /add-manga     → add-manga.html     ║
╠══════════════════════════════════════════╣
║  POST /api/auth/register                 ║
║  POST /api/auth/login                    ║
║  GET  /api/auth/me                       ║
╠══════════════════════════════════════════╣
║  GET  /api/manga                         ║
║  GET  /api/manga/trending                ║
║  GET  /api/manga/search?q=               ║
║  GET  /api/manga/genres                  ║
║  GET  /api/manga/:id                     ║
║  GET  /api/manga/:id/chapters            ║
║  POST /api/manga    (crear)              ║
║  GET  /api/social/:username/profile      ║
║  GET  /api/social/:username/library      ║
║  GET  /api/social/:username/stats        ║
║  GET  /api/social/:username/activity     ║
║  POST /api/social/follow                 ║
║  DELETE /api/social/follow/:userId       ║
║  GET  /api/social/suggestions            ║
║  GET  /api/social/feed                   ║
╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
