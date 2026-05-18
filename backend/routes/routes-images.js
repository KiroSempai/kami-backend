// ═══════════════════════════════════════════════════════════════════════════════
// 🖼️ KAMI — routes-images.js
// Procesamiento y firma de URLs de imágenes (covers, avatares).
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pool } = require('../db');
const { verifyToken } = require('../config');
const { getUserQuality } = require('../image-settings');
const { getImagePath } = require('../image-processor');
const { verifySignedURL } = require('../url-signer');

const getRole = require('../getRole');
const PREMIUM_ROLES = ['admin', 'moderator', 'company', 'gold', 'silver'];

// Clave de encriptación (se genera al iniciar el servidor)
const IMAGE_KEY = crypto.randomBytes(32);
const ALGO = 'aes-256-cbc';

// GET /api/image/key — devuelve la clave de descifrado (solo con token válido)
router.get('/key', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Se requiere autenticación' });
  try {
    await verifyToken(token);
    res.json({ key: IMAGE_KEY.toString('base64') });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

// GET /api/image/:mangaId/:chapterNum/:page
router.get('/:mangaId/:chapterNum/:page', async (req, res) => {
  try {
    const { mangaId, chapterNum, page } = req.params;
    const { expires, sig, quality: reqQuality, raw } = req.query;

    // Verificar URL firmada (si tiene parámetros de firma)
    if (expires && sig) {
      if (!verifySignedURL(req.originalUrl)) {
        return res.status(403).json({ error: 'URL expirada o inválida' });
      }
    }

    let quality = reqQuality || '1080';
    let addWatermark = false;

    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = await verifyToken(token);
        quality = await getUserQuality(decoded.userId);
        const r = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
        if (r.rows.length > 0) {
          const role = getRole(r.rows[0]);
          addWatermark = !PREMIUM_ROLES.includes(role);
        }
      } catch {}
    }

    const imagePath = getImagePath(mangaId, chapterNum, page, quality);
    if (!imagePath) return res.status(404).json({ error: 'Imagen no encontrada' });

    // Modo raw: servir imagen directamente (para reader.html con <img> tags)
    if (raw !== undefined) {
      return res.sendFile(imagePath);
    }

    let imgBuffer = fs.readFileSync(imagePath);

    // Aplicar watermark si es necesario
    if (addWatermark) {
      const username = token ? 'user' : 'visitante';
      const svg = Buffer.from(
        `<svg width="300" height="40" xmlns="http://www.w3.org/2000/svg">
          <text x="290" y="35" font-family="Arial,sans-serif" font-size="14" fill="rgba(255,255,255,0.15)" text-anchor="end">${username} · KAMI</text>
        </svg>`
      );
      imgBuffer = await require('sharp')(imgBuffer).composite([{ input: svg, gravity: 'southeast' }]).toBuffer();
    }

    // Encriptar con AES-256-CBC
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGO, IMAGE_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(imgBuffer), cipher.final()]);

    res.json({
      iv: iv.toString('base64'),
      data: encrypted.toString('base64'),
      type: imagePath.endsWith('.png') ? 'png' : 'webp',
    });
  } catch (err) {
    console.error('[routes-images] Error:', err.message);
    res.status(500).json({ error: 'Error al servir imagen' });
  }
});

// GET /api/image/:mangaId/:chapterNum/:page/raw — solo archivo original (sin encriptar, sin auth)
router.get('/:mangaId/:chapterNum/:page/raw', async (req, res) => {
  const { mangaId, chapterNum, page } = req.params;
  const chapterDir = path.join(__dirname, '..', 'public', 'assets', 'manga', mangaId, `chapter-${chapterNum}`);
  const base = path.join(chapterDir, `page-${String(page).padStart(3, '0')}`);
  const exts = ['.jpg', '.jpeg', '.png', '.webp'];
  for (const ext of exts) {
    const file = base + ext;
    if (!file.startsWith(chapterDir)) continue;
    if (fs.existsSync(file)) return res.sendFile(file);
  }
  res.status(404).json({ error: 'Original no encontrado' });
});

module.exports = router;
