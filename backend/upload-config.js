const multer = require('multer');
const path = require('path');
const fs = require('fs');

const MANGA_ASSETS_DIR = path.join(__dirname, 'public', 'assets', 'manga');
// Subidas a medio procesar: fuera de public/ para que nunca se puedan descargar desde la web
const TEMP_DIR = path.join(__dirname, 'uploads-tmp');

[MANGA_ASSETS_DIR, TEMP_DIR].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
});

const tempStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
});

const upload = multer({
    storage: tempStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /\.(jpg|jpeg|png|webp|gif|avif)$/i;
        cb(null, allowed.test(path.extname(file.originalname)));
    }
});

module.exports = { upload, MANGA_ASSETS_DIR, TEMP_DIR };
