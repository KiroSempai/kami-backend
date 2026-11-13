// ═══════════════════════════════════════════════════════════════════════════════
// 📖 KAMI — routes-chapters.js
// CRUD de capítulos: subida de páginas, edición, eliminación.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const { upload, MANGA_ASSETS_DIR } = require('../upload-config');
const { processChapterImages } = require('../image-processor');
const { verifyToken } = require('../config');
const { requireAuth, requireMangaEditor, canEditManga } = require('../middleware/auth');
const { hasColumn } = require('../schema');

// Borradores y capítulos programados no se listan al público
async function visibilityFilter(req, mangaId) {
    if (!(await hasColumn('chapters', 'status'))) return '';
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) {
        try { const u = await verifyToken(h.slice(7)); if (await canEditManga(u.userId, mangaId)) return ''; } catch { /* anónimo */ }
    }
    return " AND (c.status = 'published' OR (c.status = 'scheduled' AND c.publish_at <= NOW()))";
}
const { signURL } = require('../url-signer');

const CHAPTERS_PER_PAGE = 50;

// GET /api/chapters/:mangaId - listar capítulos de un manga
router.get('/:mangaId', async (req, res) => {
    try {
        const { mangaId } = req.params;
        const { page = 1, limit = CHAPTERS_PER_PAGE } = req.query;

        const vis = await visibilityFilter(req, mangaId);
        const countResult = await pool.query(
            'SELECT COUNT(*) FROM chapters c WHERE c.manga_id = $1' + vis,
            [mangaId]
        );
        const total = parseInt(countResult.rows[0].count);

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(parseInt(limit) || CHAPTERS_PER_PAGE, 100);
        const totalPages = Math.ceil(total / limitNum);
        const offset = (pageNum - 1) * limitNum;

        const result = await pool.query(
            `SELECT c.*,
                    COALESCE(cm.comment_count, 0) AS comment_count
             FROM chapters c
             LEFT JOIN (
               SELECT manga_id, chapter_number, COUNT(*) AS comment_count
               FROM chapter_comments
               GROUP BY manga_id, chapter_number
             ) cm ON cm.manga_id = c.manga_id AND cm.chapter_number = c.chapter_number
             WHERE c.manga_id = $1${vis}
             ORDER BY c.chapter_number DESC
             LIMIT $2 OFFSET $3`,
            [mangaId, limitNum, offset]
        );

        res.json({
            mangaId,
            chapters: result.rows.map(r => ({
                id: r.id,
                number: r.chapter_number,
                title: r.title,
                pages: r.pages,
                scanGroup: r.scan_group,
                releaseDate: r.release_date,
                createdAt: r.created_at,
                commentCount: parseInt(r.comment_count) || 0,
                status: r.status || 'published',
                freeAt: r.free_at || null,
                wordCount: r.word_count || 0,
            })),
            pagination: { page: pageNum, limit: limitNum, total, totalPages },
        });
    } catch (err) {
        console.error('Error listing chapters:', err);
        res.status(500).json({ error: 'Error al obtener capítulos' });
    }
});

// ── Progreso de lectura de cómics (página exacta) ─────────────────────────────
// Va antes de /:mangaId/:chapterNum para que «progress» no se lea como número de capítulo.
// GET /api/chapters/:mangaId/progress → { chapter, page, total, percent }
router.get('/:mangaId/progress', requireAuth, async (req, res) => {
    try {
        const r = await pool.query('SELECT last_chapter, last_page, last_percent, updated_at FROM user_reading WHERE user_id = $1 AND manga_id = $2', [req.user.userId, req.params.mangaId]);
        const row = r.rows[0];
        res.json(row ? { chapter: row.last_chapter, page: row.last_page || 0, percent: row.last_percent || 0, updatedAt: row.updated_at } : { chapter: null });
    } catch (err) {
        console.error('[chapters] leer progreso:', err.message);
        res.status(500).json({ error: 'No se pudo leer tu progreso.' });
    }
});
// PUT /api/chapters/:mangaId/progress { chapter, page (0-based), total }
router.put('/:mangaId/progress', requireAuth, async (req, res) => {
    try {
        const chapter = parseInt(req.body.chapter, 10);
        const total = Math.max(1, Math.min(2000, parseInt(req.body.total, 10) || 1));
        const page = Math.max(0, Math.min(total - 1, parseInt(req.body.page, 10) || 0));
        if (!chapter || chapter < 0) return res.status(400).json({ error: 'Falta el capítulo.' });
        const pct = Math.round(((page + 1) / total) * 100);
        const withPct = await hasColumn('user_reading', 'last_percent');
        await pool.query(
            withPct
                ? `INSERT INTO user_reading (user_id, manga_id, last_chapter, last_page, total_pages_read, last_percent)
                   VALUES ($1, $2, $3, $4, 1, $5)
                   ON CONFLICT (user_id, manga_id) DO UPDATE SET last_chapter = EXCLUDED.last_chapter, last_page = EXCLUDED.last_page,
                     last_percent = EXCLUDED.last_percent, total_pages_read = COALESCE(user_reading.total_pages_read, 0) + 1, updated_at = CURRENT_TIMESTAMP`
                : `INSERT INTO user_reading (user_id, manga_id, last_chapter, last_page, total_pages_read)
                   VALUES ($1, $2, $3, $4, 1)
                   ON CONFLICT (user_id, manga_id) DO UPDATE SET last_chapter = EXCLUDED.last_chapter, last_page = EXCLUDED.last_page,
                     total_pages_read = COALESCE(user_reading.total_pages_read, 0) + 1, updated_at = CURRENT_TIMESTAMP`,
            withPct ? [req.user.userId, req.params.mangaId, chapter, page, pct] : [req.user.userId, req.params.mangaId, chapter, page]
        );
        res.json({ success: true, percent: pct });
    } catch (err) {
        console.error('[chapters] guardar progreso:', err.message);
        res.status(500).json({ error: 'No se pudo guardar tu progreso.' });
    }
});

// GET /api/chapters/:mangaId/:chapterNum - capítulo específico con URLs de páginas
router.get('/:mangaId/:chapterNum', async (req, res) => {
    try {
        const { mangaId, chapterNum } = req.params;
        const num = parseInt(chapterNum);

        const result = await pool.query(
            'SELECT * FROM chapters WHERE manga_id = $1 AND chapter_number = $2',
            [mangaId, num]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Capítulo no encontrado' });
        }

        const chapter = result.rows[0];
        const pages = Array.from({ length: chapter.pages }, (_, i) => ({
            page: i + 1,
            url: `/assets/manga/${mangaId}/chapter-${num}/page-${String(i + 1).padStart(3, '0')}.jpg`,
        }));

        res.json({
            mangaId,
            chapter: {
                id: chapter.id,
                number: chapter.chapter_number,
                title: chapter.title,
                pages: chapter.pages,
                scanGroup: chapter.scan_group,
                releaseDate: chapter.release_date,
                pageUrls: pages,
            },
        });
    } catch (err) {
        console.error('Error getting chapter:', err);
        res.status(500).json({ error: 'Error al obtener capítulo' });
    }
});

// GET /api/chapters/:mangaId/:chapterNum/manifest — manifiesto del capítulo (con URLs firmadas)
router.get('/:mangaId/:chapterNum/manifest', async (req, res) => {
    try {
        const { mangaId, chapterNum } = req.params;
        const num = parseInt(chapterNum);

        // Obtener calidad preferida del usuario
        let quality = '1080';
        let userRole = 'user';
        let userId = null;
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            try {
                const decoded = await verifyToken(token);
                userId = decoded.userId;
                const { getUserQuality } = require('../image-settings');
                quality = await getUserQuality(decoded.userId);
                const r = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
                if (r.rows.length > 0) {
                    const getRole = require('../getRole');
                    userRole = getRole(r.rows[0]);
                }
            } catch {}
        }

        const result = await pool.query(
            'SELECT * FROM chapters WHERE manga_id = $1 AND chapter_number = $2',
            [mangaId, num]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Capítulo no encontrado' });
        }

        const chapter = result.rows[0];

        // Borradores, programados aún no publicados y adelantos: solo para quien edita la obra
        const editor = userId ? await canEditManga(userId, mangaId).catch(() => false) : false;
        const now = new Date();
        const st = chapter.status || 'published';
        const visible = st === 'published' || (st === 'scheduled' && chapter.publish_at && new Date(chapter.publish_at) <= now);
        if (!visible && !editor) return res.status(404).json({ error: 'Capítulo no encontrado' });
        if (!editor && chapter.free_at && new Date(chapter.free_at) > now) {
            return res.status(403).json({ error: 'Este capítulo es un adelanto.', locked: true, freeAt: chapter.free_at });
        }

        // Capítulos vecinos visibles, para navegar sin pedir la lista entera
        const vis = editor ? '' : ((await hasColumn('chapters', 'status')) ? " AND (status = 'published' OR (status = 'scheduled' AND publish_at <= NOW()))" : '');
        const nb = await pool.query(
            `SELECT (SELECT MAX(chapter_number) FROM chapters WHERE manga_id = $1 AND chapter_number < $2${vis}) AS prev,
                    (SELECT MIN(chapter_number) FROM chapters WHERE manga_id = $1 AND chapter_number > $2${vis}) AS next`,
            [mangaId, num]
        );
        let next = null;
        if (nb.rows[0].next != null) {
            const n = await pool.query('SELECT chapter_number, title, free_at FROM chapters WHERE manga_id = $1 AND chapter_number = $2', [mangaId, nb.rows[0].next]);
            const row = n.rows[0];
            next = { number: row.chapter_number, title: row.title || '', freeAt: row.free_at || null, locked: !editor && !!row.free_at && new Date(row.free_at) > now };
        }

        // Construir URLs firmadas para cada página
        const pageCount = chapter.pages;
        const pageUrls = [];
        for (let i = 0; i < pageCount; i++) {
            const baseUrl = `/api/image/${mangaId}/${num}/${i + 1}?quality=${quality}&raw=1`;
            pageUrls.push({
                page: i + 1,
                url: signURL(baseUrl),
            });
        }

        // Obtener datos del manga
        const mangaResult = await pool.query(
            'SELECT id, title, cover, type FROM mangas WHERE id = $1',
            [mangaId]
        );
        const manga = mangaResult.rows[0] || { id: mangaId, title: 'Desconocido' };

        res.json({
            manga: {
                id: manga.id,
                title: manga.title,
                cover: manga.cover || '',
                type: manga.type || 'manga',
            },
            nav: { prev: nb.rows[0].prev, next },
            isEditor: !!editor,
            status: st,
            chapter: {
                id: chapter.id,
                number: chapter.chapter_number,
                title: chapter.title,
                volume: chapter.volume || null,
                pages: pageCount,
                scanGroup: chapter.scan_group,
                releaseDate: chapter.release_date,
            },
            quality: {
                selected: quality,
                available: ['480', '720', '1080', 'master'],
                isPremium: ['admin', 'moderator', 'company', 'gold', 'silver'].includes(userRole),
            },
            pages: pageUrls,
            ttl: 30 * 60, // 30 minutos en segundos
        });
    } catch (err) {
        console.error('Error en manifest:', err.message);
        res.status(500).json({ error: 'Error al obtener manifiesto' });
    }
});

// POST /api/chapters/:mangaId - crear capítulo con subida de páginas (solo auth)
// Permiso comprobado antes de multer: si no es el autor, no se guarda ningún archivo
router.post('/:mangaId', requireAuth, requireMangaEditor, upload.array('pages', 200), async (req, res) => {
    try {
        const { mangaId } = req.params;
        const { chapterNumber, title, scanGroup } = req.body;

        const mangaCheck = await pool.query('SELECT id FROM mangas WHERE id = $1', [mangaId]);
        if (mangaCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Manga no encontrado' });
        }

        if (!chapterNumber || isNaN(parseInt(chapterNumber))) {
            return res.status(400).json({ error: 'Número de capítulo requerido' });
        }

        const num = parseInt(chapterNumber);

        const existing = await pool.query(
            'SELECT id FROM chapters WHERE manga_id = $1 AND chapter_number = $2',
            [mangaId, num]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: `El capítulo ${num} ya existe para este manga` });
        }

        const chapterDir = path.join(MANGA_ASSETS_DIR, mangaId, `chapter-${num}`);
        fs.mkdirSync(chapterDir, { recursive: true });

        const files = req.files || [];
        for (let i = 0; i < files.length; i++) {
            const ext = path.extname(files[i].originalname) || '.jpg';
            const pageFilename = `page-${String(i + 1).padStart(3, '0')}${ext}`;
            fs.renameSync(files[i].path, path.join(chapterDir, pageFilename));
        }

        const totalPages = files.length;

        // Publicación (si la migración de capítulos está aplicada): borrador, programado o ya, y adelanto
        let result;
        if (await hasColumn('chapters', 'status')) {
            const st = ['draft', 'scheduled', 'published'].includes(req.body.status) ? req.body.status : 'published';
            const when = req.body.publishAt && !isNaN(new Date(req.body.publishAt)) ? new Date(req.body.publishAt).toISOString() : null;
            if (st === 'scheduled' && !when) return res.status(400).json({ error: 'Elige la fecha de publicación.' });
            const free = req.body.freeAt && !isNaN(new Date(req.body.freeAt)) ? new Date(req.body.freeAt).toISOString() : null;
            const WARN = ['violencia', 'sexual', 'lenguaje', 'autolesion', 'drogas', 'terror'];
            let warnings = []; try { warnings = JSON.parse(req.body.warnings || '[]').filter(w => WARN.includes(w)); } catch { /* sin avisos */ }
            result = await pool.query(
                `INSERT INTO chapters (manga_id, chapter_number, title, pages, scan_group, release_date, status, publish_at, free_at, note_before, note_after, content_warnings)
                 VALUES ($1, $2, $3, $4, $5, COALESCE($7, CURRENT_TIMESTAMP), $6, $7, $8, $9, $10, $11)
                 RETURNING id, chapter_number, title, pages, scan_group, release_date, created_at`,
                [mangaId, num, title || `Capítulo ${num}`, totalPages, scanGroup || '', st, st === 'scheduled' ? when : null, free,
                 String(req.body.noteBefore || '').slice(0, 4000), String(req.body.noteAfter || '').slice(0, 4000), warnings]
            );
        } else {
            result = await pool.query(
                `INSERT INTO chapters (manga_id, chapter_number, title, pages, scan_group, release_date)
                 VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                 RETURNING id, chapter_number, title, pages, scan_group, release_date, created_at`,
                [mangaId, num, title || `Capítulo ${num}`, totalPages, scanGroup || '']
            );
        }

        await pool.query(
            `UPDATE mangas SET
                total_chapters = (SELECT COUNT(*) FROM chapters WHERE manga_id = $1),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [mangaId]
        );

        const chapter = result.rows[0];
        res.status(201).json({
            success: true,
            message: `Capítulo ${num} añadido correctamente`,
            chapter: {
                id: chapter.id,
                number: chapter.chapter_number,
                title: chapter.title,
                pages: chapter.pages,
                scanGroup: chapter.scan_group,
                releaseDate: chapter.release_date,
            },
        });

        // Background: procesar imágenes con IA (no bloquea la respuesta)
        processChapterImages(chapterDir, mangaId, num).catch(err => {
            console.error('[background] Error procesando imágenes:', err.message);
        });
    } catch (err) {
        console.error('Error creating chapter:', err);
        res.status(500).json({ error: 'Error al crear capítulo' });
    }
});

// PUT /api/chapters/:mangaId/:chapterNum - actualizar metadatos del capítulo
router.put('/:mangaId/:chapterNum', requireAuth, requireMangaEditor, async (req, res) => {
    try {
        const { mangaId, chapterNum } = req.params;
        const { title, scanGroup } = req.body;
        const num = parseInt(chapterNum);

        const result = await pool.query(
            `UPDATE chapters SET
                title = COALESCE($1, title),
                scan_group = COALESCE($2, scan_group),
                updated_at = CURRENT_TIMESTAMP
             WHERE manga_id = $3 AND chapter_number = $4
             RETURNING id, chapter_number, title, pages, scan_group, release_date`,
            [title || null, scanGroup || null, mangaId, num]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Capítulo no encontrado' });
        }

        res.json({
            success: true,
            message: 'Capítulo actualizado',
            chapter: result.rows[0],
        });
    } catch (err) {
        console.error('Error updating chapter:', err);
        res.status(500).json({ error: 'Error al actualizar capítulo' });
    }
});

// DELETE /api/chapters/:mangaId/:chapterNum - eliminar capítulo y sus archivos
router.delete('/:mangaId/:chapterNum', requireAuth, requireMangaEditor, async (req, res) => {
    try {
        const { mangaId, chapterNum } = req.params;
        const num = parseInt(chapterNum);

        const result = await pool.query(
            'DELETE FROM chapters WHERE manga_id = $1 AND chapter_number = $2 RETURNING id',
            [mangaId, num]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Capítulo no encontrado' });
        }

        const chapterDir = path.join(MANGA_ASSETS_DIR, mangaId, `chapter-${num}`);
        if (fs.existsSync(chapterDir)) {
            fs.rmSync(chapterDir, { recursive: true, force: true });
        }

        await pool.query(
            `UPDATE mangas SET
                total_chapters = (SELECT COUNT(*) FROM chapters WHERE manga_id = $1),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [mangaId]
        );

        res.json({
            success: true,
            message: `Capítulo ${num} eliminado`,
        });
    } catch (err) {
        console.error('Error deleting chapter:', err);
        res.status(500).json({ error: 'Error al eliminar capítulo' });
    }
});

module.exports = router;
