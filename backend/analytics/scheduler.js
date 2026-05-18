const processGlobal = require('./processors/global');
const processManga = require('./processors/manga');
const processPremium = require('./processors/premium');
const processHeatmap = require('./processors/heatmap');

const INTERVALS = {
  fast: 5 * 60 * 1000,       // 5 min
  medium: 60 * 60 * 1000,    // 1h
  slow: 24 * 60 * 60 * 1000, // 24h
};

function start() {
  console.log('[scheduler] Analytics processors started');

  // ── Cada 5 minutos ──
  setInterval(async () => {
    await Promise.all([
      processGlobal(),
      processManga(),
      processHeatmap(),
    ]);
  }, INTERVALS.fast);

  // ── Cada 1 hora ──
  setInterval(async () => {
    await processPremium();
  }, INTERVALS.medium);

  // ── Cada 24 horas ──
  setInterval(async () => {
    await dailySnapshot();
  }, INTERVALS.slow);

  // Primera ejecución inmediata
  setTimeout(async () => {
    await Promise.all([
      processGlobal(),
      processManga(),
      processHeatmap(),
      processPremium(),
    ]);
    await dailySnapshot();
    console.log('[scheduler] Initial processing complete');
  }, 3000);
}

async function dailySnapshot() {
  const fs = require('fs');
  const path = require('path');
  const { pool } = require('../db');

  const today = new Date().toISOString().split('T')[0];
  const snapDir = path.join(__dirname, 'snapshots');

  try {
    const globalStats = await pool.query('SELECT * FROM global_daily_stats WHERE date = $1', [today]);
    fs.writeFileSync(path.join(snapDir, `snapshot-${today}.json`), JSON.stringify({
      date: today,
      global: globalStats.rows[0] || null,
      createdAt: new Date().toISOString(),
    }, null, 2));
    console.log('[scheduler] Daily snapshot saved —', today);
  } catch (err) {
    console.error('[scheduler] Snapshot error:', err.message);
  }

  // Clean old cache (keep 7 days)
  const cacheDir = path.join(__dirname, 'cache');
  try {
    const files = fs.readdirSync(cacheDir);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    files.forEach(f => {
      const fp = path.join(cacheDir, f);
      if (fs.statSync(fp).mtimeMs < weekAgo) fs.unlinkSync(fp);
    });
  } catch {}
}

module.exports = { start };
