// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — monedas y adelantos de pago
//
// Reglas que este archivo garantiza:
//   · Las monedas solo se acreditan desde un aviso firmado de Stripe, tras volver
//     a pedirle la sesión de pago y comprobar que está pagada y por el importe
//     exacto del paquete. Un cobro acredita un solo lote (payments y coin_lots
//     tienen claves únicas).
//   · Desbloquear bloquea el saldo del usuario mientras opera. Un capítulo se
//     cobra una sola vez por persona (clave única en chapter_unlocks).
//   · El saldo no puede quedar en negativo (lo impide la base de datos).
//   · Cada movimiento queda en coin_ledger, que no se puede editar ni borrar.
//   · Precios y descuentos se calculan aquí. El navegador no envía importes;
//     solo confirma el precio que vio, y si ya no coincide no se cobra.
// ═══════════════════════════════════════════════════════════════════════════════
const { pool } = require('../db');
const { hasColumn } = require('../schema');
const { canEditManga } = require('../middleware/auth');
const S = require('./stripe');
const earnings = require('./earnings');

const PACKS = {
  p500:  { coins: 500,  cents: 499,  base: 500 },
  p1050: { coins: 1050, cents: 999,  base: 1000 },   // 50 de regalo
  p2200: { coins: 2200, cents: 1999, base: 2000 },   // 200 de regalo
};
const PRICE_TIERS = [30, 50, 80];   // lo que puede costar un adelanto
const GOLD_DISCOUNT = 20;           // % que paga KamiTales, no el autor
const MICROS_PER_CENT = 10000;

const idOf = (x) => (x && typeof x === 'object' ? x.id : x) || null;
const err = (status, code, message, extra) => Object.assign(new Error(message), { status, code, extra });

// ¿Están las tablas? (para leer desbloqueos no hace falta Stripe)
async function tablesReady() {
  return (await hasColumn('chapter_unlocks', 'user_id')) && (await hasColumn('chapters', 'price_coins')) && (await hasColumn('coin_wallets', 'balance'));
}
// ¿Se puede comprar? Tablas, fase 1 y claves de Stripe.
async function ready() {
  return !!S.getStripe() && (await tablesReady()) && (await hasColumn('payments', 'stripe_checkout_id')) && (await hasColumn('users', 'stripe_customer_id'));
}

const costFor = (price, gold) => (gold ? Math.max(1, Math.round(price * (100 - GOLD_DISCOUNT) / 100)) : price);

async function isGold(db, userId) {
  if (!userId) return false;
  const r = await db.query(`SELECT 1 FROM users WHERE id = $1 AND subscription_tier = 'gold' AND premium_expires_at > now()`, [userId]);
  return r.rows.length > 0;
}

// Precio que se ofrece por un capítulo bloqueado, o null si no se vende.
function offerFor(row, gold) {
  if (!row || !row.price_coins || !row.free_at || new Date(row.free_at) <= new Date()) return null;
  return { priceCoins: row.price_coins, cost: costFor(row.price_coins, gold), goldCost: costFor(row.price_coins, true), discountPct: gold ? GOLD_DISCOUNT : 0 };
}

// Contexto de un lector para una obra: qué tiene desbloqueado y si es Gold.
async function readerContext(userId, mangaId) {
  const ctx = { ready: await tablesReady(), sell: false, unlocked: new Set(), gold: false };
  ctx.sell = ctx.ready && !!S.getStripe();   // sin compras abiertas no se ofrece nada: solo esperar
  if (!ctx.ready || !userId) return ctx;
  const r = await pool.query('SELECT chapter_number FROM chapter_unlocks WHERE user_id = $1 AND manga_id = $2', [userId, mangaId]);
  r.rows.forEach((x) => ctx.unlocked.add(x.chapter_number));
  ctx.gold = await isGold(pool, userId);
  return ctx;
}

// Guarda el precio del adelanto al crear o editar un capítulo. Solo vale uno de
// los niveles, y solo si el capítulo tiene fecha de liberación futura.
function cleanPrice(rawPrice, freeAt) {
  const p = parseInt(rawPrice, 10);
  return PRICE_TIERS.includes(p) && freeAt && new Date(freeAt) > new Date() ? p : null;
}
async function savePrice(mangaId, num, rawPrice, freeAt) {
  if (!(await hasColumn('chapters', 'price_coins'))) return null;
  const price = cleanPrice(rawPrice, freeAt);
  await pool.query('UPDATE chapters SET price_coins = $3 WHERE manga_id = $1 AND chapter_number = $2', [mangaId, num, price]);
  return price;
}

// ─── Saldo ──────────────────────────────────────────────────────────────────
async function lockWallet(db, userId) {
  await db.query('INSERT INTO coin_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const r = await db.query('SELECT balance FROM coin_wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  return r.rows[0].balance;
}
async function move(db, userId, balance, delta, reason, ref = {}) {
  const after = balance + delta;
  await db.query('UPDATE coin_wallets SET balance = $2, updated_at = now() WHERE user_id = $1', [userId, after]);
  await db.query(
    `INSERT INTO coin_ledger (user_id, delta, balance_after, reason, payment_id, manga_id, chapter_number, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, delta, after, reason, ref.paymentId || null, ref.mangaId || null, ref.chapter == null ? null : ref.chapter, ref.note || null]);
  return after;
}

async function wallet(userId) {
  const open = await ready();
  const out = { open, balance: 0, gold: false, goldDiscount: GOLD_DISCOUNT, priceTiers: PRICE_TIERS,
    packs: Object.entries(PACKS).map(([key, p]) => ({ key, coins: p.coins, cents: p.cents, bonus: p.coins - p.base })) };
  if (!(await tablesReady())) return out;
  const r = await pool.query('SELECT balance FROM coin_wallets WHERE user_id = $1', [userId]);
  out.balance = r.rows[0] ? r.rows[0].balance : 0;
  out.gold = await isGold(pool, userId);
  return out;
}

async function history(userId, limit = 50) {
  if (!(await tablesReady())) return [];
  const r = await pool.query(
    `SELECT l.id, l.delta, l.balance_after, l.reason, l.manga_id, l.chapter_number, l.created_at, m.title
       FROM coin_ledger l LEFT JOIN mangas m ON m.id = l.manga_id
      WHERE l.user_id = $1 ORDER BY l.id DESC LIMIT $2`, [userId, Math.min(100, Math.max(1, limit))]);
  return r.rows.map((x) => ({ id: Number(x.id), delta: x.delta, balanceAfter: x.balance_after, reason: x.reason, mangaId: x.manga_id, mangaTitle: x.title || null, chapter: x.chapter_number, at: x.created_at }));
}

// ─── Comprar un paquete ─────────────────────────────────────────────────────
// A dónde volver tras pagar: solo rutas internas sencillas (nunca otra web).
function safeReturn(p) {
  return typeof p === 'string' && /^\/[A-Za-z0-9\-_/]{0,200}$/.test(p) && !p.includes('//') ? p : '/monedas';
}

async function createPackCheckout(userId, packKey, baseUrl, returnTo) {
  if (!Object.prototype.hasOwnProperty.call(PACKS, packKey)) throw err(400, 'bad_pack', 'Paquete no válido.');
  const pack = PACKS[packKey];
  const customer = await require('./subscriptions').ensureCustomer(userId);
  const meta = { kind: 'coin_pack', userId, pack: packKey, coins: String(pack.coins) };
  const back = safeReturn(returnTo);
  const params = {
    mode: 'payment',
    customer,
    client_reference_id: userId,
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: pack.cents, tax_behavior: 'inclusive',
      product_data: { name: new Intl.NumberFormat('es-ES').format(pack.coins) + ' monedas KamiTales' } } }],
    success_url: baseUrl + back + '?monedas=ok',
    cancel_url: baseUrl + back + '?monedas=cancelado',
    locale: 'es',
    metadata: meta,
    payment_intent_data: { metadata: meta },
  };
  if (process.env.STRIPE_AUTOMATIC_TAX === 'true') { params.automatic_tax = { enabled: true }; params.customer_update = { address: 'auto' }; }
  const session = await S.getStripe().checkout.sessions.create(params);
  return session.url;
}

// Acredita el paquete de una sesión de pago. Se llama desde el aviso de Stripe.
async function creditPack(db, sessionId) {
  const s = await S.getStripe().checkout.sessions.retrieve(sessionId, { expand: ['payment_intent.latest_charge.balance_transaction'] });
  const meta = s.metadata || {};
  if (s.mode !== 'payment' || meta.kind !== 'coin_pack') return { skipped: 'no es un paquete de monedas' };
  if (s.payment_status !== 'paid') return { skipped: 'sin pagar todavía' };
  const pack = Object.prototype.hasOwnProperty.call(PACKS, meta.pack) ? PACKS[meta.pack] : null;
  if (!pack || s.amount_total !== pack.cents || String(s.currency).toLowerCase() !== 'eur') {
    console.error('[pagos] sesión', s.id, 'no cuadra con ningún paquete:', meta.pack, s.amount_total, s.currency);
    return { skipped: 'importe o paquete no válido' };
  }
  const u = await db.query('SELECT id FROM users WHERE id = $1 AND stripe_customer_id = $2', [meta.userId || '', idOf(s.customer)]);
  if (!u.rows.length) return { skipped: 'el cliente no es de ese usuario' };
  const userId = u.rows[0].id;

  const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const charge = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const bt = charge && charge.balance_transaction && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
  const tax = earnings.taxOf(pack.cents, (s.total_details && s.total_details.amount_tax) || 0);
  const feeKnown = !!bt && Number.isInteger(bt.fee);
  const fee = feeKnown ? bt.fee : earnings.feeGuess(pack.cents);   // estimación hasta conocerla
  const net = Math.max(0, pack.cents - tax - fee);

  const pay = await db.query(
    `INSERT INTO payments (user_id, kind, stripe_checkout_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, tax_cents, fee_cents, currency, livemode)
     VALUES ($1,'coin_pack',$2,$3,$4,$5,$6,$7,'eur',$8) ON CONFLICT (stripe_checkout_id) DO NOTHING RETURNING id`,
    [userId, s.id, idOf(s.payment_intent), idOf(pi && pi.latest_charge), pack.cents, tax, feeKnown ? fee : null, !!s.livemode]);
  if (!pay.rows.length) return { already: true };   // este cobro ya se acreditó
  const paymentId = pay.rows[0].id;

  const balance = await lockWallet(db, userId);
  await db.query(
    `INSERT INTO coin_lots (user_id, coins_total, coins_left, unit_value_micros, fee_estimated, source, payment_id) VALUES ($1,$2,$2,$3,$4,'purchase',$5)`,
    [userId, pack.coins, Math.floor(net * MICROS_PER_CENT / pack.coins), !feeKnown, paymentId]);
  const after = await move(db, userId, balance, pack.coins, 'purchase', { paymentId });
  return { userId, coins: pack.coins, balance: after };
}

// Devolución total o reclamación de un paquete: se retiran las monedas que
// queden de ese lote. Las ya gastadas se tratan en la fase de liquidaciones.
async function voidPackByCharge(db, chargeId, paymentIntentId) {
  if (!(await tablesReady())) return null;
  const p = await db.query(
    `SELECT id, user_id, status FROM payments WHERE kind = 'coin_pack' AND (stripe_charge_id = $1 OR (stripe_payment_intent_id IS NOT NULL AND stripe_payment_intent_id = $2))`,
    [chargeId, paymentIntentId]);
  const pay = p.rows[0];
  if (!pay || !pay.user_id || !['refunded', 'disputed'].includes(pay.status)) return null;
  const balance = await lockWallet(db, pay.user_id);
  const l = await db.query('SELECT id, coins_left FROM coin_lots WHERE payment_id = $1 AND voided_at IS NULL FOR UPDATE', [pay.id]);
  const lot = l.rows[0];
  if (!lot) return null;
  await db.query('UPDATE coin_lots SET coins_left = 0, voided_at = now() WHERE id = $1', [lot.id]);
  const take = Math.min(lot.coins_left, balance);
  if (take > 0) await move(db, pay.user_id, balance, -take, 'refund', { paymentId: pay.id, note: pay.status === 'disputed' ? 'reclamación al banco' : 'devolución' });
  return { removed: take };
}

// ─── Desbloquear un adelanto ────────────────────────────────────────────────
async function unlock(userId, mangaId, chapterNum, expectedCost) {
  if (!(await tablesReady())) throw err(503, 'closed', 'Las monedas todavía no están activas.');
  const num = parseInt(chapterNum, 10);
  if (!Number.isInteger(num)) throw err(400, 'bad_chapter', 'Capítulo no válido.');
  const editor = await canEditManga(userId, mangaId).catch(() => false);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const c = await db.query(
      `SELECT chapter_number, price_coins, free_at, status, publish_at FROM chapters WHERE manga_id = $1 AND chapter_number = $2`, [mangaId, num]);
    const ch = c.rows[0];
    const st = ch && (ch.status || 'published');
    const visible = ch && (st === 'published' || (st === 'scheduled' && ch.publish_at && new Date(ch.publish_at) <= new Date()));
    if (!visible) throw err(404, 'not_found', 'Este capítulo no existe o todavía no está publicado.');
    if (editor) { await db.query('COMMIT'); return { ok: true, already: true }; }

    // A partir de aquí el saldo del usuario queda bloqueado: sus operaciones van de una en una.
    const balance = await lockWallet(db, userId);
    const had = await db.query('SELECT 1 FROM chapter_unlocks WHERE user_id = $1 AND manga_id = $2 AND chapter_number = $3', [userId, mangaId, num]);
    if (had.rows.length) { await db.query('COMMIT'); return { ok: true, already: true, balance }; }

    if (!ch.free_at || new Date(ch.free_at) <= new Date()) throw err(409, 'free', 'Este capítulo ya es gratis.');
    if (!ch.price_coins) throw err(409, 'not_for_sale', 'Este adelanto no está a la venta: se libera en su fecha.');
    const gold = await isGold(db, userId);
    const cost = costFor(ch.price_coins, gold);
    if (expectedCost != null && Number(expectedCost) !== cost) throw err(409, 'price_changed', 'El precio ha cambiado. Revísalo antes de confirmar.', { cost, priceCoins: ch.price_coins });
    if (balance < cost) throw err(402, 'insufficient', 'No tienes monedas suficientes.', { balance, cost, missing: cost - balance });

    // Se gastan primero las monedas más antiguas; cada lote sabe cuánto valió cada una.
    const lots = await db.query(
      `SELECT id, coins_left, unit_value_micros FROM coin_lots WHERE user_id = $1 AND coins_left > 0 AND voided_at IS NULL ORDER BY id FOR UPDATE`, [userId]);
    let need = cost, value = 0;
    for (const lot of lots.rows) {
      if (!need) break;
      const take = Math.min(need, lot.coins_left);
      await db.query('UPDATE coin_lots SET coins_left = coins_left - $2 WHERE id = $1', [lot.id, take]);
      value += take * lot.unit_value_micros; need -= take;
    }
    if (need) throw new Error('El saldo de ' + userId + ' no cuadra con sus lotes (faltan ' + need + ')');   // nunca debería pasar: se deshace todo
    const full = cost === ch.price_coins ? value : Math.round(value * ch.price_coins / cost);
    const ins = await db.query(
      `INSERT INTO chapter_unlocks (user_id, manga_id, chapter_number, price_coins, coins_spent, discount_pct, value_micros, full_value_micros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [userId, mangaId, num, ch.price_coins, cost, gold ? GOLD_DISCOUNT : 0, value, full]);
    // La parte del autor se apunta en esta misma operación: si falla, tampoco se cobra
    await earnings.recordSale(db, { id: ins.rows[0].id, userId, mangaId, chapter: num, fullValueMicros: full });
    const after = await move(db, userId, balance, -cost, 'unlock', { mangaId, chapter: num });
    await db.query('COMMIT');
    return { ok: true, already: false, spent: cost, balance: after };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

module.exports = { PACKS, PRICE_TIERS, GOLD_DISCOUNT, tablesReady, ready, wallet, history, createPackCheckout, creditPack, voidPackByCharge,
  unlock, offerFor, readerContext, savePrice, cleanPrice, costFor, safeReturn };
