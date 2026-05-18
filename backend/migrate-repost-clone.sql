-- ═══════════════════════════════════════════════════════════════════════════════
-- 🗄️ KAMI — migrate-repost-clone.sql
-- Añade soporte para repostes estilo X.com: el post se clona en feed_posts
-- con referencias al original y al usuario que repostea.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Columna que referencia al post original (CASCADE = si se borra el original, se borra el clon)
ALTER TABLE feed_posts
ADD COLUMN IF NOT EXISTS reposted_from_id INT REFERENCES feed_posts(id) ON DELETE CASCADE;

-- 2. Columna que guarda quién hizo el repost (para el banner "Tú reposteaste" / "@user Reposteó")
ALTER TABLE feed_posts
ADD COLUMN IF NOT EXISTS reposter_user_id VARCHAR(60) REFERENCES users(id) ON DELETE CASCADE;

-- 3. Índice para búsquedas rápidas en perfiles y feeds
CREATE INDEX IF NOT EXISTS idx_feed_posts_reposter ON feed_posts(reposter_user_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_reposted_from ON feed_posts(reposted_from_id);
