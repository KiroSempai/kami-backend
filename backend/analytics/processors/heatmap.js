const { pool } = require('../../db');

async function processHeatmap() {
  try {
    const heatmap = await pool.query(`
      SELECT EXTRACT(DOW FROM created_at) AS day_of_week,
             EXTRACT(HOUR FROM created_at) AS hour,
             COUNT(*) AS total_reads,
             COUNT(DISTINCT user_id) AS unique_users
      FROM user_tracking
      WHERE action_type = 'chapter_read'
        AND created_at >= CURRENT_DATE - 7
      GROUP BY EXTRACT(DOW FROM created_at), EXTRACT(HOUR FROM created_at)
      ORDER BY day_of_week, hour
    `);

    for (const row of heatmap.rows) {
      await pool.query(`
        INSERT INTO reading_heatmap (day_of_week, hour, total_reads, unique_users)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (day_of_week, hour) DO UPDATE SET
          total_reads = EXCLUDED.total_reads,
          unique_users = EXCLUDED.unique_users,
          updated_at = CURRENT_TIMESTAMP
      `, [
        parseInt(row.day_of_week) || 0,
        parseInt(row.hour) || 0,
        parseInt(row.total_reads) || 0,
        parseInt(row.unique_users) || 0,
      ]);
    }

    console.log('[processor] heatmap OK —', heatmap.rows.length, 'cells');
  } catch (err) {
    console.error('[processor] heatmap error:', err.message);
  }
}

module.exports = processHeatmap;
