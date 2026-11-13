-- ═══════════════════════════════════════════════════════════════════════════════
-- KamiTales — Pagos, fase 1: suscripciones Premium con Stripe
--
-- Solo AÑADE: una columna a users y tres tablas nuevas. No modifica ni borra
-- datos existentes. Se puede ejecutar más de una vez sin efecto.
--
-- El código funciona sin esta migración (la página Premium sigue diciendo
-- «Muy pronto»), así que se puede desplegar antes de aplicarla.
--
-- Importes: siempre enteros en céntimos. Nunca decimales.
-- ═══════════════════════════════════════════════════════════════════════════════
BEGIN;

-- Cliente de Stripe de cada usuario (cus_…). Un cliente pertenece a un solo usuario.
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer
  ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Avisos recibidos de Stripe. La clave primaria es el identificador del aviso
-- (evt_…): un aviso repetido no se procesa dos veces.
CREATE TABLE IF NOT EXISTS payment_events (
  id            VARCHAR(80)  PRIMARY KEY,
  type          VARCHAR(80)  NOT NULL,
  livemode      BOOLEAN      NOT NULL DEFAULT FALSE,
  received_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,                       -- NULL = pendiente o fallido
  attempts      INTEGER      NOT NULL DEFAULT 0,
  last_error    TEXT,
  payload       JSONB        NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_events_pending
  ON payment_events(received_at) WHERE processed_at IS NULL;

-- Suscripciones. La fuente de verdad es Stripe; esta tabla es su copia.
-- users.subscription_tier y users.premium_expires_at se recalculan desde aquí,
-- de modo que el resto de la web (calidad, ambientes, insignia) no cambia.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      BIGSERIAL    PRIMARY KEY,
  user_id                 VARCHAR(60)  REFERENCES users(id) ON DELETE SET NULL,
  stripe_subscription_id  VARCHAR(64)  NOT NULL UNIQUE,
  stripe_customer_id      VARCHAR(64)  NOT NULL,
  tier                    VARCHAR(10)  NOT NULL CHECK (tier IN ('silver', 'gold')),
  billing_interval        VARCHAR(10)  NOT NULL CHECK (billing_interval IN ('month', 'year')),
  status                  VARCHAR(24)  NOT NULL,   -- active, past_due, canceled… (el de Stripe)
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN      NOT NULL DEFAULT FALSE,
  canceled_at             TIMESTAMPTZ,
  livemode                BOOLEAN      NOT NULL DEFAULT FALSE,
  stripe_created_at       TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

-- Cobros. Un registro por factura pagada (o, más adelante, por paquete de monedas).
-- Si se borra la cuenta, el cobro se conserva sin usuario: es un registro contable.
CREATE TABLE IF NOT EXISTS payments (
  id                        BIGSERIAL    PRIMARY KEY,
  user_id                   VARCHAR(60)  REFERENCES users(id) ON DELETE SET NULL,
  kind                      VARCHAR(16)  NOT NULL CHECK (kind IN ('subscription', 'coin_pack')),
  stripe_invoice_id         VARCHAR(64)  UNIQUE,
  stripe_checkout_id        VARCHAR(80)  UNIQUE,
  stripe_payment_intent_id  VARCHAR(64),
  stripe_charge_id          VARCHAR(64),
  stripe_subscription_id    VARCHAR(64),
  amount_cents              INTEGER      NOT NULL CHECK (amount_cents >= 0),   -- lo que pagó el cliente
  tax_cents                 INTEGER      NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  fee_cents                 INTEGER      CHECK (fee_cents >= 0),               -- comisión de Stripe; NULL = aún sin saber
  refunded_cents            INTEGER      NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  currency                  CHAR(3)      NOT NULL DEFAULT 'eur',
  status                    VARCHAR(20)  NOT NULL DEFAULT 'paid'
                            CHECK (status IN ('paid', 'partially_refunded', 'refunded', 'disputed')),
  livemode                  BOOLEAN      NOT NULL DEFAULT FALSE,
  paid_at                   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(stripe_charge_id);
CREATE INDEX IF NOT EXISTS idx_payments_intent ON payments(stripe_payment_intent_id);

COMMIT;
