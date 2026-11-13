-- ═══════════════════════════════════════════════════════════════════════════════
-- KamiTales — cerrar la base de datos a la API pública de Supabase
--
-- Supabase expone por su API (PostgREST) todo lo que haya en el esquema public
-- y da permisos completos a los roles «anon» y «authenticated». KamiTales no usa
-- esa API: todo pasa por el servidor, que se conecta como dueño de las tablas.
-- Dejarla abierta permitía leer y modificar datos sin iniciar sesión en la web.
--
-- Qué hace (no toca ningún dato):
--   1. Activa la seguridad por filas en todas las tablas de public, sin reglas:
--      nadie entra por la API. El servidor (dueño) no se ve afectado.
--   2. Retira los permisos de anon y authenticated sobre tablas, vistas y secuencias.
--      Importante para la vista user_with_role, que se saltaba la seguridad por
--      filas y dejaba a la vista la tabla de usuarios.
--   3. Hace que las tablas que se creen en adelante nazcan ya sin esos permisos.
--
-- Se puede ejecutar varias veces. Para deshacerlo: GRANT … TO anon, authenticated.
-- ═══════════════════════════════════════════════════════════════════════════════
BEGIN;

DO $lock$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;   -- incluye las vistas
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  END IF;
END $lock$;

COMMIT;
