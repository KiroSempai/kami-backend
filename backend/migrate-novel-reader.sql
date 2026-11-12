-- ═══════════════════════════════════════════════════════════════════
-- KamiTales — Editor y lector de novelas
-- Aditiva y repetible: añade columnas y una tabla, no borra ni cambia
-- datos. Los capítulos de cómic existentes quedan como 'published'.
--
-- Ejecutar en el editor SQL de Supabase, o con:
--   node -e "require('./db').pool.query(require('fs').readFileSync('migrate-novel-reader.sql','utf8')).then(()=>{console.log('ok');process.exit(0)})"
-- ═══════════════════════════════════════════════════════════════════

-- Capítulos: texto por bloques (párrafos con id fijo), estado y fechas
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS content JSONB;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS word_count INTEGER DEFAULT 0;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS status VARCHAR(12) DEFAULT 'published';
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;   -- publicación programada
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS free_at TIMESTAMPTZ;      -- adelanto: fecha en que pasa a ser gratis
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS note_before TEXT DEFAULT '';
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS note_after TEXT DEFAULT '';
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS content_warnings TEXT[] DEFAULT '{}';
UPDATE chapters SET status = 'published' WHERE status IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chapters_status_check') THEN
    ALTER TABLE chapters ADD CONSTRAINT chapters_status_check CHECK (status IN ('draft', 'scheduled', 'published'));
  END IF;
END $$;

-- Comentarios por párrafo (sobre la tabla de comentarios de capítulo)
ALTER TABLE chapter_comments ADD COLUMN IF NOT EXISTS paragraph_id VARCHAR(24);
ALTER TABLE chapter_comments ADD COLUMN IF NOT EXISTS is_spoiler BOOLEAN DEFAULT FALSE;
ALTER TABLE chapter_comments ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE chapter_comments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_chapter_comments_par ON chapter_comments(manga_id, chapter_number, paragraph_id);

-- Progreso exacto: párrafo y porcentaje
ALTER TABLE user_reading ADD COLUMN IF NOT EXISTS last_paragraph VARCHAR(24);
ALTER TABLE user_reading ADD COLUMN IF NOT EXISTS last_percent INTEGER DEFAULT 0;

-- Reacción rápida al final del capítulo (una por lector y capítulo)
CREATE TABLE IF NOT EXISTS chapter_reactions (
  user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  reaction VARCHAR(12) NOT NULL CHECK (reaction IN ('love', 'fire', 'sad', 'wow')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, manga_id, chapter_number)
);
