const { pool } = require('../../db');

async function processPremium() {
  try {
    const today = new Date().toISOString().split('T')[0];

    const totalPremium = await pool.query("SELECT COUNT(*) AS c FROM users WHERE premium_expires_at > NOW()");
    const newPremium = await pool.query("SELECT COUNT(*) AS c FROM users WHERE premium_expires_at > NOW() AND created_at::date = CURRENT_DATE");
    const expired = await pool.query("SELECT COUNT(*) AS c FROM users WHERE premium_expires_at::date = CURRENT_DATE - 1");
    const byTier = await pool.query("SELECT subscription_tier, COUNT(*) AS count FROM users WHERE premium_expires_at > NOW() GROUP BY subscription_tier");

    const silver = parseInt((byTier.rows.find(r => r.subscription_tier === 'silver') || {}).count || 0);
    const gold = parseInt((byTier.rows.find(r => r.subscription_tier === 'gold') || {}).count || 0);

    await pool.query(`
      INSERT INTO premium_daily_stats (date, total_premium, new_premium, expired_premium, silver_count, gold_count)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (date) DO UPDATE SET
        total_premium = EXCLUDED.total_premium,
        new_premium = EXCLUDED.new_premium,
        expired_premium = EXCLUDED.expired_premium,
        silver_count = EXCLUDED.silver_count,
        gold_count = EXCLUDED.gold_count,
        updated_at = CURRENT_TIMESTAMP
    `, [
      today,
      parseInt(totalPremium.rows[0].c) || 0,
      parseInt(newPremium.rows[0].c) || 0,
      parseInt(expired.rows[0].c) || 0,
      silver,
      gold,
    ]);

    console.log('[processor] premium OK —', today);
  } catch (err) {
    console.error('[processor] premium error:', err.message);
  }
}

module.exports = processPremium;
