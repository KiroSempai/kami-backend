-- ════════════════════════════════════════════════════════════
-- KAMI — Migración completa para Supabase
-- ════════════════════════════════════════════════════════════

-- Copia TODO esto y pégalo en Supabase → SQL Editor → New query
-- Luego haz clic en RUN

-- 0. Crear tabla users (Supabase no la crea automáticamente)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(60) PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL DEFAULT '',
    avatar TEXT DEFAULT '',
    banner TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    country TEXT DEFAULT '',
    favorite_genres TEXT[] DEFAULT '{}',
    emoji TEXT DEFAULT '',
    premium_expires_at TIMESTAMP,
    reputation_score INTEGER DEFAULT 0,
    company_verified BOOLEAN DEFAULT FALSE,
    is_banned BOOLEAN DEFAULT FALSE,
    is_admin BOOLEAN DEFAULT FALSE,
    subscription_tier VARCHAR(20) DEFAULT NULL,
    last_ip VARCHAR(45) DEFAULT '',
    password_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    image_quality VARCHAR(10) DEFAULT '1080',
    strikes INTEGER DEFAULT 0,
    muted_until TIMESTAMP DEFAULT NULL,
    google_id VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_genres TEXT[] DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS emoji TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reputation_score INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip VARCHAR(45) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS image_quality VARCHAR(10) DEFAULT '1080';
ALTER TABLE users ADD COLUMN IF NOT EXISTS strikes INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP DEFAULT NULL;

-- 2. Mangas
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
ALTER TABLE mangas ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}';

-- 3. Capítulos
CREATE TABLE IF NOT EXISTS chapters (
    id SERIAL PRIMARY KEY,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    chapter_number INTEGER NOT NULL,
    title TEXT DEFAULT '',
    pages INTEGER DEFAULT 0,
    scan_group TEXT DEFAULT '',
    release_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(manga_id, chapter_number)
);
CREATE INDEX IF NOT EXISTS idx_chapters_manga_id ON chapters(manga_id);
CREATE INDEX IF NOT EXISTS idx_chapters_number ON chapters(manga_id, chapter_number);

-- 4. Ratings
CREATE TABLE IF NOT EXISTS user_ratings (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    rating NUMERIC(2,1) NOT NULL CHECK (rating >= 0.5 AND rating <= 10.0),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, manga_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_manga ON user_ratings(manga_id);

-- 5. Reading progress
CREATE TABLE IF NOT EXISTS user_reading (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    last_chapter INTEGER DEFAULT 0,
    last_page INTEGER DEFAULT 0,
    total_pages_read INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, manga_id)
);
CREATE INDEX IF NOT EXISTS idx_reading_user ON user_reading(user_id);
CREATE INDEX IF NOT EXISTS idx_reading_manga ON user_reading(manga_id);

-- 6. Library
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

-- 7. Banned IPs
CREATE TABLE IF NOT EXISTS banned_ips (
    id SERIAL PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL UNIQUE,
    user_id VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_banned_ips_addr ON banned_ips(ip_address);

-- 8. Notifications
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

-- 9. Moderation logs
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

-- 10. Messages
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

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
    sender_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    is_read BOOLEAN DEFAULT FALSE,
    is_staff BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(thread_id, is_read);

-- 11. Revoked tokens (JWT blacklist)
CREATE TABLE IF NOT EXISTS revoked_tokens (
    id SERIAL PRIMARY KEY,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_revoked_token_hash ON revoked_tokens(token_hash);

-- 12. Analytics
CREATE TABLE IF NOT EXISTS global_daily_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    total_users INTEGER DEFAULT 0,
    active_users INTEGER DEFAULT 0,
    new_users INTEGER DEFAULT 0,
    premium_users INTEGER DEFAULT 0,
    total_actions INTEGER DEFAULT 0,
    total_reads INTEGER DEFAULT 0,
    avg_chapters_per_user DECIMAL(6,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manga_daily_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    reads INTEGER DEFAULT 0,
    unique_readers INTEGER DEFAULT 0,
    total_minutes INTEGER DEFAULT 0,
    rating_avg DECIMAL(3,1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, manga_id)
);
CREATE INDEX IF NOT EXISTS idx_manga_daily_date ON manga_daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_manga_daily_manga ON manga_daily_stats(manga_id);

CREATE TABLE IF NOT EXISTS premium_daily_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    total_premium INTEGER DEFAULT 0,
    new_premium INTEGER DEFAULT 0,
    expired_premium INTEGER DEFAULT 0,
    silver_count INTEGER DEFAULT 0,
    gold_count INTEGER DEFAULT 0,
    revenue_generated DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_premium_daily_date ON premium_daily_stats(date);

CREATE TABLE IF NOT EXISTS reading_heatmap (
    id SERIAL PRIMARY KEY,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
    total_reads INTEGER DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(day_of_week, hour)
);

-- 13. User tracking
CREATE TABLE IF NOT EXISTS user_tracking (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manga_id VARCHAR(20) DEFAULT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    chapter_id INTEGER DEFAULT NULL,
    action_type VARCHAR(50) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracking_user ON user_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_tracking_action ON user_tracking(user_id, action_type);

-- 14. Daily activity
CREATE TABLE IF NOT EXISTS user_daily_activity (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_date DATE NOT NULL,
    chapters_read INTEGER DEFAULT 0,
    minutes_read INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, activity_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_user ON user_daily_activity(user_id, activity_date);

-- 15. Friends
CREATE TABLE IF NOT EXISTS user_friends (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'accepted',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_user ON user_friends(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON user_friends(friend_id);

-- 16. Annotations
CREATE TABLE IF NOT EXISTS page_annotations (
    id SERIAL PRIMARY KEY,
    manga_id VARCHAR(20) NOT NULL,
    chapter_number INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    region JSONB NOT NULL,
    note_text TEXT NOT NULL DEFAULT '',
    color VARCHAR(7) DEFAULT '#f5c842',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_annotations_page ON page_annotations(manga_id, chapter_number, page_number);

-- 17. Story Pins (comentarios flotantes sobre páginas)
CREATE TABLE IF NOT EXISTS story_pins (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    chapter_number INTEGER NOT NULL,
    page_index INTEGER NOT NULL,
    x NUMERIC(5,4) NOT NULL,
    y NUMERIC(5,4) NOT NULL,
    message TEXT DEFAULT '',
    visibility VARCHAR(10) NOT NULL DEFAULT 'friends' CHECK (visibility IN ('friends','public','private')),
    emoji VARCHAR(10) DEFAULT NULL,
    likes INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_story_pins_page ON story_pins(manga_id, chapter_number, page_index);
CREATE INDEX IF NOT EXISTS idx_story_pins_user ON story_pins(user_id);

-- 18. Pin likes
CREATE TABLE IF NOT EXISTS pin_likes (
    id SERIAL PRIMARY KEY,
    pin_id INTEGER NOT NULL REFERENCES story_pins(id) ON DELETE CASCADE,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pin_id, user_id)
);

-- 19. Role VIEW
DROP VIEW IF EXISTS user_with_role CASCADE;
CREATE VIEW user_with_role AS
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

-- 18. Trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 19. Aplicar triggers
DO $$
DECLARE
    t text;
    tables text[] := ARRAY['users', 'mangas', 'chapters', 'user_reading', 'user_manga_library', 'user_ratings', 'page_annotations'];
BEGIN
    FOREACH t IN ARRAY tables
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_updated_at', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t || '_updated_at', t);
    END LOOP;
END;
$$;

-- ✅ Listo
