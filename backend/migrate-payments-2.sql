-- ═══════════════════════════════════════════════════════════════════════════════
-- KamiTales — Pagos, fase 2: monedas y adelantos de pago
--
-- Solo AÑADE: una columna a chapters y cuatro tablas nuevas. No modifica ni
-- borra datos existentes. Se puede ejecutar más de una vez sin efecto.
-- Requiere migrate-payments.sql (fase 1).
--
-- Unidades: las monedas son enteros. El valor en dinero se guarda en
-- «micros»: millonésimas de euro (1 céntimo = 10.000 micros), siempre enteros.
-- ═══════════════════════════════════════════════════════════════════════════════
BEGIN;

-- Precio del adelanto en monedas. NULL = no se vende: solo se puede esperar a free_at.
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS price_coins INTEGER;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chapters_price_coins_check') THEN
    ALTER TABLE chapters ADD CONSTRAINT chapters_price_coins_check CHECK (price_coins IS NULL OR price_coins BETWEEN 1 AND 1000);
  END IF;
END $c$;

-- Saldo de cada usuario. Es la fila que se bloquea mientras se opera con sus
-- monedas; la base de datos impide que quede en negativo.
CREATE TABLE IF NOT EXISTS coin_wallets (
  user_id     VARCHAR(60)  PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance     INTEGER      NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Lotes de monedas. Cada compra crea uno y recuerda cuánto valió de verdad cada
-- moneda (neto de IVA y comisión). Se gastan del más antiguo al más nuevo.
CREATE TABLE IF NOT EXISTS coin_lots (
  id                 BIGSERIAL    PRIMARY KEY,
  user_id            VARCHAR(60)  REFERENCES users(id) ON DELETE SET NULL,
  coins_total        INTEGER      NOT NULL CHECK (coins_total > 0),
  coins_left         INTEGER      NOT NULL CHECK (coins_left >= 0),
  unit_value_micros  INTEGER      NOT NULL CHECK (unit_value_micros >= 0),
  fee_estimated      BOOLEAN      NOT NULL DEFAULT FALSE,   -- la comisión aún no se conocía al acreditar
  source             VARCHAR(12)  NOT NULL CHECK (source IN ('purchase', 'grant')),
  payment_id         BIGINT       UNIQUE REFERENCES payments(id),   -- un cobro acredita un solo lote
  voided_at          TIMESTAMPTZ,                           -- devuelto o reclamado: lo que quedaba se retiró
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (coins_left <= coins_total)
);
CREATE INDEX IF NOT EXISTS idx_coin_lots_user ON coin_lots(user_id, id) WHERE coins_left > 0;

-- Capítulos desbloqueados. La clave única impide cobrar dos veces el mismo.
CREATE TABLE IF NOT EXISTS chapter_unlocks (
  id                 BIGSERIAL    PRIMARY KEY,
  user_id            VARCHAR(60)  REFERENCES users(id) ON DELETE SET NULL,
  manga_id           VARCHAR(20)  NOT NULL,
  chapter_number     INTEGER      NOT NULL,
  price_coins        INTEGER      NOT NULL CHECK (price_coins > 0),    -- precio de lista
  coins_spent        INTEGER      NOT NULL CHECK (coins_spent > 0),    -- lo que pagó (con descuento Gold si lo hay)
  discount_pct       INTEGER      NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  value_micros       BIGINT       NOT NULL CHECK (value_micros >= 0),       -- valor real de las monedas gastadas
  full_value_micros  BIGINT       NOT NULL CHECK (full_value_micros >= 0),  -- ese valor al precio de lista: base del reparto al autor
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (user_id, manga_id, chapter_number)
);
CREATE INDEX IF NOT EXISTS idx_unlocks_manga ON chapter_unlocks(manga_id, chapter_number);

-- Libro de movimientos de monedas. Solo se añade: la base de datos rechaza
-- modificar o borrar filas. Un error se corrige con un movimiento contrario.
CREATE TABLE IF NOT EXISTS coin_ledger (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         VARCHAR(60)  NOT NULL,          -- sin clave ajena a propósito: el registro sobrevive a la cuenta
  delta           INTEGER      NOT NULL CHECK (delta <> 0),
  balance_after   INTEGER      NOT NULL CHECK (balance_after >= 0),
  reason          VARCHAR(12)  NOT NULL CHECK (reason IN ('purchase', 'unlock', 'refund', 'grant', 'adjust')),
  payment_id      BIGINT,
  manga_id        VARCHAR(20),
  chapter_number  INTEGER,
  note            TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_user ON coin_ledger(user_id, id DESC);

CREATE OR REPLACE FUNCTION kami_append_only() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  RAISE EXCEPTION 'La tabla % es un libro de movimientos: no se modifica ni se borra', TG_TABLE_NAME;
END $f$;
DROP TRIGGER IF EXISTS coin_ledger_append_only ON coin_ledger;
CREATE TRIGGER coin_ledger_append_only BEFORE UPDATE OR DELETE ON coin_ledger
  FOR EACH ROW EXECUTE FUNCTION kami_append_only();
DROP TRIGGER IF EXISTS coin_ledger_no_truncate ON coin_ledger;
CREATE TRIGGER coin_ledger_no_truncate BEFORE TRUNCATE ON coin_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION kami_append_only();

-- Cerradas a la API pública de Supabase: solo las toca el servidor.
ALTER TABLE coin_wallets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE coin_lots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapter_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE coin_ledger     ENABLE ROW LEVEL SECURITY;
DO $lock$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON coin_wallets, coin_lots, chapter_unlocks, coin_ledger FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE coin_lots_id_seq, chapter_unlocks_id_seq, coin_ledger_id_seq FROM anon, authenticated;
    REVOKE ALL ON FUNCTION kami_append_only() FROM anon, authenticated, PUBLIC;
  END IF;
END $lock$;

COMMIT;
