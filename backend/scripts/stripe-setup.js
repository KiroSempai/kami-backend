// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — crea en Stripe los productos y precios de Premium.
//
//   node scripts/stripe-setup.js
//
// Usa STRIPE_SECRET_KEY de .env. Se puede ejecutar varias veces: no duplica nada
// (busca cada precio por su lookup_key antes de crearlo). Si cambias un importe
// en payments/stripe.js, crea el precio nuevo y le traspasa el lookup_key; el
// antiguo sigue valiendo para quien ya esté suscrito.
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PLANS, getStripe, isLiveKey } = require('../payments/stripe');

(async () => {
  const stripe = getStripe();
  if (!stripe) { console.error('Falta STRIPE_SECRET_KEY en .env'); process.exit(1); }
  console.log('Modo:', isLiveKey() ? 'REAL' : 'pruebas');
  const products = {};
  for (const tier of ['silver', 'gold']) {
    const found = await stripe.products.search({ query: `metadata['kami_tier']:'${tier}' AND active:'true'` }).catch(() => ({ data: [] }));
    products[tier] = found.data[0] || await stripe.products.create({
      name: tier === 'gold' ? 'KamiTales Gold' : 'KamiTales Silver',
      description: tier === 'gold' ? 'Todo lo de Silver, insignia Gold y descuento en adelantos.' : 'Ambientes exclusivos, calidad original e insignia Premium.',
      metadata: { kami_tier: tier },
    });
    console.log('Producto', tier, '→', products[tier].id);
  }
  for (const [key, plan] of Object.entries(PLANS)) {
    const list = await stripe.prices.list({ lookup_keys: [plan.lookup], active: true, limit: 1 });
    const cur = list.data[0];
    if (cur && cur.unit_amount === plan.cents && cur.currency === 'eur' && cur.recurring && cur.recurring.interval === plan.interval) {
      console.log('Precio', key, 'ya existe →', cur.id); continue;
    }
    const price = await stripe.prices.create({
      product: products[plan.tier].id, currency: 'eur', unit_amount: plan.cents,
      recurring: { interval: plan.interval }, lookup_key: plan.lookup, transfer_lookup_key: true,
      tax_behavior: 'inclusive', metadata: { kami_plan: key },
    });
    console.log('Precio', key, 'creado →', price.id, (plan.cents / 100).toFixed(2) + ' €/' + plan.interval);
  }
  console.log('\nListo. Falta activar el portal de cliente en Stripe (Ajustes → Facturación → Portal de clientes)\ny permitir en él cancelar y cambiar entre los cuatro precios.');
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
