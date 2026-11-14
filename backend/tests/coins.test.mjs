// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — pruebas de pagos, fase 2 (monedas y adelantos)
//
//   node tests/coins.test.mjs
//
// Postgres local desechable y Stripe simulado: no toca nada real.
// ═══════════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setup } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = await setup({ pgPort: 54331, stripePort: 54332 });
const { F, q, api, hook, mkEvent, ok } = T;
const sqlFile = (f) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const DAY = 86400000, soon = new Date(Date.now() + 7 * DAY).toISOString(), past = new Date(Date.now() - DAY).toISOString();

// ─── Esquema mínimo de lo que ya existe en producción ───────────────────────
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
  INSERT INTO users (id, username, email) VALUES ('u-autor','autor','autor@prueba.test'), ('u-ana','ana','ana@prueba.test'), ('u-leo','leo','leo@prueba.test'),
    ('u-oro','oro','oro@prueba.test'), ('u-pobre','pobre','pobre@prueba.test'), ('u-mix','mix','mix@prueba.test'), ('u-multi','multi','multi@prueba.test'), ('u-dev','dev','dev@prueba.test');
  INSERT INTO users (id, username, is_banned) VALUES ('u-ban','ban',TRUE);
  UPDATE users SET subscription_tier = 'gold', premium_expires_at = now() + interval '20 days' WHERE id = 'u-oro';
  INSERT INTO mangas (id, title, author, type, created_by) VALUES ('KT-N1','Novela de prueba','autor','novel','u-autor'), ('KT-C1','Cómic de prueba','autor','manga','u-autor');
`);
const block = JSON.stringify([{ id: 'abcd1234', type: 'p', html: 'Texto secreto del adelanto.' }]);
for (let n = 1; n <= 20; n++) await q(`INSERT INTO chapters (manga_id, chapter_number, title, content, word_count, free_at) VALUES ('KT-N1',$1,$2,$3,4,$4)`, [n, 'Cap ' + n, block, n >= 3 ? soon : null]);
await q(`INSERT INTO chapters (manga_id, chapter_number, title, content, status, free_at) VALUES ('KT-N1', 30, 'Borrador', $1, 'draft', $2)`, [block, soon]);
await q(`INSERT INTO chapters (manga_id, chapter_number, title, pages, free_at) VALUES ('KT-C1', 1, 'Gratis', 3, NULL), ('KT-C1', 2, 'Adelanto', 3, $1)`, [soon]);
await q(sqlFile('migrate-payments.sql'));

await T.listen((app, require) => {
  app.use('/api/premium', require('../routes/routes-premium.js'));
  app.use('/api/coins', require('../routes/routes-coins.js'));
  app.use('/api/novel', require('../routes/routes-novel.js'));
  app.use('/api/chapters', require('../routes/routes-chapters.js'));
});

const bal = async (id) => (await q('SELECT balance FROM coin_wallets WHERE user_id = $1', [id])).rows[0]?.balance ?? 0;
const cus = async (id) => (await q('SELECT stripe_customer_id c FROM users WHERE id = $1', [id])).rows[0].c;
// Simula un paquete pagado en Stripe y entrega su aviso
let csSeq = 1;
async function buy(user, pack, over = {}, { deliver = true, stripeDown = false } = {}) {
  await api('POST', '/api/coins/checkout', { user, body: { pack } });
  const cents = { p500: 499, p1050: 999, p2200: 1999 }[pack], id = 'cs_pack_' + csSeq++;
  F.checkouts[id] = { id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: cents, currency: 'eur', customer: await cus(user), livemode: false,
    metadata: { kind: 'coin_pack', userId: user, pack }, total_details: { amount_tax: Math.round(cents * 21 / 121) },
    payment_intent: { id: 'pi_' + id, latest_charge: { id: 'ch_' + id, balance_transaction: { id: 'txn_' + id, fee: Math.round(cents * 0.015) + 25 } } }, ...over };
  F.charges['ch_' + id] = { id: 'ch_' + id, amount: cents, amount_refunded: 0, payment_intent: 'pi_' + id };
  if (stripeDown) F.failNext = 1;
  const ev = mkEvent('checkout.session.completed', { id, mode: 'payment' });
  const r = deliver ? await hook(ev) : null;
  return { id, r, ev };
}

try {
  // ── 1. Antes de la migración de monedas: todo como hoy ────────────────────
  let r = await api('GET', '/api/coins/wallet', { user: 'u-ana' });
  ok('sin migración: cartera cerrada y saldo 0', r.status === 200 && r.d.open === false && r.d.balance === 0, r);
  r = await api('POST', '/api/coins/checkout', { user: 'u-ana', body: { pack: 'p500' } });
  ok('sin migración: comprar responde «todavía no» (url null)', r.status === 200 && r.d.url === null, r);
  r = await api('POST', '/api/coins/unlock', { user: 'u-ana', body: { mangaId: 'KT-N1', chapter: 3 } });
  ok('sin migración: desbloquear → 503', r.status === 503, r);
  r = await api('GET', '/api/novel/KT-N1/3', { user: 'u-ana' });
  ok('sin migración: el adelanto sigue bloqueado y sin oferta', r.d.chapter.locked === true && r.d.chapter.offer === null && r.d.chapter.blocks === undefined, r.d.chapter);
  r = await api('GET', '/api/chapters/KT-C1/2/manifest', { user: 'u-ana' });
  ok('sin migración: cómic bloqueado (403) y sin oferta', r.status === 403 && r.d.locked && r.d.offer === null, r);

  // ── 2. Migración ──────────────────────────────────────────────────────────
  await q(sqlFile('migrate-payments-2.sql')); await q(sqlFile('migrate-payments-2.sql'));
  await T.waitColumn('coin_wallets', 'balance'); await T.waitColumn('chapter_unlocks', 'user_id'); await T.waitColumn('chapters', 'price_coins');
  r = await api('GET', '/api/coins/wallet', { user: 'u-ana' });
  ok('migración aplicada dos veces; la cartera se abre sin reiniciar', r.d.open === true && r.d.packs.length === 3 && r.d.packs[1].bonus === 50, r.d);

  // ── 3. El autor pone precio ───────────────────────────────────────────────
  const save = (n, body, user = 'u-autor') => api('PUT', '/api/novel/KT-N1/' + n, { user, body: { title: 'Cap ' + n, blocks: JSON.parse(block), status: 'published', ...body } });
  r = await save(3, { freeAt: soon, priceCoins: 50 });
  ok('autor: precio 50 en un adelanto', r.status === 200 && r.d.chapter.priceCoins === 50, r);
  r = await save(4, { freeAt: soon, priceCoins: 55 });
  ok('autor: un precio fuera de los niveles no se guarda', r.d.chapter.priceCoins === null, r.d.chapter);
  r = await save(1, { freeAt: null, priceCoins: 50 });
  ok('autor: sin fecha de liberación no hay precio', r.d.chapter.priceCoins === null, r.d.chapter);
  r = await save(5, { freeAt: soon, priceCoins: 30 }, 'u-ana');
  ok('quien no es el autor no puede poner precio (403)', r.status === 403, r);
  for (let n = 5; n <= 20; n++) await q(`UPDATE chapters SET price_coins = 50 WHERE manga_id = 'KT-N1' AND chapter_number = $1`, [n]);
  await q(`UPDATE chapters SET price_coins = 80 WHERE manga_id = 'KT-C1' AND chapter_number = 2`);
  await q(`UPDATE chapters SET price_coins = 50 WHERE manga_id = 'KT-N1' AND chapter_number = 30`);
  r = await api('GET', '/api/novel/KT-N1/3', { user: 'u-ana' });
  ok('lector: ve la oferta (50 monedas; Gold 40) pero no el texto', r.d.chapter.locked && r.d.chapter.blocks === undefined && r.d.chapter.offer.cost === 50 && r.d.chapter.offer.goldCost === 40, r.d.chapter);
  r = await api('GET', '/api/novel/KT-N1/3', { user: 'u-oro' });
  ok('lector Gold: su precio es 40 (−20 %)', r.d.chapter.offer.cost === 40 && r.d.chapter.offer.discountPct === 20, r.d.chapter.offer);
  r = await api('GET', '/api/novel/KT-N1/3');
  ok('visitante: ve el precio de lista', r.d.chapter.locked && r.d.chapter.offer.cost === 50, r.d.chapter.offer);

  // ── 4. Comprar un paquete ─────────────────────────────────────────────────
  r = await api('POST', '/api/coins/checkout', { body: { pack: 'p500' } });
  ok('compra: sin sesión → 401', r.status === 401, r);
  r = await api('POST', '/api/coins/checkout', { user: 'u-ana', body: { pack: 'p9999' } });
  ok('compra: paquete inventado → 400', r.status === 400, r);
  r = await api('POST', '/api/coins/checkout', { user: 'u-ban', body: { pack: 'p500' } });
  ok('compra: cuenta suspendida → 403', r.status === 403, r);
  r = await api('POST', '/api/coins/checkout', { user: 'u-ana', body: { pack: 'p1050', amount: 1, unit_amount: 1, coins: 999999, returnTo: '/leer/novela/KT-N1/3' } });
  let ses = F.sessions.at(-1);
  ok('compra: el importe lo pone el servidor (9,99 €)', /^https:\/\/checkout/.test(r.d.url) && ses.mode === 'payment' && ses['line_items[0][price_data][unit_amount]'] === '999' && ses['metadata[coins]'] === '1050' && ses['metadata[userId]'] === 'u-ana', ses);
  ok('compra: tras pagar vuelve al capítulo', ses.success_url === 'https://kami.prueba/leer/novela/KT-N1/3?monedas=ok', ses.success_url);
  for (const evil of ['https://malo.test/x', '//malo.test', '/leer?x=1#y', '/a/../b', 'javascript:alert(1)']) {
    await api('POST', '/api/coins/checkout', { user: 'u-ana', body: { pack: 'p500', returnTo: evil } });
    if (F.sessions.at(-1).success_url !== 'https://kami.prueba/monedas?monedas=ok') { ok('compra: vuelta a otra web rechazada (' + evil + ')', false, F.sessions.at(-1).success_url); }
  }
  ok('compra: no se puede redirigir a otra web tras pagar', F.sessions.slice(-5).every((s) => s.success_url === 'https://kami.prueba/monedas?monedas=ok'));
  ok('compra: abrir el pago no da monedas', (await bal('u-ana')) === 0);

  // ── 5. Acreditar: solo lo que Stripe confirma ─────────────────────────────
  let b = await buy('u-ana', 'p500');
  let lot = (await q(`SELECT * FROM coin_lots WHERE user_id = 'u-ana'`)).rows[0];
  ok('aviso de pago → 500 monedas', b.r.d.result === 'done' && (await bal('u-ana')) === 500, b.r);
  ok('lote: valor real por moneda = (4,99 − IVA 0,87 − comisión 0,32) / 500 = 0,0076 €', lot.unit_value_micros === 7600 && lot.coins_left === 500 && lot.fee_estimated === false, lot);
  await hook(mkEvent('checkout.session.completed', { id: b.id, mode: 'payment' }));
  await hook(mkEvent('checkout.session.async_payment_succeeded', { id: b.id, mode: 'payment' }));
  ok('otros avisos del mismo pago → no se acredita de nuevo', (await bal('u-ana')) === 500 && (await q(`SELECT count(*)::int n FROM coin_lots WHERE user_id = 'u-ana'`)).rows[0].n === 1);
  const b10 = await buy('u-leo', 'p500', {}, { deliver: false });
  await Promise.all(Array.from({ length: 10 }, () => hook(mkEvent('checkout.session.completed', { id: b10.id, mode: 'payment' }))));
  ok('10 avisos distintos y simultáneos del mismo pago → 500, no 5.000', (await bal('u-leo')) === 500 && (await q(`SELECT count(*)::int n FROM payments WHERE user_id = 'u-leo'`)).rows[0].n === 1, await bal('u-leo'));
  await buy('u-pobre', 'p500', { payment_status: 'unpaid' });
  ok('sesión sin pagar → nada', (await bal('u-pobre')) === 0);
  await buy('u-pobre', 'p500', { metadata: { kind: 'coin_pack', userId: 'u-pobre', pack: 'p2200' } });
  ok('paga 4,99 € diciendo que es el paquete de 19,99 € → nada', (await bal('u-pobre')) === 0);
  await buy('u-pobre', 'p500', { amount_total: 1 });
  ok('importe distinto al del paquete → nada', (await bal('u-pobre')) === 0);
  await buy('u-ana', 'p500', { metadata: { kind: 'coin_pack', userId: 'u-pobre', pack: 'p500' } });
  ok('pago de Ana con metadatos que apuntan a otra cuenta → nadie recibe monedas', (await bal('u-pobre')) === 0 && (await bal('u-ana')) === 500);
  const bf = await buy('u-dev', 'p500', {}, { stripeDown: true });
  ok('Stripe caído al acreditar → 500 y sin monedas a medias', bf.r.status === 500 && (await bal('u-dev')) === 0, bf.r);
  await hook(bf.ev);   // Stripe reenvía el mismo aviso
  ok('reintento → acreditado una vez', (await bal('u-dev')) === 500);

  // ── 6. Desbloquear ────────────────────────────────────────────────────────
  const unlock = (user, chapter, extra = {}, mangaId = 'KT-N1') => api('POST', '/api/coins/unlock', { user, body: { mangaId, chapter, ...extra } });
  r = await api('POST', '/api/coins/unlock', { body: { mangaId: 'KT-N1', chapter: 3 } });
  ok('desbloquear: sin sesión → 401', r.status === 401, r);
  r = await unlock('u-ban', 3);
  ok('desbloquear: cuenta suspendida → 403', r.status === 403, r);
  r = await unlock('u-ana', 2);
  ok('capítulo que ya es gratis → 409, sin cobro', r.status === 409 && r.d.code === 'free' && (await bal('u-ana')) === 500, r);
  r = await unlock('u-ana', 4);
  ok('adelanto sin precio → 409, sin cobro', r.status === 409 && r.d.code === 'not_for_sale', r);
  r = await unlock('u-ana', 30);
  ok('borrador → 404 (no revela que existe)', r.status === 404, r);
  r = await unlock('u-ana', 999);
  ok('capítulo inexistente → 404', r.status === 404, r);
  r = await unlock('u-pobre', 3);
  ok('sin saldo → 402 y dice cuánto falta', r.status === 402 && r.d.code === 'insufficient' && r.d.missing === 50, r);
  r = await unlock('u-ana', 3, { expect: 30 });
  ok('el precio que vio el lector ya no es el actual → 409, sin cobro', r.status === 409 && r.d.code === 'price_changed' && r.d.cost === 50 && (await bal('u-ana')) === 500, r);
  r = await unlock('u-ana', 3, { expect: 50 });
  let un = (await q(`SELECT * FROM chapter_unlocks WHERE user_id = 'u-ana' AND chapter_number = 3`)).rows[0];
  ok('desbloqueo: cobra 50 y deja 450', r.status === 200 && r.d.spent === 50 && r.d.balance === 450 && (await bal('u-ana')) === 450, r);
  ok('desbloqueo: guarda el valor real (50 × 0,0076 € = 0,38 €)', Number(un.value_micros) === 380000 && Number(un.full_value_micros) === 380000 && un.discount_pct === 0, un);
  r = await unlock('u-ana', 3);
  ok('repetir → «ya lo tienes», sin cobro', r.d.already === true && (await bal('u-ana')) === 450, r);
  r = await api('GET', '/api/novel/KT-N1/3', { user: 'u-ana' });
  ok('acceso: Ana ya lee el capítulo', r.d.chapter.locked === false && r.d.chapter.unlocked === true && r.d.chapter.blocks.length === 1, r.d.chapter);
  r = await api('GET', '/api/novel/KT-N1/3', { user: 'u-leo' });
  ok('acceso: para los demás sigue bloqueado', r.d.chapter.locked === true && r.d.chapter.blocks === undefined);
  r = await api('GET', '/api/novel/KT-N1/2', { user: 'u-ana' });
  ok('navegación: el siguiente ya no aparece bloqueado para Ana', r.d.next.number === 3 && r.d.next.locked === false, r.d.next);
  r = await api('GET', '/api/novel/KT-N1/chapters', { user: 'u-ana' });
  ok('lista: marca cuál tiene desbloqueado', r.d.chapters.find((c) => c.number === 3).unlocked === true && r.d.chapters.find((c) => c.number === 5).locked === true);

  // Diez clics a la vez sobre el mismo capítulo
  let many = await Promise.all(Array.from({ length: 10 }, () => unlock('u-leo', 5)));
  ok('10 peticiones simultáneas del mismo capítulo → se cobra una vez', (await bal('u-leo')) === 450 && many.every((x) => x.status === 200) && many.filter((x) => !x.d.already).length === 1, many.map((x) => x.status + ':' + x.d.already));
  // Doce capítulos a la vez con saldo para nueve
  many = await Promise.all(Array.from({ length: 12 }, (_, i) => unlock('u-leo', 6 + i)));
  const okN = many.filter((x) => x.status === 200).length, noN = many.filter((x) => x.status === 402).length;
  ok('12 capítulos a la vez con saldo para 9 → 9 sí, 3 no, saldo 0 y nunca negativo', okN === 9 && noN === 3 && (await bal('u-leo')) === 0, { okN, noN, bal: await bal('u-leo') });

  // Gold
  await buy('u-oro', 'p500');
  r = await unlock('u-oro', 3, { expect: 40 });
  un = (await q(`SELECT * FROM chapter_unlocks WHERE user_id = 'u-oro'`)).rows[0];
  ok('Gold: paga 40 en vez de 50', r.d.spent === 40 && (await bal('u-oro')) === 460, r);
  ok('Gold: el autor cobra sobre el precio completo (0,38 €), el descuento lo pone KamiTales', Number(un.value_micros) === 304000 && Number(un.full_value_micros) === 380000 && un.discount_pct === 20 && un.price_coins === 50, un);

  // Lotes de distinto valor: se gasta primero el más antiguo
  await buy('u-mix', 'p500'); await q(`UPDATE coin_lots SET coins_left = 20 WHERE user_id = 'u-mix'`); await q(`UPDATE coin_wallets SET balance = 20 WHERE user_id = 'u-mix'`);
  await buy('u-mix', 'p2200');
  r = await unlock('u-mix', 3);
  un = (await q(`SELECT * FROM chapter_unlocks WHERE user_id = 'u-mix'`)).rows[0];
  const lots = (await q(`SELECT coins_left, unit_value_micros FROM coin_lots WHERE user_id = 'u-mix' ORDER BY id`)).rows;
  ok('dos lotes: gasta primero el antiguo (20) y luego el nuevo (30), cada uno a su valor', lots[0].coins_left === 0 && lots[1].coins_left === 2170 && Number(un.value_micros) === 20 * lots[0].unit_value_micros + 30 * lots[1].unit_value_micros, { lots, un });

  // El autor y el cómic
  r = await unlock('u-autor', 3);
  ok('el autor no paga por su propia obra', r.d.already === true && (await q(`SELECT count(*)::int n FROM chapter_unlocks WHERE user_id = 'u-autor'`)).rows[0].n === 0, r);
  r = await api('GET', '/api/chapters/KT-C1/2/manifest', { user: 'u-ana' });
  ok('cómic: bloqueado con oferta de 80 monedas', r.status === 403 && r.d.offer.cost === 80 && !r.d.pages, r.d);
  r = await api('GET', '/api/chapters/KT-C1/1/manifest', { user: 'u-ana' });
  ok('cómic: desde el capítulo anterior, el siguiente lleva su oferta', r.status === 200 && r.d.nav.next.locked === true && r.d.nav.next.offer.cost === 80, r.d.nav);
  r = await unlock('u-ana', 2, { expect: 80 }, 'KT-C1');
  ok('cómic: desbloqueo por 80', r.d.spent === 80 && (await bal('u-ana')) === 370, r);
  r = await api('GET', '/api/chapters/KT-C1/2/manifest', { user: 'u-ana' });
  ok('cómic: Ana ya recibe las páginas firmadas', r.status === 200 && r.d.pages.length === 3 && /sig=|signature=|token=/.test(JSON.stringify(r.d.pages[0])), r.d.pages && r.d.pages[0]);
  r = await api('GET', '/api/chapters/KT-C1/2/manifest', { user: 'u-leo' });
  ok('cómic: los demás siguen sin páginas', r.status === 403 && !r.d.pages);
  r = await api('GET', '/api/chapters/KT-C1', { user: 'u-ana' });
  ok('cómic: la lista marca el desbloqueado y el precio', r.d.chapters.find((c) => c.number === 2).unlocked === true && r.d.chapters.find((c) => c.number === 2).priceCoins === 80, r.d.chapters);

  // El autor cambia la fecha: quien pagó no pierde el acceso
  await q(`UPDATE chapters SET free_at = $1 WHERE manga_id = 'KT-N1' AND chapter_number = 3`, [past]);
  r = await api('GET', '/api/novel/KT-N1/3', { user: 'u-pobre' });
  ok('al llegar la fecha, el capítulo es gratis para todos', r.d.chapter.locked === false && r.d.chapter.offer === null);

  // ── 7. Devolución de un paquete ───────────────────────────────────────────
  const bm = await buy('u-multi', 'p500');
  await unlock('u-multi', 5);
  F.charges['ch_' + bm.id].amount_refunded = 499;
  await hook(mkEvent('charge.refunded', { id: 'ch_' + bm.id, payment_intent: 'pi_' + bm.id }));
  lot = (await q(`SELECT coins_left, voided_at FROM coin_lots WHERE user_id = 'u-multi'`)).rows[0];
  ok('devolución: se retiran las 450 monedas que quedaban; lo ya leído se conserva', (await bal('u-multi')) === 0 && lot.coins_left === 0 && lot.voided_at !== null, { bal: await bal('u-multi'), lot });
  await hook(mkEvent('charge.refunded', { id: 'ch_' + bm.id, payment_intent: 'pi_' + bm.id }));
  ok('aviso de devolución repetido → no retira nada más', (await q(`SELECT count(*)::int n FROM coin_ledger WHERE user_id = 'u-multi' AND reason = 'refund'`)).rows[0].n === 1);

  // ── 8. La base de datos como última defensa ───────────────────────────────
  const rejects = async (sql) => q(sql).then(() => false, () => true);
  ok('el libro de monedas no se puede modificar', await rejects(`UPDATE coin_ledger SET delta = 999999 WHERE user_id = 'u-ana'`));
  ok('el libro de monedas no se puede borrar', await rejects(`DELETE FROM coin_ledger WHERE user_id = 'u-ana'`));
  ok('el libro de monedas no se puede vaciar', await rejects(`TRUNCATE coin_ledger`));
  ok('un saldo no puede ser negativo', await rejects(`UPDATE coin_wallets SET balance = -1 WHERE user_id = 'u-ana'`));
  ok('un capítulo no se puede cobrar dos veces a la misma persona', await rejects(`INSERT INTO chapter_unlocks (user_id, manga_id, chapter_number, price_coins, coins_spent, value_micros, full_value_micros) VALUES ('u-ana','KT-N1',3,50,50,1,1)`));
  ok('un cobro no puede acreditar dos lotes', await rejects(`INSERT INTO coin_lots (user_id, coins_total, coins_left, unit_value_micros, source, payment_id) SELECT user_id, 500, 500, 1, 'purchase', payment_id FROM coin_lots WHERE user_id = 'u-ana' LIMIT 1`));

  // ── 9. Conciliación: todo cuadra ──────────────────────────────────────────
  await q(`UPDATE coin_wallets SET balance = 20 WHERE user_id = 'u-mix' AND FALSE`); // (el ajuste manual de u-mix se excluye abajo)
  const rec = (await q(`
    SELECT w.user_id, w.balance,
           (SELECT COALESCE(SUM(delta), 0) FROM coin_ledger l WHERE l.user_id = w.user_id)::int AS ledger,
           (SELECT COALESCE(SUM(coins_left), 0) FROM coin_lots t WHERE t.user_id = w.user_id AND t.voided_at IS NULL)::int AS lots
      FROM coin_wallets w WHERE w.user_id <> 'u-mix'`)).rows;
  ok('conciliación: saldo = suma del libro = monedas en lotes, para cada usuario', rec.length >= 5 && rec.every((x) => x.balance === x.ledger && x.balance === x.lots), rec);
  const tot = (await q(`SELECT (SELECT COALESCE(SUM(coins_spent),0) FROM chapter_unlocks)::int spent, (SELECT COALESCE(-SUM(delta),0) FROM coin_ledger WHERE reason = 'unlock')::int led`)).rows[0];
  ok('conciliación: monedas gastadas en capítulos = movimientos de desbloqueo', tot.spent === tot.led && tot.spent > 0, tot);
  r = await api('GET', '/api/coins/history', { user: 'u-ana' });
  ok('historial: compra y desbloqueos, del más reciente al más antiguo', r.d.items.length === 3 && r.d.items[0].reason === 'unlock' && r.d.items[0].mangaTitle === 'Cómic de prueba' && r.d.items[2].reason === 'purchase' && r.d.items[2].delta === 500, r.d.items);
  r = await api('GET', '/api/coins/history', { user: 'u-leo' });
  ok('historial: cada uno ve solo el suyo', r.d.items.every((x) => x.reason) && !JSON.stringify(r.d).includes('u-ana'));
  ok('no queda ningún aviso pendiente', (await q('SELECT count(*)::int n FROM payment_events WHERE processed_at IS NULL')).rows[0].n === 0);
} catch (e) { T.fail(e); }
await T.finish();
