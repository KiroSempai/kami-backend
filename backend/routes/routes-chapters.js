const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const { upload, MANGA_ASSETS_DIR } = require('../upload-config');
const { processChapterImages } = require('../image-processor');
const { verifyToken } = require('../config');
const { signURL } = require('../url-signer');

const CHAPTERS_PER_PAGE = 50;

// GET /api/chapters/:mangaId - listar capítulos de un manga
router.get('/:mangaId', async (req, res) => {
    try {
        const { mangaId } = req.params;
        const { page = 1, limit = CHAPTERS_PER_PAGE } = req.query;

        const countResult = await pool.query(
            'SELECT COUNT(*) FROM chapters WHERE manga_id = $1',
            [mangaId]
        );
        const total = parseInt(countResult.rows[0].count);

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(parseInt(limit) || CHAPTERS_PER_PAGE, 100);
        const totalPages = Math.ceil(total / limitNum);
        const offset = (pageNum - 1) * limitNum;

        const result = await pool.query(
            `SELECT c.id, c.chapter_number, c.title, c.pages, c.scan_group, c.release_date, c.created_at,
                    COALESCE(cm.comment_count, 0) AS comment_count
             FROM chapters c
             LEFT JOIN (
               SELECT manga_id, chapter_number, COUNT(*) AS comment_count
               FROM chapter_comments
               GROUP BY manga_id, chapter_number
             ) cm ON cm.manga_id = c.manga_id AND cm.chapter_number = c.chapter_number
             WHERE c.manga_id = $1
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
            })),
            pagination: { page: pageNum, limit: limitNum, total, totalPages },
        });
    } catch (err) {
        console.error('Error listing chapters:', err);
        res.status(500).json({ error: 'Error al obtener capítulos' });
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
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            try {
                const decoded = await verifyToken(token);
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
            'SELECT id, title, cover FROM mangas WHERE id = $1',
            [mangaId]
        );
        const manga = mangaResult.rows[0] || { id: mangaId, title: 'Desconocido' };

        res.json({
            manga: {
                id: manga.id,
                title: manga.title,
                cover: manga.cover || '',
            },
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
router.post('/:mangaId', async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Se requiere autenticación' });
    try { req.user = await verifyToken(token); next(); }
    catch { return res.status(401).json({ error: 'Token inválido' }); }
}, upload.array('pages', 200), async (req, res) => {
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

        const result = await pool.query(
            `INSERT INTO chapters (manga_id, chapter_number, title, pages, scan_group, release_date)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
             RETURNING id, chapter_number, title, pages, scan_group, release_date, created_at`,
            [mangaId, num, title || `Capítulo ${num}`, totalPages, scanGroup || '']
        );

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
router.put('/:mangaId/:chapterNum', async (req, res) => {
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
router.delete('/:mangaId/:chapterNum', async (req, res) => {
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
