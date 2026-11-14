/**
 * KamiTales — routes-premium.js
 * Suscripciones Silver y Gold con Stripe.
 *
 *   POST /api/premium/create-checkout  → abre el pago (o el portal si ya hay suscripción)
 *   POST /api/premium/portal           → portal de Stripe: cancelar, cambiar de plan o de tarjeta
 *   POST /api/premium/webhook          → aviso firmado de Stripe; lo único que activa Premium
 *   GET  /api/premium/status           → plan del usuario
 *
 * Mientras falten las claves de Stripe o la migración (migrate-payments.sql),
 * create-checkout responde { url: null } y la página muestra «Muy pronto».
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAuth, getRole } = require('../middleware/auth');
const S = require('../payments/stripe');
const subs = require('../payments/subscriptions');

// Dirección a la que Stripe devuelve al usuario. PUBLIC_URL manda si está definida.
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}

const payLimiter = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'pay:' + (req.user ? req.user.userId : 'anon'),
  message: { error: 'Demasiados intentos. Espera un minuto y vuelve a probar.' },
});

function fail(res, err, fallback) {
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err && err.status === 503) return res.status(503).json({ error: err.message });
  console.error('[pagos]', fallback, '—', (err && err.type) || '', err && err.message);
  return res.status(502).json({ error: fallback });
}

router.post('/create-checkout', requireAuth, payLimiter, async (req, res) => {
  const plan = req.body && req.body.plan;
  if (typeof plan !== 'string' || !Object.prototype.hasOwnProperty.call(S.PLANS, plan)) return res.status(400).json({ error: 'Plan no válido.' });
  try {
    if (!(await subs.ready())) return res.json({ success: true, url: null }); // pagos aún sin abrir
    const out = await subs.createCheckout(req.user.userId, plan, baseUrl(req));
    res.json({ success: true, url: out.url, portal: out.portal });
  } catch (err) { fail(res, err, 'No se pudo abrir el pago. Inténtalo de nuevo.'); }
});

router.post('/portal', requireAuth, payLimiter, async (req, res) => {
  try {
    if (!(await subs.ready())) return res.json({ success: true, url: null });
    res.json({ success: true, url: await subs.createPortal(req.user.userId, baseUrl(req)) });
  } catch (err) { fail(res, err, 'No se pudo abrir la gestión de tu plan.'); }
});

// El cuerpo llega sin tocar (server.js no lo convierte a JSON en esta ruta):
// la firma de Stripe se calcula sobre el texto exacto.
router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const stripe = S.getStripe(), secret = S.webhookSecret();
  if (!stripe || !secret) return res.status(503).json({ error: 'Pagos sin configurar' });
  let event;
  try {
    if (!Buffer.isBuffer(req.body)) throw new Error('cuerpo ya interpretado');
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] || '', secret);
  } catch (err) {
    return res.status(400).json({ error: 'Firma no válida' });
  }
  // Un aviso de pruebas nunca toca una instalación con clave real, ni al revés.
  if (!!event.livemode !== S.isLiveKey()) return res.json({ received: true, ignored: 'modo distinto' });
  try {
    if (!(await subs.ready())) return res.status(503).json({ error: 'Falta la migración de pagos' });
    const result = await subs.processEvent(event);
    res.json({ received: true, result });
  } catch (err) {
    console.error('[pagos] aviso', event.id, event.type, 'falló:', err.message);
    res.status(500).json({ error: 'No se pudo procesar; se reintentará' }); // Stripe lo reenvía
  }
});

// Solo administración: comprueba que monedas, ventas y repartos cuadran
router.get('/admin/reconcile', requireAuth, async (req, res) => {
  try {
    if ((await getRole(req.user.userId)) !== 'admin') return res.status(403).json({ error: 'Solo para administración.' });
    res.json(await require('../payments/earnings').reconcile());
  } catch (err) {
    console.error('[pagos] conciliación:', err.message);
    res.status(500).json({ error: 'No se pudo comprobar.' });
  }
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const st = await subs.statusOf(req.user.userId);
    if (!st) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(st);
  } catch (err) {
    console.error('Error en premium/status:', err.message);
    res.status(500).json({ error: 'Error al consultar estado' });
  }
});

module.exports = router;
