// ═══════════════════════════════════════════════════════════════════════════════
// 📖 KamiTales — routes-novel.js
// Capítulos de novela (texto por bloques), progreso por párrafo, comentarios por
// párrafo y reacciones. Montado en /api/novel.
//
// Un capítulo guarda `content` como lista de bloques:
//   [{ id: "p3k9x2", type: "p" | "quote" | "scene", html: "Texto con <em>cursiva</em>" }]
// El id de cada bloque no cambia al editar, así los comentarios y el progreso
// siguen apuntando al mismo párrafo.
//
// Visibilidad: el autor (o un admin) ve todo. El resto ve los capítulos
// publicados o programados cuya fecha ya pasó. Si free_at está en el futuro, el
// capítulo es un adelanto: se lista, pero su texto no se entrega.
// ═══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');
const { requireAuth, requireMangaEditor, requireNotBanned, canEditManga } = require('../middleware/auth');
const { hasColumn } = require('../schema');
const coins = require('../payments/coins');

const MIGRATION_HINT = 'Falta aplicar migrate-novel-reader.sql en la base de datos.';
async function ready(req, res, next) {
  if (await hasColumn('chapters', 'content')) return next();
  return res.status(503).json({ error: 'Las novelas aún no están activadas. ' + MIGRATION_HINT });
}

// Usuario opcional: si hay token válido lo deja en req.user, si no sigue anónimo
async function optionalAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) { try { req.user = await verifyToken(h.slice(7)); } catch { /* anónimo */ } }
  next();
}
async function isEditor(req, mangaId) {
  if (!req.user?.userId) return false;
  try { return await canEditManga(req.user.userId, mangaId); } catch { return false; }
}

// ── Saneado del contenido ──────────────────────────────────────────────────────
// Solo se admiten <strong>, <em> y <br> sin atributos. Todo lo demás se escapa.
function cleanHtml(html) {
  const esc = String(html || '').slice(0, 20000)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc.replace(/&lt;(\/?)(strong|em)&gt;/g, '<$1$2>').replace(/&lt;br\s*\/?&gt;/g, '<br>')
    .replace(/&amp;(nbsp|amp|lt|gt|quot|#39);/g, '&$1;');
}
function cleanBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const seen = new Set();
  return blocks.slice(0, 5000).map(b => {
    let id = String(b?.id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
    if (id.length < 4 || seen.has(id)) id = Math.random().toString(36).slice(2, 10);
    seen.add(id);
    const type = ['p', 'quote', 'scene'].includes(b?.type) ? b.type : 'p';
    return { id, type, html: type === 'scene' ? '' : cleanHtml(b?.html) };
  }).filter(b => b.type === 'scene' || b.html.replace(/<[^>]+>|&nbsp;/g, '').trim() !== '');
}
function countWords(blocks) {
  return blocks.reduce((n, b) => n + (b.html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').match(/[^\s—–-]+/g) || []).length, 0);
}
function cleanText(s, max) { return String(s || '').trim().slice(0, max); }
function cleanDate(s) { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toISOString(); }
const WARNINGS = ['violencia', 'sexual', 'lenguaje', 'autolesion', 'drogas', 'terror'];

const VISIBLE_SQL = `(c.status = 'published' OR (c.status = 'scheduled' AND c.publish_at <= NOW()))`;

function chapterOut(r, { withContent, editor, reader }) {
  const unlocked = !!(reader && reader.unlocked.has(r.chapter_number));
  const locked = !editor && !unlocked && r.free_at && new Date(r.free_at) > new Date();
  return {
    number: r.chapter_number,
    title: r.title || '',
    status: r.status || 'published',
    publishAt: r.publish_at,
    freeAt: r.free_at,
    wordCount: r.word_count || 0,
    readMinutes: Math.max(1, Math.round((r.word_count || 0) / 230)),
    noteBefore: withContent && !locked ? r.note_before || '' : '',
    noteAfter: withContent && !locked ? r.note_after || '' : '',
    warnings: r.content_warnings || [],
    locked: !!locked,
    unlocked,
    priceCoins: reader && reader.ready ? (r.price_coins || null) : (editor ? r.price_coins || null : null),
    offer: locked && reader && reader.sell ? coins.offerFor(r, reader.gold) : null,
    blocks: withContent && !locked ? (r.content || []) : undefined,
    updatedAt: r.updated_at,
  };
}

// ── Lista de capítulos ────────────────────────────────────────────────────────
router.get('/:mangaId/chapters', ready, optionalAuth, async (req, res) => {
  try {
    const { mangaId } = req.params;
    const editor = await isEditor(req, mangaId);
    const r = await pool.query(
      `SELECT c.* FROM chapters c WHERE c.manga_id = $1 ${editor ? '' : 'AND ' + VISIBLE_SQL} ORDER BY c.chapter_number ASC`,
      [mangaId]
    );
    const reader = await coins.readerContext(req.user && req.user.userId, mangaId);
    res.json({ mangaId, isEditor: editor, chapters: r.rows.map(row => chapterOut(row, { withContent: false, editor, reader })) });
  } catch (e) {
    console.error('[novel] lista:', e.message);
    res.status(500).json({ error: 'No se pudieron cargar los capítulos.' });
  }
});

// ── Progreso de lectura (antes que /:num para que no lo capture) ──────────────
router.get('/:mangaId/progress', ready, requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT last_chapter, last_paragraph, last_percent, updated_at FROM user_reading WHERE user_id = $1 AND manga_id = $2', [req.user.userId, req.params.mangaId]);
    const row = r.rows[0];
    res.json(row ? { chapter: row.last_chapter, paragraphId: row.last_paragraph, percent: row.last_percent || 0, updatedAt: row.updated_at } : { chapter: null });
  } catch (e) { res.status(500).json({ error: 'No se pudo leer tu progreso.' }); }
});
router.put('/:mangaId/progress', ready, requireAuth, async (req, res) => {
  try {
    const chapter = parseInt(req.body.chapter, 10);
    if (!chapter) return res.status(400).json({ error: 'Falta el capítulo.' });
    const pid = String(req.body.paragraphId || '').replace(/[^a-z0-9]/gi, '').slice(0, 24) || null;
    const pct = Math.max(0, Math.min(100, parseInt(req.body.percent, 10) || 0));
    await pool.query(
      `INSERT INTO user_reading (user_id, manga_id, last_chapter, last_page, total_pages_read, last_paragraph, last_percent)
       VALUES ($1, $2, $3, 0, 0, $4, $5)
       ON CONFLICT (user_id, manga_id) DO UPDATE SET
         last_chapter = EXCLUDED.last_chapter, last_paragraph = EXCLUDED.last_paragraph,
         last_percent = EXCLUDED.last_percent, updated_at = CURRENT_TIMESTAMP`,
      [req.user.userId, req.params.mangaId, chapter, pid, pct]
    );
    // Mantener «Sigue leyendo» de la biblioteca al día, si la obra está en ella
    await pool.query(
      `UPDATE user_manga_library SET progress = GREATEST(COALESCE(progress, 0), $3), updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND manga_id = $2`,
      [req.user.userId, req.params.mangaId, pct >= 95 ? chapter : chapter - 1]
    ).catch(() => {});
    require('../payments/earnings').ping(req.user.userId, req.params.mangaId);   // tiempo de lectura (no bloquea)
    res.json({ success: true });
  } catch (e) {
    console.error('[novel] progreso:', e.message);
    res.status(500).json({ error: 'No se pudo guardar tu progreso.' });
  }
});

// ── Un capítulo ───────────────────────────────────────────────────────────────
router.get('/:mangaId/:num', ready, optionalAuth, async (req, res) => {
  try {
    const { mangaId } = req.params;
    const num = parseInt(req.params.num, 10);
    const m = await pool.query('SELECT id, title, author, type, cover, social_links, created_by FROM mangas WHERE id = $1', [mangaId]);
    if (!m.rows.length) return res.status(404).json({ error: 'Esta obra no existe.' });
    const editor = await isEditor(req, mangaId);
    const reader = await coins.readerContext(req.user && req.user.userId, mangaId);
    const visible = editor ? '' : 'AND ' + VISIBLE_SQL;
    const r = await pool.query(`SELECT c.* FROM chapters c WHERE c.manga_id = $1 AND c.chapter_number = $2 ${visible}`, [mangaId, num]);
    if (!r.rows.length) return res.status(404).json({ error: 'Este capítulo no existe o todavía no está publicado.' });
    const nav = await pool.query(
      `SELECT
         (SELECT MAX(chapter_number) FROM chapters c WHERE c.manga_id = $1 AND c.chapter_number < $2 ${visible}) AS prev,
         (SELECT MIN(chapter_number) FROM chapters c WHERE c.manga_id = $1 AND c.chapter_number > $2 ${visible}) AS next,
         (SELECT COUNT(*) FROM chapters c WHERE c.manga_id = $1 ${visible}) AS total`,
      [mangaId, num]
    );
    let next = null;
    if (nav.rows[0].next) {
      const n = await pool.query('SELECT * FROM chapters WHERE manga_id = $1 AND chapter_number = $2', [mangaId, nav.rows[0].next]);
      const row = n.rows[0];
      const nextLocked = !editor && !reader.unlocked.has(row.chapter_number) && !!row.free_at && new Date(row.free_at) > new Date();
      next = { number: row.chapter_number, title: row.title || '', freeAt: row.free_at, locked: nextLocked, offer: nextLocked && reader.sell ? coins.offerFor(row, reader.gold) : null };
    }
    const man = m.rows[0];
    res.json({
      manga: { id: man.id, title: man.title, author: man.author, type: man.type, cover: man.cover, links: man.social_links || {} },
      chapter: chapterOut(r.rows[0], { withContent: true, editor, reader }),
      prev: nav.rows[0].prev, next, total: parseInt(nav.rows[0].total, 10) || 0,
      isEditor: editor,
    });
  } catch (e) {
    console.error('[novel] capítulo:', e.message);
    res.status(500).json({ error: 'No se pudo cargar el capítulo.' });
  }
});

// ── Crear y guardar (solo el autor) ───────────────────────────────────────────
function readBody(body) {
  const blocks = cleanBlocks(body.blocks);
  const status = ['draft', 'scheduled', 'published'].includes(body.status) ? body.status : 'draft';
  return {
    title: cleanText(body.title, 200),
    blocks, words: countWords(blocks), status,
    publishAt: status === 'scheduled' ? cleanDate(body.publishAt) : null,
    freeAt: cleanDate(body.freeAt),
    noteBefore: cleanText(body.noteBefore, 4000),
    noteAfter: cleanText(body.noteAfter, 4000),
    warnings: (Array.isArray(body.warnings) ? body.warnings : []).filter(w => WARNINGS.includes(w)),
  };
}

router.post('/:mangaId', ready, requireAuth, requireMangaEditor, async (req, res) => {
  try {
    const { mangaId } = req.params;
    const m = await pool.query('SELECT type FROM mangas WHERE id = $1', [mangaId]);
    if (!m.rows.length) return res.status(404).json({ error: 'Esta obra no existe.' });
    if (m.rows[0].type !== 'novel') return res.status(400).json({ error: 'Esta obra es un cómic: sus capítulos se suben como imágenes.' });
    const d = readBody(req.body);
    if (d.status === 'scheduled' && !d.publishAt) return res.status(400).json({ error: 'Elige la fecha de publicación.' });
    let num = parseInt(req.body.number, 10);
    if (!num) {
      const mx = await pool.query('SELECT COALESCE(MAX(chapter_number), 0) + 1 AS n FROM chapters WHERE manga_id = $1', [mangaId]);
      num = mx.rows[0].n;
    }
    const r = await pool.query(
      `INSERT INTO chapters (manga_id, chapter_number, title, pages, content, word_count, status, publish_at, free_at, note_before, note_after, content_warnings, release_date)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($7::timestamptz, CURRENT_TIMESTAMP))
       ON CONFLICT (manga_id, chapter_number) DO NOTHING
       RETURNING *`,
      [mangaId, num, d.title, JSON.stringify(d.blocks), d.words, d.status, d.publishAt, d.freeAt, d.noteBefore, d.noteAfter, d.warnings]
    );
    if (!r.rows.length) return res.status(409).json({ error: `Ya existe el capítulo ${num}.` });
    r.rows[0].price_coins = await coins.savePrice(mangaId, num, req.body.priceCoins, d.freeAt);
    await pool.query('UPDATE mangas SET total_chapters = (SELECT COUNT(*) FROM chapters WHERE manga_id = $1), updated_at = CURRENT_TIMESTAMP WHERE id = $1', [mangaId]);
    res.status(201).json({ chapter: chapterOut(r.rows[0], { withContent: true, editor: true }) });
  } catch (e) {
    console.error('[novel] crear:', e.message);
    res.status(500).json({ error: 'No se pudo crear el capítulo.' });
  }
});

router.put('/:mangaId/:num', ready, requireAuth, requireMangaEditor, async (req, res) => {
  try {
    const { mangaId } = req.params;
    const num = parseInt(req.params.num, 10);
    const d = readBody(req.body);
    if (d.status === 'scheduled' && !d.publishAt) return res.status(400).json({ error: 'Elige la fecha de publicación.' });
    const r = await pool.query(
      // Tipos explícitos: $6 y $7 aparecen en dos sitios y Postgres no puede deducir un tipo único
      `UPDATE chapters SET title = $3, content = $4, word_count = $5, status = $6::varchar, publish_at = $7::timestamptz, free_at = $8,
         note_before = $9, note_after = $10, content_warnings = $11, updated_at = CURRENT_TIMESTAMP,
         release_date = CASE WHEN $6::varchar = 'published' AND status <> 'published' THEN CURRENT_TIMESTAMP
                             WHEN $6::varchar = 'scheduled' THEN $7::timestamptz ELSE release_date END
       WHERE manga_id = $1 AND chapter_number = $2 RETURNING *`,
      [mangaId, num, d.title, JSON.stringify(d.blocks), d.words, d.status, d.publishAt, d.freeAt, d.noteBefore, d.noteAfter, d.warnings]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Este capítulo no existe.' });
    if (req.body.priceCoins !== undefined) r.rows[0].price_coins = await coins.savePrice(mangaId, num, req.body.priceCoins, d.freeAt);
    if (d.status !== 'draft') await pool.query('UPDATE mangas SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [mangaId]);
    res.json({ chapter: chapterOut(r.rows[0], { withContent: false, editor: true }) });
  } catch (e) {
    console.error('[novel] guardar:', e.message);
    res.status(500).json({ error: 'No se pudo guardar el capítulo.' });
  }
});

// ── Comentarios por párrafo ───────────────────────────────────────────────────
router.get('/:mangaId/:num/comment-counts', ready, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT paragraph_id, COUNT(*)::int AS n FROM chapter_comments
       WHERE manga_id = $1 AND chapter_number = $2 AND paragraph_id IS NOT NULL AND deleted_at IS NULL
       GROUP BY paragraph_id`,
      [req.params.mangaId, parseInt(req.params.num, 10)]
    );
    const counts = {}; r.rows.forEach(x => { counts[x.paragraph_id] = x.n; });
    res.json({ counts });
  } catch (e) { res.status(500).json({ error: 'No se pudieron cargar los comentarios.' }); }
});

router.get('/:mangaId/:num/comments', ready, optionalAuth, async (req, res) => {
  try {
    const pid = String(req.query.p || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
    const params = [req.params.mangaId, parseInt(req.params.num, 10)];
    let where = 'c.manga_id = $1 AND c.chapter_number = $2 AND c.deleted_at IS NULL';
    if (pid) { params.push(pid); where += ' AND c.paragraph_id = $3'; } else where += ' AND c.paragraph_id IS NULL';
    const r = await pool.query(
      `SELECT c.id, c.text, c.created_at, c.is_spoiler, c.pinned, c.user_id, u.username, u.avatar
       FROM chapter_comments c JOIN users u ON u.id = c.user_id
       WHERE ${where} ORDER BY c.pinned DESC, c.created_at ASC LIMIT 200`, params);
    const editor = await isEditor(req, req.params.mangaId);
    res.json({
      isEditor: editor,
      comments: r.rows.map(c => ({
        id: c.id, text: c.text, createdAt: c.created_at, spoiler: c.is_spoiler, pinned: c.pinned,
        username: c.username, avatar: c.avatar, mine: !!req.user && req.user.userId === c.user_id,
      })),
    });
  } catch (e) { res.status(500).json({ error: 'No se pudieron cargar los comentarios.' }); }
});

router.post('/:mangaId/:num/comments', ready, requireAuth, requireNotBanned, async (req, res) => {
  try {
    const text = cleanText(req.body.text, 2000);
    if (!text) return res.status(400).json({ error: 'Escribe algo antes de enviar.' });
    const pid = String(req.body.paragraphId || '').replace(/[^a-z0-9]/gi, '').slice(0, 24) || null;
    const r = await pool.query(
      `INSERT INTO chapter_comments (manga_id, chapter_number, user_id, text, paragraph_id, is_spoiler)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [req.params.mangaId, parseInt(req.params.num, 10), req.user.userId, text, pid, !!req.body.spoiler]
    );
    const u = await pool.query('SELECT username, avatar FROM users WHERE id = $1', [req.user.userId]);
    res.status(201).json({ comment: { id: r.rows[0].id, text, createdAt: r.rows[0].created_at, spoiler: !!req.body.spoiler, pinned: false, username: u.rows[0]?.username, avatar: u.rows[0]?.avatar, mine: true } });
  } catch (e) {
    console.error('[novel] comentar:', e.message);
    res.status(500).json({ error: 'No se pudo publicar el comentario.' });
  }
});

router.post('/:mangaId/:num/comments/:cid/pin', ready, requireAuth, requireMangaEditor, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE chapter_comments SET pinned = NOT COALESCE(pinned, FALSE) WHERE id = $1 AND manga_id = $2 RETURNING pinned',
      [parseInt(req.params.cid, 10), req.params.mangaId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Ese comentario no existe.' });
    res.json({ pinned: r.rows[0].pinned });
  } catch (e) { res.status(500).json({ error: 'No se pudo fijar el comentario.' }); }
});

router.delete('/:mangaId/:num/comments/:cid', ready, requireAuth, async (req, res) => {
  try {
    const editor = await isEditor(req, req.params.mangaId);
    const r = await pool.query(
      `UPDATE chapter_comments SET deleted_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND manga_id = $2 AND deleted_at IS NULL ${editor ? '' : 'AND user_id = $3'} RETURNING id`,
      editor ? [parseInt(req.params.cid, 10), req.params.mangaId] : [parseInt(req.params.cid, 10), req.params.mangaId, req.user.userId]
    );
    if (!r.rows.length) return res.status(403).json({ error: 'Solo puedes borrar tus comentarios.' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo borrar el comentario.' }); }
});

// ── Reacción rápida al final del capítulo ─────────────────────────────────────
router.get('/:mangaId/:num/reactions', ready, optionalAuth, async (req, res) => {
  try {
    const p = [req.params.mangaId, parseInt(req.params.num, 10)];
    const r = await pool.query('SELECT reaction, COUNT(*)::int AS n FROM chapter_reactions WHERE manga_id = $1 AND chapter_number = $2 GROUP BY reaction', p);
    let mine = null;
    if (req.user?.userId) {
      const m = await pool.query('SELECT reaction FROM chapter_reactions WHERE manga_id = $1 AND chapter_number = $2 AND user_id = $3', [...p, req.user.userId]);
      mine = m.rows[0]?.reaction || null;
    }
    const counts = { love: 0, fire: 0, sad: 0, wow: 0 }; r.rows.forEach(x => { counts[x.reaction] = x.n; });
    res.json({ counts, mine });
  } catch (e) { res.status(500).json({ error: 'No se pudieron cargar las reacciones.' }); }
});
router.post('/:mangaId/:num/reactions', ready, requireAuth, requireNotBanned, async (req, res) => {
  try {
    const reaction = ['love', 'fire', 'sad', 'wow'].includes(req.body.reaction) ? req.body.reaction : null;
    if (!reaction) return res.status(400).json({ error: 'Reacción no válida.' });
    const p = [req.user.userId, req.params.mangaId, parseInt(req.params.num, 10)];
    const cur = await pool.query('SELECT reaction FROM chapter_reactions WHERE user_id = $1 AND manga_id = $2 AND chapter_number = $3', p);
    if (cur.rows[0]?.reaction === reaction) {
      await pool.query('DELETE FROM chapter_reactions WHERE user_id = $1 AND manga_id = $2 AND chapter_number = $3', p);
      return res.json({ mine: null });
    }
    await pool.query(
      `INSERT INTO chapter_reactions (user_id, manga_id, chapter_number, reaction) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, manga_id, chapter_number) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = CURRENT_TIMESTAMP`,
      [...p, reaction]
    );
    res.json({ mine: reaction });
  } catch (e) { res.status(500).json({ error: 'No se pudo guardar tu reacción.' }); }
});

module.exports = router;
