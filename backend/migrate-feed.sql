-- =====================================================
-- FEED ENGINE — Manga Mixer tables
-- =====================================================

-- Posts del feed (comunidad / foro)
CREATE TABLE IF NOT EXISTS feed_posts (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manga_id VARCHAR(20) REFERENCES mangas(id) ON DELETE SET NULL,
    title VARCHAR(255) DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    post_type VARCHAR(30) NOT NULL DEFAULT 'post',     -- post, review, fanart, theory, collection, meme
    chapter_number NUMERIC DEFAULT NULL,
    is_spoiler BOOLEAN DEFAULT false,
    is_sensitive BOOLEAN DEFAULT false,
    community_id VARCHAR(60) DEFAULT NULL,
    media_url TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feed_posts_created ON feed_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_posts_manga ON feed_posts(manga_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_user ON feed_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_type ON feed_posts(post_type);
CREATE INDEX IF NOT EXISTS idx_feed_posts_community ON feed_posts(community_id);

-- Interacciones del usuario con posts
CREATE TABLE IF NOT EXISTS feed_interactions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    interaction_type VARCHAR(30) NOT NULL,  -- like, repost, reply, bookmark, hide, mute, report
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, post_id, interaction_type)
);

CREATE INDEX IF NOT EXISTS idx_feed_interactions_user ON feed_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_feed_interactions_post ON feed_interactions(post_id);

-- Preferencias de feed por usuario (géneros silenciados, usuarios muteados, etc.)
CREATE TABLE IF NOT EXISTS feed_preferences (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pref_type VARCHAR(30) NOT NULL,           -- hidden_genre, muted_user, hidden_tag, +18
    pref_value VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, pref_type, pref_value)
);

CREATE INDEX IF NOT EXISTS idx_feed_prefs_user ON feed_preferences(user_id);

-- Semillas de ejemplo (usar solo después de tener usuarios reales)
-- INSERT INTO feed_posts ...
