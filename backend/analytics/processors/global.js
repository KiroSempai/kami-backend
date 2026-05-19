const { pool } = require('../../db');
const path = require('path');
const fs = require('fs');
const CACHE_DIR = path.join(__dirname, '..', 'cache');

async function processGlobal() {
  try {
    const today = new Date().toISOString().split('T')[0];

    const totalUsers = await pool.query('SELECT COUNT(*) AS c FROM users');
    const activeUsers = await pool.query("SELECT COUNT(DISTINCT user_id) AS c FROM user_daily_activity WHERE activity_date = CURRENT_DATE");
    const newUsers = await pool.query("SELECT COUNT(*) AS c FROM users WHERE created_at::date = CURRENT_DATE");
    const premiumUsers = await pool.query("SELECT COUNT(*) AS c FROM users WHERE premium_expires_at > NOW()");
    const totalActions = await pool.query("SELECT COUNT(*) AS c FROM user_tracking WHERE created_at::date = CURRENT_DATE");
    const totalReads = await pool.query("SELECT COUNT(*) AS c FROM user_tracking WHERE action_type = 'chapter_read' AND created_at::date = CURRENT_DATE");

    const rows = await pool.query("SELECT COALESCE(AVG(daily.c), 0) AS avg FROM (SELECT COUNT(*) AS c FROM user_tracking WHERE action_type = 'chapter_read' AND created_at::date = CURRENT_DATE GROUP BY user_id) daily");
    const avgChapters = parseFloat(rows.rows[0].avg) || 0;

    await pool.query(`
      INSERT INTO global_daily_stats (date, total_users, active_users, new_users, premium_users, total_actions, total_reads, avg_chapters_per_user)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (date) DO UPDATE SET
        total_users = EXCLUDED.total_users,
        active_users = EXCLUDED.active_users,
        new_users = EXCLUDED.new_users,
        premium_users = EXCLUDED.premium_users,
        total_actions = EXCLUDED.total_actions,
        total_reads = EXCLUDED.total_reads,
        avg_chapters_per_user = EXCLUDED.avg_chapters_per_user,
        updated_at = CURRENT_TIMESTAMP
    `, [
      today,
      parseInt(totalUsers.rows[0].c) || 0,
      parseInt(activeUsers.rows[0].c) || 0,
      parseInt(newUsers.rows[0].c) || 0,
      parseInt(premiumUsers.rows[0].c) || 0,
      parseInt(totalActions.rows[0].c) || 0,
      parseInt(totalReads.rows[0].c) || 0,
      avgChapters,
    ]);

    // Cache vivo
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, 'live.json'), JSON.stringify({
      totalUsers: parseInt(totalUsers.rows[0].c) || 0,
      activeUsers: parseInt(activeUsers.rows[0].c) || 0,
      actionsToday: parseInt(totalActions.rows[0].c) || 0,
      readsToday: parseInt(totalReads.rows[0].c) || 0,
      updatedAt: new Date().toISOString(),
    }));

    console.log('[processor] global OK —', today);
  } catch (err) {
    console.error('[processor] global error:', err.message);
  }
}

module.exports = processGlobal;
