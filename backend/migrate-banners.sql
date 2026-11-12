-- ═══════════════════════════════════════════════════════════════════
-- KamiTales — Banner de las obras
--
-- mangas.banner: ruta de la imagen apaisada que se muestra en la cabecera
--   de la ficha, fundida con el fondo mediante un degradado progresivo.
--   Vacío = la ficha usa la portada difuminada, como hasta ahora.
-- mangas.banner_position: punto vertical que se mantiene visible al
--   recortar el banner (0 = arriba, 50 = centro, 100 = abajo).
--
-- Aditiva y repetible: no cambia ningún dato existente. Ejecutar en Supabase o con:
--   node -e "require('dotenv').config();require('./db').pool.query(require('fs').readFileSync('migrate-banners.sql','utf8')).then(()=>{console.log('ok');process.exit(0)})"
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE mangas ADD COLUMN IF NOT EXISTS banner TEXT NOT NULL DEFAULT '';
ALTER TABLE mangas ADD COLUMN IF NOT EXISTS banner_position SMALLINT NOT NULL DEFAULT 50
  CHECK (banner_position BETWEEN 0 AND 100);
