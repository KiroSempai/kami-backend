// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — suscripciones Premium
//
// Reglas que este archivo garantiza:
//   · Solo un aviso firmado de Stripe activa o quita Premium. Nada del navegador.
//   · Cada aviso se procesa una sola vez (payment_events.id es único).
//   · No se confía en el contenido del aviso: de él solo se toman identificadores
//     y el estado real se vuelve a pedir a Stripe. Así el orden de llegada no importa.
//   · users.subscription_tier / premium_expires_at se recalculan desde la tabla
//     subscriptions; el resto de la web sigue leyendo esas dos columnas.
// ═══════════════════════════════════════════════════════════════════════════════
const { pool } = require('../db');
const { hasColumn } = require('../schema');
const S = require('./stripe');
const earnings = require('./earnings');

// Estados de Stripe en los que la suscripción da acceso.
const LIVE = ['active', 'trialing', 'past_due'];
const GRACE_DAYS = 7; // con un cobro fallido, margen mientras Stripe reintenta

const ts = (sec) => (sec ? new Date(sec * 1000) : null);
const idOf = (x) => (x && typeof x === 'object' ? x.id : x) || null;

async function ready() {
  return !!S.getStripe() && (await hasColumn('users', 'stripe_customer_id')) && (await hasColumn('subscriptions', 'stripe_subscription_id'));
}

// ─── Cliente ────────────────────────────────────────────────────────────────
async function ensureCustomer(userId) {
  const r = await pool.query('SELECT id, email, username, stripe_customer_id FROM users WHERE id = $1', [userId]);
  const u = r.rows[0];
  if (!u) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 });
  if (u.stripe_customer_id) return u.stripe_customer_id;
  const customer = await S.getStripe().customers.create(
    { email: u.email || undefined, metadata: { userId: u.id, username: u.username || '' } },
    { idempotencyKey: 'kami-customer-' + u.id }
  );
  const up = await pool.query(
    'UPDATE users SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL RETURNING stripe_customer_id', [u.id, customer.id]);
  if (up.rows.length) return customer.id;
  const again = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [u.id]); // otra petición llegó antes
  return again.rows[0].stripe_customer_id;
}

async function liveSubscription(userId) {
  const r = await pool.query(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND status = ANY($2) ORDER BY current_period_end DESC NULLS LAST LIMIT 1`, [userId, LIVE]);
  return r.rows[0] || null;
}

// ─── Pago y portal ──────────────────────────────────────────────────────────
async function createPortal(userId, baseUrl) {
  const customer = await ensureCustomer(userId);
  const s = await S.getStripe().billingPortal.sessions.create({ customer, return_url: baseUrl + '/ajustes#premium', locale: 'es' });
  return s.url;
}

async function createCheckout(userId, planKey, baseUrl) {
  if (!S.PLANS[planKey]) throw Object.assign(new Error('Plan no válido.'), { status: 400 });
  // Quien ya tiene suscripción cambia de plan en el portal: nunca dos suscripciones.
  if (await liveSubscription(userId)) return { url: await createPortal(userId, baseUrl), portal: true };
  const price = await S.priceIdFor(planKey);
  if (!price) {
    console.error('[pagos] Falta el precio de Stripe para', planKey, '— ejecuta: node scripts/stripe-setup.js');
    throw Object.assign(new Error('Los pagos no están configurados todavía.'), { status: 503 });
  }
  const customer = await ensureCustomer(userId);
  const params = {
    mode: 'subscription',
    customer,
    client_reference_id: userId,
    line_items: [{ price, quantity: 1 }],
    success_url: baseUrl + '/premium/exito?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: baseUrl + '/premium',
    locale: 'es',
    metadata: { userId, plan: planKey },
    subscription_data: { metadata: { userId, plan: planKey } },
  };
  if (process.env.STRIPE_AUTOMATIC_TAX === 'true') { params.automatic_tax = { enabled: true }; params.customer_update = { address: 'auto' }; }
  const session = await S.getStripe().checkout.sessions.create(params);
  return { url: session.url, portal: false };
}

// ─── Sincronizar una suscripción con su estado real en Stripe ───────────────
async function findUserId(db, sub) {
  const customer = idOf(sub.customer);
  const meta = sub.metadata && sub.metadata.userId;
  if (meta) {
    const r = await db.query('SELECT id, stripe_customer_id FROM users WHERE id = $1', [meta]);
    const u = r.rows[0];
    // El cliente de Stripe tiene que ser el de ese usuario (o no tener ninguno aún).
    if (u && (!u.stripe_customer_id || u.stripe_customer_id === customer)) {
      if (!u.stripe_customer_id) await db.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [u.id, customer]);
      return u.id;
    }
  }
  const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customer]);
  return r.rows[0] ? r.rows[0].id : null;
}

// Recalcula las dos columnas de users a partir de sus suscripciones.
async function refreshUser(db, userId) {
  const r = await db.query(
    `SELECT tier, status, current_period_start, current_period_end FROM subscriptions
      WHERE user_id = $1 AND status = ANY($2) ORDER BY (tier = 'gold') DESC, current_period_end DESC NULLS LAST LIMIT 1`, [userId, LIVE]);
  const s = r.rows[0];
  if (!s) {
    // Sin suscripción viva: se quita el plan. La fecha no se alarga nunca aquí.
    await db.query(`UPDATE users SET subscription_tier = NULL, premium_expires_at = LEAST(premium_expires_at, now()::timestamp) WHERE id = $1`, [userId]);
    return null;
  }
  let until = s.current_period_end;
  if (s.status === 'past_due' && s.current_period_start) {
    const grace = new Date(new Date(s.current_period_start).getTime() + GRACE_DAYS * 86400_000);
    if (!until || grace < until) until = grace;
  }
  await db.query('UPDATE users SET subscription_tier = $2, premium_expires_at = $3::timestamptz WHERE id = $1', [userId, s.tier, until]);
  return s.tier;
}

async function syncSubscription(db, subId) {
  const stripe = S.getStripe();
  const sub = await stripe.subscriptions.retrieve(subId);
  const item = sub.items && sub.items.data && sub.items.data[0];
  const plan = S.planOfPrice(item && item.price);
  if (!plan) return { skipped: 'precio ajeno a KamiTales' };
  const userId = await findUserId(db, sub);
  if (!userId) return { skipped: 'sin usuario' };

  const start = sub.current_period_start || (item && item.current_period_start);
  const end = sub.current_period_end || (item && item.current_period_end);
  await db.query(
    `INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_customer_id, tier, billing_interval, status,
                                current_period_start, current_period_end, cancel_at_period_end, canceled_at, livemode, stripe_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       user_id = EXCLUDED.user_id, tier = EXCLUDED.tier, billing_interval = EXCLUDED.billing_interval, status = EXCLUDED.status,
       current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end, canceled_at = EXCLUDED.canceled_at, updated_at = now()`,
    [userId, sub.id, idOf(sub.customer), plan.tier, plan.interval, sub.status, ts(start), ts(end),
      !!sub.cancel_at_period_end, ts(sub.canceled_at), !!sub.livemode, ts(sub.created)]
  );

  // Dos suscripciones vivas a la vez (dos pestañas pagando): se conserva la más
  // antigua; la nueva se cancela y se devuelve su cobro.
  let duplicate = false;
  if (LIVE.includes(sub.status)) {
    const others = await db.query(
      `SELECT stripe_subscription_id FROM subscriptions
        WHERE user_id = $1 AND status = ANY($2) AND stripe_subscription_id <> $3
          AND (stripe_created_at < $4 OR (stripe_created_at = $4 AND stripe_subscription_id < $3))`,
      [userId, LIVE, sub.id, ts(sub.created)]);
    if (others.rows.length) {
      duplicate = true;
      const pi = await latestPaymentIntent(stripe, sub);
      const gone = await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false });
      if (pi) await stripe.refunds.create({ payment_intent: pi, reason: 'duplicate' }, { idempotencyKey: 'kami-dup-' + sub.id });
      await db.query(`UPDATE subscriptions SET status = $2, canceled_at = now(), updated_at = now() WHERE stripe_subscription_id = $1`, [sub.id, gone.status || 'canceled']);
      console.warn('[pagos] suscripción duplicada cancelada y devuelta:', sub.id, 'usuario', userId);
    }
  }
  const tier = await refreshUser(db, userId);
  return { userId, tier, status: sub.status, duplicate };
}

async function latestPaymentIntent(stripe, sub) {
  const invId = idOf(sub.latest_invoice);
  if (!invId) return null;
  const inv = await stripe.invoices.retrieve(invId);
  return idOf(inv.payment_intent);
}

// ─── Registrar un cobro ─────────────────────────────────────────────────────
async function recordInvoice(db, invoiceId) {
  const stripe = S.getStripe();
  const inv = await stripe.invoices.retrieve(invoiceId, { expand: ['charge.balance_transaction'] });
  if (inv.status !== 'paid' || !(inv.amount_paid > 0)) return { skipped: 'factura sin cobro' };
  const subId = idOf(inv.subscription) || idOf(inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription);
  const u = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [idOf(inv.customer)]);
  const charge = inv.charge && typeof inv.charge === 'object' ? inv.charge : null;
  const bt = charge && charge.balance_transaction && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
  const tax = earnings.taxOf(inv.amount_paid, Number.isInteger(inv.tax) ? inv.tax : (inv.total_tax_amounts || []).reduce((a, t) => a + (t.amount || 0), 0));
  await db.query(
    `INSERT INTO payments (user_id, kind, stripe_invoice_id, stripe_payment_intent_id, stripe_charge_id, stripe_subscription_id,
                           amount_cents, tax_cents, fee_cents, currency, livemode, paid_at)
     VALUES ($1,'subscription',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (stripe_invoice_id) DO UPDATE SET
       fee_cents = COALESCE(payments.fee_cents, EXCLUDED.fee_cents),
       stripe_charge_id = COALESCE(payments.stripe_charge_id, EXCLUDED.stripe_charge_id),
       stripe_payment_intent_id = COALESCE(payments.stripe_payment_intent_id, EXCLUDED.stripe_payment_intent_id)`,
    [u.rows[0] ? u.rows[0].id : null, inv.id, idOf(inv.payment_intent), idOf(inv.charge), subId,
      inv.amount_paid, tax || 0, bt ? bt.fee : null, (inv.currency || 'eur').toLowerCase(), !!inv.livemode,
      ts((inv.status_transitions && inv.status_transitions.paid_at) || inv.created) || new Date()]
  );
  return { subId };
}

// Devolución total o parcial: se anota en el cobro. El importe viene de Stripe.
async function recordRefund(db, chargeId) {
  const ch = await S.getStripe().charges.retrieve(chargeId);
  const status = ch.amount_refunded >= ch.amount ? 'refunded' : (ch.amount_refunded > 0 ? 'partially_refunded' : 'paid');
  await db.query(
    `UPDATE payments SET refunded_cents = $3, status = CASE WHEN status = 'disputed' THEN status ELSE $4 END,
                         stripe_charge_id = COALESCE(stripe_charge_id, $1)
      WHERE stripe_charge_id = $1 OR (stripe_payment_intent_id IS NOT NULL AND stripe_payment_intent_id = $2)`,
    [ch.id, idOf(ch.payment_intent), ch.amount_refunded || 0, status]);
}

async function recordDispute(db, dispute) {
  await db.query(
    `UPDATE payments SET status = 'disputed' WHERE stripe_charge_id = $1 OR (stripe_payment_intent_id IS NOT NULL AND stripe_payment_intent_id = $2)`,
    [idOf(dispute.charge), idOf(dispute.payment_intent)]);
}

// ─── Avisos de Stripe ───────────────────────────────────────────────────────
const coinsReady = () => require('./coins').tablesReady();
async function handleEvent(db, event) {
  const o = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
      if (o.mode === 'subscription' && o.subscription) return syncSubscription(db, idOf(o.subscription));
      if (o.mode === 'payment') return (await coinsReady()) ? require('./coins').creditPack(db, o.id) : { skipped: 'monedas sin activar' };
      return { skipped: 'no es una suscripción' };
    case 'checkout.session.async_payment_succeeded':
      return (await coinsReady()) ? require('./coins').creditPack(db, o.id) : { skipped: 'monedas sin activar' };
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return syncSubscription(db, o.id);
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const r = await recordInvoice(db, o.id);
      if (r.subId) await syncSubscription(db, r.subId);
      // Un cobro anual cubre doce meses: el reparto de Premium lo divide entre ellos
      if (r.subId && await hasColumn('payments', 'cover_months')) {
        await db.query(
          `UPDATE payments p SET cover_months = CASE WHEN s.billing_interval = 'year' THEN 12 ELSE 1 END
             FROM subscriptions s WHERE p.stripe_invoice_id = $1 AND s.stripe_subscription_id = p.stripe_subscription_id`, [o.id]);
      }
      return r;
    }
    case 'invoice.payment_failed': {
      const subId = idOf(o.subscription) || idOf(o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription);
      return subId ? syncSubscription(db, subId) : { skipped: 'sin suscripción' };
    }
    case 'charge.refunded':
      await recordRefund(db, o.id);
      return require('./coins').voidPackByCharge(db, o.id, idOf(o.payment_intent));
    case 'charge.dispute.created':
      await recordDispute(db, o);
      return require('./coins').voidPackByCharge(db, idOf(o.charge), idOf(o.payment_intent));
    default:
      return { skipped: 'tipo sin tratar' };
  }
}

// Procesa un aviso ya verificado. Devuelve 'done', 'duplicate' o lanza si falla
// (el aviso queda pendiente y Stripe lo reenvía).
async function processEvent(event) {
  await pool.query(
    `INSERT INTO payment_events (id, type, livemode, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [event.id, event.type, !!event.livemode, JSON.stringify(event)]);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Bloquea la fila: una entrega repetida a la vez espera aquí y luego ve «procesado».
    const row = await db.query('SELECT processed_at FROM payment_events WHERE id = $1 FOR UPDATE', [event.id]);
    if (row.rows[0] && row.rows[0].processed_at) { await db.query('COMMIT'); return 'duplicate'; }
    await handleEvent(db, event);
    await db.query('UPDATE payment_events SET processed_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1', [event.id]);
    await db.query('COMMIT');
    return 'done';
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    await pool.query('UPDATE payment_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [event.id, String(err.message || err).slice(0, 500)]).catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function statusOf(userId) {
  const r = await pool.query(
    `SELECT premium_expires_at, subscription_tier,
            CASE WHEN premium_expires_at > NOW() THEN 'active' WHEN premium_expires_at IS NOT NULL THEN 'expired' ELSE 'none' END AS premium_status,
            CASE WHEN premium_expires_at > NOW() THEN EXTRACT(EPOCH FROM premium_expires_at - NOW())::INTEGER ELSE 0 END AS seconds_remaining
       FROM users WHERE id = $1`, [userId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const out = {
    premiumStatus: row.premium_status,
    subscriptionTier: row.subscription_tier,
    expiresAt: row.premium_expires_at,
    daysRemaining: row.premium_status === 'active' ? Math.floor(row.seconds_remaining / 86400) : 0,
    secondsRemaining: row.seconds_remaining,
    paymentsOpen: await ready(),
    subscription: null,
  };
  if (out.paymentsOpen) {
    const s = await liveSubscription(userId);
    if (s) out.subscription = { tier: s.tier, interval: s.billing_interval, status: s.status, renewsAt: s.current_period_end, cancelAtPeriodEnd: s.cancel_at_period_end };
  }
  return out;
}

module.exports = { ready, ensureCustomer, createCheckout, createPortal, processEvent, handleEvent, syncSubscription, statusOf, LIVE };
