// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — cliente de Stripe y catálogo de planes
//
// Los precios viven aquí, en el servidor. El navegador solo envía la clave del
// plan ('silver_monthly'…); nunca un importe.
//
// Variables de entorno:
//   STRIPE_SECRET_KEY       clave secreta (sk_test_… en pruebas)
//   STRIPE_WEBHOOK_SECRET   secreto del aviso (whsec_…)
//   PUBLIC_URL              opcional: dirección pública para volver tras el pago
// ═══════════════════════════════════════════════════════════════════════════════
const PLANS = {
  silver_monthly: { tier: 'silver', interval: 'month', cents: 399,  lookup: 'kami_silver_monthly', name: 'KamiTales Silver' },
  silver_yearly:  { tier: 'silver', interval: 'year',  cents: 2699, lookup: 'kami_silver_yearly',  name: 'KamiTales Silver' },
  gold_monthly:   { tier: 'gold',   interval: 'month', cents: 699,  lookup: 'kami_gold_monthly',   name: 'KamiTales Gold' },
  gold_yearly:    { tier: 'gold',   interval: 'year',  cents: 4999, lookup: 'kami_gold_yearly',    name: 'KamiTales Gold' },
};
const BY_LOOKUP = Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [p.lookup, { key: k, ...p }]));

let client = null;
function getStripe() {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const Stripe = require('stripe');
  const opts = { maxNetworkRetries: 2, timeout: 15000, appInfo: { name: 'KamiTales' } };
  // Solo pruebas automáticas: un Stripe simulado en esta misma máquina. Con clave real se ignora.
  const fake = process.env.STRIPE_TEST_API;
  if (fake && !isLiveKey() && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(fake)) {
    const u = new URL(fake);
    Object.assign(opts, { host: u.hostname, port: Number(u.port), protocol: 'http', maxNetworkRetries: 0 });
  }
  client = new Stripe(key, opts);
  return client;
}
// Solo para pruebas: sustituir el cliente por uno simulado.
function setStripe(fake) { client = fake; prices = null; }

const isLiveKey = () => /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '');
const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET || '';

// Precio de Stripe de cada plan, buscado por su lookup_key. Se cachea 10 minutos.
let prices = null, pricesAt = 0;
async function priceIdFor(planKey) {
  const plan = PLANS[planKey];
  if (!plan) return null;
  if (!prices || Date.now() - pricesAt > 600_000) {
    const list = await getStripe().prices.list({ lookup_keys: Object.keys(BY_LOOKUP), active: true, limit: 20 });
    prices = {};
    for (const p of list.data) if (p.lookup_key) prices[p.lookup_key] = p.id;
    pricesAt = Date.now();
  }
  return prices[plan.lookup] || null;
}

// ¿A qué plan corresponde un precio de Stripe? Solo se aceptan los nuestros.
function planOfPrice(price) {
  if (!price) return null;
  const p = BY_LOOKUP[price.lookup_key];
  if (p) return p;
  const metaKey = price.metadata && price.metadata.kami_plan;
  return PLANS[metaKey] ? { key: metaKey, ...PLANS[metaKey] } : null;
}

module.exports = { PLANS, BY_LOOKUP, getStripe, setStripe, isLiveKey, webhookSecret, priceIdFor, planOfPrice };
