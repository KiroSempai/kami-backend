/**
 * KAMI - Auth Routes
 * Punto de entrada: Landing (página 1)
 * Destino: Perfil (página 2) → Cuenta (página 3)
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { mockDatabase } = require('../models');
const { JWT_SECRET } = require('../config');

const SECRET_KEY = JWT_SECRET;

// ═══════════════════════════════════════
// POST /api/auth/register
// Registro en landing, redirige a perfil
// ═══════════════════════════════════════
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, country, language } = req.body;

        // Validar entrada
        if (!username || !email || !password) {
            return res.status(400).json({
                error: 'Faltanparámetros requeridos',
                required: ['username', 'email', 'password']
            });
        }

        // Verificar si el usuario ya existe
        const existingUser = Object.values(mockDatabase.users).find(
            u => u.email === email || u.username === username
        );

        if (existingUser) {
            return res.status(409).json({
                error: 'El usuario o email ya existe'
            });
        }

        // Hash de contraseña
        const passwordHash = await bcrypt.hash(password, 10);

        // Crear usuario
        const newUserId = `user-${Date.now()}`;
        const newUser = {
            id: newUserId,
            username,
            email,
            passwordHash,
            avatar: username.slice(0, 2).toUpperCase(),
            banner: null,
            bio: '',
            country: country || 'ES',
            language: language || 'es',
            timezone: 'CET',
            createdAt: new Date(),
            updatedAt: new Date(),
            lastLoginAt: new Date(),
            isVerified: false,
            isPremium: false,
            premiumExpires: null,
            settings: {
                readingMode: 'vertical',
                imageQuality: 'balanced',
                autoPreload: true,
                darkMode: true,
                nightFilter: false,
                scrollSaving: true,
                twoFA: false,
                emailNotifications: false,
                pushNotifications: true,
            }
        };

        mockDatabase.users[newUserId] = newUser;

        // Crear perfil
        mockDatabase.profiles[newUserId] = {
            userId: newUserId,
            username,
            bio: '',
            country: country || 'ES',
            joinedDate: new Date(),
            isPublic: true,
            stats: {
                titlesRead: 0,
                chaptersCompleted: 0,
                hoursRead: 0,
                currentStreak: 0,
                maxStreak: 0,
                followers: 0,
                following: 0,
            },
            activityFeed: [],
            readingHeatmap: [],
        };

        // Crear biblioteca
        mockDatabase.libraries[newUserId] = {
            userId: newUserId,
            mangas: [],
            lastUpdated: new Date(),
        };

        // Generar JWT
        const token = jwt.sign(
            { userId: newUserId, username, email },
            SECRET_KEY,
            { expiresIn: '24h' }
        );

        // Guardar sesión
        const sessionId = `session-${Date.now()}`;
        mockDatabase.sessions[sessionId] = {
            sessionId,
            userId: newUserId,
            token,
            device: req.headers['user-agent'],
            ipAddress: req.ip,
            lastActivity: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            isActive: true,
        };

        res.status(201).json({
            success: true,
            message: 'Registro exitoso. Redirigiendo a perfil...',
            token,
            user: {
                id: newUserId,
                username,
                email,
                avatar: newUser.avatar,
            },
            redirect: `/profile/${username}` // → Página 2
        });

    } catch (err) {
        console.error('Error en registro:', err);
        res.status(500).json({ error: 'Error en el registro' });
    }
});

// ═══════════════════════════════════════
// POST /api/auth/login
// Login desde landing, redirige a perfil
// ═══════════════════════════════════════
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                error: 'Email y contraseña requeridos'
            });
        }

        // Buscar usuario
        const user = Object.values(mockDatabase.users).find(u => u.email === email);

        if (!user) {
            return res.status(401).json({
                error: 'Email o contraseña incorrectos'
            });
        }

        // Verificar contraseña
        const passwordValid = await bcrypt.compare(password, user.passwordHash);

        if (!passwordValid) {
            return res.status(401).json({
                error: 'Email o contraseña incorrectos'
            });
        }

        // Actualizar último login
        user.lastLoginAt = new Date();

        // Generar token
        const token = jwt.sign(
            { userId: user.id, username: user.username, email: user.email },
            SECRET_KEY,
            { expiresIn: '24h' }
        );

        // Guardar sesión
        const sessionId = `session-${Date.now()}`;
        mockDatabase.sessions[sessionId] = {
            sessionId,
            userId: user.id,
            token,
            device: req.headers['user-agent'],
            ipAddress: req.ip,
            lastActivity: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            isActive: true,
        };

        res.json({
            success: true,
            message: 'Login exitoso',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar,
                isPremium: user.isPremium,
            },
            redirect: `/profile/${user.username}` // → Página 2
        });

    } catch (err) {
        console.error('Error en login:', err);
        res.status(500).json({ error: 'Error en el login' });
    }
});

// ═══════════════════════════════════════
// POST /api/auth/logout
// Cierra sesión
// ═══════════════════════════════════════
router.post('/logout', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (token) {
            // Marcar sesiones como inactivas
            Object.values(mockDatabase.sessions).forEach(session => {
                if (session.token === token) {
                    session.isActive = false;
                }
            });
        }

        res.json({
            success: true,
            message: 'Sesión cerrada correctamente',
            redirect: '/' // → Volver a landing
        });

    } catch (err) {
        console.error('Error en logout:', err);
        res.status(500).json({ error: 'Error al cerrar sesión' });
    }
});

// ═══════════════════════════════════════
// POST /api/auth/verify
// Verifica si el token es válido
// Usado por páginas para mantener sesión
// ═══════════════════════════════════════
router.post('/verify', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                valid: false,
                message: 'Token no proporcionado'
            });
        }

        const decoded = jwt.verify(token, SECRET_KEY);
        const user = mockDatabase.users[decoded.userId];

        if (!user) {
            return res.status(401).json({
                valid: false,
                message: 'Usuario no encontrado'
            });
        }

        res.json({
            valid: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar,
                isPremium: user.isPremium,
            }
        });

    } catch (err) {
        console.error('Error en verificación:', err);
        res.status(401).json({
            valid: false,
            message: 'Token inválido o expirado'
        });
    }
});

// ═══════════════════════════════════════
// GET /api/auth/me
// Obtiene datos del usuario autenticado
// Usado en Perfil (página 2) y Cuenta (página 3)
// ═══════════════════════════════════════
router.get('/me', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'No autorizado' });
        }

        const decoded = jwt.verify(token, SECRET_KEY);
        const user = mockDatabase.users[decoded.userId];
        const profile = mockDatabase.profiles[decoded.userId];
        const library = mockDatabase.libraries[decoded.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar,
                banner: user.banner,
                bio: user.bio,
                country: user.country,
                language: user.language,
                timezone: user.timezone,
                isPremium: user.isPremium,
                isVerified: user.isVerified,
                createdAt: user.createdAt,
                settings: user.settings,
            },
            profile: profile || null,
            libraryCount: library?.mangas?.length || 0,
        });

    } catch (err) {
        console.error('Error obteniendo datos de usuario:', err);
        res.status(401).json({ error: 'Token inválido' });
    }
});

// ═══════════════════════════════════════
// POST /api/auth/refresh
// Refresca el token JWT
// ═══════════════════════════════════════
router.post('/refresh', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Token requerido' });
        }

        const decoded = jwt.verify(token, SECRET_KEY, { ignoreExpiration: true });
        const user = mockDatabase.users[decoded.userId];

        if (!user) {
            return res.status(401).json({ error: 'Usuario no encontrado' });
        }

        // Generar nuevo token
        const newToken = jwt.sign(
            { userId: user.id, username: user.username, email: user.email },
            SECRET_KEY,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token: newToken,
            message: 'Token refrescado'
        });

    } catch (err) {
        console.error('Error en refresh:', err);
        res.status(401).json({ error: 'Error al refrescar token' });
    }
});

module.exports = router;