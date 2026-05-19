// ═══════════════════════════════════════════════════════════════════════════════
// 👁️ KAMI — routes-preview.js
// Vista previa de imágenes subidas (para el composer/comunidad).
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const PREVIEW_DIR = path.join(__dirname, '..', 'public', 'temp', 'preview');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const upload = multer({
  dest: PREVIEW_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|gif)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  },
});

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'preview.html'));
});

router.post('/process', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona una imagen' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const tempId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const filename = `${tempId}${ext}`;
    const destPath = path.join(PREVIEW_DIR, filename);

    fs.renameSync(req.file.path, destPath);

    res.json({
      success: true,
      url: `/temp/preview/${filename}`,
      previewUrl: `/temp/preview/${filename}`,
    });
  } catch (err) {
    console.error('[preview] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Limpiar archivos temporales viejos cada 10 minutos
setInterval(() => {
  try {
    const files = fs.readdirSync(PREVIEW_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(PREVIEW_DIR, f);
      if (fs.statSync(fp).mtimeMs < now - 10 * 60 * 1000) fs.unlinkSync(fp);
    }
  } catch {}
}, 10 * 60 * 1000);

module.exports = router;
