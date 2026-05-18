require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');

const pool = new Pool({ user:'postgres', password:'Odie', host:'localhost', database:'manga_app', port:5432 });

pool.query("SELECT id FROM users LIMIT 1").then(r => {
  const token = jwt.sign({ userId: r.rows[0].id }, process.env.JWT_SECRET);
  http.get('http://127.0.0.1:4000/api/feed/for-you?limit=5', { headers: { 'Authorization': 'Bearer ' + token } }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      const j = JSON.parse(d);
      if (j.posts) {
        j.posts.forEach(p => {
          if (p.breakdown) console.log('Post', p.id, 'statusBonus:', p.breakdown.statusBonus, 'score:', p.score);
        });
      }
      pool.end();
    });
  });
}).catch(e => { console.log('Error:', e.message); pool.end(); });
