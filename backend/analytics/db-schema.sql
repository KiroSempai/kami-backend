-- ════════════════════════════════════════════════════════════
-- KAMI Analytics — Tablas de Agregación
-- ════════════════════════════════════════════════════════════

-- 📊 Estadísticas globales diarias
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
);

-- 📚 Estadísticas diarias por manga
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
);

-- 💳 Estadísticas diarias de premium
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
);

-- 🗺️ Heatmap de lectura (día de semana × hora)
CREATE TABLE IF NOT EXISTS reading_heatmap (
    id SERIAL PRIMARY KEY,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
    total_reads INTEGER DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(day_of_week, hour)
);

-- 📥 Índices
CREATE INDEX IF NOT EXISTS idx_manga_daily_date ON manga_daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_manga_daily_manga ON manga_daily_stats(manga_id);
CREATE INDEX IF NOT EXISTS idx_premium_daily_date ON premium_daily_stats(date);

-- 🔄 Trigger para updated_at
CREATE OR REPLACE FUNCTION update_analytics_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_global_daily_stats_updated') THEN
        CREATE TRIGGER trg_global_daily_stats_updated BEFORE UPDATE ON global_daily_stats FOR EACH ROW EXECUTE FUNCTION update_analytics_timestamp();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_manga_daily_stats_updated') THEN
        CREATE TRIGGER trg_manga_daily_stats_updated BEFORE UPDATE ON manga_daily_stats FOR EACH ROW EXECUTE FUNCTION update_analytics_timestamp();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_premium_daily_stats_updated') THEN
        CREATE TRIGGER trg_premium_daily_stats_updated BEFORE UPDATE ON premium_daily_stats FOR EACH ROW EXECUTE FUNCTION update_analytics_timestamp();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_reading_heatmap_updated') THEN
        CREATE TRIGGER trg_reading_heatmap_updated BEFORE UPDATE ON reading_heatmap FOR EACH ROW EXECUTE FUNCTION update_analytics_timestamp();
    END IF;
END;
$$;
