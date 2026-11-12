-- ═══════════════════════════════════════════════════════════════════
-- KAMI — Propiedad de las obras
-- Añade mangas.created_by para que cada obra tenga un dueño. Solo ese
-- usuario (o un admin) puede editarla, borrarla o subirle capítulos.
--
-- Es aditiva y se puede repetir sin riesgo: no borra ni cambia datos.
-- Las obras existentes quedan sin dueño (NULL) y solo un admin puede
-- editarlas hasta que se les asigne uno con el UPDATE del final.
--
-- Ejecutar en el editor SQL de Supabase, o con:
--   node -e "require('./db').pool.query(require('fs').readFileSync('migrate-ownership.sql','utf8')).then(()=>{console.log('ok');process.exit(0)})"
-- Después, reinicia el servidor (la existencia de la columna se cachea).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE mangas
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mangas_created_by ON mangas(created_by);

-- Asignar una obra existente a su autor (ejemplo, rellenar a mano):
-- UPDATE mangas SET created_by = '<id del usuario>' WHERE id = 'KMI-0000001';
