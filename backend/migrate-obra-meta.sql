-- ═══════════════════════════════════════════════════════════════════
-- KamiTales — Ficha de obra ampliada (al estilo de WebNovel)
-- Idioma, protagonista, clasificación por edad, origen y etiquetas.
-- Aditiva y repetible: añade columnas con valor por defecto, no cambia datos.
--
-- Ejecutar en el editor SQL de Supabase, o con:
--   node -e "require('./db').pool.query(require('fs').readFileSync('migrate-obra-meta.sql','utf8')).then(()=>{console.log('ok');process.exit(0)})"
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE mangas ADD COLUMN IF NOT EXISTS language VARCHAR(8) DEFAULT 'es';
ALTER TABLE mangas ADD COLUMN IF NOT EXISTS lead VARCHAR(12) DEFAULT '';             -- 'masculino' | 'femenino' | 'grupo' | ''
ALTER TABLE mangas ADD COLUMN IF NOT EXISTS content_rating VARCHAR(12) DEFAULT 'todos'; -- 'todos' | 'adolescente' | 'adulto'
ALTER TABLE mangas ADD COLUMN IF NOT EXISTS origin VARCHAR(12) DEFAULT 'original';    -- 'original' | 'fanfic' | 'traduccion'
ALTER TABLE mangas ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_mangas_tags ON mangas USING GIN(tags);
