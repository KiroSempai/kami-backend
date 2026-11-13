// ═══════════════════════════════════════════════════════════════════════════════
// 🔎 KamiTales — routes-search.js
// Búsqueda principal: obras, personas y comunidades. Sin distinguir mayúsculas ni tildes.
//   GET /api/search?q=texto&type=all|works|people|communities&limit=&offset=
// ═══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Normaliza igual en JS y en SQL: minúsculas y sin tildes
const FROM = 'áéíóúüñàèìòùâêîôûäëïöç', TO = 'aeiouunaeiouaeiouaeioc';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ç/g, 'c');
const N = col => `translate(lower(${col}), '${FROM}', '${TO}')`;
const likeEsc = s => s.replace(/[\\%_]/g, m => '\\' + m);

async function works(qn, limit, offset) {
  const like = '%' + likeEsc(qn) + '%', pre = likeEsc(qn) + '%';
  const where = `(${N('m.title')} LIKE $1 OR ${N('COALESCE(m.author, \'\')')} LIKE $1
     OR EXISTS (SELECT 1 FROM unnest(COALESCE(m.alternative_titles, '{}')) t WHERE ${N('t')} LIKE $1)
     OR EXISTS (SELECT 1 FROM unnest(COALESCE(m.tags, '{}')) t WHERE ${N('t')} LIKE $1)
     OR EXISTS (SELECT 1 FROM unnest(COALESCE(m.genres, '{}')) t WHERE ${N('t')} LIKE $1))`;
  const r = await pool.query(
    `SELECT m.id, m.title, m.cover, m.type, m.status, m.genres, m.rating, m.total_chapters, m.author, m.total_reads,
            COUNT(*) OVER () AS total
       FROM mangas m WHERE ${where}
      ORDER BY (${N('m.title')} = $2) DESC, (${N('m.title')} LIKE $3) DESC, m.total_reads DESC NULLS LAST, m.title
      LIMIT $4 OFFSET $5`,
    [like, qn, pre, limit, offset]
  );
  return {
    total: r.rows.length ? parseInt(r.rows[0].total, 10) : 0,
    items: r.rows.map(m => ({ id: m.id, title: m.title, cover: m.cover || '', type: m.type, status: m.status, genres: m.genres || [], rating: parseFloat(m.rating) || 0, totalChapters: m.total_chapters || 0, author: m.author || '', totalReads: m.total_reads || 0 })),
  };
}

async function people(qn, limit, offset) {
  const like = '%' + likeEsc(qn) + '%', pre = likeEsc(qn) + '%';
  const r = await pool.query(
    `SELECT u.id, u.username, u.avatar, u.bio,
            (SELECT COUNT(*) FROM user_follows f WHERE f.following_id = u.id)::int AS followers,
            (SELECT COUNT(*) FROM mangas m WHERE m.created_by = u.id)::int AS works,
            COUNT(*) OVER () AS total
       FROM users u
      WHERE ${N('u.username')} LIKE $1 AND COALESCE(u.is_banned, FALSE) = FALSE AND u.deleted_at IS NULL
      ORDER BY (${N('u.username')} = $2) DESC, (${N('u.username')} LIKE $3) DESC, followers DESC, u.username
      LIMIT $4 OFFSET $5`,
    [like, qn, pre, limit, offset]
  );
  return {
    total: r.rows.length ? parseInt(r.rows[0].total, 10) : 0,
    items: r.rows.map(u => ({ username: u.username, avatar: u.avatar || '', bio: String(u.bio || '').slice(0, 160), followers: u.followers, works: u.works })),
  };
}

async function communities(qn, limit, offset) {
  const like = '%' + likeEsc(qn) + '%';
  const r = await pool.query(
    `SELECT c.id, c.name, c.description, c.avatar_url, c.banner_url, m.cover AS manga_cover, m.title AS manga_title,
            (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id)::int AS members,
            COUNT(*) OVER () AS total
       FROM communities c LEFT JOIN mangas m ON m.id = c.manga_id
      WHERE ${N('c.name')} LIKE $1 OR ${N('COALESCE(c.description, \'\')')} LIKE $1 OR ${N('COALESCE(m.title, \'\')')} LIKE $1
      ORDER BY members DESC, c.name
      LIMIT $2 OFFSET $3`,
    [like, limit, offset]
  );
  return {
    total: r.rows.length ? parseInt(r.rows[0].total, 10) : 0,
    items: r.rows.map(c => ({ id: c.id, name: c.name, description: String(c.description || '').slice(0, 160), avatar: c.avatar_url || '', banner: c.banner_url || '', cover: c.manga_cover || '', work: c.manga_title || '', members: c.members })),
  };
}

router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.status(400).json({ error: 'Escribe qué quieres buscar.' });
    const qn = norm(q);
    const type = ['works', 'people', 'communities'].includes(req.query.type) ? req.query.type : 'all';
    const limit = Math.max(1, Math.min(48, parseInt(req.query.limit, 10) || (type === 'all' ? 8 : 24)));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const out = { query: q };
    // En «Todo» se piden las tres; los fallos de una no tumban las demás
    const safe = p => p.catch(e => { console.error('[search]', e.message); return { total: 0, items: [], error: true }; });
    const jobs = [];
    if (type === 'all' || type === 'works') jobs.push(safe(works(qn, limit, offset)).then(r => { out.works = r; }));
    if (type === 'all' || type === 'people') jobs.push(safe(people(qn, type === 'all' ? 6 : limit, offset)).then(r => { out.people = r; }));
    if (type === 'all' || type === 'communities') jobs.push(safe(communities(qn, type === 'all' ? 6 : limit, offset)).then(r => { out.communities = r; }));
    await Promise.all(jobs);
    res.json(out);
  } catch (err) {
    console.error('[search] error:', err.message);
    res.status(500).json({ error: 'No se pudo completar la búsqueda.' });
  }
});

module.exports = router;
module.exports.norm = norm;
module.exports.N = N;
