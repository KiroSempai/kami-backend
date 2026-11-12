// ═══════════════════════════════════════════════════════════════════════════════
// KAMI — middleware de sesión y permisos
//
//   requireAuth          401 si no hay token válido; deja el payload en req.user
//   getRole(userId)      rol desde la vista user_with_role ('admin', 'banned', …)
//   requireMangaEditor   403 si el usuario no es admin ni dueño de :id / :mangaId
//
// La propiedad de una obra vive en mangas.created_by (migrate-ownership.sql).
// Mientras esa columna no exista, solo los admin pueden editar o borrar obras.
// ═══════════════════════════════════════════════════════════════════════════════
const { pool } = require('../db');
const { verifyToken } = require('../config');

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

async function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Inicia sesión para hacer esto.' });
  try {
    req.user = await verifyToken(token);
    if (!req.user || !req.user.userId) throw new Error('payload sin userId');
    next();
  } catch {
    return res.status(401).json({ error: 'Tu sesión ha caducado. Vuelve a iniciar sesión.' });
  }
}

async function getRole(userId) {
  const r = await pool.query('SELECT role FROM user_with_role WHERE id = $1', [userId]);
  return r.rows[0]?.role || null;
}

// ¿Existe la columna de propiedad? Se comprueba una vez y se cachea.
let ownershipColumn = null;
async function hasOwnershipColumn() {
  if (ownershipColumn !== null) return ownershipColumn;
  try {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'mangas' AND column_name = 'created_by'"
    );
    ownershipColumn = r.rows.length > 0;
  } catch {
    return false; // sin conexión: no cachear
  }
  return ownershipColumn;
}

async function canEditManga(userId, mangaId) {
  const role = await getRole(userId);
  if (role === 'banned' || !role) return false;
  if (role === 'admin') return true;
  if (!(await hasOwnershipColumn())) return false;
  const r = await pool.query('SELECT created_by FROM mangas WHERE id = $1', [mangaId]);
  return r.rows.length > 0 && r.rows[0].created_by === userId;
}

// Usar detrás de requireAuth.
async function requireMangaEditor(req, res, next) {
  const mangaId = req.params.mangaId || req.params.id;
  try {
    if (await canEditManga(req.user.userId, mangaId)) return next();
    return res.status(403).json({ error: 'Solo el autor de esta obra o un administrador pueden cambiarla.' });
  } catch (e) {
    console.error('[auth] requireMangaEditor:', e.message);
    return res.status(500).json({ error: 'No se pudo comprobar el permiso. Inténtalo de nuevo.' });
  }
}

// Usar detrás de requireAuth: bloquea a usuarios baneados.
async function requireNotBanned(req, res, next) {
  try {
    const role = await getRole(req.user.userId);
    if (!role) return res.status(401).json({ error: 'Tu cuenta no existe. Vuelve a iniciar sesión.' });
    if (role === 'banned') return res.status(403).json({ error: 'Tu cuenta está suspendida.' });
    req.user.role = role;
    next();
  } catch (e) {
    console.error('[auth] requireNotBanned:', e.message);
    return res.status(500).json({ error: 'No se pudo comprobar tu cuenta. Inténtalo de nuevo.' });
  }
}

module.exports = { requireAuth, requireMangaEditor, requireNotBanned, canEditManga, getRole, hasOwnershipColumn };
