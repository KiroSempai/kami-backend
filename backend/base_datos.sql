-- =====================================================
-- BASE DE DATOS USERS (IDs estilo fantasía + números)
-- =====================================================

-- CREATE TABLE users (

--     -- ID interno único (NO UUID, formato personalizado)
--     id VARCHAR(60) PRIMARY KEY,

--     username VARCHAR(30) UNIQUE NOT NULL,
--     email VARCHAR(255) UNIQUE NOT NULL,
--     password TEXT NOT NULL,

--     avatar TEXT DEFAULT '',
--     bio TEXT DEFAULT '',

--     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

-- );


CREATE TABLE users (
    id VARCHAR(60) PRIMARY KEY,
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password TEXT,
    google_id VARCHAR(255) UNIQUE,
    avatar TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    banner TEXT DEFAULT '',
    favorite_genres TEXT[] DEFAULT '{}',
    emoji TEXT DEFAULT '',
    premium_expires_at TIMESTAMP,
    reputation_score INTEGER DEFAULT 0,
    company_verified BOOLEAN DEFAULT FALSE,
    is_banned BOOLEAN DEFAULT FALSE,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Migración para bases de datos existentes:
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;
-- ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT DEFAULT '';
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMP;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS reputation_score INTEGER DEFAULT 0;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS company_verified BOOLEAN DEFAULT FALSE;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- =====================================================
-- VISTA: ROL CALCULADO DINÁMICAMENTE
-- =====================================================

CREATE OR REPLACE VIEW user_with_role AS
SELECT *,
  CASE
    WHEN is_admin = TRUE THEN 'admin'
    WHEN is_banned = TRUE THEN 'banned'
    WHEN company_verified = TRUE THEN 'company'
    WHEN premium_expires_at > NOW() AND subscription_tier = 'gold' THEN 'gold'
    WHEN premium_expires_at > NOW() AND subscription_tier = 'silver' THEN 'silver'
    WHEN reputation_score >= 500 THEN 'moderator'
    ELSE 'user'
  END AS role
FROM users;

-- =====================================================
-- TABLA MANGAS (catálogo de obras)
-- ID secuencial formateado como KMI-0000001
-- =====================================================

CREATE TABLE IF NOT EXISTS mangas (
    id VARCHAR(20) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    alternative_titles TEXT[] DEFAULT '{}',
    cover TEXT DEFAULT '',
    description TEXT DEFAULT '',
    type VARCHAR(20) NOT NULL CHECK (type IN ('manga', 'manhwa', 'manhua', 'oneshot')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('ongoing', 'completed', 'hiatus', 'cancelled')),
    genres TEXT[] DEFAULT '{}',
    demographic_target VARCHAR(30) DEFAULT '',
    author VARCHAR(255) DEFAULT '',
    artist VARCHAR(255) DEFAULT '',
    total_chapters INTEGER DEFAULT 0,
    is_oneshot BOOLEAN DEFAULT FALSE,
    social_links JSONB DEFAULT '{}',
    rating NUMERIC(3,1) DEFAULT 0,
    total_ratings INTEGER DEFAULT 0,
    total_reads INTEGER DEFAULT 0,
    chapters JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mangas_type ON mangas(type);
CREATE INDEX IF NOT EXISTS idx_mangas_status ON mangas(status);
CREATE INDEX IF NOT EXISTS idx_mangas_genres ON mangas USING GIN(genres);
CREATE INDEX IF NOT EXISTS idx_mangas_title ON mangas USING GIN(to_tsvector('spanish', title));

-- =====================================================
-- TABLA: BIBLIOTECA DE USUARIO
-- =====================================================

CREATE TABLE IF NOT EXISTS user_manga_library (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'planned',
    is_favorite BOOLEAN DEFAULT FALSE,
    score INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, manga_id)
);

CREATE INDEX IF NOT EXISTS idx_library_user ON user_manga_library(user_id);
CREATE INDEX IF NOT EXISTS idx_library_status ON user_manga_library(user_id, status);

-- =====================================================
-- TABLA: IPS BANEADAS
-- =====================================================

CREATE TABLE IF NOT EXISTS banned_ips (
    id SERIAL PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL UNIQUE,
    user_id VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_banned_ips_addr ON banned_ips(ip_address);

-- Baneados recientes
-- SELECT ip_address, reason, created_at FROM banned_ips ORDER BY created_at DESC LIMIT 20;

-- =====================================================
-- TABLA: NOTIFICACIONES
-- =====================================================

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'info',
    title VARCHAR(255) NOT NULL DEFAULT '',
    message TEXT DEFAULT '',
    is_read BOOLEAN DEFAULT FALSE,
    link TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- =====================================================
-- TABLA: HISTORIAL DE MODERACIÓN
-- =====================================================

CREATE TABLE IF NOT EXISTS moderation_logs (
    id SERIAL PRIMARY KEY,
    target_user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    moderator_user_id VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL,
    action_type VARCHAR(50) NOT NULL,
    reason TEXT DEFAULT '',
    duration_seconds BIGINT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mod_target ON moderation_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_mod_moderator ON moderation_logs(moderator_user_id);

-- =====================================================
-- TABLA: HILOS DE MENSAJES (SOPORTE)
-- =====================================================

CREATE TABLE IF NOT EXISTS message_threads (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_moderator_id VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL,
    subject VARCHAR(255) NOT NULL DEFAULT '',
    status VARCHAR(50) NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_threads_user ON message_threads(user_id);
CREATE INDEX IF NOT EXISTS idx_threads_mod ON message_threads(assigned_moderator_id);
CREATE INDEX IF NOT EXISTS idx_threads_status ON message_threads(status);

-- =====================================================
-- TABLA: MENSAJES
-- =====================================================

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
    sender_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(thread_id, is_read);

-- =====================================================
-- MONITOREO DE ROLES
-- =====================================================

-- Usuarios por rol (desde la VIEW)
-- SELECT role, COUNT(*) AS cantidad FROM user_with_role GROUP BY role ORDER BY cantidad DESC;

-- Premium próximos a expirar (próximos 7 días)
-- SELECT username, email, premium_expires_at FROM users
-- WHERE premium_expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days';

-- Premium expirados que aún tienen role premium (inconsistencias)
-- SELECT username, email FROM user_with_role
-- WHERE role = 'premium' AND premium_expires_at <= NOW();

-- Usuarios con reputación >= 500 (potenciales moderadores)
-- SELECT username, email, reputation_score FROM users
-- WHERE reputation_score >= 500 AND company_verified = FALSE AND is_banned = FALSE;

-- Usuarios admin
-- SELECT username, email FROM users WHERE is_admin = TRUE;

-- Usuarios baneados
-- SELECT username, email, is_banned FROM users WHERE is_banned = TRUE;

-- Empresas verificadas
-- SELECT username, email, company_verified FROM users WHERE company_verified = TRUE;

-- Vista panorámica de roles
-- Vista panorámica de roles
-- SELECT
--   (SELECT COUNT(*) FROM user_with_role WHERE role = 'admin') AS admins,
--   (SELECT COUNT(*) FROM user_with_role WHERE role = 'banned') AS banned,
--   (SELECT COUNT(*) FROM user_with_role WHERE role = 'company') AS companies,
--   (SELECT COUNT(*) FROM user_with_role WHERE role = 'premium') AS premium,
--   (SELECT COUNT(*) FROM user_with_role WHERE role = 'moderator') AS moderators,
--   (SELECT COUNT(*) FROM user_with_role WHERE role = 'user') AS users;

-- =====================================================
-- LISTA DE USUARIOS CON SU RANGO
-- =====================================================

-- Todos los usuarios con su rol calculado
-- SELECT id, username, email, role, created_at
-- FROM user_with_role
-- ORDER BY
--   CASE role
--     WHEN 'admin' THEN 1
--     WHEN 'moderator' THEN 2
--     WHEN 'company' THEN 3
--     WHEN 'premium' THEN 4
--     WHEN 'banned' THEN 5
--     ELSE 6
--   END,
--   username ASC;

-- Versión con más detalles
-- SELECT
--   username,
--   email,
--   role,
--   premium_expires_at,
--   reputation_score,
--   company_verified,
--   is_banned,
--   is_admin,
--   created_at
-- FROM user_with_role
-- ORDER BY role, username;