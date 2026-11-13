// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — pruebas de pagos, fase 1 (suscripciones)
//
//   node tests/payments.test.mjs
//
// No toca nada real: usa un Postgres local desechable y un Stripe simulado en
// esta máquina. Las variables de entorno se fijan ANTES de cargar el código.
// ═══════════════════════════════════════════════════════════════════════════════
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { startPg } from './pg-local.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PG_PORT = 54329, STRIPE_PORT = 54330, WH_SECRET = 'whsec_prueba_local';

Object.assign(process.env, {
  DB_HOST: 'localhost', DB_PORT: String(PG_PORT), DB_USER: 'postgres', DB_PASSWORD: 'test', DB_NAME: 'postgres', DB_SSL: 'false',
  JWT_SECRET: 'secreto-solo-de-pruebas', STRIPE_SECRET_KEY: 'sk_test_simulada', STRIPE_WEBHOOK_SECRET: WH_SECRET,
  STRIPE_TEST_API: 'http://localhost:' + STRIPE_PORT, PUBLIC_URL: 'https://kami.prueba',
});

let pass = 0, failed = 0;
const ok = (name, cond, extra) => { cond ? pass++ : failed++; console.log((cond ? 'OK    ' : 'FALLO ') + name + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

// ─── Stripe simulado ────────────────────────────────────────────────────────
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
const F = { customers: {}, subs: {}, invoices: {}, charges: {}, refunds: [], canceled: [], sessions: [], portals: [], failNext: 0, seq: 1 };
const PRICES = {
  price_silver_m: { id: 'price_silver_m', lookup_key: 'kami_silver_monthly', unit_amount: 399, metadata: {} },
  price_silver_y: { id: 'price_silver_y', lookup_key: 'kami_silver_yearly', unit_amount: 2699, metadata: {} },
  price_gold_m: { id: 'price_gold_m', lookup_key: 'kami_gold_monthly', unit_amount: 699, metadata: {} },
  price_gold_y: { id: 'price_gold_y', lookup_key: 'kami_gold_yearly', unit_amount: 4999, metadata: {} },
  price_ajeno: { id: 'price_ajeno', lookup_key: 'otra_tienda', unit_amount: 100, metadata: {} },
};
function mkSub(id, customer, price, over = {}) {
  F.invoices['in_' + id] = { id: 'in_' + id, object: 'invoice', status: 'paid', amount_paid: PRICES[price].unit_amount, tax: Math.round(PRICES[price].unit_amount * 21 / 121),
    currency: 'eur', customer, subscription: id, payment_intent: 'pi_' + id, livemode: false, created: NOW, status_transitions: { paid_at: NOW },
    charge: { id: 'ch_' + id, balance_transaction: { id: 'txn_' + id, fee: 31 } } };
  F.charges['ch_' + id] = { id: 'ch_' + id, amount: PRICES[price].unit_amount, amount_refunded: 0, payment_intent: 'pi_' + id };
  return (F.subs[id] = { id, object: 'subscription', customer, status: 'active', created: NOW, livemode: false, metadata: {}, cancel_at_period_end: false, canceled_at: null,
    current_period_start: NOW, current_period_end: NOW + 30 * DAY, latest_invoice: 'in_' + id, items: { data: [{ price: PRICES[price] }] }, ...over });
}
const fakeStripe = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const url = new URL(req.url, 'http://x'), p = url.pathname.replace('/v1', ''), form = Object.fromEntries(new URLSearchParams(body));
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (F.failNext > 0) { F.failNext--; return send(500, { error: { message: 'caída simulada', type: 'api_error' } }); }
    let m;
    if (req.method === 'POST' && p === '/customers') { const id = 'cus_' + F.seq++; F.customers[id] = { id, ...form }; return send(200, { id, object: 'customer' }); }
    if (req.method === 'GET' && p === '/prices') return send(200, { object: 'list', data: Object.values(PRICES).filter((x) => x.lookup_key.startsWith('kami_')) });
    if (req.method === 'POST' && p === '/checkout/sessions') { F.sessions.push(form); return send(200, { id: 'cs_' + F.seq++, url: 'https://checkout.stripe.test/pay/' + F.seq }); }
    if (req.method === 'POST' && p === '/billing_portal/sessions') { F.portals.push(form); return send(200, { id: 'bps_1', url: 'https://billing.stripe.test/portal' }); }
    if (req.method === 'GET' && (m = p.match(/^\/subscriptions\/(.+)$/))) return F.subs[m[1]] ? send(200, F.subs[m[1]]) : send(404, { error: { message: 'No such subscription' } });
    if (req.method === 'DELETE' && (m = p.match(/^\/subscriptions\/(.+)$/))) { F.subs[m[1]].status = 'canceled'; F.canceled.push(m[1]); return send(200, F.subs[m[1]]); }
    if (req.method === 'GET' && (m = p.match(/^\/invoices\/(.+)$/))) return F.invoices[m[1]] ? send(200, F.invoices[m[1]]) : send(404, { error: { message: 'No such invoice' } });
    if (req.method === 'GET' && (m = p.match(/^\/charges\/(.+)$/))) return send(200, F.charges[m[1]]);
    if (req.method === 'POST' && p === '/refunds') { F.refunds.push(form); return send(200, { id: 're_' + F.seq++ }); }
    send(404, { error: { message: 'ruta simulada inexistente: ' + req.method + ' ' + p } });
  });
});
await new Promise((r) => fakeStripe.listen(STRIPE_PORT, r));

// ─── Base de datos local ────────────────────────────────────────────────────
const pg = await startPg(PG_PORT);
const q = (sql, params) => pg.pool.query(sql, params);
await q(`CREATE TABLE users (id VARCHAR(60) PRIMARY KEY, username VARCHAR(60), email VARCHAR(255), premium_expires_at TIMESTAMP,
           subscription_tier VARCHAR(20), is_admin BOOLEAN DEFAULT FALSE, password_changed_at TIMESTAMP);
         CREATE TABLE revoked_tokens (token_hash TEXT PRIMARY KEY, expires_at TIMESTAMP);
         INSERT INTO users (id, username, email) VALUES ('u-ana','ana','ana@prueba.test'), ('u-leo','leo','leo@prueba.test'), ('u-mar','mar','mar@prueba.test'), ('u-dup','dup','dup@prueba.test');`);

// ─── La aplicación, con el mismo tratamiento del cuerpo que server.js ───────
const express = require('express');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { pool } = require('../db.js');
if (pool.options.host !== 'localhost' || pool.options.port !== PG_PORT) { console.error('ABORTADO: la prueba no apunta a la base local'); process.exit(2); }
const app = express();
app.use(require('../middleware/json-body.js'));
app.use('/api/premium', require('../routes/routes-premium.js'));
const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const BASE = 'http://localhost:' + srv.address().port;

const tok = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '1h' });
const api = async (method, url, { user, body, headers, raw } = {}) => {
  const r = await fetch(BASE + url, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(user ? { Authorization: 'Bearer ' + tok(user) } : {}), ...headers }, body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const signer = new Stripe('sk_test_x');
let evSeq = 1;
const mkEvent = (type, object, over = {}) => ({ id: 'evt_' + evSeq++, object: 'event', type, livemode: false, created: NOW, data: { object }, ...over });
const hook = (event, { secret = WH_SECRET, timestamp, body } = {}) => {
  const payload = body || JSON.stringify(event);
  const sig = signer.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret, timestamp });
  return api('POST', '/api/premium/webhook', { raw: payload, headers: { 'Content-Type': 'application/json', 'stripe-signature': sig } });
};
const userRow = async (id) => (await q('SELECT subscription_tier AS tier, premium_expires_at AS exp, stripe_customer_id AS cus FROM users WHERE id = $1', [id]).catch(() => ({ rows: [{}] }))).rows[0];
const isPrem = async (id) => (await q('SELECT (premium_expires_at > now() AND subscription_tier IS NOT NULL) p FROM users WHERE id = $1', [id])).rows[0].p === true;

try {
  // ── 1. Antes de la migración: todo sigue como hoy ─────────────────────────
  let r = await api('POST', '/api/premium/create-checkout', { user: 'u-ana', body: { plan: 'silver_monthly' } });
  ok('sin migración: create-checkout responde «Muy pronto» (url null)', r.status === 200 && r.d.url === null, r);
  r = await hook(mkEvent('customer.subscription.updated', { id: 'sub_x' }));
  ok('sin migración: el aviso no se acepta (503, Stripe reintentará)', r.status === 503, r);
  r = await api('GET', '/api/premium/status', { user: 'u-ana' });
  ok('sin migración: status funciona', r.status === 200 && r.d.premiumStatus === 'none' && r.d.paymentsOpen === false, r);

  // ── 2. Migración: se aplica dos veces sin error ───────────────────────────
  const sql = fs.readFileSync(path.join(here, '..', 'migrate-payments.sql'), 'utf8');
  await q(sql); await q(sql);
  const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('payment_events','subscriptions','payments')`)).rows.length;
  ok('migración: crea 3 tablas y se puede repetir', tables === 3, tables);
  await new Promise((res) => setTimeout(res, 100));
  // schema.js recuerda 30 s que la columna no existía; se espera a que lo vuelva a mirar.
  const schema = require('../schema.js');
  const t0 = Date.now(); while (!(await schema.hasColumn('users', 'stripe_customer_id')) && Date.now() - t0 < 35000) await new Promise((res) => setTimeout(res, 1000));
  ok('la migración se detecta sin reiniciar (≤ 30 s)', await schema.hasColumn('subscriptions', 'stripe_subscription_id'));

  // ── 3. Abrir el pago ──────────────────────────────────────────────────────
  r = await api('POST', '/api/premium/create-checkout', { body: { plan: 'silver_monthly' } });
  ok('pago: sin sesión → 401', r.status === 401, r);
  r = await api('POST', '/api/premium/create-checkout', { user: 'u-ana', body: { plan: 'platinum_monthly' } });
  ok('pago: plan inventado → 400', r.status === 400, r);
  r = await api('POST', '/api/premium/create-checkout', { user: 'u-ana', body: { plan: '__proto__' } });
  ok('pago: plan «__proto__» → 400', r.status === 400, r);
  r = await api('POST', '/api/premium/create-checkout', { user: 'u-ana', body: { plan: 'gold_yearly', amount: 1, price: 'price_ajeno', unit_amount: 1 } });
  const ses = F.sessions.at(-1) || {};
  ok('pago: devuelve la dirección de Stripe', r.status === 200 && /^https:\/\/checkout\.stripe\.test/.test(r.d.url), r);
  ok('pago: el precio lo pone el servidor, no el navegador', ses['line_items[0][price]'] === 'price_gold_y' && !Object.keys(ses).some((k) => /amount/.test(k)), ses);
  ok('pago: suscripción ligada al usuario', ses.mode === 'subscription' && ses.client_reference_id === 'u-ana' && ses['subscription_data[metadata][userId]'] === 'u-ana');
  ok('pago: vuelve a PUBLIC_URL', ses.success_url === 'https://kami.prueba/premium/exito?session_id={CHECKOUT_SESSION_ID}' && ses.cancel_url === 'https://kami.prueba/premium', ses.success_url);
  const anaCus = (await userRow('u-ana')).cus;
  ok('pago: se crea y se guarda el cliente de Stripe', /^cus_/.test(anaCus) && F.customers[anaCus].email === 'ana@prueba.test', anaCus);
  await api('POST', '/api/premium/create-checkout', { user: 'u-ana', body: { plan: 'silver_monthly' } });
  ok('pago: el cliente no se crea dos veces', Object.keys(F.customers).length === 1 && (await userRow('u-ana')).cus === anaCus);
  ok('pago: abrir el pago no da Premium', !(await isPrem('u-ana')));

  // ── 4. Avisos falsos ──────────────────────────────────────────────────────
  mkSub('sub_ana', anaCus, 'price_silver_m', { metadata: { userId: 'u-ana' } });
  const evDone = mkEvent('checkout.session.completed', { id: 'cs_1', mode: 'subscription', subscription: 'sub_ana', customer: anaCus });
  r = await api('POST', '/api/premium/webhook', { body: evDone });
  ok('aviso sin firma → 400', r.status === 400, r);
  r = await hook(evDone, { secret: 'whsec_de_otro' });
  ok('aviso firmado con otro secreto → 400', r.status === 400, r);
  r = await hook(evDone, { body: JSON.stringify({ ...evDone, data: { object: { ...evDone.data.object, subscription: 'sub_otro' } } }) });
  ok('aviso con el contenido alterado tras firmar → 400', r.status === 400, r);
  r = await hook(evDone, { timestamp: NOW - 3600 });
  ok('aviso antiguo reenviado (1 h) → 400', r.status === 400, r);
  ok('ningún aviso falso dio Premium ni dejó rastro', !(await isPrem('u-ana')) && (await q('SELECT count(*)::int n FROM payment_events')).rows[0].n === 0);
  r = await hook(mkEvent('checkout.session.completed', evDone.data.object, { livemode: true }));
  ok('aviso de modo real con clave de pruebas → se ignora', r.status === 200 && r.d.ignored && !(await isPrem('u-ana')), r);

  // ── 5. Aviso auténtico ────────────────────────────────────────────────────
  r = await hook(evDone);
  let u = await userRow('u-ana');
  ok('aviso auténtico → Silver activo', r.status === 200 && r.d.result === 'done' && u.tier === 'silver' && (await isPrem('u-ana')), { r, u });
  r = await api('GET', '/api/premium/status', { user: 'u-ana' });
  ok('status: activo, ~30 días, con datos de la suscripción', r.d.premiumStatus === 'active' && r.d.subscriptionTier === 'silver' && r.d.daysRemaining >= 29 && r.d.subscription && r.d.subscription.interval === 'month' && r.d.subscription.cancelAtPeriodEnd === false, r.d);
  r = await hook(evDone);
  ok('el mismo aviso otra vez → duplicado, sin cambios', r.status === 200 && r.d.result === 'duplicate' && (await q('SELECT count(*)::int n FROM subscriptions')).rows[0].n === 1, r);

  // Factura pagada: diez entregas simultáneas del mismo aviso
  const evInv = mkEvent('invoice.paid', { id: 'in_sub_ana', subscription: 'sub_ana' });
  const many = await Promise.all(Array.from({ length: 10 }, () => hook(evInv)));
  const pay = (await q('SELECT * FROM payments')).rows;
  ok('10 entregas simultáneas de un cobro → se registra una vez', pay.length === 1 && many.every((x) => x.status === 200) && many.filter((x) => x.d.result === 'done').length === 1, many.map((x) => x.d.result));
  ok('cobro: importes en céntimos (3,99 € · IVA 0,69 € · comisión 0,31 €)', pay[0].amount_cents === 399 && pay[0].tax_cents === 69 && pay[0].fee_cents === 31 && pay[0].user_id === 'u-ana' && pay[0].kind === 'subscription', pay[0]);

  // ── 6. El aviso no manda: manda lo que diga Stripe ────────────────────────
  r = await hook(mkEvent('customer.subscription.updated', { id: 'sub_ana', status: 'active', items: { data: [{ price: PRICES.price_gold_y }] }, current_period_end: NOW + 3650 * DAY }));
  u = await userRow('u-ana');
  ok('aviso que dice Gold y 10 años cuando Stripe dice Silver → sigue Silver 30 días', u.tier === 'silver' && new Date(u.exp) < new Date(Date.now() + 40 * DAY * 1000), u);

  F.subs.sub_ana.items.data[0].price = PRICES.price_gold_m;
  const evOld = mkEvent('customer.subscription.updated', { id: 'sub_ana' });
  await hook(mkEvent('customer.subscription.updated', { id: 'sub_ana' }));
  ok('cambio de plan en el portal → Gold', (await userRow('u-ana')).tier === 'gold');
  await hook(evOld);
  ok('aviso antiguo que llega tarde → se mantiene el estado actual (Gold)', (await userRow('u-ana')).tier === 'gold');

  r = await api('POST', '/api/premium/create-checkout', { user: 'u-ana', body: { plan: 'silver_yearly' } });
  ok('ya suscrito: «contratar» abre el portal, no un segundo pago', r.d.portal === true && /billing\.stripe\.test/.test(r.d.url) && F.portals.at(-1).customer === anaCus, r.d);
  r = await api('POST', '/api/premium/portal', { user: 'u-ana' });
  ok('portal: devuelve la dirección', r.status === 200 && /^https:\/\/billing/.test(r.d.url) && F.portals.at(-1).return_url === 'https://kami.prueba/ajustes#premium', r);

  // ── 7. Cobro fallido, cancelación y fin ───────────────────────────────────
  Object.assign(F.subs.sub_ana, { status: 'past_due', current_period_start: NOW - 2 * DAY, current_period_end: NOW + 28 * DAY });
  await hook(mkEvent('invoice.payment_failed', { id: 'in_2', subscription: 'sub_ana' }));
  u = await userRow('u-ana');
  const left = (new Date(u.exp) - Date.now()) / 86400000;
  ok('cobro fallido: margen de 7 días desde el inicio del periodo, no el mes entero', u.tier === 'gold' && left > 4.5 && left < 5.5, left);
  Object.assign(F.subs.sub_ana, { status: 'active', cancel_at_period_end: true, current_period_start: NOW, current_period_end: NOW + 30 * DAY });
  await hook(mkEvent('customer.subscription.updated', { id: 'sub_ana' }));
  r = await api('GET', '/api/premium/status', { user: 'u-ana' });
  ok('cancelación programada: sigue activo hasta el final y lo indica', r.d.premiumStatus === 'active' && r.d.subscription.cancelAtPeriodEnd === true, r.d);
  Object.assign(F.subs.sub_ana, { status: 'canceled', canceled_at: NOW });
  await hook(mkEvent('customer.subscription.deleted', { id: 'sub_ana' }));
  u = await userRow('u-ana');
  r = await api('GET', '/api/premium/status', { user: 'u-ana' });
  ok('suscripción terminada → sin plan', u.tier === null && !(await isPrem('u-ana')) && r.d.premiumStatus === 'expired' && r.d.subscription === null, { u, d: r.d });

  // ── 8. Intentos de dar Premium a quien no pagó ────────────────────────────
  mkSub('sub_huerfana', 'cus_desconocido', 'price_gold_y');
  r = await hook(mkEvent('customer.subscription.created', { id: 'sub_huerfana' }));
  ok('suscripción de un cliente desconocido → no se asigna a nadie', r.status === 200 && (await q(`SELECT count(*)::int n FROM subscriptions WHERE stripe_subscription_id = 'sub_huerfana'`)).rows[0].n === 0, r);
  // Leo paga, pero la suscripción dice en sus metadatos que es de Mar
  await api('POST', '/api/premium/create-checkout', { user: 'u-leo', body: { plan: 'silver_monthly' } });
  await api('POST', '/api/premium/create-checkout', { user: 'u-mar', body: { plan: 'silver_monthly' } });
  const leoCus = (await userRow('u-leo')).cus;
  mkSub('sub_leo', leoCus, 'price_silver_y', { metadata: { userId: 'u-mar' }, current_period_end: NOW + 365 * DAY });
  await hook(mkEvent('customer.subscription.created', { id: 'sub_leo' }));
  ok('metadatos que apuntan a otra cuenta → Premium va al dueño del cliente', (await isPrem('u-leo')) && !(await isPrem('u-mar')), { leo: await userRow('u-leo'), mar: await userRow('u-mar') });
  mkSub('sub_ajena', (await userRow('u-mar')).cus, 'price_ajeno', { metadata: { userId: 'u-mar' } });
  await hook(mkEvent('customer.subscription.created', { id: 'sub_ajena' }));
  ok('precio que no es de KamiTales → no da Premium', !(await isPrem('u-mar')));

  // ── 9. Stripe caído a mitad ───────────────────────────────────────────────
  mkSub('sub_mar', (await userRow('u-mar')).cus, 'price_silver_m', { metadata: { userId: 'u-mar' } });
  const evMar = mkEvent('customer.subscription.created', { id: 'sub_mar' });
  F.failNext = 1;
  r = await hook(evMar);
  let row = (await q('SELECT processed_at, attempts, last_error FROM payment_events WHERE id = $1', [evMar.id])).rows[0];
  ok('Stripe caído: responde 500, queda pendiente y sin Premium a medias', r.status === 500 && row.processed_at === null && row.attempts === 1 && !!row.last_error && !(await isPrem('u-mar')), { r, row });
  r = await hook(evMar);
  row = (await q('SELECT processed_at, attempts FROM payment_events WHERE id = $1', [evMar.id])).rows[0];
  ok('reintento de Stripe → ahora sí se procesa', r.d.result === 'done' && row.processed_at !== null && row.attempts === 2 && (await isPrem('u-mar')), { r, row });

  // ── 10. Dos pagos a la vez (dos pestañas) ─────────────────────────────────
  await api('POST', '/api/premium/create-checkout', { user: 'u-dup', body: { plan: 'silver_monthly' } });
  const dupCus = (await userRow('u-dup')).cus;
  mkSub('sub_dup1', dupCus, 'price_silver_m', { metadata: { userId: 'u-dup' }, created: NOW - 60 });
  mkSub('sub_dup2', dupCus, 'price_gold_m', { metadata: { userId: 'u-dup' }, created: NOW });
  await hook(mkEvent('customer.subscription.created', { id: 'sub_dup1' }));
  await hook(mkEvent('customer.subscription.created', { id: 'sub_dup2' }));
  ok('segunda suscripción simultánea → se cancela y se devuelve su cobro', F.canceled.includes('sub_dup2') && !F.canceled.includes('sub_dup1') && F.refunds.length === 1 && F.refunds[0].payment_intent === 'pi_sub_dup2', { canceled: F.canceled, refunds: F.refunds });
  ok('el usuario conserva la primera (Silver), no acumula dos', (await userRow('u-dup')).tier === 'silver' && (await q(`SELECT count(*)::int n FROM subscriptions WHERE user_id = 'u-dup' AND status = 'active'`)).rows[0].n === 1);
  await hook(mkEvent('customer.subscription.updated', { id: 'sub_dup1' }));
  ok('la primera no se cancela por error al reprocesarse', F.canceled.length === 1 && (await userRow('u-dup')).tier === 'silver');

  // ── 11. Devoluciones y reclamaciones ──────────────────────────────────────
  F.charges.ch_sub_ana.amount_refunded = 399;
  await hook(mkEvent('charge.refunded', { id: 'ch_sub_ana' }));
  row = (await q(`SELECT status, refunded_cents FROM payments WHERE stripe_charge_id = 'ch_sub_ana'`)).rows[0];
  ok('devolución total → el cobro queda como devuelto', row.status === 'refunded' && row.refunded_cents === 399, row);
  await hook(mkEvent('invoice.paid', { id: 'in_sub_leo' }));
  await hook(mkEvent('charge.dispute.created', { id: 'dp_1', charge: 'ch_sub_leo' }));
  row = (await q(`SELECT status FROM payments WHERE stripe_charge_id = 'ch_sub_leo'`)).rows[0];
  ok('reclamación al banco → el cobro queda marcado', row && row.status === 'disputed', row);

  // ── 12. Integridad ────────────────────────────────────────────────────────
  const bad = await q(`INSERT INTO payments (kind, amount_cents) VALUES ('subscription', -5)`).then(() => false, () => true);
  ok('la base rechaza importes negativos', bad);
  const pend = (await q('SELECT count(*)::int n FROM payment_events WHERE processed_at IS NULL')).rows[0].n;
  ok('no queda ningún aviso pendiente', pend === 0, pend);
  r = await api('POST', '/api/premium/webhook', { raw: '{"a":', headers: { 'Content-Type': 'application/json' } });
  ok('cuerpo roto en el aviso → 400, no 500', r.status === 400, r);
} catch (e) {
  failed++; console.error('ERROR EN LA PRUEBA:', e);
} finally {
  srv.close(); fakeStripe.close(); await pool.end().catch(() => {}); await pg.stop();
}
console.log(`\n${pass} OK, ${failed} fallos`);
process.exit(failed ? 1 : 0);
