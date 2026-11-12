// ═══════════════════════════════════════════════════════════════════════════════
// 🔑 KamiTales — routes-password.js
// Restablecer la contraseña de cualquier cuenta con un enlace de un solo uso.
// Montado en /api/auth (junto a login y registro).
//
//   POST /forgot-password        { email }            → siempre la misma respuesta
//   POST /reset-password/check   { token }            → ¿el enlace sigue valiendo?
//   POST /reset-password         { token, password }  → guarda la contraseña nueva
//
// El enlace es un JWT firmado con JWT_SECRET + el hash actual de la contraseña:
// caduca en 1 hora y deja de valer en cuanto la contraseña cambia (un solo uso),
// sin necesidad de guardar nada en la base de datos.
//
// Envío del correo: API de Resend si hay RESEND_API_KEY y MAIL_FROM en el entorno.
// Sin ellas, fuera de producción el enlace se escribe en el registro del servidor.
// ═══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { JWT_SECRET } = require('../config');

const TTL = '1h';
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Has pedido demasiados enlaces. Espera 15 minutos y vuelve a intentarlo.' } });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' } });

const secretFor = (user) => JWT_SECRET + ':' + (user.password || 'sin-contrasena') + ':' + user.id;
function makeToken(user) { return jwt.sign({ sub: user.id, purpose: 'pw-reset' }, secretFor(user), { expiresIn: TTL }); }

// Verifica el enlace: primero lee a quién pertenece (sin fiarse) y luego comprueba la firma con su secreto
async function userFromToken(token) {
  const peek = jwt.decode(String(token || ''));
  if (!peek || peek.purpose !== 'pw-reset' || !peek.sub) return null;
  const r = await pool.query('SELECT id, email, username, password FROM users WHERE id = $1', [peek.sub]);
  const user = r.rows[0]; if (!user) return null;
  try { jwt.verify(token, secretFor(user)); return user; } catch { return null; }
}
function maskEmail(e) {
  const [u, d] = String(e || '').split('@'); if (!d) return '';
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(Math.min(6, u.length - 2))) + '@' + d;
}
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  return proto + '://' + req.headers.host;
}

async function sendResetEmail(to, username, link) {
  const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) {
    if (process.env.NODE_ENV !== 'production') console.log(`\n[contraseña] Enlace para ${to} (válido 1 hora):\n${link}\n`);
    else console.warn('[contraseña] Falta RESEND_API_KEY o MAIL_FROM: no se pudo enviar el correo de restablecimiento.');
    return false;
  }
  const safe = String(username || '').replace(/[<>&"]/g, '');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#17151f">
    <h2 style="margin:0 0 12px">Restablecer tu contraseña</h2>
    <p>Hola${safe ? ' ' + safe : ''}, alguien (esperamos que tú) ha pedido cambiar la contraseña de tu cuenta de KamiTales.</p>
    <p style="margin:24px 0"><a href="${link}" style="background:#c62d55;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">Elegir una contraseña nueva</a></p>
    <p style="color:#4b4860;font-size:14px">El enlace caduca en 1 hora y solo sirve una vez. Si no lo has pedido tú, ignora este correo: tu contraseña no cambiará.</p></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: 'Restablece tu contraseña de KamiTales', html,
      text: `Elige una contraseña nueva para KamiTales (caduca en 1 hora): ${link}\nSi no lo has pedido tú, ignora este correo.` }),
  });
  if (!r.ok) { console.error('[contraseña] Resend respondió', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}

const GENERIC = 'Si existe una cuenta con ese correo, te hemos enviado un enlace para elegir una contraseña nueva. Revisa también la carpeta de spam.';

router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Escribe un correo válido, por ejemplo nombre@correo.com.' });
  try {
    const r = await pool.query('SELECT id, email, username, password FROM users WHERE LOWER(email) = $1', [email]);
    const user = r.rows[0];
    if (user) {
      const link = baseUrl(req) + '/restablecer?token=' + encodeURIComponent(makeToken(user));
      await sendResetEmail(user.email, user.username, link).catch(e => console.error('[contraseña] envío:', e.message));
    }
    // La respuesta es la misma exista o no la cuenta, para no revelar qué correos están registrados
    res.json({ success: true, message: GENERIC });
  } catch (e) {
    console.error('[contraseña] forgot:', e.message);
    res.status(500).json({ error: 'No se pudo procesar la petición. Inténtalo de nuevo en un momento.' });
  }
});

router.post('/reset-password/check', resetLimiter, async (req, res) => {
  try {
    const user = await userFromToken(req.body?.token);
    if (!user) return res.status(400).json({ valid: false, error: 'Este enlace ha caducado o ya se ha usado. Pide uno nuevo.' });
    res.json({ valid: true, email: maskEmail(user.email), username: user.username });
  } catch (e) { res.status(500).json({ valid: false, error: 'No se pudo comprobar el enlace.' }); }
});

router.post('/reset-password', resetLimiter, async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    if (password.length > 200) return res.status(400).json({ error: 'La contraseña es demasiado larga (máximo 200 caracteres).' });
    const user = await userFromToken(req.body?.token);
    if (!user) return res.status(400).json({ error: 'Este enlace ha caducado o ya se ha usado. Pide uno nuevo.' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = $1, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hash, user.id]);
    res.json({ success: true, message: 'Contraseña cambiada. Ya puedes iniciar sesión con ella.' });
  } catch (e) {
    console.error('[contraseña] reset:', e.message);
    res.status(500).json({ error: 'No se pudo guardar la contraseña. Inténtalo de nuevo.' });
  }
});

module.exports = router;
