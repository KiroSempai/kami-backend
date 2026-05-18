require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({
  user: process.env.DB_USER, host: process.env.DB_HOST,
  database: process.env.DB_NAME, password: String(process.env.DB_PASSWORD),
  port: parseInt(process.env.DB_PORT) || 5432, ssl: { rejectUnauthorized: false },
});
(async () => {
  // Fix sequence for chapters table
  const mangaId = "KMI-0000001";
  
  // Check max id and sequence
  let r = await pool.query("SELECT MAX(id) FROM chapters");
  const maxId = parseInt(r.rows[0].max) || 0;
  console.log("Max id:", maxId);
  
  // Reset sequence
  await pool.query("SELECT setval('chapters_id_seq', $1, true)", [maxId]);
  console.log("Sequence reset to", maxId);
  
  // Now try inserts
  const chapters = [
    { number: 2, title: "Cap\u00edtulo 2", pages: 30 },
    { number: 3, title: "Cap\u00edtulo 3", pages: 36 },
  ];
  
  for (const ch of chapters) {
    try {
      await pool.query(
        "INSERT INTO chapters (manga_id, chapter_number, title, pages, scan_group, release_date) VALUES ($1, $2, $3, $4, '', CURRENT_TIMESTAMP)",
        [mangaId, ch.number, ch.title, ch.pages]
      );
      console.log("Inserted chapter", ch.number);
    } catch (e) {
      console.error("Failed to insert chapter", ch.number + ":", e.message);
    }
  }
  
  // Update total_chapters and chapters JSON array
  let cnt = await pool.query("SELECT COUNT(*) FROM chapters WHERE manga_id = $1", [mangaId]);
  const total = parseInt(cnt.rows[0].count);
  let chs = await pool.query("SELECT chapter_number, title, pages FROM chapters WHERE manga_id = $1 ORDER BY chapter_number", [mangaId]);
  const chaptersArr = chs.rows.map(c => ({
    number: c.chapter_number,
    title: c.title,
    pages: c.pages,
  }));
  await pool.query(
    "UPDATE mangas SET total_chapters = $1, chapters = $2::jsonb, updated_at = NOW() WHERE id = $3",
    [total, JSON.stringify(chaptersArr), mangaId]
  );
  console.log("Updated total_chapters to", cnt.rows[0].count);
  
  await pool.end();
})().catch(e => console.error("Error:", e.message));
