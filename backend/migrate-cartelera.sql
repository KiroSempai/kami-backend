-- =====================================================
-- TABLE: manga_posts — forum/blog-style publications about a manga
-- =====================================================
CREATE TABLE IF NOT EXISTS manga_posts (
    id SERIAL PRIMARY KEY,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_manga_posts_manga ON manga_posts(manga_id);
CREATE INDEX IF NOT EXISTS idx_manga_posts_created ON manga_posts(created_at DESC);

-- =====================================================
-- TABLE: manga_comments — global manga-level comments
-- =====================================================
CREATE TABLE IF NOT EXISTS manga_comments (
    id SERIAL PRIMARY KEY,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_manga_comments_manga ON manga_comments(manga_id);
CREATE INDEX IF NOT EXISTS idx_manga_comments_created ON manga_comments(created_at DESC);

-- =====================================================
-- ADD notes column to user_manga_library
-- =====================================================
ALTER TABLE user_manga_library ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
