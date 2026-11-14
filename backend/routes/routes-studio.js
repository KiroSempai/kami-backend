// ═══════════════════════════════════════════════════════════════════════════════
// 🖋️ KamiTales — routes-studio.js
// API del Estudio de autores, montada en /api/studio. Todo exige sesión.
//   GET /works      obras del autor (un admin ve todas) con sus cifras
//   GET /summary    resumen para el panel de inicio
//   GET /comments   últimos comentarios en las obras del autor
//   GET /content    tablón de anuncios y boletines (data/estudio-contenido.json)
// ═══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, getRole, isOwner } = require('../middleware/auth');
const { hasColumn } = require('../schema');

router.use(requireAuth);

// Obras visibles en el Estudio: las del autor; un admin ve también las que no tienen dueño
async function worksScope(req) {
  const role = await getRole(req.user.userId);
  const owned = await hasColumn('mangas', 'created_by');
  if (role === 'admin') return { where: 'TRUE', params: [], admin: true };
  if (!owned) return { where: 'FALSE', params: [], admin: false };
  return { where: 'm.created_by = $1', params: [req.user.userId], admin: false };
}

router.get('/works', async (req, res) => {
  try {
    const scope = await worksScope(req);
    const status = await hasColumn('chapters', 'status');
    const words = await hasColumn('chapters', 'word_count');
    const r = await pool.query(
      `SELECT m.id, m.title, m.type, m.status, m.cover, m.genres, m.rating, m.total_ratings, m.total_reads, m.updated_at, m.created_at,
              ${await hasColumn('mangas', 'created_by') ? 'm.created_by' : 'NULL AS created_by'},
              ${await hasColumn('mangas', 'publisher') ? 'm.publisher' : "'' AS publisher"},
              COUNT(c.id)::int AS chapters,
              ${status ? `COUNT(c.id) FILTER (WHERE c.status = 'published' OR (c.status = 'scheduled' AND c.publish_at <= NOW()))::int AS published,
              COUNT(c.id) FILTER (WHERE c.status = 'draft')::int AS drafts,
              COUNT(c.id) FILTER (WHERE c.status = 'scheduled' AND c.publish_at > NOW())::int AS scheduled,` : 'COUNT(c.id)::int AS published, 0 AS drafts, 0 AS scheduled,'}
              ${words ? 'COALESCE(SUM(c.word_count), 0)::int AS words,' : '0 AS words,'}
              MAX(c.created_at) AS last_chapter_at,
              (SELECT COUNT(*)::int FROM community_members cm WHERE cm.community_id = 'com-' || m.id) AS members,
              (SELECT COUNT(*)::int FROM chapter_comments cc WHERE cc.manga_id = m.id AND cc.created_at > NOW() - INTERVAL '7 days') AS comments_7d
       FROM mangas m LEFT JOIN chapters c ON c.manga_id = m.id
       WHERE ${scope.where}
       GROUP BY m.id ORDER BY m.updated_at DESC NULLS LAST`,
      scope.params
    );
    res.json({
      isAdmin: scope.admin,
      isOwner: await isOwner(req.user.userId),
      works: r.rows.map(w => ({
        id: w.id, title: w.title, type: w.type, format: w.type === 'novel' ? 'novel' : 'comic', status: w.status, cover: w.cover,
        genres: w.genres || [], rating: parseFloat(w.rating) || 0, ratings: w.total_ratings || 0, reads: w.total_reads || 0,
        chapters: w.chapters, published: w.published, drafts: w.drafts, scheduled: w.scheduled, words: w.words,
        members: w.members, comments7d: w.comments_7d, updatedAt: w.updated_at, lastChapterAt: w.last_chapter_at,
        owned: !!w.created_by && w.created_by === req.user.userId,
        publisher: w.publisher || '',
      })),
    });
  } catch (e) {
    console.error('[studio] works:', e.message);
    res.status(500).json({ error: 'No se pudieron cargar tus obras.' });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const scope = await worksScope(req);
    const status = await hasColumn('chapters', 'status');
    const t = await pool.query(
      `SELECT COUNT(DISTINCT m.id)::int AS works,
              COUNT(c.id) ${status ? "FILTER (WHERE c.status = 'published')" : ''}::int AS published,
              COALESCE((SELECT SUM(total_reads) FROM mangas m WHERE ${scope.where}), 0)::int AS reads,
              (SELECT COUNT(*)::int FROM chapter_comments cc JOIN mangas m ON m.id = cc.manga_id WHERE ${scope.where} AND cc.created_at > NOW() - INTERVAL '7 days') AS comments_7d
       FROM mangas m LEFT JOIN chapters c ON c.manga_id = m.id WHERE ${scope.where}`,
      scope.params
    );
    let lastDraft = null;
    if (status) {
      const d = await pool.query(
        `SELECT c.manga_id, c.chapter_number, c.title, c.updated_at, c.word_count, m.title AS work_title, m.type
         FROM chapters c JOIN mangas m ON m.id = c.manga_id
         WHERE ${scope.where} AND c.status = 'draft' ORDER BY c.updated_at DESC NULLS LAST LIMIT 1`,
        scope.params
      );
      const x = d.rows[0];
      if (x) lastDraft = { workId: x.manga_id, workTitle: x.work_title, format: x.type === 'novel' ? 'novel' : 'comic', number: x.chapter_number, title: x.title, words: x.word_count || 0, updatedAt: x.updated_at };
    }
    res.json({ ...t.rows[0], lastDraft });
  } catch (e) {
    console.error('[studio] summary:', e.message);
    res.status(500).json({ error: 'No se pudo cargar el resumen.' });
  }
});

router.get('/comments', async (req, res) => {
  try {
    const scope = await worksScope(req);
    const params = scope.params.slice();
    let extra = '';
    if (req.query.work) { params.push(String(req.query.work)); extra = ` AND cc.manga_id = $${params.length}`; }
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const pc = await hasColumn('chapter_comments', 'paragraph_id');
    const r = await pool.query(
      `SELECT cc.id, cc.manga_id, cc.chapter_number, cc.text, cc.created_at, ${pc ? 'cc.paragraph_id, cc.is_spoiler,' : 'NULL AS paragraph_id, FALSE AS is_spoiler,'}
              u.username, u.avatar, m.title AS work_title, m.type
       FROM chapter_comments cc JOIN mangas m ON m.id = cc.manga_id JOIN users u ON u.id = cc.user_id
       WHERE ${scope.where}${extra} ${pc ? 'AND cc.deleted_at IS NULL' : ''}
       ORDER BY cc.created_at DESC LIMIT ${limit}`,
      params
    );
    res.json({
      comments: r.rows.map(c => ({
        id: c.id, workId: c.manga_id, workTitle: c.work_title, format: c.type === 'novel' ? 'novel' : 'comic',
        chapter: c.chapter_number, paragraphId: c.paragraph_id, spoiler: !!c.is_spoiler, text: c.text,
        createdAt: c.created_at, username: c.username, avatar: c.avatar,
      })),
    });
  } catch (e) {
    console.error('[studio] comments:', e.message);
    res.status(500).json({ error: 'No se pudieron cargar los comentarios.' });
  }
});

// Qué admite la base ahora mismo (depende de las migraciones aplicadas)
// Ingresos del autor: saldo, meses, obras, capítulos y últimos movimientos
router.get('/earnings', async (req, res) => {
  try {
    res.json(await require('../payments/earnings').forAuthor(req.user.userId));
  } catch (e) {
    console.error('[studio] ingresos:', e.message);
    res.status(500).json({ error: 'No se pudieron cargar tus ingresos.' });
  }
});

router.get('/features', async (req, res) => {
  res.json({
    chapterStatus: await hasColumn('chapters', 'status'),   // borrador, programado y adelanto
    novels: await hasColumn('chapters', 'content'),          // editor y lector de novelas
    ownership: await hasColumn('mangas', 'created_by'),
    workMeta: await hasColumn('mangas', 'content_rating'), // idioma, protagonista, clasificación, origen, etiquetas
  });
});

const CONTENT_FILE = path.join(__dirname, '..', 'data', 'estudio-contenido.json');
router.get('/content', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
    const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
    res.json({
      announcements: (data.announcements || []).sort((a, b) => (b.pinned - a.pinned) || byDate(a, b)),
      bulletins: (data.bulletins || []).sort(byDate),
    });
  } catch (e) {
    console.error('[studio] content:', e.message);
    res.status(500).json({ error: 'No se pudo cargar el tablón.' });
  }
});

module.exports = router;
