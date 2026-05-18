require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

(async () => {
  try {
    // 1. Banner column for users
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT DEFAULT ''");
    console.log('OK: banner column added');

    // 1b. Profile editor columns
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_genres TEXT[] DEFAULT '{}'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS emoji TEXT DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT DEFAULT ''");
    console.log('OK: favorite_genres, emoji, country columns added');

    // 1c. Role system columns
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMP");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS reputation_score INTEGER DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS company_verified BOOLEAN DEFAULT FALSE");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) DEFAULT NULL");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip VARCHAR(45) DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS image_quality VARCHAR(10) DEFAULT '1080'");
    console.log('OK: role system columns added (premium_expires_at, reputation_score, company_verified, is_banned, is_admin, subscription_tier, last_ip, password_changed_at, image_quality)');

    // 2. Create mangas table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mangas (
          id VARCHAR(20) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          alternative_titles TEXT[] DEFAULT '{}',
          cover TEXT DEFAULT '',
          description TEXT DEFAULT '',
          type VARCHAR(20) NOT NULL CHECK (type IN ('manga', 'manhwa', 'manhua', 'oneshot')),
          status VARCHAR(20) NOT NULL CHECK (status IN ('ongoing', 'completed', 'hiatus', 'cancelled')),
          genres TEXT[] DEFAULT '{}',
          demographic_target VARCHAR(30) DEFAULT '',
          author VARCHAR(255) DEFAULT '',
          artist VARCHAR(255) DEFAULT '',
          total_chapters INTEGER DEFAULT 0,
          is_oneshot BOOLEAN DEFAULT FALSE,
          rating NUMERIC(3,1) DEFAULT 0,
          total_ratings INTEGER DEFAULT 0,
          total_reads INTEGER DEFAULT 0,
          chapters JSONB DEFAULT '[]',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: mangas table created');

    // Create indexes
    await pool.query('CREATE INDEX IF NOT EXISTS idx_mangas_type ON mangas(type)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_mangas_status ON mangas(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_mangas_genres ON mangas USING GIN(genres)');
    console.log('OK: mangas indexes created');

    // 3. Add social_links column to mangas
    await pool.query("ALTER TABLE mangas ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}'");
    console.log('OK: social_links column added to mangas');

    // 4. Create chapters table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chapters (
          id SERIAL PRIMARY KEY,
          manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
          chapter_number INTEGER NOT NULL,
          title TEXT DEFAULT '',
          pages INTEGER DEFAULT 0,
          scan_group TEXT DEFAULT '',
          release_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(manga_id, chapter_number)
      )
    `);
    console.log('OK: chapters table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_chapters_manga_id ON chapters(manga_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_chapters_number ON chapters(manga_id, chapter_number)');
    console.log('OK: chapters indexes created');

    // 5. Create user_ratings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_ratings (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
          rating NUMERIC(2,1) NOT NULL CHECK (rating >= 0.5 AND rating <= 10.0),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, manga_id)
      )
    `);
    console.log('OK: user_ratings table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_ratings_manga ON user_ratings(manga_id)');
    console.log('OK: user_ratings indexes created');

    // 6. Create user_reading table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_reading (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
          last_chapter INTEGER DEFAULT 0,
          last_page INTEGER DEFAULT 0,
          total_pages_read INTEGER DEFAULT 0,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, manga_id)
      )
    `);
    console.log('OK: user_reading table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_reading_user ON user_reading(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_reading_manga ON user_reading(manga_id)');
    console.log('OK: user_reading indexes created');

    // 7. Create user_manga_library table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_manga_library (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
          status VARCHAR(50) NOT NULL DEFAULT 'planned',
          is_favorite BOOLEAN DEFAULT FALSE,
          score INTEGER DEFAULT 0,
          progress INTEGER DEFAULT 0,
          notes TEXT DEFAULT '',
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, manga_id)
      )
    `);
    console.log('OK: user_manga_library table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_library_user ON user_manga_library(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_library_status ON user_manga_library(user_id, status)');
    console.log('OK: user_manga_library indexes created');

    // 8b. Create banned_ips table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS banned_ips (
          id SERIAL PRIMARY KEY,
          ip_address VARCHAR(45) NOT NULL UNIQUE,
          user_id VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL,
          reason TEXT DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: banned_ips table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_banned_ips_addr ON banned_ips(ip_address)');
    console.log('OK: banned_ips index created');

    // 9. Create notifications table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type VARCHAR(50) NOT NULL DEFAULT 'info',
          title VARCHAR(255) NOT NULL DEFAULT '',
          message TEXT DEFAULT '',
          is_read BOOLEAN DEFAULT FALSE,
          link TEXT DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: notifications table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read)');
    console.log('OK: notifications index created');

    // 10. Create moderation_logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS moderation_logs (
          id SERIAL PRIMARY KEY,
          target_user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          moderator_user_id VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL,
          action_type VARCHAR(50) NOT NULL,
          reason TEXT DEFAULT '',
          duration_seconds BIGINT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: moderation_logs table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_mod_target ON moderation_logs(target_user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_mod_moderator ON moderation_logs(moderator_user_id)');
    console.log('OK: moderation_logs indexes created');

    // 11. Add user columns for strikes and mute
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS strikes INTEGER DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP DEFAULT NULL");
    console.log('OK: user moderation columns added (strikes, muted_until)');

    // 12. Create message_threads table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_threads (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          assigned_moderator_id VARCHAR(60) REFERENCES users(id) ON DELETE SET NULL,
          subject VARCHAR(255) NOT NULL DEFAULT '',
          status VARCHAR(50) NOT NULL DEFAULT 'open',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: message_threads table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_threads_user ON message_threads(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_threads_mod ON message_threads(assigned_moderator_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_threads_status ON message_threads(status)');
    console.log('OK: message_threads indexes created');

    // 13. Create messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
          sender_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message TEXT NOT NULL DEFAULT '',
          is_read BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: messages table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(thread_id, is_read)');
    await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_staff BOOLEAN DEFAULT FALSE");
    console.log('OK: messages.is_staff column added');

    // 5. Seed initial manga data if table is empty
    const count = await pool.query('SELECT COUNT(*) FROM mangas');
    if (parseInt(count.rows[0].count) === 0) {
      const seedData = [
        { id: 'KMI-0000001', title: 'Berserk', alt: ['ベルセルク', 'Berserk: The Prototype'], desc: 'La historia de Guts, un mercenario solitario y espadachín que ha nacido de la matriz de su madre muerta. Tras un encuentro con el carismático Griffith y los Halcones de la Banda, Guts se une al grupo como guerrero de élite.', type: 'manga', status: 'ongoing', genres: ['Acción', 'Aventura', 'Dark Fantasy', 'Horror', 'Seinen'], demo: 'seinen', author: 'Kentaro Miura', artist: 'Kentaro Miura', chapters: 374, rating: 9.8, ratings: 184200, reads: 4200000 },
        { id: 'KMI-0000002', title: 'Kingdom', alt: ['キングダム'], desc: 'En la época de los Reinos Combatientes de China, Xin, un joven huérfano de guerra, sueña con convertirse en el mejor general bajo el cielo.', type: 'manga', status: 'ongoing', genres: ['Acción', 'Aventura', 'Historia', 'Militar', 'Seinen'], demo: 'seinen', author: 'Yasuhisa Hara', artist: 'Yasuhisa Hara', chapters: 1058, rating: 9.4, ratings: 98400, reads: 3100000 },
        { id: 'KMI-0000003', title: 'Vagabond', alt: ['バガボンド'], desc: 'Basado en la novela Musashi de Eiji Yoshikawa. Sigue a Miyamoto Musashi, el más grande espadachín de Japón, en su búsqueda de la perfección y de ser invencible bajo el cielo.', type: 'manga', status: 'completed', genres: ['Acción', 'Artes Marciales', 'Drama', 'Historia', 'Seinen'], demo: 'seinen', author: 'Takehiko Inoue', artist: 'Takehiko Inoue', chapters: 327, rating: 9.5, ratings: 76300, reads: 2800000 },
        { id: 'KMI-0000004', title: 'Vinland Saga', alt: ['ヴィンランド・サガ'], desc: 'Thorfinn, hijo de un legendario guerrero vikingo, jura vengarse del mercenario Askeladd, quien asesinó a su padre. Una épica de vikingos, honor y redención.', type: 'manga', status: 'ongoing', genres: ['Acción', 'Aventura', 'Drama', 'Historia', 'Seinen'], demo: 'seinen', author: 'Makoto Yukimura', artist: 'Makoto Yukimura', chapters: 207, rating: 9.3, ratings: 61200, reads: 2100000 },
        { id: 'KMI-0000005', title: 'Solo Leveling', alt: ['나 혼자만 레벨업', 'Only I Level Up'], desc: 'En un mundo donde los cazadores con poderes mágicos luchan contra monstruos, Sung Jinwoo es el cazador más débil de la humanidad. Todo cambia cuando queda atrapado en una mazmorra de doble capa.', type: 'manhwa', status: 'completed', genres: ['Acción', 'Aventura', 'Fantasía', 'Sistema'], demo: 'shonen', author: 'Chugong', artist: 'DUBU (Redice Studio)', chapters: 179, rating: 9.2, ratings: 210000, reads: 5800000 },
        { id: 'KMI-0000006', title: 'Fullmetal Alchemist', alt: ['鋼の錬金術師', 'FMA'], desc: 'Los hermanos Edward y Alphonse Elric buscan la Piedra Filosofal para restaurar sus cuerpos tras una alquimia prohibida. Una aventura épica de ciencia, magia y humanidad.', type: 'manga', status: 'completed', genres: ['Acción', 'Aventura', 'Drama', 'Fantasía', 'Shonen'], demo: 'shonen', author: 'Hiromu Arakawa', artist: 'Hiromu Arakawa', chapters: 108, rating: 9.7, ratings: 142800, reads: 4600000 },
        { id: 'KMI-0000007', title: 'Death Note', alt: ['デスノート'], desc: 'Light Yagami encuentra un cuaderno sobrenatural que mata a cualquier persona cuyo nombre se escriba en él. Decide usarlo para crear un mundo sin crímenes, convirtiéndose en "Kira".', type: 'manga', status: 'completed', genres: ['Misterio', 'Psychological', 'Thriller', 'Shonen'], demo: 'shonen', author: 'Tsugumi Ohba', artist: 'Takeshi Obata', chapters: 108, rating: 9.3, ratings: 189600, reads: 5200000 },
        { id: 'KMI-0000008', title: 'Kaiju No. 8', alt: ['怪獣8号'], desc: 'Kafka Hibino sueña con unirse al Cuerpo de Defensa para luchar contra los kaijus. Pero todo cambia cuando él mismo se convierte en uno de ellos.', type: 'manga', status: 'ongoing', genres: ['Acción', 'Ciencia Ficción', 'Shonen'], demo: 'shonen', author: 'Naoya Matsumoto', artist: 'Naoya Matsumoto', chapters: 133, rating: 8.8, ratings: 58400, reads: 1900000 },
        { id: 'KMI-0000009', title: 'One Piece', alt: ['ワンピース', 'OP'], desc: 'Monkey D. Luffy zarpa para convertirse en el Rey de los Piratas y encontrar el legendario tesoro "One Piece". La mayor aventura del manga moderno.', type: 'manga', status: 'ongoing', genres: ['Acción', 'Aventura', 'Comedia', 'Fantasía', 'Shonen'], demo: 'shonen', author: 'Eiichiro Oda', artist: 'Eiichiro Oda', chapters: 1118, rating: 9.5, ratings: 312400, reads: 8900000 },
        { id: 'KMI-0000010', title: 'Blue Lock', alt: ['ブルーロック'], desc: 'Tras el fracaso de Japón en el Mundial, la Asociación de Fútbol lanza el proyecto Blue Lock: encerrar a 300 delanteros y entrenarlos hasta que uno se convierta en el mejor egoísta del mundo.', type: 'manga', status: 'ongoing', genres: ['Deportes', 'Psychological', 'Shonen'], demo: 'shonen', author: 'Muneyuki Kaneshiro', artist: 'Yusuke Nomura', chapters: 295, rating: 8.9, ratings: 87200, reads: 2700000 },
      ];

      for (const m of seedData) {
        await pool.query(`
          INSERT INTO mangas (id, title, alternative_titles, description, type, status, genres, demographic_target, author, artist, total_chapters, rating, total_ratings, total_reads)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (id) DO NOTHING
        `, [
          m.id, m.title, m.alt, m.desc, m.type, m.status, m.genres,
          m.demo, m.author, m.artist, m.chapters, m.rating, m.ratings, m.reads,
        ]);
      }
      console.log(`OK: ${seedData.length} mangas seeded`);
    } else {
      console.log('OK: mangas table already has data, skipping seed');
    }

    // 7. Create dynamic role VIEW
    await pool.query('DROP VIEW IF EXISTS user_with_role CASCADE');
    await pool.query(`
      CREATE VIEW user_with_role AS
      SELECT *,
        CASE
          WHEN is_admin = TRUE THEN 'admin'
          WHEN is_banned = TRUE THEN 'banned'
          WHEN company_verified = TRUE THEN 'company'
          WHEN premium_expires_at > NOW() AND subscription_tier = 'gold' THEN 'gold'
          WHEN premium_expires_at > NOW() AND subscription_tier = 'silver' THEN 'silver'
          WHEN reputation_score >= 500 THEN 'moderator'
          ELSE 'user'
        END AS role
      FROM users
    `);
    console.log('OK: user_with_role VIEW created');

    // 13b. Create revoked_tokens table (blacklist de JWT)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
          id SERIAL PRIMARY KEY,
          token_hash VARCHAR(64) NOT NULL UNIQUE,
          expires_at TIMESTAMP NOT NULL,
          revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: revoked_tokens table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_revoked_token_hash ON revoked_tokens(token_hash)');
    console.log('OK: revoked_tokens index created');

    // 14. Create analytics aggregation tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS global_daily_stats (
          id SERIAL PRIMARY KEY,
          date DATE NOT NULL UNIQUE,
          total_users INTEGER DEFAULT 0,
          active_users INTEGER DEFAULT 0,
          new_users INTEGER DEFAULT 0,
          premium_users INTEGER DEFAULT 0,
          total_actions INTEGER DEFAULT 0,
          total_reads INTEGER DEFAULT 0,
          avg_chapters_per_user DECIMAL(6,2) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: global_daily_stats table created');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS manga_daily_stats (
          id SERIAL PRIMARY KEY,
          date DATE NOT NULL,
          manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
          reads INTEGER DEFAULT 0,
          unique_readers INTEGER DEFAULT 0,
          total_minutes INTEGER DEFAULT 0,
          rating_avg DECIMAL(3,1) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(date, manga_id)
      )
    `);
    console.log('OK: manga_daily_stats table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_manga_daily_date ON manga_daily_stats(date)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_manga_daily_manga ON manga_daily_stats(manga_id)');
    console.log('OK: manga_daily_stats indexes created');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS premium_daily_stats (
          id SERIAL PRIMARY KEY,
          date DATE NOT NULL UNIQUE,
          total_premium INTEGER DEFAULT 0,
          new_premium INTEGER DEFAULT 0,
          expired_premium INTEGER DEFAULT 0,
          silver_count INTEGER DEFAULT 0,
          gold_count INTEGER DEFAULT 0,
          revenue_generated DECIMAL(10,2) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: premium_daily_stats table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_premium_daily_date ON premium_daily_stats(date)');
    console.log('OK: premium_daily_stats index created');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reading_heatmap (
          id SERIAL PRIMARY KEY,
          day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
          hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
          total_reads INTEGER DEFAULT 0,
          unique_users INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(day_of_week, hour)
      )
    `);
    console.log('OK: reading_heatmap table created');

    // 14b. Analytics triggers for updated_at
    const analyticsTables = ['global_daily_stats', 'manga_daily_stats', 'premium_daily_stats', 'reading_heatmap'];
    for (const table of analyticsTables) {
      const trigName = `trg_${table}_updated`;
      await pool.query(`
        DROP TRIGGER IF EXISTS ${trigName} ON ${table};
        CREATE TRIGGER ${trigName}
        BEFORE UPDATE ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
      `);
      console.log(`  → trigger ${trigName} applied to ${table}`);
    }

    // 15. Create user_tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tracking (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          manga_id VARCHAR(20) DEFAULT NULL REFERENCES mangas(id) ON DELETE CASCADE,
          chapter_id INTEGER DEFAULT NULL,
          action_type VARCHAR(50) NOT NULL,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: user_tracking table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_tracking_user ON user_tracking(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tracking_action ON user_tracking(user_id, action_type)');
    console.log('OK: user_tracking indexes created');

    // 15. Create user_daily_activity table (for streak tracking)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_daily_activity (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          activity_date DATE NOT NULL,
          chapters_read INTEGER DEFAULT 0,
          minutes_read INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, activity_date)
      )
    `);
    console.log('OK: user_daily_activity table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_daily_user ON user_daily_activity(user_id, activity_date)');
    console.log('OK: user_daily_activity indexes created');

    // 16. Create user_friends table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_friends (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          friend_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'accepted',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, friend_id)
      )
    `);
    console.log('OK: user_friends table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_friends_user ON user_friends(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_friends_friend ON user_friends(friend_id)');
    console.log('OK: user_friends indexes created');

    // 17. Create page_annotations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS page_annotations (
          id SERIAL PRIMARY KEY,
          manga_id VARCHAR(20) NOT NULL,
          chapter_number INTEGER NOT NULL,
          page_number INTEGER NOT NULL,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          region JSONB NOT NULL,
          note_text TEXT NOT NULL DEFAULT '',
          color VARCHAR(7) DEFAULT '#f5c842',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: page_annotations table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_annotations_page ON page_annotations(manga_id, chapter_number, page_number)');
    console.log('OK: page_annotations indexes created');

    // 18. Create chapter_comments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chapter_comments (
          id SERIAL PRIMARY KEY,
          manga_id VARCHAR(20) NOT NULL,
          chapter_number INTEGER NOT NULL,
          user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('OK: chapter_comments table created');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_chapter ON chapter_comments(manga_id, chapter_number)');
    console.log('OK: chapter_comments index created');

    // 8. Trigger function: auto-update updated_at on row modification
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('OK: update_updated_at_column() function created');

    // Apply trigger to tables that have updated_at
    const tablesWithUpdatedAt = ['users', 'mangas', 'chapters', 'user_reading', 'user_manga_library', 'user_ratings', 'page_annotations'];
    for (const table of tablesWithUpdatedAt) {
      const trigName = `${table}_updated_at`;
      const hasColumn = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'updated_at'`,
        [table]
      );
      if (hasColumn.rows.length > 0) {
        await pool.query(`
          DROP TRIGGER IF EXISTS ${trigName} ON ${table};
          CREATE TRIGGER ${trigName}
          BEFORE UPDATE ON ${table}
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log(`  → trigger ${trigName} applied to ${table}`);
      } else {
        console.log(`  → ${table} has no updated_at column, skipped`);
      }
    }

    console.log('\n✅ Migración completada exitosamente');
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    pool.end();
  }
})();
