-- 创作记录表
CREATE TABLE IF NOT EXISTS creation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    generated_content TEXT NOT NULL,
    doc_type TEXT,
    audience TEXT,
    reference_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_creation_history_created_at ON creation_history(created_at DESC);
