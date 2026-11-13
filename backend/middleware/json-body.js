// Convierte el cuerpo de las peticiones a JSON, salvo el aviso de Stripe: su
// firma se calcula sobre el texto exacto que llegó, así que esa ruta lo recibe intacto.
const express = require('express');
const RAW_PATHS = new Set(['/api/premium/webhook']);
const json = express.json({ limit: '1mb' }); // las fotos de perfil van como data URL comprimida
module.exports = (req, res, next) => (RAW_PATHS.has(req.path) ? next() : json(req, res, next));
