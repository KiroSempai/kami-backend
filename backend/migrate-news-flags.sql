-- =====================================================
-- KAMI — Migración: Columnas faltantes en feed_posts
-- Agrega is_news, is_global_announcement, views_count
-- =====================================================

ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS is_news BOOLEAN DEFAULT false;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS is_global_announcement BOOLEAN DEFAULT false;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0;
