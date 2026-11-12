-- ═══════════════════════════════════════════════════════════════════
-- KamiTales — Novelas
-- Permite el tipo 'novel' en mangas.type (antes: manga, manhwa, manhua,
-- oneshot). No cambia ni borra datos; se puede repetir sin riesgo.
--
-- Ejecutar en el editor SQL de Supabase, o con:
--   node -e "require('./db').pool.query(require('fs').readFileSync('migrate-novels.sql','utf8')).then(()=>{console.log('ok');process.exit(0)})"
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE c record;
BEGIN
  -- Quitar la restricción CHECK actual sobre type, se llame como se llame
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'mangas' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%type%manhwa%'
  LOOP
    EXECUTE format('ALTER TABLE mangas DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE mangas
  ADD CONSTRAINT mangas_type_check CHECK (type IN ('manga', 'manhwa', 'manhua', 'oneshot', 'novel'));
