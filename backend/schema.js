// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — ¿existe esta columna?
// Permite desplegar el código antes de aplicar una migración sin romper nada.
// Los positivos se cachean para siempre; los negativos se reintentan cada 30 s,
// así una migración aplicada en caliente se detecta sin reiniciar.
// ═══════════════════════════════════════════════════════════════════════════════
const { pool } = require('./db');

const yes = new Set();
const noUntil = new Map();

async function hasColumn(table, column) {
  const key = table + '.' + column;
  if (yes.has(key)) return true;
  if ((noUntil.get(key) || 0) > Date.now()) return false;
  try {
    const r = await pool.query(
      'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
      [table, column]
    );
    if (r.rows.length) { yes.add(key); return true; }
  } catch { /* sin conexión: tratar como ausente */ }
  noUntil.set(key, Date.now() + 30_000);
  return false;
}

module.exports = { hasColumn };
