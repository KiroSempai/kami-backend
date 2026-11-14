// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — ingresos de los autores
//
//   · Cada capítulo desbloqueado apunta la parte del autor en author_ledger, en
//     la misma operación que cobra las monedas: o se hacen las dos cosas o ninguna.
//   · El tiempo de lectura lo mide el servidor a partir de los guardados de
//     progreso, con topes. No se acepta el que declare el navegador.
//   · Una vez al mes, el 70 % neto de cada suscripción Premium se reparte entre
//     las obras que leyó ese suscriptor. Un mes se reparte una sola vez.
//   · La conciliación comprueba que todo cuadra, céntimo a céntimo.
//
// Importes en micros (millonésimas de euro), siempre enteros.
// ═══════════════════════════════════════════════════════════════════════════════
const { pool } = require('../db');
const { hasColumn } = require('../schema');

const DEFAULT_SHARE = 65;     // % del autor sin exclusiva (75 con contrato: mangas.author_share_pct)
const PREMIUM_POOL = 70;      // % neto de Premium que va a autores
const MICROS_PER_CENT = 10000;
const PAYOUT_MIN_MICROS = 20 * 100 * MICROS_PER_CENT;   // 20 €

// Lectura: cuánto cuenta cada guardado de progreso
const PING_MAX_GAP = 600;     // s: con más de 10 min sin señal, es otra sesión y no suma
const PING_MAX_ADD = 180;     // s: tope por guardado
const DAY_MAX = 8 * 3600;     // s: tope diario por lector

async function ready() {
  return (await hasColumn('author_ledger', 'amount_micros')) && (await hasColumn('reading_time', 'seconds')) && (await hasColumn('premium_pool_runs', 'period'));
}

// IVA de un cobro. Si Stripe lo calculó (Stripe Tax), manda ese dato. Si no, los
// precios llevan el IVA incluido: se descuenta el tipo general para no repartir
// a los autores dinero que es de Hacienda. VAT_FALLBACK_PCT lo cambia (0 = nada).
function taxOf(cents, reported) {
  if (reported > 0 || process.env.STRIPE_AUTOMATIC_TAX === 'true') return reported || 0;
  const raw = process.env.VAT_FALLBACK_PCT;
  const pct = raw === undefined || raw === '' ? 21 : Math.max(0, Math.min(40, Number(raw) || 0));
  return Math.round(cents * pct / (100 + pct));
}
// Comisión de Stripe cuando aún no se conoce: 1,5 % + 0,25 € (tarjeta europea)
const feeGuess = (cents) => Math.round(cents * 0.015) + 25;

// ─── Venta de un adelanto ───────────────────────────────────────────────────
// Se llama dentro de la transacción del desbloqueo.
async function recordSale(db, unlock) {
  if (!(await hasColumn('author_ledger', 'amount_micros'))) return null;
  const m = await db.query('SELECT created_by, author_share_pct FROM mangas WHERE id = $1', [unlock.mangaId]);
  const row = m.rows[0];
  if (!row || !row.created_by) return null;             // obra sin autor con cuenta: no hay a quién apuntar
  if (row.created_by === unlock.userId) return null;    // el autor no se compra a sí mismo
  const pct = row.author_share_pct == null ? DEFAULT_SHARE : row.author_share_pct;
  const amount = Math.floor(unlock.fullValueMicros * pct / 100);
  if (amount <= 0) return null;
  await db.query(
    `INSERT INTO author_ledger (author_id, manga_id, kind, amount_micros, base_micros, share_pct, unlock_id, chapter_number)
     VALUES ($1,$2,'sale',$3,$4,$5,$6,$7)`,
    [row.created_by, unlock.mangaId, amount, unlock.fullValueMicros, pct, unlock.id, unlock.chapter]);
  return { authorId: row.created_by, amount, pct };
}

// ─── Tiempo de lectura ──────────────────────────────────────────────────────
// Un guardado de progreso suma el tiempo pasado desde el anterior de esa obra,
// si fue hace poco. Nunca rompe la lectura: si algo falla, se ignora.
async function ping(userId, mangaId, now = new Date()) {
  try {
    if (!userId || !mangaId || !(await hasColumn('reading_time', 'seconds'))) return 0;
    const day = now.toISOString().slice(0, 10);
    const last = await pool.query(
      `SELECT last_ping FROM reading_time WHERE user_id = $1 AND manga_id = $2 AND day >= $3::date - 1 ORDER BY last_ping DESC LIMIT 1`, [userId, mangaId, day]);
    let add = 0;
    if (last.rows.length) {
      const gap = Math.floor((now - new Date(last.rows[0].last_ping)) / 1000);
      if (gap > 0 && gap <= PING_MAX_GAP) add = Math.min(gap, PING_MAX_ADD);
    }
    if (add > 0) {
      const tot = await pool.query('SELECT COALESCE(SUM(seconds), 0)::int AS s FROM reading_time WHERE user_id = $1 AND day = $2', [userId, day]);
      add = Math.max(0, Math.min(add, DAY_MAX - tot.rows[0].s));
    }
    await pool.query(
      `INSERT INTO reading_time (day, user_id, manga_id, seconds, last_ping) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (day, user_id, manga_id) DO UPDATE SET seconds = reading_time.seconds + EXCLUDED.seconds, last_ping = EXCLUDED.last_ping`,
      [day, userId, mangaId, add, now]);
    return add;
  } catch (e) {
    if (e.code !== '23503') console.error('[lectura] no se pudo anotar:', e.message);   // 23503: obra o usuario inexistente
    return 0;
  }
}

// ─── Reparto mensual de Premium ─────────────────────────────────────────────
const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const iso = (d) => d.toISOString().slice(0, 10);

// Reparte «total» entre partes proporcionales a sus pesos, en enteros y sin
// perder ni inventar un micro (los restos van a los de mayor fracción).
function split(total, weights) {
  const sum = weights.reduce((a, w) => a + w.w, 0);
  if (total <= 0 || sum <= 0) return weights.map((w) => ({ ...w, amount: 0 }));
  const T = BigInt(total), SUM = BigInt(sum);
  const out = weights.map((w) => { const num = T * BigInt(w.w); return { ...w, amount: Number(num / SUM), rem: num % SUM }; });
  let left = total - out.reduce((a, x) => a + x.amount, 0);
  out.slice().sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : String(a.key).localeCompare(String(b.key))))
    .forEach((x) => { if (left > 0) { x.amount++; left--; } });
  return out.map(({ rem, ...x }) => x);
}

// Calcula el reparto de un mes sin escribir nada.
async function computePool(db, period) {
  const from = monthStart(period), to = addMonths(from, 1);
  // Ingresos netos de Premium atribuidos al mes: un cobro anual cuenta un doceavo durante doce meses
  const pays = await db.query(
    `SELECT user_id, amount_cents, tax_cents, fee_cents, refunded_cents, cover_months
       FROM payments
      WHERE kind = 'subscription' AND user_id IS NOT NULL AND status IN ('paid', 'partially_refunded')
        AND date_trunc('month', paid_at AT TIME ZONE 'UTC') <= $1::date
        AND date_trunc('month', paid_at AT TIME ZONE 'UTC') + (cover_months || ' months')::interval > $1::date`, [iso(from)]);
  const netByUser = new Map();
  for (const p of pays.rows) {
    const fee = p.fee_cents == null ? feeGuess(p.amount_cents) : p.fee_cents;
    const net = Math.max(0, p.amount_cents - p.tax_cents - fee - p.refunded_cents) * MICROS_PER_CENT;
    netByUser.set(p.user_id, (netByUser.get(p.user_id) || 0) + Math.floor(net / p.cover_months));
  }
  // Lectura del mes en obras con autor, sin contar la del propio autor
  const read = await db.query(
    `SELECT r.user_id, r.manga_id, m.created_by AS author_id, SUM(r.seconds)::int AS s
       FROM reading_time r JOIN mangas m ON m.id = r.manga_id
      WHERE r.day >= $1::date AND r.day < $2::date AND m.created_by IS NOT NULL AND m.created_by <> r.user_id
      GROUP BY r.user_id, r.manga_id, m.created_by HAVING SUM(r.seconds) > 0`, [iso(from), iso(to)]);
  const byUser = new Map();
  for (const r of read.rows) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push({ key: r.manga_id, w: r.s, author: r.author_id }); }

  const perManga = new Map();   // manga → { author, amount }
  const give = (parts) => parts.forEach((x) => { if (x.amount > 0) { const cur = perManga.get(x.key) || { author: x.author, amount: 0 }; cur.amount += x.amount; perManga.set(x.key, cur); } });
  let net = 0, poolTotal = 0, common = 0;
  for (const [userId, userNet] of netByUser) {
    const share = Math.floor(userNet * PREMIUM_POOL / 100);
    net += userNet; poolTotal += share;
    const mine = byUser.get(userId);
    if (mine && mine.length) give(split(share, mine)); else common += share;   // no leyó nada: va al fondo común
  }
  // Fondo común: se reparte según la lectura de todos los suscriptores de ese mes
  if (common > 0) {
    const all = new Map();
    for (const [userId] of netByUser) for (const x of byUser.get(userId) || []) { const c = all.get(x.key) || { key: x.key, w: 0, author: x.author }; c.w += x.w; all.set(x.key, c); }
    give(split(common, [...all.values()]));
  }
  const distributed = [...perManga.values()].reduce((a, x) => a + x.amount, 0);
  return { period: iso(from), subscribers: netByUser.size, net, pool: poolTotal, distributed, undistributed: poolTotal - distributed,
    works: [...perManga.entries()].map(([mangaId, x]) => ({ mangaId, authorId: x.author, amount: x.amount })) };
}

// Reparte un mes ya terminado. Devuelve { skipped } si ya estaba hecho.
async function distributePool(period, { now = new Date() } = {}) {
  if (!(await ready())) return { skipped: 'sin migración' };
  const from = monthStart(period);
  if (addMonths(from, 1) > now) return { skipped: 'el mes no ha terminado' };
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('kami-premium-pool'))`);   // un reparto a la vez
    const done = await db.query('SELECT 1 FROM premium_pool_runs WHERE period = $1', [iso(from)]);
    if (done.rows.length) { await db.query('COMMIT'); return { skipped: 'ya repartido' }; }
    const c = await computePool(db, from);
    for (const w of c.works) {
      await db.query(
        `INSERT INTO author_ledger (author_id, manga_id, kind, amount_micros, base_micros, share_pct, period) VALUES ($1,$2,'premium',$3,$4,$5,$6)`,
        [w.authorId, w.mangaId, w.amount, c.pool, PREMIUM_POOL, c.period]);
    }
    await db.query(
      `INSERT INTO premium_pool_runs (period, subscribers, net_micros, pool_micros, distributed_micros, undistributed_micros, works) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [c.period, c.subscribers, c.net, c.pool, c.distributed, c.undistributed, c.works.length]);
    await db.query('COMMIT');
    return c;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { db.release(); }
}

// Reparte los meses terminados que falten (como mucho los tres últimos).
async function distributePending(now = new Date()) {
  const out = [];
  for (let i = 3; i >= 1; i--) {
    const r = await distributePool(addMonths(monthStart(now), -i), { now });
    if (!r.skipped) out.push(r);
  }
  return out;
}

// ─── Conciliación ───────────────────────────────────────────────────────────
// Devuelve { ok, problems }. Cada problema dice qué no cuadra y dónde.
async function reconcile() {
  const problems = [];
  const coinsOn = await hasColumn('coin_wallets', 'balance');
  if (coinsOn) {
    const w = await pool.query(`
      SELECT u.user_id, COALESCE(w.balance, 0) AS balance, COALESCE(l.s, 0)::int AS ledger, COALESCE(t.s, 0)::int AS lots
        FROM (SELECT user_id FROM coin_wallets UNION SELECT user_id FROM coin_ledger UNION SELECT user_id FROM coin_lots WHERE user_id IS NOT NULL) u
        LEFT JOIN coin_wallets w ON w.user_id = u.user_id
        LEFT JOIN (SELECT user_id, SUM(delta) s FROM coin_ledger GROUP BY 1) l ON l.user_id = u.user_id
        LEFT JOIN (SELECT user_id, SUM(coins_left) s FROM coin_lots WHERE voided_at IS NULL GROUP BY 1) t ON t.user_id = u.user_id
       WHERE COALESCE(w.balance, 0) <> COALESCE(l.s, 0) OR COALESCE(w.balance, 0) <> COALESCE(t.s, 0)`);
    w.rows.forEach((x) => problems.push({ check: 'saldo de monedas', userId: x.user_id, balance: x.balance, ledger: x.ledger, lots: x.lots }));
    const s = await pool.query(`SELECT (SELECT COALESCE(SUM(coins_spent), 0) FROM chapter_unlocks)::bigint AS spent, (SELECT COALESCE(-SUM(delta), 0) FROM coin_ledger WHERE reason = 'unlock')::bigint AS moved`);
    if (String(s.rows[0].spent) !== String(s.rows[0].moved)) problems.push({ check: 'monedas gastadas en capítulos', unlocks: Number(s.rows[0].spent), ledger: Number(s.rows[0].moved) });
    const lots = await pool.query(`SELECT l.id FROM coin_lots l JOIN payments p ON p.id = l.payment_id WHERE l.source = 'purchase' AND p.kind <> 'coin_pack'`);
    lots.rows.forEach((x) => problems.push({ check: 'lote sin su cobro de monedas', lotId: Number(x.id) }));
  }
  if (await hasColumn('author_ledger', 'amount_micros')) {
    // Cada venta a una obra con autor tiene su apunte, y por el importe exacto
    const sales = await pool.query(`
      SELECT u.id, u.full_value_micros, a.amount_micros, a.share_pct
        FROM chapter_unlocks u JOIN mangas m ON m.id = u.manga_id
        LEFT JOIN author_ledger a ON a.unlock_id = u.id AND a.kind = 'sale'
       WHERE m.created_by IS NOT NULL AND m.created_by IS DISTINCT FROM u.user_id AND u.full_value_micros > 0
         AND u.created_at >= (SELECT COALESCE(MIN(created_at), now()) FROM author_ledger)
         AND (a.id IS NULL OR a.amount_micros <> floor(u.full_value_micros * a.share_pct / 100.0))`);
    sales.rows.forEach((x) => problems.push({ check: 'venta sin apunte correcto del autor', unlockId: Number(x.id) }));
    const runs = await pool.query(`
      SELECT to_char(r.period, 'YYYY-MM') AS period, r.distributed_micros, COALESCE(SUM(a.amount_micros), 0) AS booked
        FROM premium_pool_runs r LEFT JOIN author_ledger a ON a.kind = 'premium' AND a.period = r.period
       GROUP BY r.period, r.distributed_micros HAVING r.distributed_micros <> COALESCE(SUM(a.amount_micros), 0)`);
    runs.rows.forEach((x) => problems.push({ check: 'reparto de Premium', period: x.period, run: Number(x.distributed_micros), booked: Number(x.booked) }));
    const over = await pool.query(`SELECT to_char(period, 'YYYY-MM') AS period FROM premium_pool_runs WHERE distributed_micros + undistributed_micros <> pool_micros OR pool_micros > net_micros`);
    over.rows.forEach((x) => problems.push({ check: 'reparto de Premium mayor que lo ingresado', period: x.period }));
    const neg = await pool.query(`SELECT author_id, SUM(amount_micros) AS s FROM author_ledger GROUP BY 1 HAVING SUM(amount_micros) < 0`);
    neg.rows.forEach((x) => problems.push({ check: 'saldo de autor negativo', authorId: x.author_id, micros: Number(x.s) }));
  }
  return { ok: problems.length === 0, problems, checkedAt: new Date().toISOString() };
}

// ─── Datos para la sección Ingresos del Estudio ─────────────────────────────
async function forAuthor(authorId) {
  const out = { ready: await ready(), sharePct: DEFAULT_SHARE, premiumPoolPct: PREMIUM_POOL, payoutMinMicros: PAYOUT_MIN_MICROS,
    totals: { earned: 0, paid: 0, balance: 0, sales: 0, premium: 0, thisMonth: 0, lastMonth: 0, unitsSold: 0 }, months: [], works: [], recent: [] };
  if (!out.ready) return out;
  const n = (v) => Number(v || 0);
  const t = await pool.query(`
    SELECT COALESCE(SUM(amount_micros) FILTER (WHERE kind <> 'payout'), 0) AS earned,
           COALESCE(-SUM(amount_micros) FILTER (WHERE kind = 'payout'), 0) AS paid,
           COALESCE(SUM(amount_micros), 0) AS balance,
           COALESCE(SUM(amount_micros) FILTER (WHERE kind = 'sale'), 0) AS sales,
           COALESCE(SUM(amount_micros) FILTER (WHERE kind = 'premium'), 0) AS premium,
           COALESCE(SUM(amount_micros) FILTER (WHERE kind <> 'payout' AND COALESCE(period, created_at::date) >= date_trunc('month', now())), 0) AS this_month,
           COALESCE(SUM(amount_micros) FILTER (WHERE kind <> 'payout' AND COALESCE(period, created_at::date) >= date_trunc('month', now()) - interval '1 month'
                                                 AND COALESCE(period, created_at::date) < date_trunc('month', now())), 0) AS last_month,
           COUNT(*) FILTER (WHERE kind = 'sale')::int AS units
      FROM author_ledger WHERE author_id = $1`, [authorId]);
  const r = t.rows[0];
  out.totals = { earned: n(r.earned), paid: n(r.paid), balance: n(r.balance), sales: n(r.sales), premium: n(r.premium), thisMonth: n(r.this_month), lastMonth: n(r.last_month), unitsSold: r.units };
  const m = await pool.query(`
    SELECT to_char(date_trunc('month', COALESCE(period, created_at::date)), 'YYYY-MM') AS month,
           COALESCE(SUM(amount_micros) FILTER (WHERE kind = 'sale'), 0) AS sales,
           COALESCE(SUM(amount_micros) FILTER (WHERE kind = 'premium'), 0) AS premium,
           COALESCE(SUM(amount_micros) FILTER (WHERE kind IN ('reversal', 'adjust')), 0) AS other
      FROM author_ledger WHERE author_id = $1 AND kind <> 'payout' AND COALESCE(period, created_at::date) >= date_trunc('month', now()) - interval '11 months'
     GROUP BY 1 ORDER BY 1`, [authorId]);
  out.months = m.rows.map((x) => ({ month: x.month, sales: n(x.sales), premium: n(x.premium), other: n(x.other) }));
  const w = await pool.query(`
    SELECT a.manga_id, mg.title, mg.type, mg.author_share_pct,
           COALESCE(SUM(a.amount_micros) FILTER (WHERE a.kind = 'sale'), 0) AS sales,
           COALESCE(SUM(a.amount_micros) FILTER (WHERE a.kind = 'premium'), 0) AS premium,
           COALESCE(SUM(a.amount_micros), 0) AS total, COUNT(*) FILTER (WHERE a.kind = 'sale')::int AS units
      FROM author_ledger a LEFT JOIN mangas mg ON mg.id = a.manga_id
     WHERE a.author_id = $1 AND a.manga_id IS NOT NULL AND a.kind <> 'payout' GROUP BY 1, 2, 3, 4 ORDER BY total DESC`, [authorId]);
  const ch = await pool.query(`
    SELECT manga_id, chapter_number, COUNT(*)::int AS units, SUM(amount_micros) AS total
      FROM author_ledger WHERE author_id = $1 AND kind = 'sale' GROUP BY 1, 2 ORDER BY total DESC`, [authorId]);
  out.works = w.rows.map((x) => ({ mangaId: x.manga_id, title: x.title || 'Obra retirada', type: x.type, sharePct: x.author_share_pct == null ? DEFAULT_SHARE : x.author_share_pct,
    sales: n(x.sales), premium: n(x.premium), total: n(x.total), unitsSold: x.units,
    chapters: ch.rows.filter((c) => c.manga_id === x.manga_id).map((c) => ({ number: c.chapter_number, unitsSold: c.units, total: n(c.total) })) }));
  const rec = await pool.query(`
    SELECT a.id, a.kind, a.amount_micros, a.manga_id, a.chapter_number, to_char(a.period, 'YYYY-MM-DD') AS period, a.created_at, a.note, mg.title
      FROM author_ledger a LEFT JOIN mangas mg ON mg.id = a.manga_id WHERE a.author_id = $1 ORDER BY a.id DESC LIMIT 30`, [authorId]);
  out.recent = rec.rows.map((x) => ({ id: Number(x.id), kind: x.kind, amount: n(x.amount_micros), mangaId: x.manga_id, mangaTitle: x.title || null, chapter: x.chapter_number,
    period: x.period || null, at: x.created_at, note: x.note || null }));
  return out;
}

module.exports = { DEFAULT_SHARE, PREMIUM_POOL, PAYOUT_MIN_MICROS, ready, taxOf, feeGuess, recordSale, ping, split, computePool, distributePool, distributePending, reconcile, forAuthor };
