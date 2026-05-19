// ═══════════════════════════════════════════════════════════════════════════════
// 👁️ KAMI — routes-preview.js
// Vista previa de imágenes subidas (para el composer/comunidad).
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

let JimpClass = null;
try { const { Jimp } = require('jimp'); JimpClass = Jimp; } catch (e) {}

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

// 🚪 [POST] /api/upload/image — Subir imagen/GIF a Supabase Storage (con compresión Jimp si es foto)
// 👤 Permiso: auth (token)
// 📥 Body: multipart (field: 'image')
// 📤 Respuesta: { success, url, previewUrl }
router.post('/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const isGif = ext === '.gif';
    const tempId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let buffer, contentType;

    if (isGif) {
      // GIF: subir sin compresión para mantener animación
      buffer = fs.readFileSync(req.file.path);
      contentType = 'image/gif';
    } else if (JimpClass) {
      // Imagen: comprimir con Jimp
      const image = await JimpClass.read(req.file.path);
      const MAX = 1080;
      if (image.bitmap.width > MAX || image.bitmap.height > MAX) {
        if (image.bitmap.width > image.bitmap.height) image.resize(MAX, -1);
        else image.resize(-1, MAX);
      }
      buffer = await image.quality(80).getBufferAsync(JimpClass.MIME_JPEG);
      contentType = 'image/jpeg';
    } else {
      // Sin Jimp: subir tal cual
      buffer = fs.readFileSync(req.file.path);
      contentType = req.file.mimetype || 'image/jpeg';
    }

    // Limpiar temp
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    const filename = `${tempId}${isGif ? '.gif' : '.jpg'}`;

    const { error: upErr } = await supabase.storage
      .from('post-images')
      .upload(filename, buffer, { contentType, upsert: false });

    if (upErr) return res.status(500).json({ error: `Supabase: ${upErr.message}` });

    const { data: { publicUrl } } = supabase.storage.from('post-images').getPublicUrl(filename);

    res.json({ success: true, url: publicUrl, previewUrl: publicUrl });
  } catch (err) {
    console.error('[upload] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
