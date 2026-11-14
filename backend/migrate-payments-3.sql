-- ═══════════════════════════════════════════════════════════════════════════════
-- KamiTales — Pagos, fase 3: ingresos de los autores
--
-- Solo AÑADE: dos columnas (mangas, payments) y tres tablas nuevas. No modifica
-- ni borra datos existentes. Se puede ejecutar más de una vez sin efecto.
-- Requiere migrate-payments.sql y migrate-payments-2.sql.
--
-- Importes en «micros»: millonésimas de euro (1 céntimo = 10.000), enteros.
-- ═══════════════════════════════════════════════════════════════════════════════
BEGIN;

-- Porcentaje que recibe el autor de esta obra. NULL = el general (65 %).
-- Un contrato de exclusiva lo sube a 75.
ALTER TABLE mangas ADD COLUMN IF NOT EXISTS author_share_pct SMALLINT;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mangas_author_share_pct_check') THEN
    ALTER TABLE mangas ADD CONSTRAINT mangas_author_share_pct_check CHECK (author_share_pct IS NULL OR author_share_pct BETWEEN 0 AND 100);
  END IF;
END $c$;

-- Meses que cubre un cobro de suscripción: 1 (mensual) o 12 (anual). El reparto
-- de Premium reparte un cobro anual entre sus doce meses.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cover_months SMALLINT NOT NULL DEFAULT 1;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_cover_months_check') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_cover_months_check CHECK (cover_months IN (1, 12));
  END IF;
END $c$;

-- Tiempo de lectura medido por el servidor (no el que declare el navegador):
-- segundos entre guardados de progreso, con topes. Una fila por día, lector y obra.
CREATE TABLE IF NOT EXISTS reading_time (
  day        DATE         NOT NULL,
  user_id    VARCHAR(60)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manga_id   VARCHAR(20)  NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  seconds    INTEGER      NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  last_ping  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (day, user_id, manga_id)
);
CREATE INDEX IF NOT EXISTS idx_reading_time_user_day ON reading_time(user_id, day);

-- Libro de ingresos de los autores. Solo se añade: la base de datos rechaza
-- modificar o borrar filas. El saldo de un autor es la suma de sus movimientos.
--   sale     parte del autor en un capítulo desbloqueado
--   premium  su parte del reparto mensual de Premium
--   reversal anulación de un ingreso (devolución o reclamación)
--   payout   pago al autor (negativo)
--   adjust   corrección manual, siempre con nota
CREATE TABLE IF NOT EXISTS author_ledger (
  id             BIGSERIAL    PRIMARY KEY,
  author_id      VARCHAR(60)  NOT NULL,           -- sin clave ajena a propósito: el registro sobrevive a la cuenta
  manga_id       VARCHAR(20),
  kind           VARCHAR(10)  NOT NULL CHECK (kind IN ('sale', 'premium', 'reversal', 'payout', 'adjust')),
  amount_micros  BIGINT       NOT NULL CHECK (amount_micros <> 0),
  base_micros    BIGINT,                          -- importe neto sobre el que se calculó
  share_pct      SMALLINT,                        -- porcentaje aplicado
  unlock_id      BIGINT       REFERENCES chapter_unlocks(id),
  chapter_number INTEGER,
  period         DATE,                            -- primer día del mes, en los repartos de Premium
  note           TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- Una venta se apunta una sola vez; un mes de Premium, una vez por obra.
CREATE UNIQUE INDEX IF NOT EXISTS idx_author_ledger_sale ON author_ledger(unlock_id) WHERE kind = 'sale';
CREATE UNIQUE INDEX IF NOT EXISTS idx_author_ledger_premium ON author_ledger(period, manga_id) WHERE kind = 'premium';
CREATE INDEX IF NOT EXISTS idx_author_ledger_author ON author_ledger(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_author_ledger_manga ON author_ledger(manga_id);

DROP TRIGGER IF EXISTS author_ledger_append_only ON author_ledger;
CREATE TRIGGER author_ledger_append_only BEFORE UPDATE OR DELETE ON author_ledger
  FOR EACH ROW EXECUTE FUNCTION kami_append_only();
DROP TRIGGER IF EXISTS author_ledger_no_truncate ON author_ledger;
CREATE TRIGGER author_ledger_no_truncate BEFORE TRUNCATE ON author_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION kami_append_only();

-- Repartos mensuales de Premium ya hechos. Uno por mes: no se reparte dos veces.
CREATE TABLE IF NOT EXISTS premium_pool_runs (
  period              DATE         PRIMARY KEY,   -- primer día del mes repartido
  subscribers         INTEGER      NOT NULL,
  net_micros          BIGINT       NOT NULL,      -- ingresos netos de Premium atribuidos a ese mes
  pool_micros         BIGINT       NOT NULL,      -- el 70 %: lo que corresponde a autores
  distributed_micros  BIGINT       NOT NULL,      -- lo realmente apuntado a autores
  undistributed_micros BIGINT      NOT NULL,      -- sin lectura que lo reciba: se queda en la plataforma
  works               INTEGER      NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Cerradas a la API pública de Supabase: solo las toca el servidor.
ALTER TABLE reading_time       ENABLE ROW LEVEL SECURITY;
ALTER TABLE author_ledger      ENABLE ROW LEVEL SECURITY;
ALTER TABLE premium_pool_runs  ENABLE ROW LEVEL SECURITY;
DO $lock$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON reading_time, author_ledger, premium_pool_runs FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE author_ledger_id_seq FROM anon, authenticated;
  END IF;
END $lock$;

COMMIT;
