// ═══════════════════════════════════════════════════════════════════════════════
// 🍱 KAMI — routes-feed.js
// Feed algorítmico "Manga Mixer": scoring multi-factor, interacciones,
// notificaciones, vistas, y utilidades (GIF proxy/search).
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');
const https = require('https');
const http = require('http');
const urlModule = require('url');

// ── Auth middleware ──
async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = await verifyToken(token); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// ── Helper: progreso de lectura del usuario ──
async function getUserProgress(userId) {
  try {
    const r = await pool.query(
      `SELECT manga_id, progress, status, is_favorite FROM user_manga_library WHERE user_id = $1`,
      [userId]
    );
    return r.rows.reduce((acc, row) => {
      acc[row.manga_id] = { chapter: row.progress || 0, status: row.status, is_favorite: row.is_favorite || false };
      return acc;
    }, {});
  } catch { return {}; }
}

// ── Helper: preferencias de feed ──
async function getUserPrefs(userId) {
  try {
    const r = await pool.query(
      `SELECT pref_type, pref_value FROM feed_preferences WHERE user_id = $1`,
      [userId]
    );
    return r.rows.reduce((acc, row) => {
      if (!acc[row.pref_type]) acc[row.pref_type] = [];
      acc[row.pref_type].push(row.pref_value);
      return acc;
    }, {});
  } catch { return {}; }
}

// ── Helper: comunidades del usuario ──
async function getUserCommunities(userId) {
  try {
    const r = await pool.query(
      `SELECT community_id FROM community_members WHERE user_id = $1`,
      [userId]
    );
    return r.rows.map(r => r.community_id);
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════
// SUB-ALGORITHM 1: OtakuCred — Reputación por categoría
// ═══════════════════════════════════════════════════════════════
async function getOtakuCred(userId) {
  try {
    const r = await pool.query(
      `SELECT category, score FROM otaku_cred WHERE user_id = $1`,
      [userId]
    );
    return r.rows.reduce((acc, row) => { acc[row.category] = row.score; return acc; }, {});
  } catch { return {}; }
}

// Obtener cred del autor de un post
async function getPostOtakuCred(postUserId) {
  try {
    const r = await pool.query(
      `SELECT category, score FROM otaku_cred WHERE user_id = $1`,
      [postUserId]
    );
    return r.rows.reduce((acc, row) => { acc[row.category] = row.score; return acc; }, { general: 100 });
  } catch { return { general: 100 }; }
}

// ═══════════════════════════════════════════════════════════════
// SUB-ALGORITHM 2: FandomJet — Grafo de conexiones
// ═══════════════════════════════════════════════════════════════
async function fandomJetScore(userId, postUserId, mangaId, communityId) {
  try {
    let score = 0;
    // ¿El usuario sigue al autor del post?
    const follow = await pool.query(
      `SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = $2`,
      [userId, postUserId]
    );
    if (follow.rows.length > 0) score += 15;

    // ¿El usuario interactuó con el mismo manga?
    if (mangaId) {
      const mangaInt = await pool.query(
        `SELECT 1 FROM feed_interactions fi
         JOIN feed_posts fp ON fp.id = fi.post_id
         WHERE fi.user_id = $1 AND fp.manga_id = $2 LIMIT 1`,
        [userId, mangaId]
      );
      if (mangaInt.rows.length > 0) score += 10;
    }
    return score;
  } catch { return 0; }
}

// ═══════════════════════════════════════════════════════════════
// SUB-ALGORITHM 3: Safety — Detección de spoilers y toxicidad
// ═══════════════════════════════════════════════════════════════
async function safetyCheck(text, title) {
  try {
    const fullText = ((title || '') + ' ' + (text || '')).toLowerCase();
    const r = await pool.query(
      `SELECT category, severity FROM safety_keywords WHERE $1 LIKE '%' || keyword || '%'`,
      [fullText]
    );
    let spoilerPenalty = 0;
    let toxicityPenalty = 0;
    let isLeak = false;
    r.rows.forEach(row => {
      if (row.category === 'spoiler') spoilerPenalty += row.severity;
      if (row.category === 'leak') { isLeak = true; spoilerPenalty += row.severity * 2; }
      if (row.category === 'toxicity') toxicityPenalty += row.severity;
    });
    return { spoilerPenalty, toxicityPenalty, isLeak };
  } catch { return { spoilerPenalty: 0, toxicityPenalty: 0, isLeak: false }; }
}

// ═══════════════════════════════════════════════════════════════
// SUB-ALGORITHM 4: Fatiga — Anti-monotonía
// ═══════════════════════════════════════════════════════════════
async function getFatigueMultiplier(userId, mangaId, communityId, sessionId) {
  try {
    if (!mangaId && !communityId) return 1.0;
    const r = await pool.query(
      `SELECT viewed_count FROM fatigue_tracker
       WHERE session_id = $1 AND user_id = $2
       AND (manga_id = $3 OR (manga_id IS NULL AND $3 IS NULL))
       AND (community_id = $4 OR (community_id IS NULL AND $4 IS NULL))`,
      [sessionId, userId, mangaId, communityId]
    );
    if (r.rows.length === 0) return 1.0;
    const count = r.rows[0].viewed_count;
    if (count >= 6) return 0.1;
    if (count >= 4) return 0.3;
    if (count >= 3) return 0.5;
    if (count >= 2) return 0.7;
    return 0.9;
  } catch { return 1.0; }
}

async function incrementFatigue(userId, mangaId, communityId, sessionId) {
  try {
    await pool.query(`
      INSERT INTO fatigue_tracker (session_id, user_id, manga_id, community_id, viewed_count)
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (session_id, user_id, manga_id, community_id)
      DO UPDATE SET viewed_count = fatigue_tracker.viewed_count + 1, viewed_at = CURRENT_TIMESTAMP
    `, [sessionId, userId, mangaId || null, communityId || null]);
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════
// HELPERS: Tokenizar contenido para embeddings básicos
// ═══════════════════════════════════════════════════════════════
const GENRE_KEYWORDS = {
  shonen: ['pelea','batalla','poder','amistad','superación','torneo','entrenamiento'],
  seinen: ['violencia','psicológico','moral','adulto','supervivencia','guerra','política'],
  shojo: ['romance','amor','sentimientos','relaciones','drama escolar'],
  fantasy: ['magia','reino','dragón','héroe','aventura','mundo','espada'],
  horror: ['miedo','terror','sangre','oscuridad','maldición','pesadilla'],
};

function classifyText(text) {
  if (!text) return 'general';
  const lower = text.toLowerCase();
  const scores = {};
  Object.keys(GENRE_KEYWORDS).forEach(genre => {
    scores[genre] = GENRE_KEYWORDS[genre].reduce((sum, kw) => sum + (lower.includes(kw) ? 1 : 0), 0);
  });
  return Object.keys(scores).reduce((best, g) => scores[g] > (scores[best] || 0) ? g : best, 'general');
}

async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) { req.user = null; return next(); }
  try { req.user = await verifyToken(token); next(); }
  catch(e) { req.user = null; next(); }
}

// 🚪 [GET] /api/feed/for-you
// 👤 Permiso: público (auth opcional — sin auth = feed cronológico simple)
// 📥 Query: ?limit=25&offset=0&session=<session_id>
// 📤 Respuesta: { feed_type, posts[], offset, limit, session, cached?, guest? }
// 📝 Feed algorítmico "Manga Mixer". Combina 4 sub-algoritmos:
//      OtakuCred (reputación), FandomJet (grafo conexiones),
//      Safety (spoilers/toxicidad), Fatiga (anti-monotonía).
//      Cachea scoring 1 minuto para evitar fluctuaciones.
//      Guests ven feed cronológico sin personalización.

// Caché de scoring para evitar fluctuaciones (1 minuto TTL)
const forYouCache = new Map();
const CACHE_TTL_MS = 60000;

router.get('/for-you', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const limit = Math.min(parseInt(req.query.limit) || 25, 50);
    const offset = parseInt(req.query.offset) || 0;
    const tag = req.query.tag || null;
    const guestKey = 'guest_' + Math.floor(Date.now() / 60000);
    const sessionId = req.query.session || (userId ? userId + '_' + Math.floor(Date.now() / 60000) : guestKey);
    const cacheKey = (userId || 'guest') + '_' + sessionId;

    // Check cache de scoring
    const cached = forYouCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
      const idsPagina = cached.ids.slice(offset, offset + limit);
      if (idsPagina.length === 0) return res.json({ feed_type: 'Para Ti', posts: [], offset, limit, session: sessionId });

      const cr = await pool.query(`
        SELECT fp.*, u.username, u.avatar, ur.username AS reposter_username, m.title AS manga_title, m.cover AS manga_cover,
               (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
               (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
               (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
               (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies
        FROM feed_posts fp
        LEFT JOIN users u ON u.id = fp.user_id
        LEFT JOIN users ur ON ur.id = fp.reposter_user_id
        LEFT JOIN mangas m ON m.id = fp.manga_id
        WHERE fp.id = ANY($1)
      `, [idsPagina]);
      const posMap = new Map(idsPagina.map((id, i) => [id, i]));
      const ordered = cr.rows.sort((a, b) => posMap.get(a.id) - posMap.get(b.id));
      const formatted = ordered.map(post => ({
        id: post.id, user: post.username || 'Anónimo', handle: `@${(post.username || 'anon').toLowerCase()}`,
        avatar: post.avatar || null, text: post.content || '', title: post.title || '',
        type: post.post_type || 'post',
        manga: post.manga_title ? { id: post.manga_id, title: post.manga_title, cover: post.manga_cover || null } : undefined,
        chapter: post.chapter_number, spoiler: post.is_spoiler || false,
        media_url: post.media_url || null, parent_id: post.parent_id || null,
        likes: parseInt(post.real_likes) || 0, replies: parseInt(post.real_replies) || 0,
        reposts: parseInt(post.real_reposts) || 0, views_count: parseInt(post.views_count) || 0,
        author_role: post.author_role || 'user', created_at: post.created_at,
      }));
      const enriched = await enrichPosts(formatted, userId);
      return res.json({ feed_type: 'Para Ti', posts: enriched, offset, limit, session: sessionId, cached: true });
    }

    if (!userId) {
      // Guest: feed cronológico simple sin personalización
      let guestQuery = `
        SELECT fp.*, u.username, u.avatar, ur.username AS reposter_username, m.title AS manga_title, m.cover AS manga_cover,
               (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
               (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
               (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
               (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies
        FROM feed_posts fp
        LEFT JOIN users u ON u.id = fp.user_id
        LEFT JOIN users ur ON ur.id = fp.reposter_user_id
        LEFT JOIN mangas m ON m.id = fp.manga_id
        WHERE fp.parent_id IS NULL AND fp.reposted_from_id IS NULL
      `;
      let guestParams = [];
      let gpIdx = 1;
      if (tag) {
        guestQuery += ` AND fp.post_type = $${gpIdx}`;
        guestParams.push(tag.toLowerCase());
        gpIdx++;
      }
      guestQuery += ` ORDER BY fp.created_at DESC LIMIT $${gpIdx} OFFSET $${gpIdx + 1}`;
      guestParams.push(limit, offset);
      const fallback = await pool.query(guestQuery, guestParams);
      const formatted = fallback.rows.map(post => ({
        id: post.id, user: post.username || 'Anónimo', handle: `@${(post.username || 'anon').toLowerCase()}`,
        avatar: post.avatar || null, text: post.content || '', title: post.title || '',
        type: post.post_type || 'post',
        manga: post.manga_title ? { id: post.manga_id, title: post.manga_title, cover: post.manga_cover || null } : undefined,
        chapter: post.chapter_number, spoiler: post.is_spoiler || false,
        media_url: post.media_url || null, parent_id: post.parent_id || null,
        likes: parseInt(post.real_likes) || 0, replies: parseInt(post.real_replies) || 0,
        reposts: parseInt(post.real_reposts) || 0, views_count: parseInt(post.views_count) || 0,
        author_role: post.author_role || 'user', created_at: post.created_at,
      }));
      const enriched = await enrichPosts(formatted, null);
      return res.json({ feed_type: 'Para Ti', posts: enriched, offset, limit, session: sessionId, guest: true });
    }

    const progress = await getUserProgress(userId);
    const prefs = await getUserPrefs(userId);
    const communities = await getUserCommunities(userId);
    const otakuCred = await getOtakuCred(userId);

    // Fase 1: Sourcing — extraer candidatos
    let query = `
      SELECT fp.*, u.username, u.avatar, ur.username AS reposter_username, m.title AS manga_title, m.cover AS manga_cover,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies
      FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN users ur ON ur.id = fp.reposter_user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id
      WHERE fp.parent_id IS NULL AND fp.reposted_from_id IS NULL
    `;
    const params = [];
    let paramIdx = 1;

    if (tag) {
      query += ` AND fp.post_type = $${paramIdx}`;
      params.push(tag.toLowerCase());
      paramIdx++;
    }

    if (communities.length > 0) {
      query += ` AND (fp.community_id = ANY($${paramIdx}) OR fp.community_id IS NULL)`;
      params.push(communities);
      paramIdx++;
    }

    const hiddenGenres = prefs.hidden_genre || [];
    if (hiddenGenres.length > 0) {
      query += ` AND (fp.manga_id IS NULL OR fp.manga_id NOT IN (
        SELECT mg.manga_id FROM manga_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE g.name = ANY($${paramIdx})
      ))`;
      params.push(hiddenGenres);
      paramIdx++;
    }

    query += ` ORDER BY fp.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx+1}`;
    params.push(limit * 2, offset); // traer el doble para mejor selección
    const result = await pool.query(query, params);
    let posts = result.rows;

    // Fase 2: Scoring con todos los sub-algoritmos
    let scoredPosts = await Promise.all(posts.map(async (post) => {
      let score = 50; // base

      const mangaId = post.manga_id;
      const prog = mangaId ? progress[mangaId] : null;

      // ── Spoiler blocker: ocultar si el usuario no ha llegado al capítulo ──
      if (post.is_spoiler || (prog && post.chapter_number && post.chapter_number > (prog.chapter || 0) + 5)) {
        return { ...post, score: -9999, spoiler: true, breakdown: { base: 0 } };
      }

      // ── Manga Mixer core ──
      if (prog && post.chapter_number) {
        const diff = Math.abs(post.chapter_number - (prog.chapter || 0));
        if (diff <= 5) score += 25;
        else if (diff <= 20) score += 10;
        if (post.chapter_number > (prog.chapter || 0) + 10) score -= 15;
      }
      // ── Estado de la obra según biblioteca (con prioridades) ──
      let statusBonus = 0;
      let statusLabel = '';
      if (prog) {
        // Prioridad 1: Abandonado (gana a todo)
        if (prog.status === 'dropped') {
          statusBonus = -60;
          statusLabel = 'Abandonado';
        }
        // Prioridad 2: Terminado (gana a favorito)
        else if (prog.status === 'completed') {
          statusBonus = 15;
          statusLabel = 'Terminado';
        }
        // Prioridad 3: Favorito (gana a leyendo/continuando/pendiente/releyendo)
        else if (prog.is_favorite) {
          statusBonus = 50;
          statusLabel = 'Favorito';
        }
        // Resto: bonus normal de cada estado
        else {
          switch (prog.status) {
            case 'rereading': statusBonus = 40; statusLabel = 'Releyendo'; break;
            case 'reading': statusBonus = 30; statusLabel = 'Leyendo'; break;
            case 'continuing': statusBonus = 20; statusLabel = 'Continuando'; break;
            case 'planned': case 'plan_to_read': statusBonus = 5; statusLabel = 'Pendiente'; break;
          }
        }
      }
      score += statusBonus;
      if (post.community_id && communities.includes(post.community_id)) score += 15;
      const hoursAge = (Date.now() - new Date(post.created_at).getTime()) / 3600000;
      score += Math.max(0, 10 - hoursAge / 2);

      // ── Follow bonus: +100 si el usuario sigue al autor ──
      let followBonus = 0;
      try {
        const f = await pool.query('SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = $2', [userId, post.user_id]);
        if (f.rows.length > 0) followBonus = 100;
      } catch(e) {}
      score += followBonus;

      // ── Community penalty: -50 si el post es de una comunidad ajena ──
      let communityPenalty = 0;
      if (post.community_id && !communities.includes(post.community_id)) {
        communityPenalty = -50;
      }
      score += communityPenalty;

      // ── OtakuCred: peso según reputación del autor ──
      const authorCred = await getPostOtakuCred(post.user_id);
      const textGenre = classifyText(post.content + ' ' + (post.title || ''));
      const credScore = authorCred[textGenre] || authorCred.general || 100;
      score += (credScore - 100) * 0.3; // +/- según cred

      // ── FandomJet: conexiones en el grafo ──
      const fjScore = await fandomJetScore(userId, post.user_id, mangaId, post.community_id);
      score += fjScore;

      // ── Safety: penalizar spoilers y toxicidad ──
      const safety = await safetyCheck(post.content, post.title);
      score -= safety.spoilerPenalty;
      score -= safety.toxicityPenalty;
      let spoilerFlag = post.is_spoiler || safety.isLeak;

      // Si el usuario no ha alcanzado ese capítulo → spoiler adicional
      if (!spoilerFlag && prog && post.chapter_number && post.chapter_number > (prog.chapter || 0) + 5) {
        spoilerFlag = true;
      }

      // ── Repost: bonus de difusión ──
      const repostCount = parseInt(post.repost_count) || 0;
      const repostBonus = Math.min(repostCount * 3, 30); // máx 30 puntos
      score = score + repostBonus;

      // ── Fatiga: reducir monotonía ──
      const fatigueMul = await getFatigueMultiplier(userId, mangaId, post.community_id, sessionId);
      const preFatigueScore = score;
      score = score * fatigueMul;

      // Guardar componentes para auditoría
      const breakdown = {
        base: 50,
        readingAffinity: prog && post.chapter_number ? (Math.abs(post.chapter_number - (prog.chapter || 0)) <= 5 ? 25 : 10) : 0,
        communityFactor: post.community_id && communities.includes(post.community_id) ? 15 : 0,
        followBonus: followBonus,
        communityPenalty: communityPenalty,
        recencyBonus: Math.round(Math.max(0, 10 - hoursAge / 2)),
        fandomJet: fjScore,
        otakuCredBonus: Math.round((credScore - 100) * 0.3),
        repostBonus: repostBonus,
        safetyPenalty: safety.spoilerPenalty + safety.toxicityPenalty,
        statusBonus: statusBonus,
        chapterAheadPenalty: prog && post.chapter_number && post.chapter_number > (prog.chapter || 0) + 10 ? -15 : 0,
        fatigueMul: Math.round(fatigueMul * 100) / 100,
        antesDeFatiga: Math.round(preFatigueScore),
      };

      // Spoiler flag final
      if (safety.spoilerPenalty >= 15) spoilerFlag = true;

      return { ...post, score, spoiler: spoilerFlag, breakdown };
    }));

    // Filtrar posts bloqueados por spoiler y ordenar
    scoredPosts = scoredPosts.filter(p => p.score > -9999);
    scoredPosts.sort((a, b) => b.score - a.score);
    const topPosts = scoredPosts.slice(0, limit);

    // Guardar orden completo en caché para mantener feed estable
    forYouCache.set(cacheKey, { ts: Date.now(), ids: scoredPosts.map(p => p.id) });

    // Registrar fatiga para los posts mostrados
    await Promise.all(topPosts.map(p => incrementFatigue(userId, p.manga_id, p.community_id, sessionId)));


    // Formatear respuesta
    const formatted = topPosts.map(post => ({
      id: post.id,
      user: post.username || 'Anónimo',
      handle: `@${(post.username || 'anon').toLowerCase()}`,
      avatar: post.avatar || null,
      text: post.content || '',
      title: post.title || '',
      type: post.post_type || 'post',
      manga: post.manga_title ? { id: post.manga_id, title: post.manga_title, cover: post.manga_cover || null } : undefined,
      chapter: post.chapter_number,
      spoiler: post.spoiler,
      media_url: post.media_url || null,
      parent_id: post.parent_id || null,
      score: Math.round(post.score),
      scoreBreakdown: post.breakdown,
      likes: parseInt(post.real_likes) || 0,
      replies: parseInt(post.real_replies) || 0,
      reposts: parseInt(post.real_reposts) || 0,
      views_count: parseInt(post.views_count) || 0,
      author_role: post.author_role || 'user',
      created_at: post.created_at,
    }));

    const enriched = await enrichPosts(formatted, req.user?.userId);
    res.json({ feed_type: 'Para Ti', posts: enriched, offset, limit, session: sessionId });

  } catch (err) {
    console.error('[feed] Error en for-you:', err.message);
    res.status(500).json({ error: 'Error al generar feed' });
  }
});

// 🚪 [GET] /api/feed/latest
// 👤 Permiso: público (auth opcional para enrichPosts)
// 📥 Query: ?limit=25&offset=0
// 📤 Respuesta: { feed_type, posts[], offset, limit }
// 📝 Feed cronológico: últimos posts, sin algoritmo de scoring.
router.get('/latest', optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 50);
    const offset = parseInt(req.query.offset) || 0;
    const tag = req.query.tag || null;

    let queryStr = `
      SELECT fp.*, u.username, u.avatar, ur.username AS reposter_username, m.title AS manga_title, m.cover AS manga_cover,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies
      FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN users ur ON ur.id = fp.reposter_user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id
      WHERE fp.parent_id IS NULL AND fp.reposted_from_id IS NULL
    `;
    let queryParams = [];
    let paramIdx = 1;

    if (tag) {
      queryStr += ` AND fp.post_type = $${paramIdx}`;
      queryParams.push(tag.toLowerCase());
      paramIdx++;
    }

    queryStr += ` ORDER BY fp.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    queryParams.push(limit, offset);

    const result = await pool.query(queryStr, queryParams);

    let posts = result.rows.map(post => ({
      id: post.id,
      user: post.username || 'Anónimo',
      handle: `@${(post.username || 'anon').toLowerCase()}`,
      avatar: post.avatar || null,
      text: post.content || '',
      type: post.post_type || 'post',
      manga: post.manga_title ? { id: post.manga_id, title: post.manga_title, cover: post.manga_cover || null } : undefined,
      chapter: post.chapter_number,
      spoiler: post.is_spoiler,
      media_url: post.media_url || null,
      parent_id: post.parent_id || null,
      likes: parseInt(post.real_likes) || 0,
      replies: parseInt(post.real_replies) || 0,
      reposts: parseInt(post.real_reposts) || 0,
      views_count: parseInt(post.views_count) || 0,
      author_role: post.author_role || 'user',
      created_at: post.created_at,
    }));

    posts = await enrichPosts(posts, req.user?.userId || null);
    res.json({ feed_type: 'Últimos', posts, offset, limit });

  } catch (err) {
    console.error('[feed] Error en latest:', err.message);
    res.status(500).json({ error: 'Error al obtener feed' });
  }
});

// 🚪 [POST] /api/feed/interact
// 👤 Permiso: auth
// 📥 Body: { post_id, interaction_type, metadata? }
// 📤 Respuesta: { success, action: 'added'|'removed' }
// 📝 Toggle para likes/reposts/bookmarks (DELETE si ya existe).
//      Hide/mute/report son acciones únicas.
//      Emite WebSocket a 'post:<id>' y notifica al autor.
router.post('/interact', auth, async (req, res) => {
  try {
    const { post_id, interaction_type, metadata } = req.body;
    if (!post_id || !interaction_type) {
      return res.status(400).json({ error: 'post_id e interaction_type requeridos' });
    }

    const validTypes = ['like', 'repost', 'reply', 'bookmark', 'hide', 'mute', 'report', 'spoiler_revealed'];
    if (!validTypes.includes(interaction_type)) {
      return res.status(400).json({ error: 'Tipo de interacción inválido' });
    }

    // Toggle para like, repost, bookmark — el resto son acciones únicas
    const toggleTypes = ['like', 'repost', 'bookmark'];
    let action = 'added';

    if (toggleTypes.includes(interaction_type)) {
      // Verificar si ya existe
      const existing = await pool.query(
        'SELECT id FROM feed_interactions WHERE user_id = $1 AND post_id = $2 AND interaction_type = $3',
        [req.user.userId, post_id, interaction_type]
      );

      if (existing.rows.length > 0) {
        // Ya existe → eliminar (unlike, etc.)
        await pool.query('DELETE FROM feed_interactions WHERE id = $1', [existing.rows[0].id]);
        action = 'removed';
      } else {
        // No existe → insertar
        await pool.query(`
          INSERT INTO feed_interactions (user_id, post_id, interaction_type, metadata)
          VALUES ($1, $2, $3, $4)
        `, [req.user.userId, post_id, interaction_type, JSON.stringify(metadata || {})]);
      }

      // Actualizar contador en caché
      const deltaKey = interaction_type === 'like' ? 'likes' : interaction_type === 'repost' ? 'reposts' : null;
      if (deltaKey) {
        const delta = global.interactionDeltas.get(post_id) || { likes:0, reposts:0, replies:0 };
        delta[deltaKey] = (delta[deltaKey] || 0) + (action === 'added' ? 1 : -1);
        global.interactionDeltas.set(post_id, delta);
      }

      // WebSocket: notificar a los suscriptores del post
      if (global.io) {
        global.io.to('post:' + post_id).emit('interaction-update', {
          post_id, interaction_type, action,
          actor_id: req.user.userId,
        });
      }
    } else {
      // Acciones no toggle (hide, mute, report, spoiler_revealed)
      await pool.query(`
        INSERT INTO feed_interactions (user_id, post_id, interaction_type, metadata)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, post_id, interaction_type)
        DO UPDATE SET created_at = CURRENT_TIMESTAMP, metadata = EXCLUDED.metadata
      `, [req.user.userId, post_id, interaction_type, JSON.stringify(metadata || {})]);

      // Si es "hide" con manga_id, añadir a preferencias
      if (interaction_type === 'hide' && metadata?.manga_id) {
        await pool.query(`
          INSERT INTO feed_preferences (user_id, pref_type, pref_value)
          VALUES ($1, 'hidden_manga', $2)
          ON CONFLICT (user_id, pref_type, pref_value) DO NOTHING
        `, [req.user.userId, metadata.manga_id]);
      }
    }

    // Notificación al autor del post (solo si fue añadido, no removido)
    if (action === 'added' && (interaction_type === 'like' || interaction_type === 'repost' || interaction_type === 'bookmark')) {
      const author = await pool.query('SELECT user_id, manga_id FROM feed_posts WHERE id = $1', [post_id]);
      if (author.rows.length > 0 && author.rows[0].user_id !== req.user.userId) {
        const authorId = author.rows[0].user_id;
        await pool.query(`
          INSERT INTO feed_notifications (user_id, actor_id, post_id, notification_type)
          VALUES ($1, $2, $3, $4)
        `, [authorId, req.user.userId, post_id, interaction_type]);

        // OtakuCred: sumar puntaje según tipo de interacción
        const credField = interaction_type === 'like' ? 'total_likes_received' : interaction_type === 'repost' ? 'total_reposts' : 'total_bookmarks';
        await pool.query(`
          INSERT INTO otaku_cred (user_id, category, score, ${credField})
          VALUES ($1, 'general', 100, 1)
          ON CONFLICT (user_id, category)
          DO UPDATE SET ${credField} = otaku_cred.${credField} + 1,
                        score = 100 + (otaku_cred.total_likes_received * 0.5) + (otaku_cred.total_reposts * 0.3) + (otaku_cred.total_bookmarks * 0.2) - (otaku_cred.total_reports * 2),
                        updated_at = CURRENT_TIMESTAMP
        `, [authorId]);

        // FandomGraph: arista entre el que repostea y el autor
        if (interaction_type === 'repost') {
          await pool.query(`
            INSERT INTO fandom_graph (source_type, source_id, target_type, target_id, weight, interaction_count)
            VALUES ('user', $1, 'user', $2, 1.0, 1)
            ON CONFLICT (source_type, source_id, target_type, target_id)
            DO UPDATE SET weight = LEAST(fandom_graph.weight + 0.5, 5.0),
                          interaction_count = fandom_graph.interaction_count + 1,
                          updated_at = CURRENT_TIMESTAMP
          `, [req.user.userId, authorId]);

          // FandomGraph: arista entre el que repostea y el manga del post
          const mangaId = author.rows[0].manga_id;
          if (mangaId) {
            await pool.query(`
              INSERT INTO fandom_graph (source_type, source_id, target_type, target_id, weight, interaction_count)
              VALUES ('user', $1, 'manga', $2, 1.0, 1)
              ON CONFLICT (source_type, source_id, target_type, target_id)
              DO UPDATE SET weight = LEAST(fandom_graph.weight + 0.5, 5.0),
                            interaction_count = fandom_graph.interaction_count + 1,
                            updated_at = CURRENT_TIMESTAMP
            `, [req.user.userId, mangaId]);
          }
        }
      }
    }

    res.json({ success: true, action });

  } catch (err) {
    console.error('[feed] Error en interact:', err.message);
    res.status(500).json({ error: 'Error al registrar interacción' });
  }
});

// 🚪 [POST] /api/feed/track-views
// 👤 Permiso: auth
// 📥 Body: { post_ids: number[] }
// 📤 Respuesta: { success, tracked: number }
// 📝 Anti-fraude: solo cuenta vistas si no hay registro en las últimas 4h.
//      Incrementa views_count en feed_posts y registra en viewed_posts.
router.post('/track-views', auth, async (req, res) => {
  try {
    const { post_ids } = req.body;
    if (!post_ids || !post_ids.length) return res.json({ success: true, tracked: 0 });

    const seen = await pool.query(
      'SELECT post_id FROM viewed_posts WHERE user_id = $1 AND viewed_at > NOW() - INTERVAL \'4 hours\'',
      [req.user.userId]
    );
    const seenSet = new Set(seen.rows.map(r => r.post_id));
    const newIds = post_ids.filter(id => !seenSet.has(id));

    if (newIds.length === 0) return res.json({ success: true, tracked: 0 });

    // UPDATE e INSERT en paralelo, si uno falla, ninguno se confirma
    await Promise.all([
      pool.query('UPDATE feed_posts SET views_count = views_count + 1 WHERE id = ANY($1)', [newIds]),
      (() => {
        const params = [];
        newIds.forEach(id => { params.push(id, req.user.userId); });
        const placeholders = newIds.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, NOW())`).join(',');
        return pool.query(`
          INSERT INTO viewed_posts (post_id, user_id, viewed_at)
          VALUES ${placeholders}
          ON CONFLICT (post_id, user_id) DO UPDATE SET viewed_at = NOW()
        `, params);
      })()
    ]);

    res.json({ success: true, tracked: newIds.length });
  } catch (err) {
    console.error('[feed] Error en track-views:', err.message);
    res.status(500).json({ error: 'Error al registrar vistas' });
  }
});

// 🚪 [GET] /api/feed/company-posts
// 👤 Permiso: público (auth opcional)
// 📥 Query: ?user_id=<id>
// 📤 Respuesta: { success, posts[] }
// 📝 Posts de un creador/company (is_news o is_global_announcement).
router.get('/company-posts', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });

    let userId = null;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) { const u = await verifyToken(token); userId = u.userId; }
    } catch(e) {}

    const result = await pool.query(`
      SELECT fp.id, fp.content, fp.title, fp.post_type, fp.chapter_number, fp.is_spoiler,
             fp.community_id, fp.manga_id, fp.media_url, fp.created_at, fp.views_count,
             fp.parent_id, fp.quoted_post_id,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies,
             u.username, u.avatar, m.title AS manga_title, m.cover AS manga_cover,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role
      FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id
      WHERE fp.parent_id IS NULL AND fp.user_id = $1 AND (fp.is_news = true OR fp.is_global_announcement = true)
      ORDER BY fp.created_at DESC LIMIT 25
    `, [user_id]);

    let posts = result.rows.map(p => ({
      id: p.id, user: p.username || 'Anónimo',
      handle: `@${(p.username || 'anon').toLowerCase()}`,
      avatar: p.avatar || null, text: p.content || '',
      title: p.title || '', type: p.post_type || 'post',
      manga: p.manga_title ? { id: p.manga_id, title: p.manga_title, cover: p.manga_cover || null } : undefined,
      chapter: p.chapter_number, spoiler: p.is_spoiler || false,
      media_url: p.media_url || null, parent_id: p.parent_id || null,
      quoted_post_id: p.quoted_post_id || null,
      likes: parseInt(p.real_likes) || 0, replies: parseInt(p.real_replies) || 0,
      reposts: parseInt(p.real_reposts) || 0,
      views_count: parseInt(p.views_count) || 0,
      author_role: p.author_role || 'user', created_at: p.created_at,
    }));

    posts = await enrichPosts(posts, userId);
    res.json({ success: true, posts });
  } catch (err) {
    console.error('[feed] Error en company-posts:', err.message);
    res.status(500).json({ error: 'Error al obtener posts' });
  }
});

// 🚪 [GET] /api/feed/profile-activity
// 👤 Permiso: público (auth opcional)
// 📥 Query: ?user_id=<id>&type=posts|replies|media|likes&limit=25&offset=0
// 📤 Respuesta: { success, posts[] }
// 📝 Filtra la actividad de un perfil según el tipo solicitado.
router.get('/profile-activity', async (req, res) => {
  try {
    const { user_id, type, limit, offset } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const lim = Math.min(parseInt(limit) || 25, 50);
    const off = parseInt(offset) || 0;

    // Auth opcional para enrichPosts
    let userId = null;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) { const u = await verifyToken(token); userId = u.userId; }
    } catch(e) {}

    const selectBase = `
      SELECT fp.id, fp.content, fp.title, fp.post_type, fp.chapter_number, fp.is_spoiler,
             fp.community_id, fp.manga_id, fp.media_url, fp.created_at, fp.views_count,
             fp.parent_id, fp.quoted_post_id,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies,
             u.username, u.avatar, ur.username AS reposter_username, m.title AS manga_title, m.cover AS manga_cover,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
             (SELECT u2.username FROM feed_posts fp2 JOIN users u2 ON u2.id = fp2.user_id WHERE fp2.id = fp.parent_id) AS reply_to_user
    `;
    const joins = `FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN users ur ON ur.id = fp.reposter_user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id`;
    const order = `ORDER BY fp.created_at DESC LIMIT $2 OFFSET $3`;

    let query, params;
    if (type === 'replies') {
      query = `
        SELECT fp.id, fp.content, fp.title, fp.post_type, fp.chapter_number, fp.is_spoiler,
               fp.community_id, fp.manga_id, fp.media_url, fp.created_at, fp.views_count,
               fp.parent_id, fp.quoted_post_id,
               (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
               (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
               (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies,
               u.username, u.avatar,
               (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
               p_fp.content AS parent_text, p_fp.user_id AS parent_user_id,
               p_fp.created_at AS parent_created_at, p_fp.media_url AS parent_media_url,
               p_fp.views_count AS parent_views_count,
               p_u.username AS parent_username, p_u.avatar AS parent_avatar,
               (SELECT role FROM user_with_role WHERE id = p_fp.user_id) AS parent_author_role
        FROM feed_posts fp
        LEFT JOIN users u ON u.id = fp.user_id
        LEFT JOIN feed_posts p_fp ON p_fp.id = fp.parent_id
        LEFT JOIN users p_u ON p_u.id = p_fp.user_id
        WHERE fp.user_id = $1 AND fp.parent_id IS NOT NULL
        ORDER BY fp.created_at DESC LIMIT $2 OFFSET $3
      `;
      params = [user_id, lim, off];
    } else if (type === 'media') {
      query = selectBase + joins + ` WHERE fp.user_id = $1 AND fp.media_url IS NOT NULL ` + order;
      params = [user_id, lim, off];
    } else if (type === 'likes') {
      query = selectBase + `
        FROM feed_interactions fi
        JOIN feed_posts fp ON fp.id = fi.post_id
        LEFT JOIN users u ON u.id = fp.user_id
        LEFT JOIN users ur ON ur.id = fp.reposter_user_id
        LEFT JOIN mangas m ON m.id = fp.manga_id
        WHERE fi.user_id = $1 AND fi.interaction_type = 'like' AND fp.parent_id IS NULL ` + order;
      params = [user_id, lim, off];
    } else {
      // default: posts propios + repostes del usuario
      query = selectBase + joins + ` WHERE ((fp.user_id = $1 AND fp.parent_id IS NULL AND fp.community_id IS NULL) OR (fp.reposter_user_id = $1)) ` + order;
      params = [user_id, lim, off];
    }

    const result = await pool.query(query, params);
    console.log('[profile-activity] Query ejecutada. Tipo:', type, 'Filas:', result.rows.length);
    result.rows.forEach(r => console.log('  → id:', r.id, 'user_id:', r.user_id, 'reposter_user_id:', r.reposter_user_id, 'reposter_username:', r.reposter_username));

    let posts = result.rows.map(p => ({
      id: p.id, user: p.username || 'Anónimo',
      handle: `@${(p.username || 'anon').toLowerCase()}`,
      avatar: p.avatar || null, text: p.content || '',
      title: p.title || '', type: p.post_type || 'post',
      manga: p.manga_title ? { id: p.manga_id, title: p.manga_title, cover: p.manga_cover || null } : undefined,
      chapter: p.chapter_number, spoiler: p.is_spoiler || false,
      media_url: p.media_url || null, parent_id: p.parent_id || null,
      quoted_post_id: p.quoted_post_id || null,
      replyToUser: p.reply_to_user || null,
      reposter_username: p.reposter_username || null,
      parent_post: p.parent_username ? {
        id: p.parent_id, content: p.parent_text, text: p.parent_text,
        created_at: p.parent_created_at, media_url: p.parent_media_url || null,
        likes: 0, replies: 0, reposts: 0,
        views_count: parseInt(p.parent_views_count) || 0,
        user: p.parent_username, handle: `@${p.parent_username.toLowerCase()}`,
        avatar: p.parent_avatar, author_role: p.parent_author_role || 'user'
      } : null,
      likes: parseInt(p.real_likes) || 0, replies: parseInt(p.real_replies) || 0,
      reposts: parseInt(p.real_reposts) || 0,
      views_count: parseInt(p.views_count) || 0,
      author_role: p.author_role || 'user', created_at: p.created_at,
    }));

    posts = await enrichPosts(posts, userId);
    res.json({ success: true, posts });

  } catch (err) {
    console.error('[feed] Error en profile-activity:', err.message);
    res.status(500).json({ error: 'Error al obtener actividad' });
  }
});

// 🚪 [POST] /api/feed/pin-post
// 👤 Permiso: auth (solo dueño del post)
// 📥 Body: { post_id }
// 📤 Respuesta: { success, pinned: true, post_id }
// 📝 Fija un post en la cabecera del perfil del usuario.
router.post('/pin-post', auth, async (req, res) => {
  try {
    const { post_id } = req.body;
    if (!post_id) return res.status(400).json({ error: 'post_id requerido' });
    const r = await pool.query('SELECT user_id FROM feed_posts WHERE id = $1', [post_id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Post no encontrado' });
    if (r.rows[0].user_id !== req.user.userId)
      return res.status(403).json({ error: 'No puedes fijar un post que no es tuyo' });
    await pool.query('UPDATE users SET pinned_post_id = $1 WHERE id = $2', [post_id, req.user.userId]);
    res.json({ success: true, pinned: true, post_id });
  } catch (err) {
    console.error('[feed] Error en pin-post:', err.message);
    res.status(500).json({ error: 'Error al fijar post' });
  }
});

// 🚪 [POST] /api/feed/unpin-post
// 👤 Permiso: auth
// 📤 Respuesta: { success, pinned: false }
// 📝 Elimina el post fijado del perfil del usuario.
router.post('/unpin-post', auth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET pinned_post_id = NULL WHERE id = $1', [req.user.userId]);
    res.json({ success: true, pinned: false });
  } catch (err) {
    console.error('[feed] Error en unpin-post:', err.message);
    res.status(500).json({ error: 'Error al desfijar post' });
  }
});

// 🚪 [GET] /api/feed/user-posts/:userId
// 👤 Permiso: público
// 📤 Respuesta: { success, pinned_post, posts[] }
// 📝 Posts de un usuario (excluye el fijado que se devuelve aparte).
router.get('/user-posts/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    // Obtener pinned_post_id del usuario
    const userR = await pool.query('SELECT pinned_post_id, username FROM users WHERE id = $1', [userId]);
    if (!userR.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const pinnedId = userR.rows[0].pinned_post_id;
    let pinnedPost = null;

    // Si tiene post fijado, traerlo
    if (pinnedId) {
      const r = await pool.query(`
        SELECT fp.*, u.username, u.avatar, m.title AS manga_title,
               (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
               (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
               (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
               (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies
        FROM feed_posts fp
        LEFT JOIN users u ON u.id = fp.user_id
        LEFT JOIN mangas m ON m.id = fp.manga_id
        WHERE fp.id = $1
      `, [pinnedId]);
      if (r.rows.length) {
        const p = r.rows[0];
        pinnedPost = {
          id: p.id, user: p.username, avatar: p.avatar, text: p.content,
          media_url: p.media_url, created_at: p.created_at,
          likes: parseInt(p.real_likes) || 0, replies: parseInt(p.real_replies) || 0,
          reposts: parseInt(p.real_reposts) || 0, views_count: parseInt(p.views_count) || 0,
          author_role: p.author_role || 'user',
          manga: p.manga_title ? { id: p.manga_id, title: p.manga_title } : undefined,
        };
      }
    }

    // Traer posts del usuario + repostes que hizo (excluyendo el fijado)
    const postsR = await pool.query(`
      SELECT fp.*, u.username, u.avatar, m.title AS manga_title,
             ur.username AS reposter_username,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies
      FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN users ur ON ur.id = fp.reposter_user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id
      WHERE (fp.user_id = $1 OR fp.reposter_user_id = $1) AND fp.parent_id IS NULL
        AND ($2::INTEGER IS NULL OR fp.id <> $2)
      ORDER BY fp.created_at DESC LIMIT 25
    `, [userId, pinnedId]);

    const posts = postsR.rows.map(p => ({
      id: p.id, user: p.username || 'Anónimo',
      handle: `@${(p.username || 'anon').toLowerCase()}`,
      avatar: p.avatar || null, text: p.content || '', type: p.post_type || 'post',
      media_url: p.media_url || null,
      manga: p.manga_title ? { id: p.manga_id, title: p.manga_title } : undefined,
      chapter: p.chapter_number, spoiler: p.is_spoiler || false,
      likes: parseInt(p.real_likes) || 0, replies: parseInt(p.real_replies) || 0,
      reposts: parseInt(p.real_reposts) || 0, views_count: parseInt(p.views_count) || 0,
      author_role: p.author_role || 'user', created_at: p.created_at,
      reposter_username: p.reposter_username || null,
    }));

    res.json({ success: true, pinned_post: pinnedPost, posts });
  } catch (err) {
    console.error('[feed] Error en user-posts:', err.message);
    res.status(500).json({ error: 'Error al obtener posts' });
  }
});

// 🚪 [GET] /api/feed/replies/:postId
// 👤 Permiso: público
// 📤 Respuesta: { success, replies[] }
// 📝 Respuestas de un post, ordenadas ascendentemente (máx 100).
router.get('/replies/:postId', async (req, res) => {
  try {
    const postId = parseInt(req.params.postId);
    if (!postId) return res.status(400).json({ error: 'post_id inválido' });

    const result = await pool.query(`
      SELECT fp.id, fp.content, fp.title, fp.post_type, fp.chapter_number, fp.is_spoiler,
             fp.community_id, fp.manga_id, fp.media_url, fp.created_at, fp.views_count,
             fp.parent_id,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies,
             u.username, u.avatar,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role,
             (SELECT u2.username FROM feed_posts fp2 JOIN users u2 ON u2.id = fp2.user_id WHERE fp2.id = fp.parent_id) AS reply_to_user
      FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      WHERE fp.parent_id = $1
      ORDER BY fp.created_at ASC
      LIMIT 100
    `, [postId]);

    const replies = result.rows.map(p => ({
      id: p.id,
      user: p.username || 'Anónimo',
      handle: `@${(p.username || 'anon').toLowerCase()}`,
      avatar: p.avatar || null,
      text: p.content || '',
      type: p.post_type || 'reply',
      spoiler: p.is_spoiler || false,
      parent_id: p.parent_id,
      replyToUser: p.reply_to_user || null,
      likes: parseInt(p.real_likes) || 0,
      replies: parseInt(p.real_replies) || 0,
      reposts: parseInt(p.real_reposts) || 0,
      views_count: parseInt(p.views_count) || 0,
      author_role: p.author_role || 'user',
      created_at: p.created_at,
    }));

    res.json({ success: true, replies });

  } catch (err) {
    console.error('[feed] Error en replies:', err.message);
    res.status(500).json({ error: 'Error al obtener respuestas' });
  }
});

// 🚪 [GET] /api/feed/notifications
// 👤 Permiso: auth
// 📥 Query: ?limit=20&offset=0
// 📤 Respuesta: { success, notifications[], unread_count }
// 📝 Notificaciones del usuario (likes, reposts, replies, bookmarks).
router.get('/notifications', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(`
      SELECT fn.id, fn.notification_type, fn.read, fn.created_at,
             fn.post_id, fn.actor_id,
             u.username AS actor_username, u.avatar AS actor_avatar
      FROM feed_notifications fn
      LEFT JOIN users u ON u.id = fn.actor_id
      WHERE fn.user_id = $1
      ORDER BY fn.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.userId, limit, offset]);

    const countResult = await pool.query(
      'SELECT COUNT(*) AS total FROM feed_notifications WHERE user_id = $1 AND read = false',
      [req.user.userId]
    );

    res.json({
      success: true,
      notifications: result.rows.map(n => ({
        id: n.id,
        type: n.notification_type,
        read: n.read,
        created_at: n.created_at,
        post_id: n.post_id,
        actor: { id: n.actor_id, username: n.actor_username || 'Anónimo', avatar: n.actor_avatar },
      })),
      unread_count: parseInt(countResult.rows[0].total),
    });
  } catch (err) {
    console.error('[feed] Error en notifications:', err.message);
    res.status(500).json({ error: 'Error al obtener notificaciones' });
  }
});

// 🚪 [POST] /api/feed/notifications/read
// 👤 Permiso: auth
// 📥 Body: { ids?: number[] } — si es null, marca todas
// 📤 Respuesta: { success }
// 📝 Marca notificaciones como leídas. Sin ids, marca todas.
router.post('/notifications/read', auth, async (req, res) => {
  try {
    const { ids } = req.body; // array opcional de IDs. Si es null, marca todas
    if (ids && Array.isArray(ids) && ids.length > 0) {
      await pool.query(
        'UPDATE feed_notifications SET read = true WHERE user_id = $1 AND id = ANY($2)',
        [req.user.userId, ids]
      );
    } else {
      await pool.query(
        'UPDATE feed_notifications SET read = true WHERE user_id = $1',
        [req.user.userId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[feed] Error al marcar leídas:', err.message);
    res.status(500).json({ error: 'Error al marcar notificaciones' });
  }
});

// 🚪 [POST] /api/feed/repost
// 👤 Permiso: auth
// 📥 Body: { post_id, community_id? }
// 📤 Respuesta: { success, action }
// 📝 Crea un repost. Inserta en reposts_manga y feed_interactions.
//      Emite WebSocket a 'post:<id>'.
router.post('/repost', auth, async (req, res) => {
  const { post_id } = req.body;
  const callerId = req.user.userId;
  console.log('[repost BACKEND] Usuario', callerId, 'solicita repostear post', post_id);
  if (!post_id) return res.status(400).json({ error: 'post_id requerido' });

  try {
    // Verificar si ya existe un clon de este repost (toggle)
    const existente = await pool.query(
      'SELECT id FROM feed_posts WHERE reposter_user_id = $1 AND reposted_from_id = $2',
      [callerId, post_id]
    );
    console.log('[repost BACKEND] Clon existente?', existente.rows.length > 0);
    if (existente.rows.length > 0) {
      await pool.query('DELETE FROM feed_posts WHERE id = $1', [existente.rows[0].id]);
      await pool.query("DELETE FROM feed_interactions WHERE user_id = $1 AND post_id = $2 AND interaction_type = 'repost'", [callerId, post_id]);
      console.log('[repost BACKEND] Clon eliminado (unrepost)');
      if (global.io) global.io.to('post:' + post_id).emit('interaction-update', { post_id, interaction_type:'repost', action:'removed', actor_id: callerId });
      return res.json({ success: true, action: 'unreposted' });
    }

    // Traer el post original con todas sus columnas
    const orig = await pool.query('SELECT * FROM feed_posts WHERE id = $1', [post_id]);
    if (!orig.rows.length) return res.status(404).json({ error: 'El post original no existe.' });

    const o = orig.rows[0];
    console.log('[repost BACKEND] Post original encontrado. user_id:', o.user_id, 'content:', (o.content || '').substring(0, 30));
    const realFromId = o.reposted_from_id || o.id;

    // Insertar el clon visual usando media_url
    await pool.query(
      `INSERT INTO feed_posts
        (user_id, content, manga_id, community_id, media_url, reposted_from_id, reposter_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [o.user_id, o.content, o.manga_id, o.community_id, o.media_url, realFromId, callerId]
    );
    // Insertar en feed_interactions para que enrichPosts lo detecte
    await pool.query(
      `INSERT INTO feed_interactions (user_id, post_id, interaction_type, metadata)
       VALUES ($1, $2, 'repost', '{}')
       ON CONFLICT (user_id, post_id, interaction_type) DO NOTHING`,
      [callerId, post_id]
    );
    console.log('[repost BACKEND] Clon creado exitosamente para post', post_id, 'por usuario', callerId);

    if (global.io) global.io.to('post:' + post_id).emit('interaction-update', { post_id, interaction_type:'repost', action:'added', actor_id: callerId });

    res.json({ success: true, action: 'reposted' });
  } catch (err) {
    console.error('[repost BACKEND] Error en POST /repost (clon):', err.message);
    console.error('[repost BACKEND] Stack:', err.stack);
    res.status(500).json({ error: 'Error al procesar el repost.' });
  }
});

// 🚪 [DELETE] /api/feed/repost
// 👤 Permiso: auth
// 📥 Body: { post_id }
// 📤 Respuesta: { success, action }
// 📝 Elimina un repost y decrementa el contador.
router.delete('/repost', auth, async (req, res) => {
  const { post_id } = req.body;
  if (!post_id) return res.status(400).json({ error: 'post_id requerido' });

  try {
    const r = await pool.query(
      'DELETE FROM feed_posts WHERE reposter_user_id = $1 AND reposted_from_id = $2 RETURNING id',
      [req.user.userId, post_id]
    );
    const deleted = r.rowCount > 0;
    if (deleted) {
      await pool.query("DELETE FROM feed_interactions WHERE user_id = $1 AND post_id = $2 AND interaction_type = 'repost'", [req.user.userId, post_id]);
      if (global.io) global.io.to('post:' + post_id).emit('interaction-update', { post_id, interaction_type:'repost', action:'removed', actor_id: req.user.userId });
    }
    res.json({ success: true, action: deleted ? 'unreposted' : 'none' });
  } catch (err) {
    console.error('[feed] Error al quitar repost:', err.message);
    res.status(500).json({ error: 'Error al quitar repost' });
  }
});

// 🚪 [GET] /api/feed/post/:id
// 👤 Permiso: público (auth opcional)
// 📤 Respuesta: { success, post, parent_post? }
// 📝 Post individual con contadores dinámicos (no cacheados).
//      Si tiene parent_id, trae el post padre como contexto.
router.get('/post/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // Auth opcional para flags de interacción (user_has_liked, etc.)
    let userId = null;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) { const u = await verifyToken(token); userId = u.userId; }
    } catch(e) {}

    const r = await pool.query(`
      SELECT fp.*, u.username, u.avatar, m.title AS manga_title, m.cover AS manga_cover,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role
      FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id
      WHERE fp.id = $1
    `, [id]);

    if (!r.rows.length) return res.status(404).json({ error: 'Post no encontrado' });
    const p = r.rows[0];

    // Enrich con flags de interacción del usuario (si autenticado)
    const enriched = await enrichPosts([p], userId);
    const post = enriched[0];

    // Recalcular contadores dinámicamente (no confiar en columnas cacheadas)
    try {
      const cnt = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM feed_posts WHERE parent_id = $1) AS real_replies,
          (SELECT COUNT(*) FROM feed_interactions WHERE post_id = $1 AND interaction_type = 'like') AS real_likes,
          (SELECT COUNT(*) FROM feed_interactions WHERE post_id = $1 AND interaction_type = 'repost') AS real_reposts,
          (SELECT COUNT(*) FROM feed_interactions WHERE post_id = $1 AND interaction_type = 'bookmark') AS real_bookmarks
      `, [id]);
      const cr = cnt.rows[0];
      post.reply_count = parseInt(cr.real_replies) || 0;
      post.like_count = parseInt(cr.real_likes) || 0;
      post.repost_count = parseInt(cr.real_reposts) || 0;
      post.bookmark_count = parseInt(cr.real_bookmarks) || 0;
    } catch(e) {}

    // Si el post tiene padre, traerlo para contexto
    let parentPost = null;
    if (post.parent_id) {
      try {
        const pr = await pool.query(`
          SELECT fp.*, u.username, u.avatar,
                 (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role
          FROM feed_posts fp
          LEFT JOIN users u ON u.id = fp.user_id
          WHERE fp.id = $1
        `, [post.parent_id]);
        if (pr.rows.length > 0) {
          const pEnriched = await enrichPosts([pr.rows[0]], userId);
          const pp = pEnriched[0];
          // Recalcular contadores del padre también
          try {
            const pc = await pool.query(`
              SELECT
                (SELECT COUNT(*) FROM feed_posts WHERE parent_id = $1) AS real_replies,
                (SELECT COUNT(*) FROM feed_interactions WHERE post_id = $1 AND interaction_type = 'like') AS real_likes,
                (SELECT COUNT(*) FROM feed_interactions WHERE post_id = $1 AND interaction_type = 'repost') AS real_reposts
            `, [pp.id]);
            const pcr = pc.rows[0];
            pp.reply_count = parseInt(pcr.real_replies) || 0;
            pp.like_count = parseInt(pcr.real_likes) || 0;
            pp.repost_count = parseInt(pcr.real_reposts) || 0;
          } catch(e) {}
          parentPost = {
            id: pp.id, user: pp.username || 'Anónimo', handle: `@${(pp.username||'anon').toLowerCase()}`,
            avatar: pp.avatar, text: pp.content, type: pp.post_type,
            spoiler: pp.is_spoiler, media_url: pp.media_url,
            views_count: parseInt(pp.views_count) || 0, author_role: pp.author_role || 'user',
            likes: parseInt(pp.like_count) || 0, reposts: parseInt(pp.repost_count) || 0,
            replies: parseInt(pp.reply_count) || 0,
            user_has_liked: pp.user_has_liked || false,
            user_has_reposted: pp.user_has_reposted || false,
            user_has_bookmarked: pp.user_has_bookmarked || false,
            created_at: pp.created_at,
          };
        }
      } catch(e) {}
    }

    res.json({
      success: true,
      post: {
        id: post.id, user: post.username || 'Anónimo', handle: `@${(post.username||'anon').toLowerCase()}`,
        avatar: post.avatar, text: post.content, type: post.post_type,
        manga: post.manga_title ? { id: post.manga_id, title: post.manga_title, cover: post.manga_cover || null } : undefined,
        chapter: post.chapter_number, spoiler: post.is_spoiler, media_url: post.media_url,
        views_count: parseInt(post.views_count) || 0, author_role: post.author_role || 'user',
        likes: parseInt(post.like_count) || 0, reposts: parseInt(post.repost_count) || 0,
        replies: parseInt(post.reply_count) || 0, bookmark_count: parseInt(post.bookmark_count) || 0,
        user_has_liked: post.user_has_liked || false,
        user_has_reposted: post.user_has_reposted || false,
        user_has_bookmarked: post.user_has_bookmarked || false,
        created_at: post.created_at,
        parent_id: post.parent_id,
      },
      parent_post: parentPost,
    });
  } catch (err) {
    console.error('[feed] Error en get post:', err.message);
    res.status(500).json({ error: 'Error al obtener post' });
  }
});

// 🚪 [POST] /api/feed/preferences
// 👤 Permiso: auth
// 📥 Body: { pref_type, pref_value, action?: 'add'|'remove' }
// 📤 Respuesta: { success }
// 📝 Gestiona preferencias de feed (géneros ocultos, mangas silenciados, etc.).
router.post('/preferences', auth, async (req, res) => {
  try {
    const { pref_type, pref_value, action } = req.body;
    if (!pref_type || !pref_value) {
      return res.status(400).json({ error: 'pref_type y pref_value requeridos' });
    }

    if (action === 'remove') {
      await pool.query(
        `DELETE FROM feed_preferences WHERE user_id = $1 AND pref_type = $2 AND pref_value = $3`,
        [req.user.userId, pref_type, pref_value]
      );
    } else {
      await pool.query(
        `INSERT INTO feed_preferences (user_id, pref_type, pref_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, pref_type, pref_value) DO NOTHING`,
        [req.user.userId, pref_type, pref_value]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[feed] Error en preferences:', err.message);
    res.status(500).json({ error: 'Error al actualizar preferencias' });
  }
});

// 🚪 [GET] /api/feed/cred
// 👤 Permiso: auth
// 📤 Respuesta: { creds[] }
// 📝 Devuelve el OtakuCred del usuario (reputación por categorías).
//      Si no tiene cred, retorna score base 100 en categoría 'general'.
router.get('/cred', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT category, score, total_posts, total_likes_received, total_bookmarks, total_reports
       FROM otaku_cred WHERE user_id = $1 ORDER BY score DESC`,
      [req.user.userId]
    );
    res.json({ creds: r.rows.length > 0 ? r.rows : [{ category: 'general', score: 100 }] });
  } catch (err) {
    console.error('[feed] Error en cred:', err.message);
    res.status(500).json({ error: 'Error al obtener cred' });
  }
});

// 🚪 [POST] /api/feed/post
// 👤 Permiso: auth
// 📥 Body: { content, manga_id?, chapter_number?, community_id?, parent_id?,
//           quoted_post_id?, is_spoiler?, post_type?, title?, media_url?,
//           is_news?, is_global_announcement? }
// 📤 Respuesta: { success, post: { id, created_at, user, avatar } }
// 📝 Publica un post. Si es reply, hereda spoiler del padre.
//      Admin/company/creator pueden marcar is_news; solo admin is_global.
//      Si se publica en comunidad sin manga_id, auto-vincula el KMI de la comunidad.
//      Incrementa OtakuCred del autor.
router.post('/post', auth, async (req, res) => {
  try {
    const { content, manga_id, chapter_number, post_type, is_spoiler, community_id, media_url, title, parent_id, quoted_post_id, is_news, is_global_announcement } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'El contenido del post no puede estar vacío' });
    }

    let spoiler = is_spoiler || false;

    // Validar flags de noticias según rango
    let canNews = false, canGlobal = false;
    const roleR = await pool.query("SELECT role FROM user_with_role WHERE id = $1", [req.user.userId]);
    const role = roleR.rows[0]?.role || 'user';
    if (['admin','company','creator'].includes(role)) canNews = true;
    if (role === 'admin') canGlobal = true;
    let finalIsNews = is_news && canNews;
    let finalIsGlobal = is_global_announcement && canGlobal;

    // Si es reply, heredar spoiler del post padre
    if (parent_id) {
      const parent = await pool.query('SELECT is_spoiler FROM feed_posts WHERE id = $1', [parent_id]);
      if (parent.rows.length > 0 && parent.rows[0].is_spoiler) {
        spoiler = true;
      }
    }

    // ── Prefijo automático + vinculación forzada según contexto ──
    let finalMangaId = manga_id || null;
    let commPrefix = null;
    let mangaPrefix = null;
    const prefixPromises = [];
    if (community_id) {
      prefixPromises.push(
        pool.query('SELECT name FROM communities WHERE id = $1', [community_id])
          .then(async (r) => {
            if (r.rows.length > 0) {
              const communityName = r.rows[0].name;
              commPrefix = `📢 [${communityName}]`;
              if (!finalMangaId) {
                try {
                  const mr = await pool.query('SELECT id, title FROM mangas WHERE title = $1 LIMIT 1', [communityName]);
                  if (mr.rows.length > 0) {
                    finalMangaId = mr.rows[0].id;
                    mangaPrefix = `📖 [${mr.rows[0].title}]`;
                  }
                } catch(e) {}
              }
            }
          })
          .catch(() => {})
      );
    }
    if (manga_id) {
      prefixPromises.push(
        pool.query('SELECT title FROM mangas WHERE id = $1', [manga_id])
          .then(r => { if (r.rows.length > 0) mangaPrefix = `📖 [${r.rows[0].title}]`; })
          .catch(() => {})
      );
    }
    await Promise.all(prefixPromises);
    const prefixStr = [mangaPrefix, commPrefix].filter(Boolean).join(' ');
    const finalContent = (prefixStr ? prefixStr + '\n' : '') + content.trim();

    const result = await pool.query(`
      INSERT INTO feed_posts (user_id, content, manga_id, chapter_number, post_type, is_spoiler, community_id, media_url, title, parent_id, quoted_post_id, is_news, is_global_announcement)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, created_at
    `, [req.user.userId, finalContent, finalMangaId, chapter_number || null, post_type || 'post', spoiler, community_id || null, media_url || null, title || '', parent_id || null, quoted_post_id || null, finalIsNews, finalIsGlobal]);

    const post = result.rows[0];

    // Si es reply, incrementar contador del padre
    if (parent_id) {
      const delta = global.interactionDeltas.get(parent_id) || { likes:0, reposts:0, replies:0 };
      delta.replies = (delta.replies || 0) + 1;
      global.interactionDeltas.set(parent_id, delta);

      // Emitir WebSocket al canal del padre
      if (global.io) global.io.to('post:' + parent_id).emit('new-reply', { post_id: post.id, parent_id });

      // Notificar al autor del post padre
      try {
        const parentPost = await pool.query('SELECT user_id FROM feed_posts WHERE id = $1', [parent_id]);
        if (parentPost.rows.length > 0) {
          const receptorId = parentPost.rows[0].user_id;
          if (receptorId !== req.user.userId) {
            await pool.query(`
              INSERT INTO feed_notifications (user_id, actor_id, post_id, notification_type, read, created_at)
              VALUES ($1, $2, $3, 'reply', false, NOW())
            `, [receptorId, req.user.userId, parent_id]);
          }
        }
      } catch (notifErr) {
        console.error('[feed] Error al crear notificación de reply:', notifErr.message);
      }
    }

    await pool.query(`
      INSERT INTO otaku_cred (user_id, category, score, total_posts)
      VALUES ($1, 'general', 100, 1)
      ON CONFLICT (user_id, category)
      DO UPDATE SET total_posts = otaku_cred.total_posts + 1,
                    score = 100 + (otaku_cred.total_likes_received * 0.5) - (otaku_cred.total_reports * 2),
                    updated_at = CURRENT_TIMESTAMP
    `, [req.user.userId]);

    const userResult = await pool.query(`SELECT username, avatar FROM users WHERE id = $1`, [req.user.userId]);

    res.status(201).json({
      success: true,
      post: {
        id: post.id,
        created_at: post.created_at,
        user: userResult.rows[0]?.username || 'Anónimo',
        avatar: userResult.rows[0]?.avatar || null,
      }
    });

  } catch (err) {
    console.error('[feed] Error al crear post:', err.message);
    res.status(500).json({ error: 'Error interno al guardar el post' });
  }
});

// ── Helper: enriquecer posts con flags de interacción del usuario ──
async function enrichPosts(posts, userId) {
  if (!userId || !posts.length) {
    return posts.map(p => ({ ...p, user_has_liked: false, user_has_reposted: false, user_has_bookmarked: false }));
  }
  const ids = posts.map(p => p.id);
  const result = await pool.query(`
    SELECT post_id, interaction_type FROM feed_interactions
    WHERE user_id = $1 AND post_id = ANY($2)
  `, [userId, ids]);
  const intMap = {};
  result.rows.forEach(r => {
    if (!intMap[r.post_id]) intMap[r.post_id] = {};
    intMap[r.post_id][r.interaction_type] = true;
  });
  return posts.map(p => ({
    ...p,
    user_has_liked: !!intMap[p.id]?.like,
    user_has_reposted: !!intMap[p.id]?.repost,
    user_has_bookmarked: !!intMap[p.id]?.bookmark,
  }));
}

// 🚪 [GET] /api/feed/posts
// 👤 Permiso: público (auth opcional para enrichPosts)
// 📥 Query: ?limit=25&offset=0
// 📤 Respuesta: { success, posts[], offset, limit, total }
// 📝 Feed público cronológico. Usado por la pestaña "Mis Comunidades".
router.get('/posts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 50);
    const offset = parseInt(req.query.offset) || 0;
    const tag = req.query.tag || null;

    // Auth opcional — extraer userId si hay token
    let userId = null;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) { const u = await verifyToken(token); userId = u.userId; }
    } catch (e) {}

    let queryStr = `
      SELECT fp.id, fp.content, fp.title, fp.post_type, fp.chapter_number, fp.is_spoiler,
             fp.community_id, fp.manga_id, fp.media_url, fp.created_at, fp.views_count,
             fp.parent_id, fp.quoted_post_id,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies,
             u.username, u.avatar, ur.username AS reposter_username, m.title AS manga_title, m.cover AS manga_cover,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role
      FROM feed_posts fp
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN users ur ON ur.id = fp.reposter_user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id
      WHERE fp.parent_id IS NULL AND fp.reposted_from_id IS NULL
    `;
    let queryParams = [];
    let paramIdx = 1;

    if (tag) {
      queryStr += ` AND fp.post_type = $${paramIdx}`;
      queryParams.push(tag.toLowerCase());
      paramIdx++;
    }

    queryStr += ` ORDER BY fp.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    queryParams.push(limit, offset);

    const result = await pool.query(queryStr, queryParams);

    let posts = result.rows.map(p => ({
      id: p.id,
      user: p.username || 'Anónimo',
      handle: `@${(p.username || 'anon').toLowerCase()}`,
      avatar: p.avatar || null,
      text: p.content || '',
      title: p.title || '',
      type: p.post_type || 'post',
      manga: p.manga_title ? { id: p.manga_id, title: p.manga_title, cover: p.manga_cover || null } : undefined,
      chapter: p.chapter_number,
      spoiler: p.is_spoiler || false,
      media_url: p.media_url || null,
      parent_id: p.parent_id || null,
      quoted_post_id: p.quoted_post_id || null,
      likes: parseInt(p.real_likes) || 0,
      replies: parseInt(p.real_replies) || 0,
      reposts: parseInt(p.real_reposts) || 0,
      views_count: parseInt(p.views_count) || 0,
      author_role: p.author_role || 'user',
      created_at: p.created_at,
      reposter_username: p.reposter_username || null,
    }));

    posts = await enrichPosts(posts, userId);
    res.json({ success: true, posts, offset, limit, total: posts.length });

  } catch (err) {
    console.error('[feed] Error en posts:', err.message);
    res.status(500).json({ error: 'Error al obtener posts' });
  }
});

// 🚪 [GET] /api/feed/communities
// 👤 Permiso: auth
// 📥 Query: ?limit=25&offset=0
// 📤 Respuesta: { success, posts[], offset, limit }
// 📝 Posts de comunidades cuyos mangas el usuario sigue (via community_members).
router.get('/communities', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const limit = Math.min(parseInt(req.query.limit) || 25, 50);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(`
      SELECT DISTINCT ON (fp.id) fp.id, fp.content, fp.title, fp.post_type, fp.chapter_number, fp.is_spoiler,
             fp.community_id, fp.manga_id, fp.media_url, fp.created_at, fp.views_count,
             fp.parent_id, fp.quoted_post_id,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'like') AS real_likes,
             (SELECT COUNT(*) FROM feed_interactions fi WHERE fi.post_id = fp.id AND fi.interaction_type = 'repost') AS real_reposts,
             (SELECT COUNT(*) FROM feed_posts fp3 WHERE fp3.parent_id = fp.id) AS real_replies,
             u.username, u.avatar, m.title AS manga_title, m.cover AS manga_cover,
             (SELECT role FROM user_with_role WHERE id = fp.user_id) AS author_role
      FROM feed_posts fp
      JOIN communities c ON (fp.manga_id IS NOT NULL AND c.manga_id = fp.manga_id)
      JOIN community_members cm ON cm.community_id = c.id
      LEFT JOIN users u ON u.id = fp.user_id
      LEFT JOIN mangas m ON m.id = fp.manga_id
      WHERE cm.user_id = $1 AND fp.parent_id IS NULL
      ORDER BY fp.id, fp.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    let posts = result.rows.map(p => ({
      id: p.id, user: p.username || 'Anónimo',
      handle: `@${(p.username || 'anon').toLowerCase()}`,
      avatar: p.avatar || null, text: p.content || '',
      title: p.title || '', type: p.post_type || 'post',
      manga: p.manga_title ? { id: p.manga_id, title: p.manga_title, cover: p.manga_cover || null } : undefined,
      chapter: p.chapter_number, spoiler: p.is_spoiler || false,
      media_url: p.media_url || null, parent_id: p.parent_id || null,
      quoted_post_id: p.quoted_post_id || null,
      likes: parseInt(p.real_likes) || 0, replies: parseInt(p.real_replies) || 0,
      reposts: parseInt(p.real_reposts) || 0,
      views_count: parseInt(p.views_count) || 0,
      author_role: p.author_role || 'user', created_at: p.created_at,
    }));

    posts = await enrichPosts(posts, userId);
    res.json({ success: true, posts, offset, limit });

  } catch (err) {
    console.error('[feed] Error en communities feed:', err.message);
    res.status(500).json({ error: 'Error al obtener feed de comunidades' });
  }
});

// 🚪 [GET] /api/feed/gif-proxy
// 👤 Permiso: público
// 📥 Query: ?url=<encoded gif url>
// 📤 Respuesta: binary image (Content-Type del origen)
// 📝 Proxy para GIFs que evita bloqueos CORS/adblock.
//      Cachea en memoria (máx 100 entradas) con TTL implícito.
const gifProxyCache = {};

router.get('/gif-proxy', async (req, res) => {
  try {
    const gifUrl = req.query.url;
    if (!gifUrl) return res.status(400).end();

    if (gifProxyCache[gifUrl]) {
      res.set('Content-Type', gifProxyCache[gifUrl].type);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.end(gifProxyCache[gifUrl].data);
    }

    const parsed = urlModule.parse(gifUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const proxyReq = mod.get(gifUrl, { timeout: 8000 }, function(proxyRes) {
      if (proxyRes.statusCode >= 400) {
        return res.status(502).end();
      }
      const chunks = [];
      proxyRes.on('data', function(c) { chunks.push(c); });
      proxyRes.on('end', function() {
        const buf = Buffer.concat(chunks);
        const contentType = proxyRes.headers['content-type'] || 'image/gif';
        gifProxyCache[gifUrl] = { data: buf, type: contentType, time: Date.now() };
        // Limpiar caché si crece demasiado
        const keys = Object.keys(gifProxyCache);
        if (keys.length > 100) {
          const oldest = keys.sort((a,b) => gifProxyCache[a].time - gifProxyCache[b].time).slice(0,50);
          oldest.forEach(function(k) { delete gifProxyCache[k]; });
        }
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.end(buf);
      });
    });
    proxyReq.on('error', function() { res.status(502).end(); });
    proxyReq.setTimeout(8000, function() { proxyReq.destroy(); res.status(504).end(); });
  } catch (e) {
    res.status(500).end();
  }
});

// 🚪 [GET] /api/feed/gif-search
// 👤 Permiso: público
// 📥 Query: ?q=<término>&limit=30
// 📤 Respuesta: { success, results[], next }
// 📝 Busca GIFs vía Giphy API (si hay GIPHY_API_KEY) o usa muestra local.
//      Los resultados pasan por gif-proxy para evitar bloqueos.
function proxyUrl(cdnUrl) {
  return '/api/feed/gif-proxy?url=' + encodeURIComponent(cdnUrl);
}

const SAMPLE_GIFS = [
  { id:'s1',  title:'Abrazo',      cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif') },
  { id:'s2',  title:'Aplauso',     cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7aD2saAlB5fayzGU/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7aD2saAlB5fayzGU/giphy.gif') },
  { id:'s3',  title:'Triste',      cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif') },
  { id:'s4',  title:'Felicidad',   cat:'reaction', url:proxyUrl('https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif') },
  { id:'s5',  title:'Enfado',      cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3oFzmdNTei3Mqj0e4w/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3oFzmdNTei3Mqj0e4w/giphy.gif') },
  { id:'s6',  title:'Sorpresa',    cat:'reaction', url:proxyUrl('https://media.giphy.com/media/l0HlNQ03J5JxX6lI4/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0HlNQ03J5JxX6lI4/giphy.gif') },
  { id:'s7',  title:'Baile',       cat:'reaction', url:proxyUrl('https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif') },
  { id:'s8',  title:'Risa',        cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif') },
  { id:'s9',  title:'No',          cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7abGQ1ONC4bdvhIQ/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7abGQ1ONC4bdvhIQ/giphy.gif') },
  { id:'s10', title:'Sí',          cat:'reaction', url:proxyUrl('https://media.giphy.com/media/l0HlOBK6oF8x8H3Dm/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0HlOBK6oF8x8H3Dm/giphy.gif') },
  { id:'s11', title:'Gracias',     cat:'reaction', url:proxyUrl('https://media.giphy.com/media/l0HlL0kHlHlJqyXcI/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0HlL0kHlHlJqyXcI/giphy.gif') },
  { id:'s12', title:'Manga',       cat:'anime',    url:proxyUrl('https://media.giphy.com/media/l2JhA4mzGkRqeV5Ko/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l2JhA4mzGkRqeV5Ko/giphy.gif') },
  { id:'s13', title:'Anime',       cat:'anime',    url:proxyUrl('https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif') },
  { id:'s14', title:'Naruto',      cat:'anime',    url:proxyUrl('https://media.giphy.com/media/l0HlL0kHlHlJqyXcI/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0HlL0kHlHlJqyXcI/giphy.gif') },
  { id:'s15', title:'One Piece',   cat:'anime',    url:proxyUrl('https://media.giphy.com/media/l2JhA4mzGkRqeV5Ko/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l2JhA4mzGkRqeV5Ko/giphy.gif') },
  { id:'s16', title:'Dragon Ball', cat:'anime',    url:proxyUrl('https://media.giphy.com/media/l0HlNQ03J5JxX6lI4/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0HlNQ03J5JxX6lI4/giphy.gif') },
  { id:'s17', title:'Love',        cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif') },
  { id:'s18', title:'Wow',         cat:'reaction', url:proxyUrl('https://media.giphy.com/media/l0HlNQ03J5JxX6lI4/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0HlNQ03J5JxX6lI4/giphy.gif') },
  { id:'s19', title:'Tranquilo',   cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif') },
  { id:'s20', title:'Genial',      cat:'reaction', url:proxyUrl('https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif') },
  { id:'s21', title:'Beso',        cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif') },
  { id:'s22', title:'Llanto',      cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif') },
  { id:'s23', title:'Celebrar',    cat:'reaction', url:proxyUrl('https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif') },
  { id:'s24', title:'Saludar',     cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7aD2saAlB5fayzGU/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7aD2saAlB5fayzGU/giphy.gif') },
  { id:'s25', title:'Música',      cat:'reaction', url:proxyUrl('https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif') },
  { id:'s26', title:'Ojos',        cat:'reaction', url:proxyUrl('https://media.giphy.com/media/l0HlNQ03J5JxX6lI4/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l0HlNQ03J5JxX6lI4/giphy.gif') },
  { id:'s27', title:'Miedo',       cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3oFzmdNTei3Mqj0e4w/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3oFzmdNTei3Mqj0e4w/giphy.gif') },
  { id:'s28', title:'Fastidioso',  cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3oFzmdNTei3Mqj0e4w/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3oFzmdNTei3Mqj0e4w/giphy.gif') },
  { id:'s29', title:'Vergüenza',   cat:'reaction', url:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/3o7aeTanxBWK4IR3aE/giphy.gif') },
  { id:'s30', title:'Cómic',       cat:'anime',    url:proxyUrl('https://media.giphy.com/media/l2JhA4mzGkRqeV5Ko/giphy.gif'), preview:proxyUrl('https://media.giphy.com/media/l2JhA4mzGkRqeV5Ko/giphy.gif') },
];

router.get('/gif-search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const apiKey = process.env.GIPHY_API_KEY;

    // Si hay API key configurada, usar Giphy real
    if (apiKey) {
      try {
        const giphyUrl = query
          ? `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=${limit}&rating=g`
          : `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${limit}&rating=g`;

        const response = await fetch(giphyUrl);
        if (response.ok) {
          const data = await response.json();
          const results = (data.data || []).map(g => ({
            id: g.id,
            title: g.title || '',
            description: '',
            url: proxyUrl(g.images?.fixed_height?.url || g.images?.original?.url || ''),
            preview: proxyUrl(g.images?.fixed_width_small?.url || g.images?.fixed_width?.url || ''),
            mp4: '',
            width: g.images?.fixed_height?.width || 0,
            height: g.images?.fixed_height?.height || 0,
          }));
          return res.json({ success: true, results, next: data.pagination?.total_count || 0 });
        }
      } catch (e) {
        console.warn('[feed] Giphy API error:', e.message);
      }
    }

    // Sin API key o fallo: usar GIFs de muestra (proxy siempre funciona)
    let results;
    if (query) {
      results = SAMPLE_GIFS.filter(g =>
        g.title.toLowerCase().includes(query) ||
        g.cat.includes(query)
      );
    } else {
      results = SAMPLE_GIFS;
    }

    res.json({
      success: true,
      results: results.slice(0, limit).map(g => ({ ...g, description: g.title, mp4: '', width: 200, height: 200 })),
      next: 0,
      _fallback: !apiKey,
    });

  } catch (err) {
    console.error('[feed] Error en gif-search:', err.message);
    res.json({
      success: true,
      results: SAMPLE_GIFS.slice(0, Math.min(limit, 12)).map(g => ({ ...g, description: g.title, mp4: '', width: 200, height: 200 })),
      next: 0,
    });
  }
});

// Limpia cachés de scoring expiradas cada 5 minutos (mayor a CACHE_TTL)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of forYouCache) {
    if (now - v.ts > 600000) forYouCache.delete(k);
  }
}, 300000);

module.exports = router;
