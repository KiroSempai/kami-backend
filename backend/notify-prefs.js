// ═══════════════════════════════════════════════════════════════════════════════
// 🔔 KamiTales — notify-prefs.js
// ¿Quiere esta persona recibir este tipo de aviso? Lee users.notification_prefs
// (migrate-user-settings.sql). Sin la migración, o si falla la consulta, todo
// cuenta como activado. Caché de 30 s por usuario.
// ═══════════════════════════════════════════════════════════════════════════════
const { pool } = require('./db');
const { hasColumn } = require('./schema');

const KEYS = ['likes', 'reposts', 'replies', 'follows', 'messages'];
const cache = new Map();

async function getPrefs(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < 30000) return hit.prefs;
  let prefs = {};
  try {
    if (await hasColumn('users', 'notification_prefs')) {
      const r = await pool.query('SELECT notification_prefs FROM users WHERE id = $1', [userId]);
      prefs = (r.rows[0] && r.rows[0].notification_prefs) || {};
    }
  } catch { prefs = {}; }
  const out = {};
  KEYS.forEach(k => { out[k] = prefs[k] !== false; });
  cache.set(userId, { prefs: out, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return out;
}

async function wants(userId, key) {
  if (!userId || !KEYS.includes(key)) return true;
  return (await getPrefs(userId))[key];
}

function forget(userId) { cache.delete(userId); }

module.exports = { KEYS, getPrefs, wants, forget };
