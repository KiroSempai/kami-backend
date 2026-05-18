/**
 * KAMI — routes-auth.js
 * Usa PostgreSQL real (via db.js / pool)
 *
 * Endpoints:
 *   POST   /api/auth/register
 *   POST   /api/auth/login
 *   POST   /api/auth/logout
 *   POST   /api/auth/verify
 *   GET    /api/auth/me
 *   POST   /api/auth/refresh
 *   GET    /api/auth/check-username/:username
 *   GET    /api/auth/check-email/:email
 */


const { v4: uuidv4 } = require('uuid');
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { signToken, verifyToken, verifyTokenIgnoreExp, revokeToken } = require('../config');

const generateUserId = require('../generateUserID');
const getRole = require('../getRole');
const { OAuth2Client } = require('google-auth-library');

function getDefaultAvatar() {
  return '/assets/avatars/p-default' + (Math.floor(Math.random() * 9) + 1) + '.png';
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const APP_PORT = process.env.PORT || 3000;
const GOOGLE_REDIRECT_URI = `http://localhost:${APP_PORT}/api/auth/google/callback`;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de inicio de sesión. Espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: 'Demasiados registros desde esta IP. Espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Helper: extraer token del header ───────────────
function extractToken(req) {
    return req.headers.authorization?.split(' ')[1] ?? null;
}

router.get('/pool-test', async (req, res) => {
    try {
        const r = await pool.query('SELECT 1 AS ok');
        const u = await pool.query("SELECT id, username, email, password FROM users WHERE email = 'kirouchihaks@gmail.com'");
        let bcryptTest = 'not tested';
        try {
            bcryptTest = await bcrypt.compare('1234', u.rows[0]?.password || '');
        } catch(e) { bcryptTest = 'bcrypt error: ' + e.message; }
        res.json({ pool: 'ok', test: r.rows[0], user: { id: u.rows[0]?.id, username: u.rows[0]?.username }, bcryptTest });
    } catch(e) {
        res.status(500).json({ pool: 'error', message: e.message, stack: e.stack?.split('\n').slice(0,3).join('; ') });
    }
});

// ══════════════════════════════════════════════════════
// POST /api/auth/register
// Crea cuenta → guarda en PostgreSQL → devuelve JWT
// ══════════════════════════════════════════════════════
router.post('/register', registerLimiter, async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                error: 'Faltan campos requeridos',
                required: ['username', 'email', 'password'],
            });
        }

        // Validaciones básicas
        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ error: 'El nombre de usuario debe tener entre 3 y 30 caracteres' });
        }

        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: 'El nombre de usuario solo puede contener letras, números y _' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        }

        // Comprobar si ya existe
        const existing = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'El usuario o email ya están en uso' });
        }

        // Hash de contraseña
        const passwordHash = await bcrypt.hash(password, 10);
        // const userId = generateUserId();
        const userId = uuidv4(); // cambio por el de arriba


        // Insertar en BD
        const result = await pool.query(
            `INSERT INTO users (id, username, email, password, avatar, bio, password_changed_at)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
             RETURNING id, username, email, created_at`,
            [userId, username, email, passwordHash, getDefaultAvatar(), '']
        );

        const newUser = result.rows[0];

        // JWT
        const token = signToken({ userId: newUser.id, username: newUser.username, email: newUser.email });

        res.status(201).json({
            success: true,
            message: 'Cuenta creada correctamente',
            token,
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                avatar: newUser.avatar || getDefaultAvatar(),
                banner: '',
                bio: '',
                role: 'user',
            },
            redirect: `/profile/${newUser.username}`,
        });

    } catch (err) {
        console.error('Error en /register:', err);
        res.status(500).json({ error: 'Error interno al crear la cuenta' });
    }
});

// ══════════════════════════════════════════════════════
// POST /api/auth/login
// ══════════════════════════════════════════════════════
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña requeridos' });
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos' });
        }

        const user = result.rows[0];
        const role = getRole(user);

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos' });
        }

        try {
            const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || '';
            await pool.query(
                'UPDATE users SET updated_at = CURRENT_TIMESTAMP, last_ip = $1 WHERE id = $2',
                [clientIp.replace(/^::ffff:/, ''), user.id]
            );
        } catch(e) { console.warn('[login] IP update failed:', e.message); }

        const token = signToken({ userId: user.id, username: user.username, email: user.email });

        res.json({
            success: true,
            message: 'Login exitoso',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar || user.username.slice(0, 2).toUpperCase(),
                banner: user.banner || '',
                bio: user.bio || '',
                role,
            },
            redirect: `/profile/${user.username}`,
        });

    } catch (err) {
        console.error('Error en /login:', err.message);
        res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
    }
    }
});

// ══════════════════════════════════════════════════════
// POST /api/auth/logout
// ══════════════════════════════════════════════════════
router.post('/logout', async (req, res) => {
    try {
        const token = extractToken(req);
        if (token) {
            await revokeToken(token);
        }
        res.json({
            success: true,
            message: 'Sesión cerrada correctamente',
            redirect: '/',
        });
    } catch (err) {
        res.json({
            success: true,
            message: 'Sesión cerrada',
            redirect: '/',
        });
    }
});

// ══════════════════════════════════════════════════════
// POST /api/auth/verify  —  comprueba si el token es válido
// ══════════════════════════════════════════════════════
router.post('/verify', async (req, res) => {
    try {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ valid: false, message: 'Token no proporcionado' });

        const decoded = await verifyToken(token);

        const result = await pool.query(
            'SELECT id, username, email, avatar FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ valid: false, message: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        res.json({
            valid: true,
            user: { ...user, avatar: user.avatar || user.username.slice(0, 2).toUpperCase() },
        });

    } catch (err) {
        res.status(401).json({ valid: false, message: 'Token inválido o expirado' });
    }
});

// ══════════════════════════════════════════════════════
// GET /api/auth/me  —  datos del usuario autenticado
// ══════════════════════════════════════════════════════
router.get('/me', async (req, res) => {
    try {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ error: 'No autorizado' });

        const decoded = await verifyToken(token);

        const result = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        const role = getRole(user);
        res.json({
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar || user.username.slice(0, 2).toUpperCase(),
                bio: user.bio || '',
                banner: user.banner || '',
                country: user.country || '',
                imageQuality: user.image_quality || '1080',
                passwordChangedAt: user.password_changed_at,
                passwordOld: user.password_changed_at ? (Date.now() - new Date(user.password_changed_at).getTime()) > 180 * 24 * 60 * 60 * 1000 : false,
                favoriteGenres: user.favorite_genres || [],
                emoji: user.emoji || '',
                createdAt: user.created_at,
                premiumExpiresAt: user.premium_expires_at,
                reputationScore: user.reputation_score,
                companyVerified: user.company_verified,
                isBanned: user.is_banned,
                role,
            },
        });

    } catch (err) {
        console.error('Error en /me:', err);
        res.status(401).json({ error: 'Token inválido' });
    }
});

// ══════════════════════════════════════════════════════
// POST /api/auth/refresh  —  renueva el JWT
// ══════════════════════════════════════════════════════
router.post('/refresh', async (req, res) => {
    try {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ error: 'Token requerido' });

        const decoded = await verifyTokenIgnoreExp(token);

        const result = await pool.query(
            'SELECT id, username, email FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        const newToken = signToken({ userId: user.id, username: user.username, email: user.email });

        res.json({ success: true, token: newToken });

    } catch (err) {
        console.error('Error en /refresh:', err);
        res.status(401).json({ error: 'Error al refrescar token' });
    }
});

// ══════════════════════════════════════════════════════
// GET /api/auth/check-username/:username
// Usado por register.html en tiempo real
// ══════════════════════════════════════════════════════
router.get('/check-username/:username', async (req, res) => {
    try {
        const { username } = req.params;

        const result = await pool.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
        );

        res.json({ exists: result.rows.length > 0 });

    } catch (err) {
        console.error('Error en /check-username:', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ══════════════════════════════════════════════════════
// GET /api/auth/check-email/:email
// Usado por register.html en tiempo real
// ══════════════════════════════════════════════════════
router.get('/check-email/:email', async (req, res) => {
    try {
        const { email } = req.params;

        const result = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );

        res.json({ exists: result.rows.length > 0 });

    } catch (err) {
        console.error('Error en /check-email:', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ══════════════════════════════════════════════════════
// POST /api/auth/google
// Verifica el ID token de Google, crea o vincula cuenta
// ══════════════════════════════════════════════════════
router.post('/google', async (req, res) => {
    try {
        const { credential } = req.body;

        if (!credential) {
            return res.status(400).json({ error: 'Token de Google requerido' });
        }

        if (!GOOGLE_CLIENT_ID) {
            return res.status(500).json({ error: 'Google Auth no configurado en el servidor' });
        }

        // Verificar el token con Google
        const client = new OAuth2Client(GOOGLE_CLIENT_ID);
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name || email.split('@')[0];
        const picture = payload.picture || '';

        // 1. Buscar por google_id
        let result = await pool.query(
            'SELECT * FROM users WHERE google_id = $1',
            [googleId]
        );

        let user;

        if (result.rows.length > 0) {
            // Ya tiene cuenta con Google → login directo
            user = result.rows[0];
        } else {
            // 2. Buscar por email (vincular cuenta existente)
            result = await pool.query(
                'SELECT * FROM users WHERE email = $1',
                [email]
            );

            if (result.rows.length > 0) {
                // Vincular Google a cuenta existente
                user = result.rows[0];
                await pool.query(
                    'UPDATE users SET google_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [googleId, user.id]
                );
            } else {
                // 3. Crear cuenta nueva
                const userId = uuidv4();

                // Generar username único a partir del nombre
                let baseUsername = name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
                if (baseUsername.length < 3) baseUsername = 'user' + Date.now().toString().slice(-6);

                // Verificar unicidad del username
                let username = baseUsername;
                let attempt = 0;
                while (true) {
                    const check = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
                    if (check.rows.length === 0) break;
                    attempt++;
                    username = baseUsername + attempt;
                }

                const defaultAvatar = getDefaultAvatar();
                const insertResult = await pool.query(
                    `INSERT INTO users (id, username, email, google_id, avatar, bio)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     RETURNING id, username, email, avatar, created_at`,
                    [userId, username, email, googleId, defaultAvatar, '']

                );

                user = insertResult.rows[0];
            }
        }

        // Actualizar última sesión
        await pool.query(
            'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [user.id]
        );

        const token = signToken({ userId: user.id, username: user.username, email: user.email });
        const role = getRole(user);

        res.json({
            success: true,
            message: 'Login con Google exitoso',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar || user.username.slice(0, 2).toUpperCase(),
                banner: user.banner || '',
                bio: user.bio || '',
                role,
            },
            redirect: `/profile/${user.username}`,
        });

    } catch (err) {
        console.error('Error en /google:', err);
        if (err.message?.includes('Token used too late') || err.message?.includes('Invalid token')) {
            return res.status(401).json({ error: 'Token de Google inválido o expirado' });
        }
        res.status(500).json({ error: 'Error al autenticar con Google' });
    }
});

// ══════════════════════════════════════════════════════
// GET /api/auth/google-client-id
// Expone el Client ID para que el frontend lo use
// ══════════════════════════════════════════════════════
router.get('/google-client-id', (req, res) => {
    res.json({ clientId: GOOGLE_CLIENT_ID });
});

// ══════════════════════════════════════════════════════
// GET /api/auth/google/redirect
// Redirige al usuario a la pantalla de consentimiento de Google
// ══════════════════════════════════════════════════════
router.get('/google/redirect', (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return res.status(500).json({ error: 'Google Auth no configurado' });
    }

    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account',
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// ══════════════════════════════════════════════════════
// GET /api/auth/google/callback
// Google redirige aquí con ?code=xxx
// Intercambia el code por tokens, obtiene info del user
// ══════════════════════════════════════════════════════
router.get('/google/callback', async (req, res) => {
    try {
        const { code } = req.query;

        if (!code) {
            return res.redirect('/login?error=google_no_code');
        }

        // 1. Intercambiar code por tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: GOOGLE_REDIRECT_URI,
                grant_type: 'authorization_code',
            }),
        });

        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok) {
            console.error('Google token error:', tokenData);
            return res.redirect('/login?error=google_token_failed');
        }

        // 2. Obtener info del usuario con el access_token
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        const googleUser = await userInfoResponse.json();
        const googleId = googleUser.id;
        const email = googleUser.email;
        const name = googleUser.name || email.split('@')[0];

        // 3. Buscar o crear usuario
        let user;

        // Buscar por google_id
        let result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);

        if (result.rows.length > 0) {
            user = result.rows[0];
        } else {
            // Buscar por email
            result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

            if (result.rows.length > 0) {
                user = result.rows[0];
                await pool.query(
                    'UPDATE users SET google_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [googleId, user.id]
                );
            } else {
                // Crear cuenta nueva
                const userId = uuidv4();
                let baseUsername = name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
                if (baseUsername.length < 3) baseUsername = 'user' + Date.now().toString().slice(-6);

                let username = baseUsername;
                let attempt = 0;
                while (true) {
                    const check = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
                    if (check.rows.length === 0) break;
                    attempt++;
                    username = baseUsername + attempt;
                }

                const defaultAvatar = getDefaultAvatar();
                const insertResult = await pool.query(
                    `INSERT INTO users (id, username, email, google_id, avatar, bio)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     RETURNING id, username, email, avatar, created_at`,
                    [userId, username, email, googleId, defaultAvatar, '']

                );

                user = insertResult.rows[0];
            }
        }

        // 4. Generar JWT propio
        const token = signToken({ userId: user.id, username: user.username, email: user.email });
        const userData = encodeURIComponent(JSON.stringify({
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: user.avatar || user.username.slice(0, 2).toUpperCase(),
            banner: user.banner || '',
            bio: user.bio || '',
        }));

        // 5. Redirigir al login con token en params
        res.redirect(`/login?google_token=${token}&google_user=${userData}`);

    } catch (err) {
        console.error('Error en Google callback:', err);
        res.redirect('/login?error=google_callback_failed');
    }
});

// ══════════════════════════════════════════════════════
// PUT /api/auth/profile/edit  (requiere JWT)
// Editar perfil visual: bio, avatar, banner, favoriteGenres, emoji
// ══════════════════════════════════════════════════════
router.put('/profile/edit', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'Token requerido' });

        let decoded;
        try {
            decoded = await verifyToken(token);
        } catch {
            return res.status(401).json({ error: 'Token inválido' });
        }

        const { bio, avatar, banner, favoriteGenres, emoji } = req.body;

        if (bio !== undefined && bio.length > 300) {
            return res.status(400).json({ error: 'La bio no puede superar 300 caracteres' });
        }
        if (favoriteGenres !== undefined && (!Array.isArray(favoriteGenres) || favoriteGenres.length > 3)) {
            return res.status(400).json({ error: 'Máximo 3 géneros favoritos' });
        }

        const result = await pool.query(
            `UPDATE users
             SET bio            = COALESCE($1, bio),
                 avatar         = COALESCE($2, avatar),
                 banner         = COALESCE($3, banner),
                 favorite_genres = COALESCE($4, favorite_genres),
                 emoji          = COALESCE($5, emoji),
                 updated_at     = CURRENT_TIMESTAMP
             WHERE id = $6
             RETURNING *`,
            [
                bio             !== undefined ? bio              : null,
                avatar          !== undefined ? avatar           : null,
                banner          !== undefined ? banner           : null,
                favoriteGenres  !== undefined ? favoriteGenres   : null,
                emoji           !== undefined ? emoji            : null,
                decoded.userId,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        const role = getRole(user);
        res.json({
            success: true,
            message: 'Perfil actualizado',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar,
                bio: user.bio,
                banner: user.banner,
                country: user.country || '',
                favoriteGenres: user.favorite_genres || [],
                emoji: user.emoji || '',
                role,
            },
        });

    } catch (err) {
        console.error('Error editando perfil:', err);
        res.status(500).json({ error: 'Error al guardar cambios' });
    }
});

// ══════════════════════════════════════════════════════
// GET /api/auth/profile/editor  (requiere JWT)
// Devuelve datos editables del perfil + username
// ══════════════════════════════════════════════════════
router.get('/profile/editor', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'Token requerido' });

        let decoded;
        try {
            decoded = await verifyToken(token);
        } catch {
            return res.status(401).json({ error: 'Token inválido' });
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        const role = getRole(user);
        res.json({
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar || '',
                bio: user.bio || '',
                banner: user.banner || '',
                country: user.country || '',
                favoriteGenres: user.favorite_genres || [],
                emoji: user.emoji || '',
                createdAt: user.created_at,
                premiumExpiresAt: user.premium_expires_at,
                reputationScore: user.reputation_score,
                companyVerified: user.company_verified,
                isBanned: user.is_banned,
                role,
            },
        });

    } catch (err) {
        console.error('Error obteniendo perfil editor:', err.message);
        res.status(500).json({ error: 'Error al cargar perfil: ' + err.message });
    }
});

// ══════════════════════════════════════════════════════
// PUT /api/auth/change-password
// ══════════════════════════════════════════════════════
router.put('/change-password', async (req, res) => {
    try {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ error: 'Token requerido' });
        const decoded = await verifyToken(token);
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Todos los campos son requeridos' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
        }

        const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        const passwordValid = await bcrypt.compare(currentPassword, user.password);
        if (!passwordValid) {
            return res.status(401).json({ error: 'Contraseña actual incorrecta' });
        }

        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPasswordHash, decoded.userId]);

        res.json({ success: true, message: 'Contraseña actualizada correctamente' });
    } catch (err) {
        console.error('Error cambiando contraseña:', err.message);
        res.status(500).json({ error: 'Error al cambiar contraseña' });
    }
});

module.exports = router;
