const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const getRole = require('../getRole');
const { verifyToken } = require('../config');

const authMiddleware = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    try {
        req.user = await verifyToken(token);
        next();
    } catch {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

router.get('/:username', async (req, res) => {
    try {
        const { username } = req.params;
        let requesterRole = null;
        let requesterId = null;
        try {
            const token = req.headers.authorization?.split(' ')[1];
            if (token) {
                const decoded = await verifyToken(token);
                requesterId = decoded.userId;
                const r = await pool.query('SELECT * FROM users WHERE id = $1', [requesterId]);
                if (r.rows.length > 0) requesterRole = getRole(r.rows[0]);
            }
        } catch {}

        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        const role = getRole(user);
        const isMod = ['admin', 'moderator', 'company'].includes(requesterRole);

        let followersCount = 0, followingCount = 0, isFollowing = false;
        try {
            const followersResult = await pool.query(
                'SELECT COUNT(*) AS count FROM user_follows WHERE following_id = $1',
                [user.id]
            );
            followersCount = parseInt(followersResult.rows[0].count);
            const followingResult = await pool.query(
                'SELECT COUNT(*) AS count FROM user_follows WHERE follower_id = $1',
                [user.id]
            );
            followingCount = parseInt(followingResult.rows[0].count);

            if (requesterId) {
                const followCheck = await pool.query(
                    'SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = $2',
                    [requesterId, user.id]
                );
                isFollowing = followCheck.rows.length > 0;
            }
        } catch {} // Tabla user_follows aún no existe

        res.json({
            user: {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                banner: user.banner,
                bio: user.bio || '',
                country: user.country || '',
                role,
                isVerified: user.company_verified || false,
                isPremium: role === 'premium',
                joinedDate: user.created_at,
                favoriteGenres: user.favorite_genres || [],
                emoji: user.emoji || '',
                followers: followersCount,
                following: followingCount,
            },
            profile: {
                stats: null,
                badges: [],
                isPublic: true,
            },
            isFollowing: isFollowing,
            canEdit: requesterId === user.id,
        });
    } catch (err) {
        console.error('Error obteniendo perfil:', err);
        res.status(500).json({ error: 'Error al obtener perfil' });
    }
});

router.get('/:username/library', async (req, res) => {
    try {
        const { username } = req.params;
        const { state } = req.query;

        const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        const userId = userResult.rows[0].id;

        let query = `SELECT l.status, l.score, l.progress, l.is_favorite, l.updated_at,
                            m.id AS manga_id, m.title, m.cover, m.type, m.genres, m.total_chapters, m.rating
                     FROM user_manga_library l
                     JOIN mangas m ON m.id = l.manga_id
                     WHERE l.user_id = $1`;
        const params = [userId];

        if (state) {
            const stateMap = {
                leyendo: 'reading', continuando: 'continuing', pendientes: 'planned',
                favoritos: 'favorite', terminados: 'completed', abandonados: 'dropped', releyendo: 'rereading',
            };
            query += ' AND l.status = $2';
            params.push(stateMap[state] || state);
        }

        query += ' ORDER BY l.updated_at DESC';
        const result = await pool.query(query, params);

        res.json({
            username,
            totalMangas: result.rows.length,
            mangas: result.rows.map(r => ({
                mangaId: r.manga_id,
                title: r.title,
                cover: r.cover,
                type: r.type,
                genres: r.genres,
                totalChapters: r.total_chapters,
                rating: r.rating,
                status: r.status,
                score: r.score,
                progress: r.progress,
                isFavorite: r.is_favorite,
                lastReadAt: r.updated_at,
            })),
        });
    } catch (err) {
        console.error('Error obteniendo biblioteca:', err);
        res.status(500).json({ error: 'Error al obtener biblioteca' });
    }
});

router.get('/:username/stats', async (req, res) => {
    try {
        const { username } = req.params;
        const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        const userId = userResult.rows[0].id;

        const lib = await pool.query('SELECT COUNT(*) AS total, COALESCE(SUM(progress),0) AS chapters FROM user_manga_library WHERE user_id = $1', [userId]);
        const total = parseInt(lib.rows[0].total) || 0;
        const chapters = parseInt(lib.rows[0].chapters) || 0;

        res.json({
            username,
            stats: {
                titlesRead: total,
                chaptersCompleted: chapters,
                hoursRead: (chapters * 0.15).toFixed(1),
                hoursPerWeek: (Math.random() * 15 + 3).toFixed(1),
                chaptersPerDay: (chapters / 365).toFixed(1),
                mangasPerMonth: (total / 12).toFixed(1),
                currentStreak: 0,
                maxStreak: 0,
                followers: 0,
                following: 0,
                favoriteGenres: [],
            },
            heatmap: generateHeatmap(),
            weeklyData: generateWeeklyData(),
            genreBreakdown: generateGenreBreakdown(),
            topMangas: [],
        });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener estad�sticas' });
    }
});

router.get('/:username/activity', (req, res) => {
    const { username } = req.params;
    res.json({ username, activity: [], activityCount: 0 });
});

router.get('/:username/lists', (req, res) => {
    const { username } = req.params;
    res.json({ username, lists: [], totalLists: 0 });
});

router.get('/:username/achievements', (req, res) => {
    const { username } = req.params;
    res.json({
        username,
        achievements: [],
        totalUnlocked: 0,
        totalAchievements: 0,
        level: 1,
        xp: 0,
        xpForNextLevel: 1000,
    });
});

router.put('/', authMiddleware, async (req, res) => {
    try {
        const { bio, country, avatar, banner, imageQuality } = req.body;
        const result = await pool.query(
            `UPDATE users SET
                bio = COALESCE($1, bio),
                country = COALESCE($2, country),
                avatar = COALESCE($3, avatar),
                banner = COALESCE($4, banner),
                image_quality = COALESCE($5, image_quality),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $6
             RETURNING *`,
            [bio || null, country || null, avatar || null, banner || null, imageQuality || null, req.user.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        const user = result.rows[0];
        const role = getRole(user);
        res.json({
            success: true,
            message: 'Perfil actualizado correctamente',
            user: { id: user.id, username: user.username, bio: user.bio, country: user.country, avatar: user.avatar, role, imageQuality: user.image_quality },
            redirect: '/account',
        });
    } catch (err) {
        console.error('Error actualizando perfil:', err);
        res.status(500).json({ error: 'Error al actualizar perfil' });
    }
});

function generateHeatmap() {
    const heatmap = [];
    const today = new Date();
    for (let i = 364; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const level = Math.floor(Math.random() * 3);
        heatmap.push({ date: date.toISOString().split('T')[0], level, count: level * 3 });
    }
    return heatmap;
}

function generateWeeklyData() {
    const days = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
    return days.map((day, i) => ({ day, chapters: [12, 8, 15, 6, 10, 24, 7][i] }));
}

function generateGenreBreakdown() {
    return [
        { genre: 'Seinen', count: 0, percentage: 0 },
        { genre: 'Acci�n', count: 0, percentage: 0 },
        { genre: 'Shonen', count: 0, percentage: 0 },
    ];
}

module.exports = router;
