-- ═══════════════════════════════════════════════════════════════════
-- KAMI — migrate-dm.sql
-- Mensajes Directos: conversaciones, participantes, mensajes
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dm_conversations (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dm_conversation_participants (
    conversation_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    user_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS dm_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    sender_id VARCHAR(60) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dm_part_user ON dm_conversation_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_conv_time ON dm_conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_msg_conv ON dm_messages(conversation_id, created_at);
