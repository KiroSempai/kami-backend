-- ─────────────────────────────────────────────────────────────
-- KAMI — Migración de Vistas (Opción D)
-- Ejecutar DESPUÉS de migrate.sql
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS viewed_posts (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_viewed_posts_user ON viewed_posts(user_id, viewed_at);
