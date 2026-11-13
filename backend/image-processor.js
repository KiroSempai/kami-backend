const path = require('path');
const fs = require('fs');

const ENHANCED_DIR = path.join(__dirname, 'public', 'cache', 'enhanced');

const QUALITIES = {
  master: { label: 'Master (2x)', width: null },
  1080:   { label: 'Alta 1080px', width: 1080 },
  720:    { label: 'Normal 720px', width: 720 },
  480:    { label: 'Eco 480px', width: 480 },
};

const QUALITY_ORDER = ['master', '1080', '720', '480'];

function getOutputDir(mangaId, chapterNum) {
  return path.join(ENHANCED_DIR, mangaId, `chapter-${chapterNum}`);
}

function pageFilename(pageNum, suffix) {
  return `page-${String(pageNum).padStart(3, '0')}_${suffix}.webp`;
}

// ── Subida: solo guarda master ──

async function processImage(inputPath, mangaId, chapterNum, pageNum) {
  const outDir = getOutputDir(mangaId, chapterNum);
  fs.mkdirSync(outDir, { recursive: true });

  const metadata = await require("sharp")(inputPath).metadata();
  const origW = metadata.width || 800;
  const origH = metadata.height || 1200;
  const masterW = Math.round(origW * 2);
  const masterH = Math.round(origH * 2);

  const masterBuf = await upscaleImage(inputPath, masterW, masterH);
  const masterPath = path.join(outDir, pageFilename(pageNum, 'master'));
  await require("sharp")(masterBuf).toFormat('webp', { quality: 92 }).toFile(masterPath);

  return {
    original: { width: origW, height: origH },
    master: { width: masterW, height: masterH },
  };
}

// ── Servir: redimensiona desde master en caliente si es necesario ──

function getImagePath(mangaId, chapterNum, pageNum, quality) {
  if (!QUALITIES[quality]) quality = '1080';
  const outDir = getOutputDir(mangaId, chapterNum);
  const masterPath = path.join(outDir, pageFilename(pageNum, 'master'));

  // Master directo
  if (quality === 'master' && fs.existsSync(masterPath)) return masterPath;

  // Resolución derivada — generarla desde master si no existe
  const q = QUALITIES[quality];
  const targetPath = path.join(outDir, pageFilename(pageNum, quality));

  if (!fs.existsSync(targetPath)) {
    if (!fs.existsSync(masterPath)) return fallbackOriginal(mangaId, chapterNum, pageNum);
    // Generar on-the-fly (no await — primera vez lento, siguientes instantáneo)
    require("sharp")(masterPath)
      .resize(q.width, null, { fit: 'inside', withoutEnlargement: true })
      .toFormat('webp', { quality: 85 })
      .toFile(targetPath)
      .catch(() => {});
  }

  // Si el archivo ya existe o se está generando, devolver master como fallback inmediato
  return fs.existsSync(targetPath) ? targetPath : masterPath;
}

// Igual que getImagePath, pero si la calidad pedida aún no existe la genera y espera,
// en vez de entregar el master (que es la calidad Premium) mientras tanto.
async function getImagePathReady(mangaId, chapterNum, pageNum, quality) {
  if (!QUALITIES[quality]) quality = '1080';
  const outDir = getOutputDir(mangaId, chapterNum);
  const masterPath = path.join(outDir, pageFilename(pageNum, 'master'));
  if (!fs.existsSync(masterPath)) return fallbackOriginal(mangaId, chapterNum, pageNum);
  if (quality === 'master') return masterPath;
  const targetPath = path.join(outDir, pageFilename(pageNum, quality));
  if (fs.existsSync(targetPath)) return targetPath;
  const tmp = targetPath + '.' + process.pid + '.' + Date.now() + '.tmp';
  await require('sharp')(masterPath)
    .resize(QUALITIES[quality].width, null, { fit: 'inside', withoutEnlargement: true })
    .toFormat('webp', { quality: 85 })
    .toFile(tmp);
  try { fs.renameSync(tmp, targetPath); } catch { try { fs.unlinkSync(tmp); } catch { /* nada */ } }
  return fs.existsSync(targetPath) ? targetPath : null;
}

function fallbackOriginal(mangaId, chapterNum, pageNum) {
  const chapterDir = path.join(__dirname, 'public', 'assets', 'manga', mangaId, `chapter-${chapterNum}`);
  const base = path.join(chapterDir, `page-${String(pageNum).padStart(3, '0')}`);
  const exts = ['.jpg', '.jpeg', '.png', '.webp'];
  for (const ext of exts) {
    const p = base + ext;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Background batch ──

// Versión de cada capítulo: al editar o borrar se incrementa, y un procesado anterior que siga
// en marcha deja de escribir (si no, colaría imágenes viejas en la caché recién limpiada).
const generations = {};
function bumpGeneration(mangaId, chapterNum) {
  const k = mangaId + '/' + chapterNum;
  generations[k] = (generations[k] || 0) + 1;
}

async function processChapterImages(chapterDir, mangaId, chapterNum) {
  const k = mangaId + '/' + chapterNum, gen = generations[k] || 0;
  const files = fs.readdirSync(chapterDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  for (const file of files) {
    if ((generations[k] || 0) !== gen) return;          // el capítulo cambió: este procesado ya no vale
    const match = file.match(/page-(\d+)/);
    if (!match) continue;
    const pageNum = parseInt(match[1]);
    try {
      await processImage(path.join(chapterDir, file), mangaId, chapterNum, pageNum);
      if ((generations[k] || 0) !== gen) {                // cambió mientras se procesaba: se descarta
        try { fs.unlinkSync(path.join(getOutputDir(mangaId, chapterNum), pageFilename(pageNum, 'master'))); } catch { /* nada */ }
        return;
      }
    } catch (err) {
      console.error(`[image-processor] Error en ${file}:`, err.message);
    }
  }
}

// ── IA upscale con fallback ──

async function upscaleImage(inputPath, targetW, targetH) {
  try {
    const upscaler = require('upscaler');
    const model = require('@upscalerjs/esrgan-slim');
    const u = new upscaler({ model });
    const buffer = await fs.promises.readFile(inputPath);
    const result = await u.upscale(buffer, { output: 'buffer' });
    return result;
  } catch {
    return await require("sharp")(inputPath)
      .resize(targetW, targetH, { kernel: require("sharp").kernel.lanczos3, fit: 'fill' })
      .toBuffer();
  }
}

module.exports = {
  processImage,
  processChapterImages,
  getImagePath,
  getImagePathReady,
  getOutputDir,
  bumpGeneration,
  QUALITIES,
  QUALITY_ORDER,
};
