require('dotenv').config();
const bcrypt = require('bcryptjs');
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
  const hash = await bcrypt.hash('1234', 10);
  await pool.query("UPDATE users SET password = $1 WHERE email = 'kirouchihaks@gmail.com'", [hash]);
  console.log('Password reset to 1234');
  const r = await pool.query("SELECT email, LEFT(password, 30) AS pw FROM users WHERE email = 'kirouchihaks@gmail.com'");
  console.log('User:', JSON.stringify(r.rows[0]));
  pool.end();
})();
