const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '30d';

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no está definido en el archivo .env');
  process.exit(1);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

async function verifyToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  await checkBlacklist(token);
  return decoded;
}

async function verifyTokenIgnoreExp(token) {
  const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
  await checkBlacklist(token);
  return decoded;
}

async function checkBlacklist(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(
    'SELECT 1 FROM revoked_tokens WHERE token_hash = $1',
    [hash]
  );
  if (result.rows.length > 0) {
    const err = new Error('Token revocado');
    err.name = 'TokenRevokedError';
    throw err;
  }
}

async function revokeToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(decoded.exp * 1000);
    await pool.query(
      'INSERT INTO revoked_tokens (token_hash, expires_at) VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING',
      [hash, expiresAt]
    );
  } catch {
    // Token inválido, no se puede revocar
  }
}

async function cleanExpiredTokens() {
  try {
    const result = await pool.query(
      'DELETE FROM revoked_tokens WHERE expires_at < NOW()'
    );
    if (result.rowCount > 0) {
      console.log(`[cleanup] ${result.rowCount} tokens expirados eliminados de la blacklist`);
    }
  } catch (err) {
    console.error('[cleanup] Error limpiando tokens expirados:', err.message);
  }
}

module.exports = {
  JWT_SECRET,
  signToken,
  verifyToken,
  verifyTokenIgnoreExp,
  revokeToken,
  cleanExpiredTokens,
};
