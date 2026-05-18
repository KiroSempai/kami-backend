const { pool } = require('../../db');

async function processManga() {
  try {
    const today = new Date().toISOString().split('T')[0];

    const stats = await pool.query(`
      SELECT t.manga_id,
             COUNT(*) AS reads,
             COUNT(DISTINCT t.user_id) AS unique_readers,
             COALESCE(SUM((t.metadata->>'minutes')::INTEGER), 0) AS total_minutes,
             COALESCE(AVG(r.rating), 0) AS rating_avg
      FROM user_tracking t
      LEFT JOIN user_ratings r ON r.manga_id = t.manga_id AND r.user_id = t.user_id
      WHERE t.action_type = 'chapter_read' AND t.manga_id IS NOT NULL
        AND t.created_at::date = CURRENT_DATE
      GROUP BY t.manga_id
    `);

    for (const row of stats.rows) {
      await pool.query(`
        INSERT INTO manga_daily_stats (date, manga_id, reads, unique_readers, total_minutes, rating_avg)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (date, manga_id) DO UPDATE SET
          reads = EXCLUDED.reads,
          unique_readers = EXCLUDED.unique_readers,
          total_minutes = EXCLUDED.total_minutes,
          rating_avg = EXCLUDED.rating_avg,
          updated_at = CURRENT_TIMESTAMP
      `, [
        today,
        row.manga_id,
        parseInt(row.reads) || 0,
        parseInt(row.unique_readers) || 0,
        parseInt(row.total_minutes) || 0,
        parseFloat(row.rating_avg) || 0,
      ]);
    }

    console.log('[processor] manga OK —', today, '(' + stats.rows.length + ' mangas)');
  } catch (err) {
    console.error('[processor] manga error:', err.message);
  }
}

module.exports = processManga;
