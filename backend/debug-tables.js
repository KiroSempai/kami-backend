require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: String(process.env.DB_PASSWORD || ''),
  port: parseInt(process.env.DB_PORT) || 5432,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  try {
    const r = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    console.log('Tables:', r.rows.map(t => t.table_name).join(', '));
    const u = await pool.query("SELECT id, username, email FROM users");
    console.log('Users:', JSON.stringify(u.rows));
  } catch(e) { console.error('Error:', e.message); }
  pool.end();
})();
