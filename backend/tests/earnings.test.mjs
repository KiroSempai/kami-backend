// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — pruebas de pagos, fase 3 (ingresos de los autores)
//
//   node tests/earnings.test.mjs
//
// Postgres local desechable y Stripe simulado: no toca nada real.
// ═══════════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setup } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = await setup({ pgPort: 54333, stripePort: 54334 });
const { F, q, api, hook, mkEvent, ok } = T;
const sqlFile = (f) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const DAY = 86400000, soon = new Date(Date.now() + 7 * DAY).toISOString();
const now = new Date();
const P = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));   // el mes pasado: el que se reparte
const month = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const iso = (d) => d.toISOString().slice(0, 10);

await q(`
  CREATE TABLE users (id VARCHAR(60) PRIMARY KEY, username VARCHAR(60), email VARCHAR(255), premium_expires_at TIMESTAMP, subscription_tier VARCHAR(20),
    is_admin BOOLEAN DEFAULT FALSE, is_banned BOOLEAN DEFAULT FALSE, is_owner BOOLEAN DEFAULT FALSE, company_verified BOOLEAN DEFAULT FALSE,
    reputation_score INTEGER DEFAULT 0, image_quality VARCHAR(10) DEFAULT '1080', password_changed_at TIMESTAMP);
  CREATE VIEW user_with_role AS SELECT *, CASE WHEN is_admin THEN 'admin' WHEN is_banned THEN 'banned'
    WHEN premium_expires_at > NOW() AND subscription_tier = 'gold' THEN 'gold' WHEN premium_expires_at > NOW() AND subscription_tier = 'silver' THEN 'silver' ELSE 'user' END AS role FROM users;
  CREATE TABLE revoked_tokens (token_hash TEXT PRIMARY KEY, expires_at TIMESTAMP);
  CREATE TABLE mangas (id VARCHAR(20) PRIMARY KEY, title VARCHAR(255), author VARCHAR(255), type VARCHAR(20), cover TEXT, social_links JSONB DEFAULT '{}',
    created_by VARCHAR(60), total_chapters INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT now());
  CREATE TABLE chapters (id SERIAL PRIMARY KEY, manga_id VARCHAR(20) REFERENCES mangas(id), chapter_number INTEGER, title VARCHAR(255), pages INTEGER DEFAULT 0, scan_group TEXT,
    release_date TIMESTAMP DEFAULT now(), created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now(), status VARCHAR(12) DEFAULT 'published', publish_at TIMESTAMPTZ,
    free_at TIMESTAMPTZ, note_before TEXT, note_after TEXT, content_warnings TEXT[] DEFAULT '{}', content JSONB, word_count INTEGER DEFAULT 0, UNIQUE (manga_id, chapter_number));
  CREATE TABLE chapter_comments (id SERIAL PRIMARY KEY, manga_id VARCHAR(20), chapter_number INTEGER);
  CREATE TABLE user_reading (id SERIAL PRIMARY KEY, user_id VARCHAR(60), manga_id VARCHAR(20), last_chapter INTEGER DEFAULT 0, last_page INTEGER DEFAULT 0, total_pages_read INTEGER DEFAULT 0,
    last_paragraph VARCHAR(24), last_percent INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT now(), UNIQUE (user_id, manga_id));
  CREATE TABLE user_manga_library (id SERIAL PRIMARY KEY, user_id VARCHAR(60), manga_id VARCHAR(20), progress INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT now());
  INSERT INTO users (id, username, email) SELECT 'u-' || n, n, n || '@prueba.test' FROM unnest(ARRAY['autor','autor2','ana','leo','oro','subA','subB','subC','subD','subE','nosub','lector']) n;
  INSERT INTO users (id, username, is_admin) VALUES ('u-admin', 'admin', TRUE);
  UPDATE users SET subscription_tier = 'gold', premium_expires_at = now() + interval '20 days' WHERE id = 'u-oro';
  INSERT INTO mangas (id, title, author, type, created_by) VALUES ('KT-N1','Novela Uno','autor','novel','u-autor'), ('KT-N2','Novela Dos','autor2','novel','u-autor2'), ('KT-X','Sin dueño','KamiTales','novel',NULL);
`);
const block = JSON.stringify([{ id: 'abcd1234', type: 'p', html: 'Texto.' }]);
for (const id of ['KT-N1', 'KT-N2', 'KT-X']) for (let n = 1; n <= 4; n++) await q(`INSERT INTO chapters (manga_id, chapter_number, title, content, free_at) VALUES ($1,$2,$3,$4,$5)`, [id, n, 'Cap ' + n, block, n >= 2 ? soon : null]);
await q(sqlFile('migrate-payments.sql')); await q(sqlFile('migrate-payments-2.sql'));
await q(`UPDATE chapters SET price_coins = CASE manga_id WHEN 'KT-N2' THEN 80 ELSE 50 END WHERE free_at IS NOT NULL`);

await T.listen((app, require) => {
  app.use('/api/premium', require('../routes/routes-premium.js'));
  app.use('/api/coins', require('../routes/routes-coins.js'));
  app.use('/api/novel', require('../routes/routes-novel.js'));
  app.use('/api/studio', require('../routes/routes-studio.js'));
});
const E = T.require('../payments/earnings.js');

const cus = async (id) => (await q('SELECT stripe_customer_id c FROM users WHERE id = $1', [id])).rows[0].c;
const bal = async (id) => (await q('SELECT balance FROM coin_wallets WHERE user_id = $1', [id])).rows[0]?.balance ?? 0;
let csSeq = 1;
async function buy(user, pack, tax) {
  await api('POST', '/api/coins/checkout', { user, body: { pack } });
  const cents = { p500: 499, p1050: 999, p2200: 1999 }[pack], id = 'cs_pack_' + csSeq++;
  F.checkouts[id] = { id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: cents, currency: 'eur', customer: await cus(user), livemode: false,
    metadata: { kind: 'coin_pack', userId: user, pack }, total_details: { amount_tax: tax === undefined ? Math.round(cents * 21 / 121) : tax },
    payment_intent: { id: 'pi_' + id, latest_charge: { id: 'ch_' + id, balance_transaction: { id: 'txn_' + id, fee: Math.round(cents * 0.015) + 25 } } } };
  return hook(mkEvent('checkout.session.completed', { id, mode: 'payment' }));
}
const unlock = (user, mangaId, chapter) => api('POST', '/api/coins/unlock', { user, body: { mangaId, chapter } });
const ledger = async (author) => (await q(`SELECT kind, manga_id, chapter_number, amount_micros::int a, base_micros::int b, share_pct pct, to_char(period,'YYYY-MM-DD') period FROM author_ledger WHERE author_id = $1 ORDER BY id`, [author])).rows;

try {
  // ── 1. Antes de la migración de ingresos: vender sigue funcionando ────────
  await buy('u-lector', 'p500');
  let r = await unlock('u-lector', 'KT-N1', 4);
  ok('sin migración: se puede desbloquear igual (sin apunte de autor)', r.status === 200 && r.d.spent === 50, r);
  r = await api('GET', '/api/studio/earnings', { user: 'u-autor' });
  ok('sin migración: el Estudio responde «aún no» sin romperse', r.status === 200 && r.d.ready === false && r.d.totals.balance === 0, r.d);
  ok('sin migración: anotar lectura no falla', (await E.ping('u-ana', 'KT-N1')) === 0);

  // ── 2. Migración ──────────────────────────────────────────────────────────
  await q(sqlFile('migrate-payments-3.sql')); await q(sqlFile('migrate-payments-3.sql'));
  await T.waitColumn('author_ledger', 'amount_micros'); await T.waitColumn('reading_time', 'seconds'); await T.waitColumn('premium_pool_runs', 'period'); await T.waitColumn('payments', 'cover_months');
  ok('migración aplicada dos veces y detectada sin reiniciar', await E.ready());
  await q(`UPDATE mangas SET author_share_pct = 75 WHERE id = 'KT-N2'`);   // contrato de exclusiva

  // ── 3. Cada venta apunta la parte del autor ───────────────────────────────
  await buy('u-ana', 'p1050'); await buy('u-oro', 'p500');
  const unitAna = (await q(`SELECT unit_value_micros u FROM coin_lots WHERE user_id = 'u-ana'`)).rows[0].u;   // 9,99 € − IVA 1,73 − comisión 0,40 = 7,86 € / 1.050
  ok('valor real de la moneda del paquete de 9,99 € (con regalo): 0,007485 €', unitAna === 7485, unitAna);
  r = await unlock('u-ana', 'KT-N1', 2);
  let L = await ledger('u-autor');
  ok('venta: el autor recibe el 65 % del valor neto (50 × 0,007485 € × 65 %)', L.length === 1 && L[0].kind === 'sale' && L[0].b === 50 * 7485 && L[0].a === Math.floor(50 * 7485 * 0.65) && L[0].pct === 65 && L[0].chapter_number === 2, L);
  r = await unlock('u-oro', 'KT-N1', 2);
  L = await ledger('u-autor');
  ok('venta a un lector Gold (paga 40): el autor cobra como si fueran 50', r.d.spent === 40 && L[1].b === 50 * 7600 && L[1].a === 247000, L[1]);
  r = await unlock('u-ana', 'KT-N2', 2);
  L = await ledger('u-autor2');
  ok('obra con exclusiva (75 %): 80 × 0,007485 € × 75 %', L.length === 1 && L[0].pct === 75 && L[0].a === Math.floor(80 * 7485 * 0.75), L);
  r = await unlock('u-ana', 'KT-X', 2);
  ok('obra sin autor con cuenta: se vende, pero no se apunta a nadie', r.status === 200 && (await q(`SELECT count(*)::int n FROM author_ledger WHERE manga_id = 'KT-X'`)).rows[0].n === 0, r);
  await unlock('u-ana', 'KT-N1', 2);
  ok('repetir un desbloqueo no duplica el ingreso', (await ledger('u-autor')).length === 2);
  // Si el apunte del autor falla, no se cobra al lector
  await q(`CREATE TRIGGER boom BEFORE INSERT ON author_ledger FOR EACH ROW EXECUTE FUNCTION kami_append_only()`);
  const before = await bal('u-ana');
  r = await unlock('u-ana', 'KT-N1', 3);
  ok('si no se puede apuntar al autor, no se cobra ni se desbloquea', r.status === 500 && (await bal('u-ana')) === before && (await q(`SELECT count(*)::int n FROM chapter_unlocks WHERE user_id = 'u-ana' AND chapter_number = 3`)).rows[0].n === 0, { r, bal: await bal('u-ana'), before });
  await q(`DROP TRIGGER boom ON author_ledger`);
  r = await unlock('u-ana', 'KT-N1', 3);
  ok('…y al reintentar funciona', r.status === 200 && (await ledger('u-autor')).length === 3);

  // ── 4. IVA cuando Stripe no lo informa ────────────────────────────────────
  await buy('u-leo', 'p500', 0);
  let pay = (await q(`SELECT tax_cents FROM payments WHERE user_id = 'u-leo'`)).rows[0];
  ok('sin dato de IVA de Stripe: se descuenta el 21 % incluido (0,87 € de 4,99 €)', pay.tax_cents === 87, pay);
  process.env.VAT_FALLBACK_PCT = '0';
  await buy('u-nosub', 'p500', 0);
  pay = (await q(`SELECT tax_cents FROM payments WHERE user_id = 'u-nosub'`)).rows[0];
  ok('VAT_FALLBACK_PCT=0 lo desactiva', pay.tax_cents === 0, pay);
  delete process.env.VAT_FALLBACK_PCT;

  // ── 5. Tiempo de lectura medido por el servidor ───────────────────────────
  const t0 = new Date(Date.UTC(P.getUTCFullYear(), P.getUTCMonth(), 15, 10, 0, 0));
  const at = (s) => new Date(t0.getTime() + s * 1000);
  const adds = [await E.ping('u-leo', 'KT-N1', at(0)), await E.ping('u-leo', 'KT-N1', at(60)), await E.ping('u-leo', 'KT-N1', at(360)), await E.ping('u-leo', 'KT-N1', at(1500)), await E.ping('u-leo', 'KT-N1', at(1530))];
  ok('lectura: primer guardado 0; +60 s; 5 min sin señal cuenta 180 s (tope); tras 19 min es otra sesión (0); +30 s', adds.join() === '0,60,180,0,30', adds);
  await q(`UPDATE reading_time SET seconds = 8 * 3600 - 10 WHERE user_id = 'u-leo'`);
  ok('lectura: tope diario de 8 h por lector', (await E.ping('u-leo', 'KT-N2', at(1531))) === 0 && (await E.ping('u-leo', 'KT-N2', at(1591))) === 10 && (await E.ping('u-leo', 'KT-N2', at(1651))) === 0);
  ok('lectura: obra inexistente no rompe nada', (await E.ping('u-leo', 'NO-EXISTE', at(2000))) === 0);
  await q(`DELETE FROM reading_time`);
  r = await api('PUT', '/api/novel/KT-N1/progress', { user: 'u-leo', body: { chapter: 1, paragraphId: 'abcd1234', percent: 40, minutes: 9999, seconds: 999999 } });
  await new Promise((res) => setTimeout(res, 1200));
  r = await api('PUT', '/api/novel/KT-N1/progress', { user: 'u-leo', body: { chapter: 1, paragraphId: 'abcd1234', percent: 60, minutes: 9999 } });
  await new Promise((res) => setTimeout(res, 300));
  const rt = (await q(`SELECT seconds FROM reading_time WHERE user_id = 'u-leo' AND manga_id = 'KT-N1'`)).rows[0];
  ok('guardar el progreso anota ~1 s real; los «minutos» que mande el navegador se ignoran', r.status === 200 && rt && rt.seconds >= 1 && rt.seconds <= 3, rt);
  await q(`DELETE FROM reading_time`);

  // ── 6. Reparto mensual de Premium ─────────────────────────────────────────
  const paidIn = (d, days) => new Date(d.getTime() + days * DAY).toISOString();
  const subPay = (user, cents, tax, fee, cover, paidAt, status = 'paid', refunded = 0) => q(
    `INSERT INTO payments (user_id, kind, stripe_invoice_id, amount_cents, tax_cents, fee_cents, refunded_cents, status, cover_months, paid_at) VALUES ($1,'subscription',$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user, 'in_' + user + '_' + Math.random().toString(36).slice(2, 8), cents, tax, fee, refunded, status, cover, paidAt]);
  await subPay('u-subA', 399, 69, 31, 1, paidIn(P, 10));                    // mensual → neto 2,99 €
  await subPay('u-subB', 2699, 468, 65, 12, paidIn(month(P, -5), 3));       // anual, pagado hace 5 meses → 21,66 € / 12
  await subPay('u-subC', 699, 121, null, 1, paidIn(P, 2));                  // Gold mensual, comisión aún desconocida (se estima 0,35 €)
  await subPay('u-subD', 399, 69, 31, 1, paidIn(P, 4), 'refunded', 399);    // devuelto: no cuenta
  await subPay('u-subE', 2699, 468, 65, 12, paidIn(month(P, -13), 3));      // anual ya vencido: no cuenta
  await subPay('u-autor', 399, 69, 31, 1, paidIn(P, 6));                    // el autor también es suscriptor
  const read = (user, manga, s, d = P, day = 12) => q(`INSERT INTO reading_time (day, user_id, manga_id, seconds) VALUES ($1,$2,$3,$4)`, [iso(new Date(d.getTime() + day * DAY)), user, manga, s]);
  await read('u-subA', 'KT-N1', 3000); await read('u-subA', 'KT-N2', 1000); await read('u-subA', 'KT-X', 9999);
  await read('u-subB', 'KT-N2', 500);
  await read('u-autor', 'KT-N1', 20000);                                    // leerse a uno mismo no cuenta
  await read('u-nosub', 'KT-N1', 50000);                                    // sin suscripción: no reparte nada
  await read('u-subA', 'KT-N2', 77777, month(P, -1));                       // lectura de otro mes
  await read('u-subB', 'KT-N1', 88888, month(P, 1), 0);                     // idem

  r = await E.distributePool(now);
  ok('el mes en curso no se reparte', r.skipped === 'el mes no ha terminado', r);
  const two = await Promise.all([E.distributePool(P), E.distributePool(P)]);
  const run = two.find((x) => !x.skipped);
  ok('dos repartos a la vez → solo uno se ejecuta', two.filter((x) => x.skipped).length === 1 && !!run, two.map((x) => x.skipped || 'hecho'));
  ok('reparto: 4 suscriptores cuentan (el devuelto y el anual vencido, no)', run.subscribers === 4, run.subscribers);
  ok('reparto: neto del mes 13,215 € (2,99 + 21,66/12 + 5,43 + 2,99)', run.net === 13215000, run.net);
  ok('reparto: el 70 % va a autores (9,2505 €) y se reparte entero', run.pool === 9250500 && run.distributed === 9250500 && run.undistributed === 0, run);
  L = await ledger('u-autor');
  const prem1 = L.find((x) => x.kind === 'premium');
  const prem2 = (await ledger('u-autor2')).find((x) => x.kind === 'premium');
  // subA: 2.093.000 × 3/4 = 1.569.750 a N1 y 523.250 a N2 · subB: 1.263.500 a N2
  // fondo común (subC no leyó; el autor solo se leyó a sí mismo): 5.894.000 → N1 3.929.333 y N2 1.964.667
  ok('Novela Uno recibe 5,499083 € (lo de subA + su parte del fondo común)', prem1 && prem1.a === 1569750 + 3929333 && prem1.manga_id === 'KT-N1' && prem1.period === iso(P), prem1);
  ok('Novela Dos recibe 3,751417 € (subA + todo subB + su parte del fondo común)', prem2 && prem2.a === 523250 + 1263500 + 1964667, prem2);
  ok('la obra sin autor, el lector sin suscripción y la lectura de otros meses no reciben nada', (await q(`SELECT count(*)::int n FROM author_ledger WHERE kind = 'premium'`)).rows[0].n === 2);
  r = await E.distributePool(P);
  ok('repetir el reparto del mismo mes → no hace nada', r.skipped === 'ya repartido' && (await q(`SELECT count(*)::int n FROM author_ledger WHERE kind = 'premium'`)).rows[0].n === 2, r);
  const sp = E.split(100, [{ key: 'a', w: 1 }, { key: 'b', w: 1 }, { key: 'c', w: 1 }]);
  ok('repartir 100 entre tres partes iguales da 34+33+33: ni se pierde ni se inventa un micro', sp.reduce((a, x) => a + x.amount, 0) === 100 && sp.map((x) => x.amount).sort().join() === '33,33,34', sp);
  // Un mes con suscriptores pero sin lectura
  await subPay('u-subA', 399, 69, 31, 1, paidIn(month(P, -1), 10));
  await q(`DELETE FROM reading_time WHERE day < $1`, [iso(P)]);
  r = await E.distributePool(month(P, -1));
  ok('mes sin lectura: no se apunta nada a nadie y queda registrado como no repartido', r.works.length === 0 && r.distributed === 0 && r.undistributed === r.pool && r.pool > 0, r);
  // Suscripción anual por el aviso de Stripe: queda marcada como de 12 meses
  await api('POST', '/api/premium/create-checkout', { user: 'u-lector', body: { plan: 'gold_yearly' } });
  const lc = await cus('u-lector');
  F.subs.sub_y = { id: 'sub_y', object: 'subscription', customer: lc, status: 'active', created: T.NOW, livemode: false, metadata: { userId: 'u-lector' }, cancel_at_period_end: false,
    current_period_start: T.NOW, current_period_end: T.NOW + 365 * 86400, latest_invoice: 'in_y', items: { data: [{ price: { id: 'price_gy', lookup_key: 'kami_gold_yearly', metadata: {} } }] } };
  F.invoices = F.invoices || {};
  r = await hook(mkEvent('customer.subscription.created', { id: 'sub_y' }));
  ok('alta de suscripción anual por aviso', r.d.result === 'done', r);

  // ── 7. Lo que ve el autor en el Estudio ───────────────────────────────────
  r = await api('GET', '/api/studio/earnings', { user: 'u-autor' });
  const sales1 = Math.floor(50 * 7485 * 0.65) * 2 + 247000;
  ok('Estudio: saldo = ventas + Premium, al micro', r.d.ready && r.d.totals.sales === sales1 && r.d.totals.premium === 5499083 && r.d.totals.balance === sales1 + 5499083 && r.d.totals.paid === 0 && r.d.totals.unitsSold === 3, r.d.totals);
  ok('Estudio: desglose por obra y por capítulo', r.d.works.length === 1 && r.d.works[0].mangaId === 'KT-N1' && r.d.works[0].sharePct === 65 && r.d.works[0].unitsSold === 3 && r.d.works[0].chapters.length === 2 && r.d.works[0].chapters.find((c) => c.number === 2).unitsSold === 2, r.d.works);
  ok('Estudio: meses y últimos movimientos', r.d.months.length >= 1 && r.d.months.reduce((a, m) => a + m.sales + m.premium, 0) === r.d.totals.balance && r.d.recent.length === 4 && r.d.recent[0].kind === 'premium', { months: r.d.months, recent: r.d.recent.map((x) => x.kind) });
  r = await api('GET', '/api/studio/earnings', { user: 'u-autor2' });
  ok('Estudio: cada autor ve solo lo suyo', r.d.totals.balance === Math.floor(80 * 7485 * 0.75) + 3751417 && !JSON.stringify(r.d).includes('KT-N1'), r.d.totals);
  r = await api('GET', '/api/studio/earnings', { user: 'u-ana' });
  ok('Estudio: quien no es autor ve cero', r.d.totals.balance === 0 && r.d.works.length === 0);
  r = await api('GET', '/api/studio/earnings');
  ok('Estudio: sin sesión → 401', r.status === 401);

  // ── 8. Conciliación ───────────────────────────────────────────────────────
  r = await api('GET', '/api/premium/admin/reconcile', { user: 'u-ana' });
  ok('conciliación: solo administración (403 para los demás)', r.status === 403, r);
  // (el desbloqueo hecho antes de existir el libro queda fuera de la comprobación, como en producción)
  r = await api('GET', '/api/premium/admin/reconcile', { user: 'u-admin' });
  ok('conciliación: todo cuadra', r.status === 200 && r.d.ok === true && r.d.problems.length === 0, r.d);
  await q(`UPDATE coin_wallets SET balance = balance + 5 WHERE user_id = 'u-ana'`);
  r = await E.reconcile();
  ok('conciliación: detecta un saldo de monedas alterado a mano', !r.ok && r.problems.length === 1 && r.problems[0].check === 'saldo de monedas' && r.problems[0].userId === 'u-ana', r.problems);
  await q(`UPDATE coin_wallets SET balance = balance - 5 WHERE user_id = 'u-ana'`);
  await q(`INSERT INTO chapter_unlocks (user_id, manga_id, chapter_number, price_coins, coins_spent, value_micros, full_value_micros) VALUES ('u-leo','KT-N1',4,50,50,380000,380000)`);
  r = await E.reconcile();
  ok('conciliación: detecta una venta sin apunte del autor (y monedas que no salieron del saldo)', !r.ok && r.problems.some((x) => x.check === 'venta sin apunte correcto del autor') && r.problems.some((x) => x.check === 'monedas gastadas en capítulos'), r.problems);
  await q(`DELETE FROM chapter_unlocks WHERE user_id = 'u-leo' AND manga_id = 'KT-N1' AND chapter_number = 4`);
  await q(`UPDATE premium_pool_runs SET distributed_micros = distributed_micros + 1 WHERE period = $1`, [iso(P)]);
  r = await E.reconcile();
  ok('conciliación: detecta un reparto que no coincide con lo apuntado', !r.ok && r.problems.some((x) => x.check === 'reparto de Premium'), r.problems);
  await q(`UPDATE premium_pool_runs SET distributed_micros = distributed_micros - 1 WHERE period = $1`, [iso(P)]);
  ok('conciliación: vuelve a cuadrar', (await E.reconcile()).ok);

  // ── 9. El libro de ingresos no se toca ────────────────────────────────────
  const rejects = async (sql) => q(sql).then(() => false, () => true);
  ok('el libro de ingresos no se puede modificar', await rejects(`UPDATE author_ledger SET amount_micros = 999999999 WHERE author_id = 'u-autor'`));
  ok('el libro de ingresos no se puede borrar', await rejects(`DELETE FROM author_ledger WHERE author_id = 'u-autor2'`));
  ok('el libro de ingresos no se puede vaciar', await rejects(`TRUNCATE author_ledger`));
  ok('una venta no se puede apuntar dos veces', await rejects(`INSERT INTO author_ledger (author_id, manga_id, kind, amount_micros, unlock_id) SELECT author_id, manga_id, 'sale', 1, unlock_id FROM author_ledger WHERE kind = 'sale' LIMIT 1`));
  ok('un mes de Premium no se puede apuntar dos veces a la misma obra', await rejects(`INSERT INTO author_ledger (author_id, manga_id, kind, amount_micros, period) VALUES ('u-autor','KT-N1','premium',1,'${iso(P)}')`));
} catch (e) { T.fail(e); }
await T.finish();
