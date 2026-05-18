-- Tabla para tracking de vistas únicas por manga
CREATE TABLE IF NOT EXISTS manga_views (
    id SERIAL PRIMARY KEY,
    manga_id VARCHAR(20) NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(manga_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_manga_views_manga ON manga_views(manga_id);
