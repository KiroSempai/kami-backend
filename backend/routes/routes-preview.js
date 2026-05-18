const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { processImage, QUALITIES } = require('../image-processor');

const PREVIEW_DIR = path.join(__dirname, '..', 'public', 'temp', 'preview');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const upload = multer({
  dest: PREVIEW_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  },
});

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'preview.html'));
});

router.post('/process', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona una imagen' });

    const tempId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const inputPath = req.file.path;

    const metadata = await sharp(inputPath).metadata();
    const result = await processImage(inputPath, '_preview', tempId, 1);

    // Master path
    const masterSrc = path.join(__dirname, '..', 'public', 'cache', 'enhanced', '_preview', `chapter-${tempId}`, 'page-001_master.webp');
    const masterPreview = path.join(PREVIEW_DIR, `${tempId}_master.webp`);
    if (fs.existsSync(masterSrc)) fs.copyFileSync(masterSrc, masterPreview);

    // Generar versiones derivadas desde master para el preview
    const versions = {};
    const sizes = [
      { key: 'master', width: null, quality: 92 },
      { key: '1080', width: 1080, quality: 85 },
      { key: '720', width: 720, quality: 85 },
      { key: '480', width: 480, quality: 85 },
    ];

    for (const s of sizes) {
      const outPath = path.join(PREVIEW_DIR, `${tempId}_${s.key}.webp`);
      if (s.key === 'master') {
        if (fs.existsSync(masterPreview)) {
          const stat = fs.statSync(masterPreview);
          versions.master = { url: `/temp/preview/${tempId}_master.webp`, size: stat.size };
        }
      } else if (fs.existsSync(masterSrc)) {
        await sharp(masterSrc)
          .resize(s.width, null, { fit: 'inside', withoutEnlargement: true })
          .toFormat('webp', { quality: s.quality })
          .toFile(outPath);
        const stat = fs.statSync(outPath);
        versions[s.key] = { url: `/temp/preview/${tempId}_${s.key}.webp`, size: stat.size };
      }
    }

    res.json({
      success: true,
      original: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        size: req.file.size,
      },
      result,
      versions,
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
