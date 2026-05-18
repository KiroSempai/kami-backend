-- KAMI — Community Bans + Admin auto-creator upgrade
-- Ejecutar en Supabase SQL Editor

-- 1. Ascender admins globales a creator en todas las comunidades donde sean miembros
UPDATE community_members cm
SET role = 'creator'
FROM user_with_role uwr
WHERE uwr.id = cm.user_id AND uwr.role = 'admin' AND cm.role != 'creator';

-- 2. Tabla de baneos por comunidad
CREATE TABLE IF NOT EXISTS community_bans (
    id SERIAL PRIMARY KEY,
    community_id VARCHAR(60) NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by VARCHAR(60) NOT NULL REFERENCES users(id),
    reason TEXT DEFAULT '',
    banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_id, user_id)
);
