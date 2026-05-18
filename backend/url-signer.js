const crypto = require('crypto');

const SECRET = (process.env.JWT_SECRET || 'kami-signing-key').slice(0, 32);
const DEFAULT_TTL = 30 * 60 * 1000; // 30 min

function signURL(url) {
  const expires = Math.floor((Date.now() + DEFAULT_TTL) / 1000);
  const payload = `${url}|${expires}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 16);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}expires=${expires}&sig=${sig}`;
}

function verifySignedURL(fullUrl) {
  // fullUrl: /api/image/X/Y/Z?quality=1080&expires=123&sig=abc
  const urlObj = new URL(fullUrl, 'http://localhost');
  const expires = urlObj.searchParams.get('expires');
  const sig = urlObj.searchParams.get('sig');
  if (!expires || !sig) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now > parseInt(expires)) return false;

  // Reconstruir la URL original sin expires y sig
  urlObj.searchParams.delete('expires');
  urlObj.searchParams.delete('sig');
  const originalUrl = urlObj.pathname + urlObj.search; // /api/image/X/Y/Z?quality=1080

  const payload = `${originalUrl}|${expires}`;
  const expectedSig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 16);
  return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig));
}

module.exports = { signURL, verifySignedURL };
