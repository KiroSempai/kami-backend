// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️ KAMI — community-permissions.js
// Helpers de verificación de permisos dentro de comunidades.
// checkCommunityAdmin: verifica si el usuario es creator/moderator en la comunidad
//   o admin global. checkCommunityPermission: verifica un permiso específico
//   leyendo desde community_role_permissions.
// ═══════════════════════════════════════════════════════════════════════════════

const { pool } = require('./db');

async function checkCommunityAdmin(userId, comId) {
  try {
    const globalCheck = await pool.query("SELECT role FROM user_with_role WHERE id = $1", [userId]);
    if (globalCheck.rows.length > 0 && globalCheck.rows[0].role === 'admin') return true;
    const mem = await pool.query(
      "SELECT role FROM community_members WHERE user_id = $1 AND community_id = $2 AND role IN ('creator', 'moderator')",
      [userId, comId]
    );
    return mem.rows.length > 0;
  } catch (err) {
    console.error("Error en checkCommunityAdmin:", err);
    return false;
  }
}

async function checkCommunityPermission(userId, communityId, requiredPermission) {
  try {
    const globalCheck = await pool.query("SELECT role FROM user_with_role WHERE id = $1", [userId]);
    if (globalCheck.rows.length > 0 && globalCheck.rows[0].role === 'admin') return true;
    const query = `
      SELECT p.${requiredPermission}
      FROM community_members cm
      JOIN community_role_permissions p ON cm.role = p.role
      WHERE cm.user_id = $1 AND cm.community_id = $2
    `;
    const res = await pool.query(query, [userId, communityId]);
    if (res.rows.length === 0) return false;
    return res.rows[0][requiredPermission] === true;
  } catch (err) {
    console.error("Error en checkCommunityPermission:", err);
    return false;
  }
}

module.exports = { checkCommunityAdmin, checkCommunityPermission };
