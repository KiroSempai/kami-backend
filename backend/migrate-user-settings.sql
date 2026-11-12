-- ═══════════════════════════════════════════════════════════════════
-- KamiTales — Preferencias de notificaciones y eliminación de cuentas
--
-- 1. users.notification_prefs (JSONB): qué avisos quiere recibir cada
--    persona. Claves: likes, reposts, replies, follows, messages
--    (true/false). Lo que falta cuenta como activado. Los avisos de
--    moderación se envían siempre.
-- 2. users.deleted_at: fecha en que se eliminó la cuenta. La cuenta se
--    anonimiza (nombre, correo, foto, bio…) y deja de poder iniciar sesión;
--    la fila se conserva para no romper respuestas y conversaciones.
--
-- Aditiva y repetible: no cambia ningún dato existente. Ejecutar en Supabase o con:
--   node -e "require('./db').pool.query(require('fs').readFileSync('migrate-user-settings.sql','utf8')).then(()=>{console.log('ok');process.exit(0)})"
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at) WHERE deleted_at IS NOT NULL;
