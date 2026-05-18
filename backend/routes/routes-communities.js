// KAMI — Routes: Communities
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

var COMM_MEDIA_DIR = path.join(__dirname, '..', 'public', 'assets', 'communities');
try { fs.mkdirSync(COMM_MEDIA_DIR, { recursive: true }); } catch(e) {}

var commUpload = multer({
  storage: multer.diskStorage({
    destination: function(req, file, cb) { cb(null, COMM_MEDIA_DIR); },
    filename: function(req, file, cb) {
      var ext = path.extname(file.originalname) || '.jpg';
      cb(null, req.params.id + '_' + file.fieldname + '_' + Date.now() + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    cb(null, /\.(jpg|jpeg|png|webp|gif)$/i.test(path.extname(file.originalname)));
  }
});

const { checkCommunityAdmin, checkCommunityPermission } = require('../community-permissions');

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = await verifyToken(token); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// ═══ RUTAS ESTÁTICAS (antes que :id) ═══

// GET /api/communities — Listar comunidades (con membresía del usuario)
router.get('/', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, m.cover AS manga_cover,
        (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id) AS member_count,
        (SELECT role FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = $1) AS my_role
      FROM communities c
      LEFT JOIN mangas m ON m.id = c.manga_id
      ORDER BY c.created_at DESC LIMIT 50
    `, [req.user.userId]);
    res.json({ success: true, communities: r.rows });
  } catch (err) {
    console.error('[communities] Error:', err.message);
    res.status(500).json({ error: 'Error al obtener comunidades' });
  }
});

// GET /api/feed/search — Búsqueda general 
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, posts: [], mangas: [], users: [] });
    const term = '%' + q + '%';
    const [posts, mangas, users] = await Promise.all([
      pool.query(`SELECT fp.id, fp.content, fp.created_at, fp.community_id, u.username, u.avatar, m.title AS manga_title FROM feed_posts fp LEFT JOIN users u ON u.id = fp.user_id LEFT JOIN mangas m ON m.id = fp.manga_id WHERE fp.content ILIKE $1 AND fp.parent_id IS NULL ORDER BY fp.created_at DESC LIMIT 20`, [term]),
      pool.query(`SELECT id, title, cover FROM mangas WHERE title ILIKE $1 ORDER BY created_at DESC LIMIT 10`, [term]),
      pool.query(`SELECT id, username, avatar FROM users WHERE username ILIKE $1 LIMIT 10`, [term]),
    ]);
    res.json({ success: true, posts: posts.rows, mangas: mangas.rows, users: users.rows });
  } catch (err) {
    console.error('[feed] Error en search:', err.message);
    res.status(500).json({ error: 'Error al buscar' });
  }
});

// GET /api/communities/trending — Comunidades/posts populares
router.get('/trending', async (req, res) => {
  try {
    const [commR, newsR, postR] = await Promise.all([
      pool.query(`SELECT c.id, c.name, c.manga_id, c.created_at, (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id) AS member_count, (SELECT COUNT(*) FROM feed_posts fp WHERE fp.community_id = c.id) AS post_count FROM communities c ORDER BY member_count DESC, post_count DESC LIMIT 10`),
      pool.query(`SELECT fp.id, fp.content, fp.created_at, fp.community_id, fp.manga_id, fp.media_url, fp.views_count, fp.like_count, fp.reply_count, fp.repost_count, fp.is_news, fp.is_global_announcement, u.username, u.avatar, m.title AS manga_title, ur.role AS author_role FROM feed_posts fp LEFT JOIN users u ON u.id = fp.user_id LEFT JOIN user_with_role ur ON ur.id = fp.user_id LEFT JOIN mangas m ON m.id = fp.manga_id WHERE fp.parent_id IS NULL AND fp.is_spoiler = false AND (ur.role IN ('admin','company','creator') OR fp.manga_id IS NOT NULL) ORDER BY fp.is_global_announcement DESC, fp.is_news DESC, (ur.role = 'admin') DESC, (ur.role = 'company') DESC, (ur.role = 'creator') DESC, fp.created_at DESC LIMIT 10`),
      pool.query(`SELECT fp.id, fp.content, fp.created_at, fp.community_id, fp.manga_id, fp.media_url, fp.views_count, fp.like_count, fp.reply_count, fp.repost_count, u.username, u.avatar, m.title AS manga_title, ur.role AS author_role FROM feed_posts fp LEFT JOIN users u ON u.id = fp.user_id LEFT JOIN user_with_role ur ON ur.id = fp.user_id LEFT JOIN mangas m ON m.id = fp.manga_id WHERE fp.parent_id IS NULL AND fp.is_spoiler = false ORDER BY fp.like_count + fp.repost_count DESC NULLS LAST LIMIT 10`),
    ]);
    res.json({ success: true, trending_communities: commR.rows, latest_news: newsR.rows, trending_posts: postR.rows });
  } catch (err) {
    console.error('[communities] Error en trending:', err.message);
    res.status(500).json({ error: 'Error al obtener tendencias' });
  }
});

// GET /api/communities/trending/mangas — Últimos KMI
router.get('/trending/mangas', async (req, res) => {
  try {
    const r = await pool.query(`SELECT m.id, m.title, m.cover, m.type, m.created_at, (SELECT COUNT(*) FROM community_members cm JOIN communities c ON c.id = cm.community_id WHERE c.manga_id = m.id) AS member_count FROM mangas m ORDER BY m.created_at DESC LIMIT 20`);
    res.json({ success: true, mangas: r.rows });
  } catch (err) {
    console.error('[communities] Error en trending mangas:', err.message);
    res.status(500).json({ error: 'Error' });
  }
});

// GET /api/communities/trending/channels — Canales de noticias agrupados por entidad
router.get('/trending/channels', async (req, res) => {
  try {
    // Auth opcional para filtrar por follows
    let userId = null;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) { const u = require('../config').verifyToken(token); userId = u.userId; }
    } catch(e) {}

    const r = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (fp.user_id)
          fp.id AS last_post_id, fp.content AS last_content, fp.created_at AS last_post_at,
          u.id AS entity_id, u.username AS entity_name, u.avatar AS entity_avatar,
          ur.role AS entity_role,
          (SELECT COUNT(*) FROM feed_posts fp2 WHERE fp2.user_id = fp.user_id AND fp2.is_news = true AND fp2.created_at > NOW() - INTERVAL '7 days') AS posts_this_week
        FROM feed_posts fp
        JOIN users u ON u.id = fp.user_id
        JOIN user_with_role ur ON ur.id = fp.user_id
        WHERE fp.parent_id IS NULL AND ur.role IN ('admin', 'company', 'creator') AND (fp.is_news = true OR fp.is_global_announcement = true)
          AND (ur.role = 'admin' OR $1::VARCHAR IS NULL OR EXISTS (SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = fp.user_id))
        ORDER BY fp.user_id, fp.created_at DESC
      ) AS channels
      ORDER BY last_post_at DESC
    `, [userId]);
    res.json({ success: true, channels: r.rows });
  } catch (err) {
    console.error('[communities] Error en channels:', err.message);
    res.status(500).json({ error: 'Error al obtener canales' });
  }
});

// GET /api/communities/trending/topics — Trending topics (últimas 6h)
router.get('/trending/topics', async (req, res) => {
  try {
    const r = await pool.query(`SELECT content FROM feed_posts WHERE created_at > NOW() - INTERVAL '6 hours' AND content IS NOT NULL AND content != ''`);
    const stopWords = ['que','del','con','para','una','por','las','los','mas','pero','esta','este','como','todo','bien','muy','hay','era','entre','sido','tiene','cada','vez','parte','desde','hasta','tema','cual','eso','algo','otro','puede','donde','sobre','tanto','nada','casi','sino','aquel','ser','estar','haber','tener','hacer','poder','decir','ir','ver','dar','saber','querer','pensar','creer','llamar','parecer'];
    const wordCount = {};
    r.rows.forEach(row => {
      const words = (row.content || '').toLowerCase().match(/[a-zA-Z0-9\u00E0-\u00FC]{4,}/g) || [];
      words.forEach(w => { if (!stopWords.includes(w)) wordCount[w] = (wordCount[w] || 0) + 1; });
    });
    const topics = Object.entries(wordCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([topic, count]) => ({ topic: topic.charAt(0).toUpperCase() + topic.slice(1), count, label: count >= 1000 ? (Math.round(count/1000)+'k') : ''+count }));
    res.json({ success: true, topics });
  } catch (err) {
    console.error('[communities] Error en topics:', err.message);
    res.status(500).json({ error: 'Error' });
  }
});

// GET /api/communities/trending/hashtags — Trending hashtags últimas 24h
router.get('/trending/hashtags', async (req, res) => {
  try {
    const r = await pool.query(`SELECT regexp_matches(fp.content, '#([\\w\u00E0-\u00FC]+)', 'gi') AS tags FROM feed_posts fp WHERE fp.created_at > NOW() - INTERVAL '24 hours'`);
    const count = {};
    r.rows.forEach(row => { if (row.tags) row.tags.forEach(t => { const tag = t.toLowerCase(); count[tag] = (count[tag] || 0) + 1; }); });
    const tags = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([tag, count]) => ({ tag: '#' + tag, count }));
    res.json({ success: true, hashtags: tags });
  } catch (err) {
    console.error('[communities] Error en hashtags:', err.message);
    res.status(500).json({ error: 'Error' });
  }
});

// ════════════════════════════════════════════════
// GET /api/communities/sidebar-data  — Comunidades unidas + sugeridas para "Mis comunidades"
// ════════════════════════════════════════════════
router.get('/sidebar-data', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const joined = await pool.query(`
      SELECT c.*, m.cover AS manga_cover,
        (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count
      FROM communities c
      LEFT JOIN mangas m ON m.id = c.manga_id
      JOIN community_members cm ON cm.community_id = c.id
      WHERE cm.user_id = $1
      ORDER BY cm.joined_at DESC LIMIT 50
    `, [userId]);

    const suggested = await pool.query(`
      SELECT DISTINCT ON (c.id) c.*, m.cover AS manga_cover, uml.added_at AS manga_saved_at,
        (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count
      FROM communities c
      LEFT JOIN mangas m ON m.id = c.manga_id
      JOIN user_manga_library uml ON uml.manga_id = c.manga_id
      WHERE uml.user_id = $1
        AND c.id NOT IN (SELECT community_id FROM community_members WHERE user_id = $1)
      ORDER BY c.id, uml.added_at DESC LIMIT 50
    `, [userId]);

    const sorted = suggested.rows.sort(function(a, b) { return new Date(b.manga_saved_at) - new Date(a.manga_saved_at); });

    res.json({ success: true, joined: joined.rows, suggested: sorted });
  } catch (err) {
    console.error('[communities] Error en sidebar-data:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══ RUTAS DINÁMICAS (:id) ═══

// GET /api/communities/:id — Detalle de una comunidad
router.get('/:id', async (req, res) => {
  try {
    // Auth opcional para detectar my_role
    let userId = null;
    try {
      var t = req.headers.authorization?.split(' ')[1];
      if (t) { var u = await verifyToken(t); userId = u.userId; }
    } catch(e) {}

    const r = await pool.query(`
      SELECT c.*, m.title AS manga_title, m.cover AS manga_cover,
        (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
        (SELECT role FROM community_members WHERE user_id = $2 AND community_id = c.id) AS my_role
      FROM communities c
      LEFT JOIN mangas m ON m.id = c.manga_id
      WHERE c.id = $1
    `, [req.params.id, userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Comunidad no encontrada' });
    res.json({ success: true, community: r.rows[0] });
  } catch (err) {
    console.error('[communities] Error:', err.message);
    res.status(500).json({ error: 'Error al obtener comunidad' });
  }
});

// POST /api/communities/:id/join — Unirse / Salirse (toggle) + auto añadir manga a pendiente
router.post('/:id/join', auth, async (req, res) => {
  try {
    var userId = req.user.userId;
    var comId = req.params.id;
    // Verificar si ya es miembro
    var member = await pool.query("SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2", [comId, userId]);
    if (member.rows.length) {
      // LEAVE
      await pool.query("DELETE FROM community_members WHERE community_id = $1 AND user_id = $2", [comId, userId]);
      res.json({ success: true, joined: false });
    } else {
      // JOIN
      await pool.query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [comId, userId]);
      // Auto-insert manga en biblioteca como 'pendiente' (sin pisar estados existentes)
      var comData = await pool.query("SELECT manga_id FROM communities WHERE id = $1", [comId]);
      if (comData.rows[0]?.manga_id) {
        await pool.query(
          "INSERT INTO user_manga_library (user_id, manga_id, status, added_at) VALUES ($1, $2, 'pendiente', NOW()) ON CONFLICT (user_id, manga_id) DO NOTHING",
          [userId, comData.rows[0].manga_id]
        );
      }
      res.json({ success: true, joined: true });
    }
  } catch (err) {
    console.error('[communities] Error al unirse/salir:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/communities/:id/banner — Subir/actualizar banner
router.post('/:id/banner', auth, commUpload.single('banner'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió ninguna imagen' });
    var isAdmin = await checkCommunityAdmin(req.user.userId, req.params.id);
    if (!isAdmin) return res.status(403).json({ error: 'No tienes permisos' });
    var url = '/assets/communities/' + req.file.filename;
    await pool.query('UPDATE communities SET banner_url = $1, updated_at = NOW() WHERE id = $2', [url, req.params.id]);
    res.json({ success: true, banner_url: url });
  } catch (err) {
    console.error('[banner] Error:', err.message);
    res.status(500).json({ error: 'Error al subir banner: ' + err.message });
  }
});

// POST /api/communities/:id/avatar — Subir/actualizar avatar
router.post('/:id/avatar', auth, commUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió ninguna imagen' });
    var isAdmin = await checkCommunityAdmin(req.user.userId, req.params.id);
    if (!isAdmin) return res.status(403).json({ error: 'No tienes permisos' });
    var url = '/assets/communities/' + req.file.filename;
    await pool.query('UPDATE communities SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [url, req.params.id]);
    res.json({ success: true, avatar_url: url });
  } catch (err) {
    console.error('[communities] Error avatar:', err.message);
    res.status(500).json({ error: 'Error al subir avatar' });
  }
});

// GET /api/communities/:id/posts — Posts de la comunidad (paginados)
router.get('/:id/posts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 50);
    const offset = parseInt(req.query.offset) || 0;
    const r = await pool.query(`
      SELECT fp.id, fp.content, fp.title, fp.post_type, fp.chapter_number, fp.is_spoiler,
             fp.community_id, fp.manga_id, fp.media_url, fp.created_at, fp.parent_id,
             fp.quoted_post_id,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies,
             u.username, u.avatar, m.title AS manga_title, m.cover AS manga_cover,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
             cm.role AS local_role
      FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id
      LEFT JOIN community_members cm ON cm.user_id = fp.user_id AND cm.community_id = $1
      WHERE fp.community_id = $1 AND fp.parent_id IS NULL
      ORDER BY fp.created_at DESC LIMIT $2 OFFSET $3
    `, [req.params.id, limit, offset]);

    let posts = r.rows.map(p => ({
      id: p.id, user: p.username || 'Anónimo',
      handle: '@' + (p.username || 'anon').toLowerCase(),
      avatar: p.avatar || null, text: p.content || '',
      title: p.title || '', type: p.post_type || 'post',
      manga: p.manga_title ? { id: p.manga_id, title: p.manga_title, cover: p.manga_cover || null } : undefined,
      chapter: p.chapter_number, spoiler: p.is_spoiler || false,
      media_url: p.media_url || null, parent_id: p.parent_id || null,
      quoted_post_id: p.quoted_post_id || null,
      local_role: p.local_role || null,
      likes: parseInt(p.real_likes) || 0, replies: parseInt(p.real_replies) || 0,
      reposts: parseInt(p.real_reposts) || 0,
      views_count: parseInt(p.views_count) || 0,
      author_role: p.author_role || 'user', created_at: p.created_at,
      user_has_liked: false, user_has_reposted: false, user_has_bookmarked: false,
    }));

    res.json({ success: true, posts, offset, limit });
  } catch (err) {
    console.error('[communities] Error al obtener posts:', err.message);
    res.status(500).json({ error: 'Error al obtener posts' });
  }
});

// GET /api/communities/:id/members — Miembros
router.get('/:id/members', async (req, res) => {
  try {
    const r = await pool.query(`SELECT cm.user_id, cm.role, cm.joined_at, u.username, u.avatar FROM community_members cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.community_id = $1 ORDER BY cm.joined_at ASC`, [req.params.id]);
    res.json({ success: true, members: r.rows });
  } catch (err) {
    console.error('[communities] Error al obtener miembros:', err.message);
    res.status(500).json({ error: 'Error al obtener miembros' });
  }
});

// POST /api/communities/:id/set-role — Gestionar roles locales (solo creator)
router.post('/:id/set-role', auth, async (req, res) => {
  try {
    const { target_user_id, new_role } = req.body;
    const callerId = req.user.userId;

    if (!['moderator', 'member'].includes(new_role)) {
      return res.status(400).json({ error: 'Rol no válido. Permitidos: moderator, member' });
    }

    const canManage = await checkCommunityPermission(callerId, req.params.id, 'can_manage_roles');
    if (!canManage) {
      return res.status(403).json({ error: 'No tienes permisos para gestionar roles en esta comunidad' });
    }

    if (target_user_id === callerId) {
      return res.status(400).json({ error: 'No puedes alterar tu propio rol' });
    }

    // Verificar que el target sea miembro
    const targetMember = await pool.query(
      'SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2',
      [req.params.id, target_user_id]
    );
    if (targetMember.rows.length === 0) {
      return res.status(404).json({ error: 'El usuario objetivo no es miembro de esta comunidad' });
    }

    // No permitir degradar a otro creator (solo admin global puede hacerlo)
    if (targetMember.rows[0].role === 'creator') {
      return res.status(403).json({ error: 'No puedes modificar el rol de un creator' });
    }

    await pool.query(
      'UPDATE community_members SET role = $1 WHERE community_id = $2 AND user_id = $3',
      [new_role, req.params.id, target_user_id]
    );

    res.json({ success: true, message: 'Rol actualizado a ' + new_role });
  } catch (err) {
    console.error('[communities] Error en set-role:', err.message);
    res.status(500).json({ error: 'Error al actualizar rol' });
  }
});

// DELETE /api/communities/:id/posts/:postId — Moderación de posts (solo creator/moderator)
router.delete('/:id/posts/:postId', auth, async (req, res) => {
  try {
    const canModerate = await checkCommunityPermission(req.user.userId, req.params.id, 'can_moderate_posts');
    if (!canModerate) {
      return res.status(403).json({ error: 'No tienes permiso para borrar posts en esta comunidad' });
    }

    const del = await pool.query(
      'DELETE FROM feed_posts WHERE id = $1 AND community_id = $2 RETURNING id',
      [req.params.postId, req.params.id]
    );

    if (del.rows.length === 0) {
      return res.status(404).json({ error: 'El post no existe o no pertenece a esta comunidad' });
    }

    res.json({ success: true, message: 'Post eliminado por moderador de la comunidad' });
  } catch (err) {
    console.error('[communities] Error al borrar post:', err.message);
    res.status(500).json({ error: 'Error al moderar el post' });
  }
});

// POST /api/communities/:id/chat — Enviar mensaje al chat de la comunidad
router.post('/:id/chat', auth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Mensaje requerido' });
    let thread = await pool.query('SELECT id FROM message_threads WHERE subject = $1', ['chat-comm-' + req.params.id]);
    let threadId;
    if (thread.rows.length) { threadId = thread.rows[0].id; }
    else {
      thread = await pool.query(`INSERT INTO message_threads (user_id, subject, status) VALUES ($1, $2, 'open') RETURNING id`, [req.user.userId, 'chat-comm-' + req.params.id]);
      threadId = thread.rows[0].id;
    }
    await pool.query(`INSERT INTO messages (thread_id, sender_id, message) VALUES ($1, $2, $3)`, [threadId, req.user.userId, message.trim()]);
    if (global.io) {
      const userR = await pool.query('SELECT username, avatar FROM users WHERE id = $1', [req.user.userId]);
      global.io.to('comm-chat:' + req.params.id).emit('chat-message', { user: req.user.userId, username: userR.rows[0]?.username || 'Anónimo', avatar: userR.rows[0]?.avatar || null, message: message.trim(), created_at: new Date() });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[communities] Error en chat:', err.message);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

// GET /api/communities/:id/chat — Obtener mensajes del chat
router.get('/:id/chat', async (req, res) => {
  try {
    const thread = await pool.query('SELECT id FROM message_threads WHERE subject = $1', ['chat-comm-' + req.params.id]);
    if (!thread.rows.length) return res.json({ success: true, messages: [] });
    const r = await pool.query(`SELECT m.id, m.message, m.created_at, m.sender_id, u.username, u.avatar FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.thread_id = $1 ORDER BY m.created_at ASC LIMIT 100`, [thread.rows[0].id]);
    res.json({ success: true, messages: r.rows });
  } catch (err) {
    console.error('[communities] Error al obtener chat:', err.message);
    res.status(500).json({ error: 'Error' });
  }
});

module.exports = router;
