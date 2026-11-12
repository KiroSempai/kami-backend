-- ═══════════════════════════════════════════════════════════════════
-- KamiTales — Cuenta propietaria y editorial de las obras
--
-- 1. users.is_owner: rango por encima de admin. Solo puede haber una
--    cuenta propietaria; nadie puede banearla, sancionarla ni cambiarle el
--    rol. Se asigna a la cuenta «Kiro» (que además queda como admin).
-- 2. mangas.publisher: editorial que publica la obra. Las obras sin dueño
--    o creadas por un admin se publican como «KamiTales»; el campo author
--    conserva al autor real. Si el autor está vacío, pasa a «KamiTales».
--
-- Aditiva y repetible. Ejecutar en Supabase o con:
--   node -e "require('./db').pool.query(require('fs').readFileSync('migrate-owner-publisher.sql','utf8')).then(()=>{console.log('ok');process.exit(0)})"
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users ((is_owner)) WHERE is_owner;

UPDATE users SET is_owner = TRUE, is_admin = TRUE
WHERE LOWER(username) = 'kiro'
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner);

ALTER TABLE mangas ADD COLUMN IF NOT EXISTS publisher VARCHAR(60) DEFAULT '';

UPDATE mangas SET publisher = 'KamiTales'
WHERE COALESCE(publisher, '') = ''
  AND (created_by IS NULL OR created_by IN (SELECT id FROM users WHERE is_admin));

UPDATE mangas SET author = 'KamiTales' WHERE COALESCE(TRIM(author), '') = '';
