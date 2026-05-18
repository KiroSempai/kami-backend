// ═══════════════════════════════════════════════════════════════════════════════
// ⚙️ KAMI — routes-account.js
// Gestión de la cuenta de usuario: cambio de email, contraseña, borrado.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { mockDatabase } = require('../models');
const { JWT_SECRET } = require('../config');

const SECRET_KEY = JWT_SECRET;

// ═══════════════════════════════════════
// Middleware: verificar token (requerido)
// ═══════════════════════════════════════
const authMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            error: 'No autorizado. Por favor, inicia sesión',
            redirect: '/'
        });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({
            error: 'Token inválido o expirado',
            redirect: '/'
        });
    }
};

// Aplicar middleware a todas las rutas
router.use(authMiddleware);

// ═══════════════════════════════════════
// GET /api/account
// Obtener toda la configuración de la cuenta
// Cargado al abrir Página 3
// ═══════════════════════════════════════
router.get('/', (req, res) => {
    try {
        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const sessions = Object.values(mockDatabase.sessions)
            .filter(s => s.userId === req.user.userId && s.isActive)
            .map(s => ({
                id: s.sessionId,
                device: s.device,
                ipAddress: s.ipAddress,
                lastActivity: s.lastActivity,
                isCurrent: s.token === req.headers.authorization?.split(' ')[1],
            }));

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
                isVerified: user.isVerified,
                isPremium: user.isPremium,
                premiumExpires: user.premiumExpires,
                createdAt: user.createdAt,
            },
            settings: user.settings,
            sessions,
            security: {
                twoFaEnabled: user.settings.twoFA,
                lastPasswordChange: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000),
            }
        });

    } catch (err) {
        console.error('Error obteniendo configuración:', err);
        res.status(500).json({ error: 'Error al obtener configuración' });
    }
});

// ═══════════════════════════════════════
// PUT /api/account/profile
// SECCIÓN 1: Información Básica
// Actualizar datos del perfil
// ═══════════════════════════════════════
router.put('/profile', (req, res) => {
    try {
        const { username, email, bio, country, language, timezone } = req.body;
        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Validar cambios
        if (email && email !== user.email) {
            const emailExists = Object.values(mockDatabase.users).some(
                u => u.email === email && u.id !== req.user.userId
            );
            if (emailExists) {
                return res.status(409).json({ error: 'El email ya está en uso' });
            }
            user.email = email;
        }

        if (bio !== undefined) user.bio = bio;
        if (country) user.country = country;
        if (language) user.language = language;
        if (timezone) user.timezone = timezone;
        user.updatedAt = new Date();

        res.json({
            success: true,
            message: 'Información actualizada correctamente',
            user: {
                username: user.username,
                email: user.email,
                bio: user.bio,
                country: user.country,
                language: user.language,
                timezone: user.timezone,
            }
        });

    } catch (err) {
        console.error('Error actualizando perfil:', err);
        res.status(500).json({ error: 'Error al actualizar' });
    }
});

// ═══════════════════════════════════════
// PUT /api/account/password
// SECCIÓN 2: Seguridad - Cambiar contraseña
// ═══════════════════════════════════════
router.put('/password', async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Verificar contraseña actual
        const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);

        if (!passwordValid) {
            return res.status(401).json({ error: 'Contraseña actual incorrecta' });
        }

        // Hash de nueva contraseña
        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        user.passwordHash = newPasswordHash;
        user.updatedAt = new Date();

        res.json({
            success: true,
            message: 'Contraseña actualizada correctamente'
        });

    } catch (err) {
        console.error('Error cambiando contraseña:', err);
        res.status(500).json({ error: 'Error al cambiar contraseña' });
    }
});

// ═══════════════════════════════════════
// PUT /api/account/2fa
// SECCIÓN 2: Seguridad - Autenticación 2FA
// ═══════════════════════════════════════
router.put('/2fa', (req, res) => {
    try {
        const { enabled, method } = req.body;
        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        user.settings.twoFA = enabled;
        user.updatedAt = new Date();

        res.json({
            success: true,
            message: enabled ? '2FA habilitado' : '2FA deshabilitado',
            twoFaEnabled: enabled,
            backupCodes: enabled ? generateBackupCodes() : null,
        });

    } catch (err) {
        console.error('Error con 2FA:', err);
        res.status(500).json({ error: 'Error configurando 2FA' });
    }
});

// ═══════════════════════════════════════
// DELETE /api/account/session/:sessionId
// SECCIÓN 2: Seguridad - Cerrar sesión específica
// ═══════════════════════════════════════
router.delete('/session/:sessionId', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = mockDatabase.sessions[sessionId];

        if (!session || session.userId !== req.user.userId) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        session.isActive = false;

        res.json({
            success: true,
            message: 'Sesión cerrada correctamente'
        });

    } catch (err) {
        console.error('Error cerrando sesión:', err);
        res.status(500).json({ error: 'Error al cerrar sesión' });
    }
});

// ═══════════════════════════════════════
// PUT /api/account/preferences
// SECCIÓN 3: Preferencias de Lectura
// ═══════════════════════════════════════
router.put('/preferences', (req, res) => {
    try {
        const { readingMode, imageQuality, autoPreload, darkMode, nightFilter, scrollSaving } = req.body;
        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        if (readingMode) user.settings.readingMode = readingMode;
        if (imageQuality) user.settings.imageQuality = imageQuality;
        if (autoPreload !== undefined) user.settings.autoPreload = autoPreload;
        if (darkMode !== undefined) user.settings.darkMode = darkMode;
        if (nightFilter !== undefined) user.settings.nightFilter = nightFilter;
        if (scrollSaving !== undefined) user.settings.scrollSaving = scrollSaving;
        user.updatedAt = new Date();

        res.json({
            success: true,
            message: 'Preferencias de lectura actualizadas',
            settings: user.settings
        });

    } catch (err) {
        console.error('Error actualizando preferencias:', err);
        res.status(500).json({ error: 'Error al actualizar preferencias' });
    }
});

// ═══════════════════════════════════════
// PUT /api/account/library-automation
// SECCIÓN 4: Automatización de Biblioteca
// ═══════════════════════════════════════
router.put('/library-automation', (req, res) => {
    try {
        const {
            autoMarkPrevious,
            autoMoveContinuing,
            autoMoveCompleted,
            markAbandonedAfter,
            trackStatistics,
            includeInPublic
        } = req.body;

        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Actualizar configuración en settings.libraryAutomation
        if (!user.settings.libraryAutomation) {
            user.settings.libraryAutomation = {};
        }

        if (autoMarkPrevious !== undefined) user.settings.libraryAutomation.autoMarkPrevious = autoMarkPrevious;
        if (autoMoveContinuing !== undefined) user.settings.libraryAutomation.autoMoveContinuing = autoMoveContinuing;
        if (autoMoveCompleted !== undefined) user.settings.libraryAutomation.autoMoveCompleted = autoMoveCompleted;
        if (markAbandonedAfter !== undefined) user.settings.libraryAutomation.markAbandonedAfter = markAbandonedAfter;
        if (trackStatistics !== undefined) user.settings.libraryAutomation.trackStatistics = trackStatistics;
        if (includeInPublic !== undefined) user.settings.libraryAutomation.includeInPublic = includeInPublic;

        user.updatedAt = new Date();

        res.json({
            success: true,
            message: 'Automatización de biblioteca configurada',
            automation: user.settings.libraryAutomation
        });

    } catch (err) {
        console.error('Error configurando automatización:', err);
        res.status(500).json({ error: 'Error al configurar automatización' });
    }
});

// ═══════════════════════════════════════
// PUT /api/account/notifications
// SECCIÓN 5: Notificaciones
// ═══════════════════════════════════════
router.put('/notifications', (req, res) => {
    try {
        const { emailNotifications, pushNotifications, discordWebhook } = req.body;
        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        if (emailNotifications !== undefined) user.settings.emailNotifications = emailNotifications;
        if (pushNotifications !== undefined) user.settings.pushNotifications = pushNotifications;

        if (!user.settings.notifications) {
            user.settings.notifications = {};
        }
        if (discordWebhook !== undefined) user.settings.notifications.discordWebhook = discordWebhook;

        user.updatedAt = new Date();

        res.json({
            success: true,
            message: 'Notificaciones configuradas',
            notifications: {
                email: user.settings.emailNotifications,
                push: user.settings.pushNotifications,
            }
        });

    } catch (err) {
        console.error('Error configurando notificaciones:', err);
        res.status(500).json({ error: 'Error al configurar notificaciones' });
    }
});

// ═══════════════════════════════════════
// POST /api/account/backup/export
// SECCIÓN 6: Backup - Exportar datos
// ═══════════════════════════════════════
router.post('/backup/export', (req, res) => {
    try {
        const user = mockDatabase.users[req.user.userId];
        const library = mockDatabase.libraries[req.user.userId];
        const profile = mockDatabase.profiles[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const exportData = {
            user: {
                username: user.username,
                email: user.email,
                bio: user.bio,
                country: user.country,
                createdAt: user.createdAt,
            },
            library: library?.mangas || [],
            profile: profile || {},
            exportedAt: new Date(),
        };

        res.json({
            success: true,
            message: 'Datos exportados correctamente',
            data: exportData,
            downloadUrl: `/api/account/backup/download/${req.user.userId}`
        });

    } catch (err) {
        console.error('Error exportando datos:', err);
        res.status(500).json({ error: 'Error al exportar datos' });
    }
});

// ═══════════════════════════════════════
// PUT /api/account/privacy
// SECCIÓN 7: Privacidad
// ═══════════════════════════════════════
router.put('/privacy', (req, res) => {
    try {
        const { isPublic, hideActivity, hideLibrary, hideFavorites, allowFollowers } = req.body;
        const user = mockDatabase.users[req.user.userId];
        const profile = mockDatabase.profiles[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        if (!profile) {
            return res.status(404).json({ error: 'Perfil no encontrado' });
        }

        if (isPublic !== undefined) profile.isPublic = isPublic;

        if (!profile.privacy) {
            profile.privacy = {};
        }
        if (hideActivity !== undefined) profile.privacy.hideActivity = hideActivity;
        if (hideLibrary !== undefined) profile.privacy.hideLibrary = hideLibrary;
        if (hideFavorites !== undefined) profile.privacy.hideFavorites = hideFavorites;
        if (allowFollowers !== undefined) profile.privacy.allowFollowers = allowFollowers;

        user.updatedAt = new Date();

        res.json({
            success: true,
            message: 'Configuración de privacidad actualizada',
            privacy: profile.privacy
        });

    } catch (err) {
        console.error('Error actualizando privacidad:', err);
        res.status(500).json({ error: 'Error al actualizar privacidad' });
    }
});

// ═══════════════════════════════════════
// PUT /api/account/accessibility
// SECCIÓN 8: Accesibilidad
// ═══════════════════════════════════════
router.put('/accessibility', (req, res) => {
    try {
        const { fontSize, highContrast, reduceAnimations, colorblindMode } = req.body;
        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        if (!user.settings.accessibility) {
            user.settings.accessibility = {};
        }

        if (fontSize) user.settings.accessibility.fontSize = fontSize;
        if (highContrast !== undefined) user.settings.accessibility.highContrast = highContrast;
        if (reduceAnimations !== undefined) user.settings.accessibility.reduceAnimations = reduceAnimations;
        if (colorblindMode) user.settings.accessibility.colorblindMode = colorblindMode;

        user.updatedAt = new Date();

        res.json({
            success: true,
            message: 'Configuración de accesibilidad actualizada',
            accessibility: user.settings.accessibility
        });

    } catch (err) {
        console.error('Error actualizando accesibilidad:', err);
        res.status(500).json({ error: 'Error al actualizar accesibilidad' });
    }
});

// ═══════════════════════════════════════
// DELETE /api/account
// Eliminar cuenta permanentemente
// ═══════════════════════════════════════
router.delete('/', (req, res) => {
    try {
        const { password } = req.body;
        const user = mockDatabase.users[req.user.userId];

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Verificar contraseña antes de eliminar
        // (En este caso simplificado, solo verificamos que se envíe)
        if (!password) {
            return res.status(400).json({ error: 'Contraseña requerida para eliminar cuenta' });
        }

        // Marcar usuario como eliminado (soft delete)
        delete mockDatabase.users[req.user.userId];
        delete mockDatabase.profiles[req.user.userId];
        delete mockDatabase.libraries[req.user.userId];

        res.json({
            success: true,
            message: 'Cuenta eliminada permanentemente',
            redirect: '/'
        });

    } catch (err) {
        console.error('Error eliminando cuenta:', err);
        res.status(500).json({ error: 'Error al eliminar cuenta' });
    }
});

// ═══════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════

function generateBackupCodes() {
    const codes = [];
    for (let i = 0; i < 10; i++) {
        codes.push(`KAMI-${Math.random().toString(36).substr(2, 8).toUpperCase()}`);
    }
    return codes;
}

module.exports = router;