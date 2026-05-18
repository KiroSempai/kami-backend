// ======================================================
// Backend básico de autenticación con Node.js + Express
// Registro + Login + Verificar si existe usuario/email
// Base de datos: PostgreSQL
// ======================================================

// INSTALAR:
// npm install express bcrypt jsonwebtoken pg dotenv cors

// ======================================================
// ESTRUCTURA SQL
// ======================================================

/*

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

*/

// ======================================================
// server.js
// ======================================================

require('dotenv').config()

const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const cors = require('cors')
const { Pool } = require('pg')

const app = express()

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors())
app.use(express.json())

// ======================================================
// POSTGRESQL
// ======================================================

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
})

// ======================================================
// REGISTRO
// ======================================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body

        // Validaciones básicas
        if (!username || !email || !password) {
            return res.status(400).json({
                error: 'Faltan datos'
            })
        }

        // Verificar si usuario existe
        const existingUser = await pool.query(
            'SELECT * FROM users WHERE username = $1 OR email = $2',
            [username, email]
        )

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                error: 'Usuario o email ya existen'
            })
        }

        // Hashear contraseña
        const hashedPassword = await bcrypt.hash(password, 10)

        // Crear usuario
        const newUser = await pool.query(
            `
            INSERT INTO users (username, email, password)
            VALUES ($1, $2, $3)
            RETURNING id, username, email, created_at
            `,
            [username, email, hashedPassword]
        )

        // Crear token
        const token = jwt.sign(
            {
                id: newUser.rows[0].id
            },
            process.env.JWT_SECRET,
            {
                expiresIn: '30d'
            }
        )

        res.status(201).json({
            message: 'Cuenta creada',
            token,
            user: newUser.rows[0]
        })

    } catch (error) {
        console.error(error)

        res.status(500).json({
            error: 'Error interno'
        })
    }
})

// ======================================================
// LOGIN
// ======================================================

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body

        // Buscar usuario
        const userResult = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        )

        if (userResult.rows.length === 0) {
            return res.status(401).json({
                error: 'Credenciales incorrectas'
            })
        }

        const user = userResult.rows[0]

        // Verificar password
        const validPassword = await bcrypt.compare(
            password,
            user.password
        )

        if (!validPassword) {
            return res.status(401).json({
                error: 'Credenciales incorrectas'
            })
        }

        // Token
        const token = jwt.sign(
            {
                id: user.id
            },
            process.env.JWT_SECRET,
            {
                expiresIn: '30d'
            }
        )

        res.json({
            message: 'Login exitoso',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar
            }
        })

    } catch (error) {
        console.error(error)

        res.status(500).json({
            error: 'Error interno'
        })
    }
})

// ======================================================
// VERIFICAR SI USUARIO EXISTE
// ======================================================

app.get('/api/auth/check-username/:username', async (req, res) => {
    try {
        const { username } = req.params

        const result = await pool.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
        )

        res.json({
            exists: result.rows.length > 0
        })

    } catch (error) {
        console.error(error)

        res.status(500).json({
            error: 'Error interno'
        })
    }
})

// ======================================================
// VERIFICAR SI EMAIL EXISTE
// ======================================================

app.get('/api/auth/check-email/:email', async (req, res) => {
    try {
        const { email } = req.params

        const result = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        )

        res.json({
            exists: result.rows.length > 0
        })

    } catch (error) {
        console.error(error)

        res.status(500).json({
            error: 'Error interno'
        })
    }
})

// ======================================================
// VERIFICAR TOKEN
// ======================================================

app.get('/api/auth/me', async (req, res) => {
    try {

        const authHeader = req.headers.authorization

        if (!authHeader) {
            return res.status(401).json({
                error: 'No autorizado'
            })
        }

        const token = authHeader.split(' ')[1]

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        )

        const userResult = await pool.query(
            `
            SELECT id, username, email, avatar
            FROM users
            WHERE id = $1
            `,
            [decoded.id]
        )

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Usuario no encontrado'
            })
        }

        res.json(userResult.rows[0])

    } catch (error) {
        console.error(error)

        res.status(401).json({
            error: 'Token inválido'
        })
    }
})

// ======================================================
// INICIAR SERVIDOR
// ======================================================

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
    console.log(`Servidor funcionando en puerto ${PORT}`)
})


// ======================================================
// .env
// ======================================================

/*

DB_USER=postgres
DB_HOST=localhost
DB_NAME=manga_app
DB_PASSWORD=tu_password
DB_PORT=5432

JWT_SECRET=SUPER_SECRET_KEY

*/

// ======================================================
// EJEMPLOS FRONTEND
// ======================================================

// REGISTRO

/*

fetch('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        username: 'Carlos',
        email: 'carlos@gmail.com',
        password: '123456'
    })
})

*/

// LOGIN

/*

fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        email: 'carlos@gmail.com',
        password: '123456'
    })
})

*/