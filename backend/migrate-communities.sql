-- =====================================================
-- COMMUNITIES — Tablas para el sistema de comunidades
-- =====================================================

CREATE TABLE IF NOT EXISTS communities (
    id VARCHAR(60) PRIMARY KEY,
    name VARCHAR(255) NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    manga_id VARCHAR(20) REFERENCES mangas(id) ON DELETE SET NULL,
    type VARCHAR(20) DEFAULT 'both',
    created_by VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS community_members (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    community_id VARCHAR(60) NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, community_id)
);

CREATE INDEX IF NOT EXISTS idx_commembers_community ON community_members(community_id);
CREATE INDEX IF NOT EXISTS idx_commembers_user ON community_members(user_id);
CREATE INDEX IF NOT EXISTS idx_communities_manga ON communities(manga_id);
