require('dotenv').config();
const { Pool } = require('pg');

// Forzamos que la contraseña se lea estrictamente como texto plano
const dbPassword = process.env.DB_PASSWORD ? String(process.env.DB_PASSWORD) : '';

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME,
    password: dbPassword,
    port: parseInt(process.env.DB_PORT) || 5432,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };