-- =====================================================
-- ALGORITHM: OtakuCred — Reputación de usuario por categoría
-- =====================================================
CREATE TABLE IF NOT EXISTS otaku_cred (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category VARCHAR(60) NOT NULL DEFAULT 'general',   -- seinen, shonen, fantasy, general
    score NUMERIC DEFAULT 100,                         -- base 100
    total_posts INTEGER DEFAULT 0,
    total_likes_received INTEGER DEFAULT 0,
    total_bookmarks INTEGER DEFAULT 0,
    total_reports INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_otaku_cred_user ON otaku_cred(user_id);
CREATE INDEX IF NOT EXISTS idx_otaku_cred_category ON otaku_cred(category);

-- =====================================================
-- ALGORITHM: FandomJet — Grafo de conexiones usuario-manga-comunidad
-- =====================================================
CREATE TABLE IF NOT EXISTS fandom_graph (
    id SERIAL PRIMARY KEY,
    source_type VARCHAR(20) NOT NULL,  -- user, manga, community, author
    source_id VARCHAR(60) NOT NULL,
    target_type VARCHAR(20) NOT NULL,
    target_id VARCHAR(60) NOT NULL,
    weight NUMERIC DEFAULT 1.0,
    interaction_count INTEGER DEFAULT 1,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, source_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_fandom_graph_source ON fandom_graph(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_fandom_graph_target ON fandom_graph(target_type, target_id);

-- =====================================================
-- ALGORITHM: Fatigue Tracker — Control de monotonía
-- =====================================================
CREATE TABLE IF NOT EXISTS fatigue_tracker (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL,           -- session ID o user_id + fecha
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manga_id VARCHAR(20) REFERENCES mangas(id) ON DELETE SET NULL,
    community_id VARCHAR(60) DEFAULT NULL,
    viewed_count INTEGER DEFAULT 1,
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, user_id, manga_id, community_id)
);

CREATE INDEX IF NOT EXISTS idx_fatigue_session ON fatigue_tracker(session_id);

-- =====================================================
-- ALGORITHM: Safety — Spoiler keywords + toxic patterns
-- =====================================================
CREATE TABLE IF NOT EXISTS safety_keywords (
    id SERIAL PRIMARY KEY,
    keyword VARCHAR(255) NOT NULL UNIQUE,
    category VARCHAR(30) NOT NULL,              -- spoiler, toxicity, leak
    severity INTEGER DEFAULT 5,                 -- 1-10
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Palabras clave de spoiler comunes
INSERT INTO safety_keywords (keyword, category, severity) VALUES
    ('muere', 'spoiler', 8),
    ('asesinato', 'spoiler', 7),
    ('traidor', 'spoiler', 6),
    ('resurrección', 'spoiler', 5),
    ('filtración', 'leak', 10),
    ('leak', 'leak', 10),
    ('spoiler', 'spoiler', 9),
    ('capítulo filtrado', 'leak', 10),
    ('insulto', 'toxicity', 4),
    ('basura', 'toxicity', 3),
    ('sobrevalorado', 'toxicity', 2),
    ('infravalorado', 'toxicity', 2)
ON CONFLICT (keyword) DO NOTHING;
