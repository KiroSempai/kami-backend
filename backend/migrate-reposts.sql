-- Reposts: puntero al post original sin duplicar contenido
CREATE TABLE IF NOT EXISTS reposts_manga (
    id SERIAL PRIMARY KEY,
    usuario_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_original_id INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    comunidad_destino_id VARCHAR(60) DEFAULT NULL,
    fecha_repost TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(usuario_id, post_original_id)
);

CREATE INDEX IF NOT EXISTS idx_reposts_original ON reposts_manga(post_original_id);
CREATE INDEX IF NOT EXISTS idx_reposts_usuario ON reposts_manga(usuario_id);

-- quoted_post_id para "Citar Post" (Quote)
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS quoted_post_id INTEGER REFERENCES feed_posts(id) ON DELETE SET NULL;
