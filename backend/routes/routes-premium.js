/**
 * KAMI — routes-premium.js
 * ESQUELETO para sistema de suscripción Silver/Gold.
 * Pendiente de conectar con Stripe/PayPal/Mercado Pago.
 *
 * Planes:
 *   silver_monthly  → 3,99€/mes
 *   silver_yearly   → 26,99€/año
 *   gold_monthly    → 6,99€/mes
 *   gold_yearly     → 49,99€/año
 *
 * Endpoints:
 *   POST /api/premium/create-checkout  → Crear sesión de pago (placeholder)
 *   POST /api/premium/webhook          → Recibir confirmación del provider (placeholder)
 *   GET  /api/premium/status           → Consultar suscripción activa
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../config');

const VALID_PLANS = ['silver_monthly', 'silver_yearly', 'gold_monthly', 'gold_yearly'];

// ── Auth middleware ──────────────────────────────
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = await verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// ══════════════════════════════════════════════════
// POST /api/premium/create-checkout
// ══════════════════════════════════════════════════
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido. Usa: silver_monthly, silver_yearly, gold_monthly, gold_yearly' });
    }

    // ── TODO: Integrar con proveedor de pagos ──
    // const session = await stripe.checkout.sessions.create({
    //   customer_email: req.user.email,
    //   mode: 'subscription',
    //   line_items: [{ price: PRICES[plan], quantity: 1 }],
    //   success_url: `${BASE_URL}/premium/success?session_id={CHECKOUT_SESSION_ID}&tier=${plan.split('_')[0]}`,
    //   cancel_url: `${BASE_URL}/premium`,
    //   metadata: { userId: req.user.userId, tier: plan.split('_')[0] },
    // });
    // return res.json({ url: session.url });

    res.json({
      success: true,
      message: `Checkout para ${plan} creado (placeholder)`,
      url: null,
    });

  } catch (err) {
    console.error('Error en create-checkout:', err);
    res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
});

// ══════════════════════════════════════════════════
// POST /api/premium/webhook
// ══════════════════════════════════════════════════
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'] || req.headers['x-webhook-signature'];

    // ── TODO: Validar firma + activar suscripción ──
    // const event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    // if (event.type === 'checkout.session.completed') {
    //   const session = event.data.object;
    //   const userId = session.metadata.userId;
    //   const tier = session.metadata.tier; // 'silver' | 'gold'
    //   const isYearly = session.mode === 'subscription' && session.amount_total > 10000;
    //   await activateSubscription(userId, tier, isYearly);
    // }

    res.json({ received: true });

  } catch (err) {
    console.error('Error en webhook:', err);
    res.status(400).json({ error: 'Firma inválida' });
  }
});

// ══════════════════════════════════════════════════
// GET /api/premium/status
// ══════════════════════════════════════════════════
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT premium_expires_at, subscription_tier,
              CASE
                WHEN premium_expires_at > NOW() THEN 'active'
                WHEN premium_expires_at IS NOT NULL THEN 'expired'
                ELSE 'none'
              END AS premium_status,
              CASE
                WHEN premium_expires_at > NOW()
                  THEN EXTRACT(EPOCH FROM premium_expires_at - NOW())::INTEGER
                ELSE 0
              END AS seconds_remaining
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const row = result.rows[0];
    res.json({
      premiumStatus: row.premium_status,
      subscriptionTier: row.subscription_tier,
      expiresAt: row.premium_expires_at,
      daysRemaining: row.premium_status === 'active'
        ? Math.floor(row.seconds_remaining / 86400)
        : 0,
      secondsRemaining: row.seconds_remaining,
    });

  } catch (err) {
    console.error('Error en premium/status:', err);
    res.status(500).json({ error: 'Error al consultar estado' });
  }
});

// ══════════════════════════════════════════════════
// (Interno) Activar suscripción — llamado por webhook
// ══════════════════════════════════════════════════
async function activateSubscription(userId, tier, isYearly) {
  const duration = isYearly ? '1 year' : '30 days';
  await pool.query(
    `UPDATE users SET
       subscription_tier = $1,
       premium_expires_at = CASE
         WHEN premium_expires_at IS NULL OR premium_expires_at < NOW()
           THEN NOW() + INTERVAL '${duration}'
         ELSE premium_expires_at + INTERVAL '${duration}'
       END
     WHERE id = $2`,
    [tier, userId]
  );
}

module.exports = router;
