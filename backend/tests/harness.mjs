// Banco de pruebas de pagos: Postgres local desechable + Stripe simulado + la app real.
// Nada de esto toca la base de datos ni el Stripe de verdad.
import http from 'http';
import { createRequire } from 'module';
import { startPg } from './pg-local.mjs';

export async function setup({ pgPort, stripePort }) {
  const WH_SECRET = 'whsec_prueba_local';
  Object.assign(process.env, {
    DB_HOST: 'localhost', DB_PORT: String(pgPort), DB_USER: 'postgres', DB_PASSWORD: 'test', DB_NAME: 'postgres', DB_SSL: 'false',
    JWT_SECRET: 'secreto-solo-de-pruebas', STRIPE_SECRET_KEY: 'sk_test_simulada', STRIPE_WEBHOOK_SECRET: WH_SECRET,
    STRIPE_TEST_API: 'http://localhost:' + stripePort, PUBLIC_URL: 'https://kami.prueba',
  });
  const require = createRequire(import.meta.url);
  const NOW = Math.floor(Date.now() / 1000);

  // ── Stripe simulado: cada prueba rellena F con lo que Stripe «sabe» ──
  const F = { customers: {}, subs: {}, invoices: {}, charges: {}, checkouts: {}, refunds: [], canceled: [], sessions: [], portals: [], failNext: 0, seq: 1 };
  const fake = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const p = new URL(req.url, 'http://x').pathname.replace('/v1', ''), form = Object.fromEntries(new URLSearchParams(body));
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (F.failNext > 0) { F.failNext--; return send(500, { error: { message: 'caída simulada', type: 'api_error' } }); }
      let m;
      if (req.method === 'POST' && p === '/customers') { const id = 'cus_' + F.seq++; F.customers[id] = { id, ...form }; return send(200, { id, object: 'customer' }); }
      if (req.method === 'GET' && p === '/prices') return send(200, { object: 'list', data: [] });
      if (req.method === 'POST' && p === '/checkout/sessions') { F.sessions.push(form); return send(200, { id: 'cs_' + F.seq++, url: 'https://checkout.stripe.test/pay/' + F.seq }); }
      if (req.method === 'GET' && (m = p.match(/^\/checkout\/sessions\/(.+)$/))) return F.checkouts[m[1]] ? send(200, F.checkouts[m[1]]) : send(404, { error: { message: 'No such session' } });
      if (req.method === 'GET' && (m = p.match(/^\/subscriptions\/(.+)$/))) return F.subs[m[1]] ? send(200, F.subs[m[1]]) : send(404, { error: { message: 'No such subscription' } });
      if (req.method === 'GET' && (m = p.match(/^\/charges\/(.+)$/))) return F.charges[m[1]] ? send(200, F.charges[m[1]]) : send(404, { error: { message: 'No such charge' } });
      if (req.method === 'POST' && p === '/refunds') { F.refunds.push(form); return send(200, { id: 're_' + F.seq++ }); }
      send(404, { error: { message: 'ruta simulada inexistente: ' + req.method + ' ' + p } });
    });
  });
  await new Promise((r) => fake.listen(stripePort, r));

  const pg = await startPg(pgPort);
  const q = (sql, params) => pg.pool.query(sql, params);

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const Stripe = require('stripe');
  const { pool } = require('../db.js');
  if (pool.options.host !== 'localhost' || pool.options.port !== pgPort) { console.error('ABORTADO: la prueba no apunta a la base local'); process.exit(2); }

  let srv, BASE;
  async function listen(mount) {
    const app = express();
    app.use(require('../middleware/json-body.js'));
    mount(app, require);
    srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    BASE = 'http://localhost:' + srv.address().port;
  }
  const tok = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const api = async (method, url, { user, body, headers, raw } = {}) => {
    const r = await fetch(BASE + url, { method, headers: { ...(raw !== undefined ? {} : { 'Content-Type': 'application/json' }), ...(user ? { Authorization: 'Bearer ' + tok(user) } : {}), ...headers }, body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined) });
    return { status: r.status, d: await r.json().catch(() => ({})) };
  };
  const signer = new Stripe('sk_test_x');
  let evSeq = 1;
  const mkEvent = (type, object, over = {}) => ({ id: 'evt_' + evSeq++, object: 'event', type, livemode: false, created: NOW, data: { object }, ...over });
  const hook = (event, { secret = WH_SECRET } = {}) => {
    const payload = JSON.stringify(event);
    return api('POST', '/api/premium/webhook', { raw: payload, headers: { 'Content-Type': 'application/json', 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret }) } });
  };

  let pass = 0, failed = 0;
  const ok = (name, cond, extra) => { cond ? pass++ : failed++; console.log((cond ? 'OK    ' : 'FALLO ') + name + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
  const finish = async () => {
    if (srv) srv.close(); fake.close(); await pool.end().catch(() => {}); await pg.stop();
    console.log(`\n${pass} OK, ${failed} fallos`);
    process.exit(failed ? 1 : 0);
  };
  const waitColumn = async (table, col) => {
    const schema = require('../schema.js'); const t0 = Date.now();
    while (!(await schema.hasColumn(table, col)) && Date.now() - t0 < 35000) await new Promise((r) => setTimeout(r, 1000));
  };
  return { F, q, api, hook, mkEvent, ok, fail: (e) => { failed++; console.error('ERROR EN LA PRUEBA:', e); }, finish, listen, waitColumn, NOW, require };
}
