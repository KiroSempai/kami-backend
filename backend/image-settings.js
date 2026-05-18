const { pool } = require('./db');

// Orden de calidad (de mayor a menor)
const QUALITY_ORDER = ['master', '1080', '720', '480'];

// Calidad máxima según rol
const ROLE_MAX = {
  admin: 'master',
  moderator: 'master',
  company: 'master',
  gold: 'master',
  silver: 'master',
  user: '1080',
  banned: '480',
};

function getAllowedQualities(role) {
  const max = ROLE_MAX[role] || '1080';
  const idx = QUALITY_ORDER.indexOf(max);
  return QUALITY_ORDER.slice(0, idx + 1);
}

function getDefaultQuality(role) {
  const max = ROLE_MAX[role] || '1080';
  return max === 'master' ? 'master' : '1080';
}

async function getUserQuality(userId) {
  try {
    const r = await pool.query('SELECT image_quality, subscription_tier FROM users WHERE id = $1', [userId]);
    if (r.rows.length === 0) return '1080';
    const u = r.rows[0];
    const pref = u.image_quality || '1080';
    const role = u.subscription_tier || 'user';
    const allowed = getAllowedQualities(role);
    return allowed.includes(pref) ? pref : getDefaultQuality(role);
  } catch {
    return '1080';
  }
}

async function setUserQuality(userId, quality) {
  if (!QUALITY_ORDER.includes(quality)) throw new Error('Calidad no válida');
  await pool.query('UPDATE users SET image_quality = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [quality, userId]);
}

module.exports = {
  QUALITY_ORDER,
  getAllowedQualities,
  getDefaultQuality,
  getUserQuality,
  setUserQuality,
};
