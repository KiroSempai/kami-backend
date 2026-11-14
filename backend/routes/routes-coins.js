/**
 * KamiTales — routes-coins.js
 * Monedas: saldo, compra de paquetes y desbloqueo de adelantos.
 *
 *   GET  /api/coins/wallet    → saldo, paquetes y si las compras están abiertas
 *   GET  /api/coins/history   → últimos movimientos
 *   POST /api/coins/checkout  → { pack, returnTo } abre el pago de un paquete
 *   POST /api/coins/unlock    → { mangaId, chapter, expect } gasta monedas en un adelanto
 *
 * Las monedas se acreditan en el aviso de Stripe (routes-premium.js → /webhook).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAuth, requireNotBanned } = require('../middleware/auth');
const coins = require('../payments/coins');

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}
const limiter = (limit) => rateLimit({
  windowMs: 60_000, limit, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'coins:' + (req.user ? req.user.userId : 'anon'),
  message: { error: 'Demasiados intentos. Espera un minuto y vuelve a probar.' },
});
function fail(res, e, fallback) {
  if (e && e.status && e.status < 500) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) });
  if (e && e.status === 503) return res.status(503).json({ error: e.message, code: e.code });
  console.error('[monedas]', fallback, '—', e && e.message);
  return res.status(500).json({ error: fallback });
}

router.get('/wallet', requireAuth, async (req, res) => {
  try { res.json(await coins.wallet(req.user.userId)); } catch (e) { fail(res, e, 'No se pudo cargar tu saldo.'); }
});

router.get('/history', requireAuth, async (req, res) => {
  try { res.json({ items: await coins.history(req.user.userId, parseInt(req.query.limit, 10) || 50) }); } catch (e) { fail(res, e, 'No se pudo cargar el historial.'); }
});

router.post('/checkout', requireAuth, requireNotBanned, limiter(10), async (req, res) => {
  const pack = req.body && req.body.pack;
  if (typeof pack !== 'string' || !Object.prototype.hasOwnProperty.call(coins.PACKS, pack)) return res.status(400).json({ error: 'Paquete no válido.' });
  try {
    if (!(await coins.ready())) return res.json({ success: true, url: null });   // compras aún sin abrir
    res.json({ success: true, url: await coins.createPackCheckout(req.user.userId, pack, baseUrl(req), req.body.returnTo) });
  } catch (e) { fail(res, e, 'No se pudo abrir el pago. Inténtalo de nuevo.'); }
});

router.post('/unlock', requireAuth, requireNotBanned, limiter(30), async (req, res) => {
  const b = req.body || {};
  if (typeof b.mangaId !== 'string' || !/^[A-Za-z0-9-]{1,20}$/.test(b.mangaId)) return res.status(400).json({ error: 'Obra no válida.' });
  try {
    res.json(await coins.unlock(req.user.userId, b.mangaId, b.chapter, b.expect));
  } catch (e) { fail(res, e, 'No se pudo desbloquear. No se te ha cobrado nada.'); }
});

module.exports = router;
