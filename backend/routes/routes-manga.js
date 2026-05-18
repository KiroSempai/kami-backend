// ═══════════════════════════════════════════════════════════════════════════════
// 📚 KAMI — routes-manga.js
// CRUD de mangas (KMI), capítulos, géneros, búsqueda, trending.
// Incluye carga de imágenes (covers, banners) y auto-creación de comunidad.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const path = require('path');
const fs = require('fs');
const { upload, MANGA_ASSETS_DIR } = require('../upload-config');
const { verifyToken } = require('../config');

function formatId(num) {
    return `KMI-${String(num).padStart(7, '0')}`;
}

function mapRow(row) {
    return {
        id: row.id,
        title: row.title,
        alternativeTitles: row.alternative_titles || [],
        cover: row.cover || null,
        description: row.description || '',
        type: row.type,
        status: row.status,
        genres: row.genres || [],
        demographicTarget: row.demographic_target || '',
        author: row.author || '',
        artist: row.artist || '',
        totalChapters: row.total_chapters || 0,
        isOneshot: row.is_oneshot || false,
        rating: parseFloat(row.rating) || 0,
        totalRatings: row.total_ratings || 0,
        totalReads: row.total_reads || 0,
        chapters: row.chapters || [],
        socialLinks: row.social_links || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

router.get('/next-id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS INTEGER)), 0) + 1 AS next_id FROM mangas`
        );
        res.json({ nextId: formatId(result.rows[0].next_id) });
    } catch (err) {
        console.error('Error getting next ID:', err);
        res.status(500).json({ error: 'Error al obtener siguiente ID' });
    }
});

router.get('/', async (req, res) => {
    try {
        const { type, status, genre, sort = 'popular', page = 1, limit = 20, q } = req.query;

        let sql = 'SELECT * FROM mangas WHERE 1=1';
        const params = [];
        let idx = 1;

        if (type) { sql += ` AND type = $${idx++}`; params.push(type); }
        if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
        if (genre) { sql += ` AND $${idx++} = ANY(genres)`; params.push(genre); }
        if (q) { sql += ` AND (title ILIKE $${idx} OR EXISTS(SELECT 1 FROM unnest(alternative_titles) t WHERE t ILIKE $${idx}))`; params.push(`%${q}%`); idx++; }

        switch (sort) {
            case 'rating': sql += ' ORDER BY rating DESC'; break;
            case 'latest': sql += ' ORDER BY updated_at DESC'; break;
            case 'popular': sql += ' ORDER BY total_reads DESC'; break;
            case 'az': sql += ' ORDER BY title ASC'; break;
            default: sql += ' ORDER BY total_reads DESC';
        }

        const countResult = await pool.query(`SELECT COUNT(*) FROM (${sql}) AS sub`, params);
        const total = parseInt(countResult.rows[0].count);

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(parseInt(limit) || 20, 50);
        const totalPages = Math.ceil(total / limitNum);
        const offset = (pageNum - 1) * limitNum;

        sql += ` LIMIT $${idx++} OFFSET $${idx++}`;
        params.push(limitNum, offset);

        const result = await pool.query(sql, params);

        res.json({
            mangas: result.rows.map(m => ({
                id: m.id, title: m.title, cover: m.cover,
                type: m.type, status: m.status, genres: m.genres,
                rating: parseFloat(m.rating), totalChapters: m.total_chapters,
                updatedAt: m.updated_at,
            })),
            pagination: { page: pageNum, limit: limitNum, total, totalPages },
        });
    } catch (err) {
        console.error('Error listando mangas:', err);
        res.status(500).json({ error: 'Error al obtener catálogo' });
    }
});

router.get('/trending', async (req, res) => {
    try {
        const { limit = 10 } = req.query;
        const result = await pool.query(`
            SELECT * FROM mangas
            ORDER BY (rating * 0.6 + LEAST(total_reads / 1000000.0, 10) * 0.4) DESC
            LIMIT $1
        `, [parseInt(limit)]);
        res.json({
            trending: result.rows.map((m, i) => ({
                rank: i + 1, id: m.id, title: m.title, cover: m.cover,
                type: m.type, status: m.status, genres: m.genres,
                rating: parseFloat(m.rating), totalReads: m.total_reads,
            }))
        });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener tendencias' });
    }
});

router.get('/latest', async (req, res) => {
    try {
        const { limit = 10 } = req.query;
        const result = await pool.query(`
            SELECT * FROM mangas
            WHERE status = 'ongoing'
            ORDER BY updated_at DESC
            LIMIT $1
        `, [parseInt(limit)]);
        res.json({
            latest: result.rows.map(m => ({
                id: m.id, title: m.title, cover: m.cover,
                type: m.type, genres: m.genres,
                latestChapter: m.chapters && m.chapters.length > 0
                    ? m.chapters[m.chapters.length - 1]
                    : { number: m.total_chapters, releaseDate: m.updated_at },
                updatedAt: m.updated_at,
            }))
        });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener novedades' });
    }
});

router.get('/search', async (req, res) => {
    try {
        const { q, limit = 10 } = req.query;
        if (!q || q.trim().length < 1) {
            return res.status(400).json({ error: 'Se requiere término de búsqueda' });
        }
        const result = await pool.query(`
            SELECT id, title, cover, type, status, rating, total_chapters FROM mangas
            WHERE title ILIKE $1
               OR EXISTS(SELECT 1 FROM unnest(alternative_titles) t WHERE t ILIKE $1)
               OR author ILIKE $1
            LIMIT $2
        `, [`%${q}%`, parseInt(limit)]);
        res.json({
            results: result.rows.map(m => ({
                id: m.id, title: m.title, cover: m.cover,
                type: m.type, status: m.status,
                rating: parseFloat(m.rating), totalChapters: m.total_chapters,
            })),
            total: result.rows.length,
            query: q,
        });
    } catch (err) {
        res.status(500).json({ error: 'Error en la búsqueda' });
    }
});

router.get('/genres', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT unnest(genres) AS name, COUNT(*) AS count
            FROM mangas
            GROUP BY name
            ORDER BY count DESC
        `);
        res.json({ genres: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener géneros' });
    }
});

router.get('/genre/:genre', async (req, res) => {
    try {
        const { genre } = req.params;
        const { sort = 'popular', limit = 20 } = req.query;

        let sql = `SELECT * FROM mangas WHERE $1 = ANY(genres)`;
        if (sort === 'rating') sql += ' ORDER BY rating DESC';
        else sql += ' ORDER BY total_reads DESC';
        sql += ' LIMIT $2';

        const result = await pool.query(sql, [genre, parseInt(limit)]);
        res.json({
            genre,
            mangas: result.rows.map(m => ({
                id: m.id, title: m.title, cover: m.cover,
                type: m.type, status: m.status, genres: m.genres,
                rating: parseFloat(m.rating), totalChapters: m.total_chapters,
            })),
            total: result.rows.length,
        });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener género' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM mangas WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Manga no encontrado' });

        const manga = mapRow(result.rows[0]);

        // Ranked (position by rating, lower = better)
        const rankedResult = await pool.query(
            'SELECT COUNT(*) + 1 AS rank FROM mangas WHERE rating > $1',
            [manga.rating || 0]
        );

        // Members (users who added to library)
        const membersResult = await pool.query(
            'SELECT COUNT(*) AS count FROM user_manga_library WHERE manga_id = $1',
            [req.params.id]
        );
        const memberCount = parseInt(membersResult.rows[0].count) || 0;

        // Popularity (position by library count, lower = better)
        const popResult = await pool.query(`
            SELECT COUNT(*) + 1 AS rank FROM (
                SELECT manga_id FROM user_manga_library GROUP BY manga_id
                HAVING COUNT(*) > $1
            ) AS sub
        `, [memberCount]);

        manga.ranked = parseInt(rankedResult.rows[0].rank) || 0;
        manga.popularity = parseInt(popResult.rows[0].rank) || 0;
        manga.members = memberCount;

        // Check if current user has viewed the cartelera
        let hasViewedCartelera = false;
        try {
            const token = req.headers.authorization?.split(' ')[1];
            if (token) {
                const decoded = await verifyToken(token);
                const v = await pool.query(
                    'SELECT 1 FROM manga_views WHERE manga_id = $1 AND user_id = $2',
                    [req.params.id, decoded.userId]
                );
                hasViewedCartelera = v.rows.length > 0;
            }
        } catch {}

        manga.hasViewedCartelera = hasViewedCartelera;

        res.json({ manga });
    } catch (err) {
        console.error('Error al obtener manga:', err);
        res.status(500).json({ error: 'Error al obtener manga' });
    }
});



router.post('/', upload.single('coverImage'), async (req, res) => {
    try {
        const {
            title, alternativeTitles = '[]', description = '',
            type, status, genres = '[]', demographicTarget = '',
            author = '', artist = '', totalChapters = 0, isOneshot = 'false',
        } = req.body;

        if (!title || !title.trim()) return res.status(400).json({ error: 'El título es obligatorio' });
        if (!['manga', 'manhwa', 'manhua', 'oneshot'].includes(type)) {
            return res.status(400).json({ error: 'Tipo inválido. Usa: manga, manhwa, manhua, oneshot' });
        }
        if (!['ongoing', 'completed', 'hiatus', 'cancelled'].includes(status)) {
            return res.status(400).json({ error: 'Estado inválido. Usa: ongoing, completed, hiatus, cancelled' });
        }

        const seqResult = await pool.query(
            `SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS INTEGER)), 0) + 1 AS next_id FROM mangas`
        );
        const nextId = seqResult.rows[0].next_id;
        const formattedId = formatId(nextId);

        const altArr = JSON.parse(alternativeTitles || '[]');
        const genresArr = JSON.parse(genres || '[]');

        let coverPath = null;
        if (req.file) {
            const ext = path.extname(req.file.originalname) || '.jpg';
            const mangaDir = path.join(MANGA_ASSETS_DIR, formattedId);
            fs.mkdirSync(mangaDir, { recursive: true });
            const finalName = `cover${ext}`;
            fs.renameSync(req.file.path, path.join(mangaDir, finalName));
            coverPath = `/assets/manga/${formattedId}/${finalName}`;
        }

        const result = await pool.query(`
            INSERT INTO mangas (id, title, alternative_titles, cover, description, type, status, genres, demographic_target, author, artist, total_chapters, is_oneshot)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            RETURNING id, title, type, status, cover, created_at
        `, [
            formattedId, title.trim(), altArr, coverPath, description || '',
            type, status, genresArr, demographicTarget || '',
            author || '', artist || author || '',
            isOneshot === 'true' ? 1 : (parseInt(totalChapters) || 0), isOneshot === 'true',
        ]);

        const newManga = result.rows[0];

        // Auto-crear comunidad para el nuevo manga
        try {
            const commId = 'com-' + newManga.id;
            let creatorId = null;
            try {
                const tok = req.headers.authorization?.split(' ')[1];
                if (tok) { const u = require('../config').verifyToken(tok); creatorId = u.userId; }
            } catch(e) {}
            await pool.query(`
                INSERT INTO communities (id, name, description, manga_id, type, created_by)
                VALUES ($1, $2, $3, $4, 'both', $5)
                ON CONFLICT (id) DO NOTHING
            `, [commId, newManga.title + ' (Comunidad)', (description || '').substring(0, 200), newManga.id, creatorId]);
            if (creatorId) {
                await pool.query(`
                    INSERT INTO community_members (user_id, community_id, role)
                    VALUES ($1, $2, 'admin')
                    ON CONFLICT DO NOTHING
                `, [creatorId, commId]);
            }
        } catch(e) { console.warn('[manga] Error al crear comunidad:', e.message); }

        res.status(201).json({
            success: true,
            message: `"${newManga.title}" añadido al catálogo de KAMI`,
            manga: {
                id: newManga.id,
                title: newManga.title,
                type: newManga.type,
                status: newManga.status,
                cover: newManga.cover,
                createdAt: newManga.created_at,
            },
        });
    } catch (err) {
        if (req.file) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        console.error('Error creando manga:', err);
        res.status(500).json({ error: 'Error al crear manga' });
    }
});

router.put('/:id', upload.single('coverImage'), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, type, status, genres, demographicTarget, author, artist, alternativeTitles, totalChapters, isOneshot, socialLinks } = req.body;

        let coverPath = null;
        if (req.file) {
            const ext = path.extname(req.file.originalname) || '.jpg';
            const mangaDir = path.join(MANGA_ASSETS_DIR, id);
            fs.mkdirSync(mangaDir, { recursive: true });
            const finalName = `cover${ext}`;
            if (fs.existsSync(mangaDir)) {
                fs.readdirSync(mangaDir).filter(f => f.startsWith('cover.')).forEach(f => {
                    try { fs.unlinkSync(path.join(mangaDir, f)); } catch (_) {}
                });
            }
            fs.renameSync(req.file.path, path.join(mangaDir, finalName));
            coverPath = `/assets/manga/${id}/${finalName}`;
        }

        const genresArr = genres ? JSON.parse(genres) : undefined;
        const altArr = alternativeTitles ? JSON.parse(alternativeTitles) : undefined;
        const socialArr = socialLinks ? JSON.parse(socialLinks) : undefined;

        const result = await pool.query(`
            UPDATE mangas SET
                title              = COALESCE($1, title),
                description        = COALESCE($2, description),
                type               = COALESCE($3, type),
                status             = COALESCE($4, status),
                genres             = COALESCE($5, genres),
                demographic_target = COALESCE($6, demographic_target),
                author             = COALESCE($7, author),
                artist             = COALESCE($8, artist),
                cover              = COALESCE($9, cover),
                alternative_titles = COALESCE($10, alternative_titles),
                total_chapters     = COALESCE($11, total_chapters),
                is_oneshot         = COALESCE($12, is_oneshot),
                social_links       = COALESCE($13, social_links),
                updated_at         = CURRENT_TIMESTAMP
            WHERE id = $14
            RETURNING id, title, type, status, cover, genres, demographic_target, author, artist, alternative_titles, total_chapters, is_oneshot, social_links, updated_at
        `, [
            title || null, description || null, type || null, status || null,
            genresArr || null, demographicTarget || null, author || null,
            artist || null, coverPath,
            altArr || null, totalChapters ? parseInt(totalChapters) : null,
            isOneshot !== undefined ? isOneshot === 'true' : null,
            socialArr || null, id,
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Manga no encontrado' });
        }

        res.json({
            success: true,
            message: 'Manga actualizado correctamente',
            manga: result.rows[0],
        });
    } catch (err) {
        if (req.file) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        console.error('Error actualizando manga:', err);
        res.status(500).json({ error: 'Error al actualizar manga' });
    }
});

// POST /api/manga/:id/rate — Votar manga (requiere auth)
async function getUserId(req) {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = await verifyToken(token);
            if (decoded && decoded.userId) return decoded.userId;
        }
    } catch {}
    if (req.body && req.body.userId) return req.body.userId;
    return null;
}

router.post('/:id/rate', async (req, res) => {
    try {
        const { id } = req.params;
        const { rating } = req.body;
        const userId = await getUserId(req);

        if (!userId) return res.status(401).json({ error: 'Debes iniciar sesi\u00f3n para votar' });

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Puntuaci\u00f3n debe ser de 1 a 5 estrellas' });
        }

        const mangaCheck = await pool.query('SELECT id FROM mangas WHERE id = $1', [id]);
        if (mangaCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Manga no encontrado' });
        }

        await pool.query(`
            INSERT INTO user_ratings (user_id, manga_id, rating)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, manga_id)
            DO UPDATE SET rating = EXCLUDED.rating, created_at = CURRENT_TIMESTAMP
        `, [userId, id, parseFloat(rating)]);

        const stats = await pool.query(`
            SELECT ROUND(AVG(rating) * 2::numeric, 1) AS avg_rating, COUNT(*) AS total
            FROM user_ratings WHERE manga_id = $1
        `, [id]);

        const avgRating = parseFloat(stats.rows[0].avg_rating) || 0;
        const totalRatings = parseInt(stats.rows[0].total) || 0;

        await pool.query(`
            UPDATE mangas SET rating = $1, total_ratings = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
        `, [avgRating, totalRatings, id]);

        try {
            await pool.query(
                `INSERT INTO activity_feed (user_id, action_type, manga_id, metadata)
                 VALUES ($1, 'rating', $2, $3)`,
                [userId, id, JSON.stringify({ rating: parseFloat(rating), avgRating })]
            );
        } catch {}

        res.json({ success: true, rating: avgRating, totalRatings });
    } catch (err) {
        console.error('Error rating manga:', err);
        res.status(500).json({ error: 'Error al votar' });
    }
});

// DELETE /api/manga/:id/rate — Eliminar voto
router.delete('/:id/rate', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = await getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Debes iniciar sesi\u00f3n' });

        await pool.query('DELETE FROM user_ratings WHERE user_id = $1 AND manga_id = $2', [userId, id]);

        const stats = await pool.query(
            'SELECT ROUND(AVG(rating) * 2::numeric, 1) AS avg_rating, COUNT(*) AS total FROM user_ratings WHERE manga_id = $1', [id]
        );
        const avgRating = parseFloat(stats.rows[0].avg_rating) || 0;
        const totalRatings = parseInt(stats.rows[0].total) || 0;
        await pool.query('UPDATE mangas SET rating = $1, total_ratings = $2 WHERE id = $3', [avgRating, totalRatings, id]);

        res.json({ success: true, rating: avgRating, totalRatings, deleted: true });
    } catch (err) {
        console.error('Error removing rating:', err);
        res.status(500).json({ error: 'Error al eliminar voto' });
    }
});

// GET /api/manga/:id/stats — Estadísticas completas
router.get('/:id/stats', async (req, res) => {
    try {
        const { id } = req.params;
        let userId = null;
        try {
            const token = req.headers.authorization?.split(' ')[1];
            if (token) {
                const decoded = await verifyToken(token);
                userId = decoded.userId;
            }
        } catch {}

        const mangaCheck = await pool.query('SELECT id, rating, total_ratings, total_reads FROM mangas WHERE id = $1', [id]);
        if (mangaCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Manga no encontrado' });
        }

        const manga = mangaCheck.rows[0];

        // Global: ratings from user_ratings
        const ratingStats = await pool.query(`
            SELECT
                ROUND(AVG(rating) * 2::numeric, 1) AS avg_rating,
                COUNT(*) AS total_votes,
                COUNT(*) FILTER (WHERE rating >= 4) AS high_votes,
                COUNT(*) FILTER (WHERE rating = 3) AS mid_votes,
                COUNT(*) FILTER (WHERE rating <= 2) AS low_votes
            FROM user_ratings WHERE manga_id = $1
        `, [id]);

        // Global: unique views from manga_views
        const viewsStats = await pool.query('SELECT COUNT(*) AS total_views FROM manga_views WHERE manga_id = $1', [id]);

        // Individual: chapters read by this user
        let chaptersRead = 0;
        let userRating = null;
        if (userId) {
            const prog = await pool.query('SELECT COUNT(*) AS cnt FROM user_chapter_progress WHERE user_id = $1 AND manga_id = $2', [userId, id]);
            chaptersRead = parseInt(prog.rows[0].cnt) || 0;

            const ur = await pool.query('SELECT rating FROM user_ratings WHERE user_id = $1 AND manga_id = $2', [userId, id]);
            if (ur.rows.length > 0) userRating = parseFloat(ur.rows[0].rating);
        }

        // Update mangas table with aggregated stats
        const avgRating = parseFloat(ratingStats.rows[0].avg_rating) || 0;
        const totalVotes = parseInt(ratingStats.rows[0].total_votes) || 0;
        const totalViews = parseInt(viewsStats.rows[0].total_views) || 0;
        // total_reads is maintained by manga_reads (chapter-read endpoint), not overwritten here
        await pool.query('UPDATE mangas SET rating = $1, total_ratings = $2 WHERE id = $3', [avgRating, totalVotes, id]);
        // Read the current total_reads from mangas (kept in sync by manga_reads)
        const readsRow = await pool.query('SELECT total_reads FROM mangas WHERE id = $1', [id]);
        const totalReads = parseInt(readsRow.rows[0]?.total_reads) || 0;

        res.json({
            mangaId: id,
            rating: avgRating,
            totalRatings: totalVotes,
            totalReads: totalReads,
            userRating: userRating,
            chaptersRead: chaptersRead,
            distribution: {
                high: parseInt(ratingStats.rows[0].high_votes) || 0,
                mid: parseInt(ratingStats.rows[0].mid_votes) || 0,
                low: parseInt(ratingStats.rows[0].low_votes) || 0,
            },
        });
    } catch (err) {
        console.error('Error getting stats:', err);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

// POST /api/manga/:id/reading — Actualizar progreso de lectura
router.post('/:id/reading', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, lastChapter, lastPage, totalPagesRead } = req.body;

        if (!userId) return res.status(401).json({ error: 'Debes iniciar sesión' });

        await pool.query(`
            INSERT INTO user_reading (user_id, manga_id, last_chapter, last_page, total_pages_read)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id, manga_id)
            DO UPDATE SET
                last_chapter = GREATEST(user_reading.last_chapter, EXCLUDED.last_chapter),
                last_page = EXCLUDED.last_page,
                total_pages_read = user_reading.total_pages_read + EXCLUDED.total_pages_read,
                updated_at = CURRENT_TIMESTAMP
        `, [userId, id, lastChapter || 0, lastPage || 0, totalPagesRead || 0]);

        res.json({ success: true });
    } catch (err) {
        console.error('Error updating reading progress:', err);
        res.status(500).json({ error: 'Error al actualizar progreso' });
    }
});

// POST /api/manga/:id/view — Track unique view (do NOT count as lectura)
router.post('/:id/view', async (req, res) => {
    try {
        const { id } = req.params;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Se requiere autenticaci\u00f3n' });
        const decoded = await verifyToken(token);
        const userId = decoded.userId;

        // Check if user already viewed before attempting insert
        const existing = await pool.query(
            'SELECT 1 FROM manga_views WHERE manga_id = $1 AND user_id = $2',
            [id, userId]
        );
        const hasViewed = existing.rows.length > 0;

        if (!hasViewed) {
            await pool.query(
                'INSERT INTO manga_views (manga_id, user_id) VALUES ($1, $2) ON CONFLICT (manga_id, user_id) DO NOTHING',
                [id, userId]
            );
        }

        const count = await pool.query('SELECT COUNT(*) AS total FROM manga_views WHERE manga_id = $1', [id]);
        const totalViews = parseInt(count.rows[0].total) || 0;

        res.json({ success: true, hasViewed, totalViews });
    } catch (err) {
        console.error('Error tracking view:', err);
        res.status(500).json({ error: 'Error al registrar visita' });
    }
});

// POST /api/manga/:id/chapter-read — Track chapter read + register lectura (once)
router.post('/:id/chapter-read', async (req, res) => {
    try {
        const { id } = req.params;
        const { chapterNumber } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Se requiere autenticaci\u00f3n' });
        const decoded = await verifyToken(token);
        const userId = decoded.userId;

        if (!chapterNumber) return res.status(400).json({ error: 'chapterNumber requerido' });

        // 1) Track chapter progress
        await pool.query(
            'INSERT INTO user_chapter_progress (user_id, manga_id, chapter_number) VALUES ($1, $2, $3) ON CONFLICT (user_id, manga_id, chapter_number) DO NOTHING',
            [userId, id, chapterNumber]
        );

        // 2) Auto-mark cartelera as viewed (reading a chapter implies viewing the manga)
        //    ON CONFLICT handles repeat visits gracefully
        await pool.query(
            'INSERT INTO manga_views (manga_id, user_id) VALUES ($1, $2) ON CONFLICT (manga_id, user_id) DO NOTHING',
            [id, userId]
        );

        // 3) Register lectura (once per manga per user)
        const lectura = await pool.query(
            'INSERT INTO manga_reads (manga_id, user_id) VALUES ($1, $2) ON CONFLICT (manga_id, user_id) DO NOTHING RETURNING id',
            [id, userId]
        );

        let lecturaRegistered = lectura.rows.length > 0;
        if (lecturaRegistered) {
            // Update total_reads from manga_reads count
            const reads = await pool.query(
                'SELECT COUNT(*) AS total FROM manga_reads WHERE manga_id = $1',
                [id]
            );
            await pool.query(
                'UPDATE mangas SET total_reads = $1 WHERE id = $2',
                [parseInt(reads.rows[0].total), id]
            );
        }

        const count = await pool.query('SELECT COUNT(*) AS total FROM user_chapter_progress WHERE user_id = $1 AND manga_id = $2', [userId, id]);
        res.json({
            success: true,
            chaptersRead: parseInt(count.rows[0].total) || 0,
            lecturaRegistered,
        });
    } catch (err) {
        console.error('Error tracking chapter read:', err);
        res.status(500).json({ error: 'Error al registrar lectura' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        await pool.query('DELETE FROM chapters WHERE manga_id = $1', [id]);

        const result = await pool.query('DELETE FROM mangas WHERE id = $1 RETURNING id, title', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Manga no encontrado' });
        }

        const mangaDir = path.join(MANGA_ASSETS_DIR, id);
        if (fs.existsSync(mangaDir)) {
            fs.rmSync(mangaDir, { recursive: true, force: true });
        }

        res.json({
            success: true,
            message: `"${result.rows[0].title}" eliminado del catálogo`,
        });
    } catch (err) {
        console.error('Error eliminando manga:', err);
        res.status(500).json({ error: 'Error al eliminar manga' });
    }
});

// ─── MANGA POSTS (foro/blog) ──────────────────────────────

// GET /api/manga/:id/posts — listar posts del manga
router.get('/:id/posts', async (req, res) => {
    try {
        const { limit = 20, offset = 0 } = req.query;
        const posts = await pool.query(
            `SELECT p.*, u.username, u.avatar
             FROM manga_posts p
             JOIN users u ON u.id = p.user_id
             WHERE p.manga_id = $1
             ORDER BY p.created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.params.id, parseInt(limit), parseInt(offset)]
        );
        res.json({ posts: posts.rows, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (err) {
        console.error('Error getting posts:', err);
        res.status(500).json({ error: 'Error al obtener publicaciones' });
    }
});

// POST /api/manga/:id/posts — crear un post
router.post('/:id/posts', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Se requiere autenticaci\u00f3n' });
        const decoded = await verifyToken(token);
        const { title, content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: 'El contenido es obligatorio' });

        const result = await pool.query(
            'INSERT INTO manga_posts (manga_id, user_id, title, content) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.params.id, decoded.userId, (title || '').trim(), content.trim()]
        );
        res.json({ success: true, post: result.rows[0] });
    } catch (err) {
        console.error('Error creating post:', err);
        res.status(500).json({ error: 'Error al crear publicación' });
    }
});

// ─── MANGA COMMENTS (globales) ────────────────────────────

// GET /api/manga/:id/comments — listar comentarios
router.get('/:id/comments', async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const comments = await pool.query(
            `SELECT c.*, u.username, u.avatar
             FROM manga_comments c
             JOIN users u ON u.id = c.user_id
             WHERE c.manga_id = $1
             ORDER BY c.created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.params.id, parseInt(limit), parseInt(offset)]
        );
        res.json({ comments: comments.rows, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (err) {
        console.error('Error getting comments:', err);
        res.status(500).json({ error: 'Error al obtener comentarios' });
    }
});

// POST /api/manga/:id/comments — crear comentario
router.post('/:id/comments', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Se requiere autenticaci\u00f3n' });
        const decoded = await verifyToken(token);
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: 'El comentario no puede estar vacío' });

        const result = await pool.query(
            'INSERT INTO manga_comments (manga_id, user_id, content) VALUES ($1, $2, $3) RETURNING *',
            [req.params.id, decoded.userId, content.trim()]
        );
        // Return with user info
        const comment = await pool.query(
            `SELECT c.*, u.username, u.avatar FROM manga_comments c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
            [result.rows[0].id]
        );
        res.json({ success: true, comment: comment.rows[0] });
    } catch (err) {
        console.error('Error creating comment:', err);
        res.status(500).json({ error: 'Error al crear comentario' });
    }
});

// ─── USER NOTES (privadas) ────────────────────────────────

// GET /api/manga/:id/notes — obtener nota privada del usuario
router.get('/:id/notes', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Se requiere autenticaci\u00f3n' });
        const decoded = await verifyToken(token);

        const result = await pool.query(
            'SELECT notes FROM user_manga_library WHERE user_id = $1 AND manga_id = $2',
            [decoded.userId, req.params.id]
        );
        res.json({ notes: result.rows[0]?.notes || '' });
    } catch (err) {
        console.error('Error getting notes:', err);
        res.status(500).json({ error: 'Error al obtener notas' });
    }
});

// POST /api/manga/:id/notes — guardar nota privada
router.post('/:id/notes', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Se requiere autenticaci\u00f3n' });
        const decoded = await verifyToken(token);
        const { notes } = req.body;

        await pool.query(
            `INSERT INTO user_manga_library (user_id, manga_id, notes, status)
             VALUES ($1, $2, $3, 'pendientes')
             ON CONFLICT (user_id, manga_id)
             DO UPDATE SET notes = EXCLUDED.notes`,
            [decoded.userId, req.params.id, (notes || '').trim()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving notes:', err);
        res.status(500).json({ error: 'Error al guardar notas' });
    }
});

// ─── MANGA ACTIVITY (stats comunitarias) ────────────────────

// GET /api/manga/:id/activity — miembros nuevos hoy, empezaron leyendo esta semana
router.get('/:id/activity', async (req, res) => {
    try {
        const { id } = req.params;

        // Users who added this manga to library TODAY
        const newToday = await pool.query(
            `SELECT COUNT(*) AS count FROM user_manga_library
             WHERE manga_id = $1 AND updated_at >= CURRENT_DATE`,
            [id]
        );

        // Users who set status to 'reading' this WEEK
        const readingWeek = await pool.query(
            `SELECT COUNT(*) AS count FROM user_manga_library
             WHERE manga_id = $1 AND status = 'reading'
             AND updated_at >= date_trunc('week', CURRENT_TIMESTAMP)`,
            [id]
        );

        res.json({
            newMembersToday: parseInt(newToday.rows[0].count) || 0,
            startedReadingWeek: parseInt(readingWeek.rows[0].count) || 0,
        });
    } catch (err) {
        console.error('Error getting manga activity:', err);
        res.status(500).json({ error: 'Error al obtener actividad' });
    }
});

// ─── RECOMMENDATIONS ──────────────────────────────────────

// GET /api/manga/:id/recommendations — recomendaciones por género similar
router.get('/:id/recommendations', async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 6 } = req.query;

        // Get this manga's genres
        const manga = await pool.query('SELECT genres FROM mangas WHERE id = $1', [id]);
        if (manga.rows.length === 0) return res.status(404).json({ error: 'Manga no encontrado' });

        const genres = manga.rows[0].genres || [];

        if (genres.length === 0) {
            // Fallback: random popular
            const fallback = await pool.query(
                'SELECT id, title, cover, rating FROM mangas WHERE id != $1 ORDER BY total_reads DESC LIMIT $2',
                [id, parseInt(limit)]
            );
            return res.json({ recommendations: fallback.rows });
        }

        // Find mangas with overlapping genres, excluding current
        const recs = await pool.query(
            `SELECT m.id, m.title, m.cover, m.rating, m.genres,
                    (SELECT COUNT(*) FROM unnest(m.genres) g WHERE g = ANY($2)) AS match_count
             FROM mangas m
             WHERE m.id != $1
               AND m.genres && $2
             ORDER BY match_count DESC, m.total_reads DESC
             LIMIT $3`,
            [id, genres, parseInt(limit)]
        );

        res.json({ recommendations: recs.rows });
    } catch (err) {
        console.error('Error getting recommendations:', err);
        res.status(500).json({ error: 'Error al obtener recomendaciones' });
    }
});

module.exports = router;
