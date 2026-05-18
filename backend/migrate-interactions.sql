-- =====================================================
-- INTERACTION SYSTEM — Columnas adicionales para replies
-- =====================================================

-- parent_id para hilos de comentarios (NULL = post raíz)
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES feed_posts(id) ON DELETE CASCADE;

-- Contadores consolidados (actualizados por background job cada 10s)
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS like_count INTEGER DEFAULT 0;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS repost_count INTEGER DEFAULT 0;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS reply_count INTEGER DEFAULT 0;

-- Índices
CREATE INDEX IF NOT EXISTS idx_feed_posts_parent ON feed_posts(parent_id);

-- Tabla de notificaciones de interacciones
CREATE TABLE IF NOT EXISTS feed_notifications (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER REFERENCES feed_posts(id) ON DELETE CASCADE,
    notification_type VARCHAR(30) NOT NULL,  -- like, repost, reply, bookmark
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feed_notif_user ON feed_notifications(user_id, read);
