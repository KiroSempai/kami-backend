-- =====================================================
-- SOCIAL FEATURES MIGRATION
-- =====================================================

-- Table: user_follows (unidirectional follow)
CREATE TABLE IF NOT EXISTS user_follows (
    id SERIAL PRIMARY KEY,
    follower_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(follower_id, following_id),
    CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON user_follows(following_id);

-- Table: activity_feed (public user actions)
CREATE TABLE IF NOT EXISTS activity_feed (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL,
    manga_id VARCHAR(20) REFERENCES mangas(id) ON DELETE SET NULL,
    chapter_number NUMERIC DEFAULT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_feed(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_feed(action_type);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_feed(created_at DESC);

-- Insert sample activity for existing users (so feed isn't empty)
-- This is safe to run multiple times due to the nature of the data
INSERT INTO activity_feed (user_id, action_type, metadata, created_at)
SELECT id, 'daily_login', jsonb_build_object('type', 'login'), created_at
FROM users WHERE EXISTS (SELECT 1 FROM user_follows LIMIT 0)
ON CONFLICT DO NOTHING;

-- =====================================================
-- TABLE: manga_reads (one "lectura" per user per manga)
-- Only counted when user has viewed the cartelera AND
-- read at least 1 chapter. Dedup: one per manga per user.
-- =====================================================
CREATE TABLE IF NOT EXISTS manga_reads (
    id SERIAL PRIMARY KEY,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(manga_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_manga_reads_manga ON manga_reads(manga_id);
CREATE INDEX IF NOT EXISTS idx_manga_reads_user ON manga_reads(user_id, manga_id);
