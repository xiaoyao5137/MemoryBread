-- 063: 将 bake 文档向量从原始 capture 生命周期中分离。
--
-- artifact_vector_index 只记录已经成功写入 Qdrant 的持久文档分块；
-- vector_deletion_queue 是 SQLite -> Qdrant 的可重试删除 outbox。

CREATE TABLE IF NOT EXISTS artifact_vector_index (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id      INTEGER NOT NULL
                     REFERENCES bake_documents(id) ON DELETE CASCADE,
    qdrant_point_id  TEXT    NOT NULL UNIQUE,
    doc_key          TEXT    NOT NULL,
    content_hash     TEXT    NOT NULL,
    chunk_index      INTEGER NOT NULL,
    chunk_text       TEXT    NOT NULL,
    model_name       TEXT    NOT NULL DEFAULT 'bge-small-zh-v1.5',
    indexed_at       INTEGER NOT NULL,
    UNIQUE(document_id, content_hash, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_artifact_vector_document
ON artifact_vector_index(document_id);

CREATE INDEX IF NOT EXISTS idx_artifact_vector_version
ON artifact_vector_index(document_id, content_hash);

CREATE TABLE IF NOT EXISTS vector_deletion_queue (
    qdrant_point_id TEXT PRIMARY KEY,
    source_type     TEXT    NOT NULL,
    reason          TEXT    NOT NULL,
    enqueued_at     INTEGER NOT NULL,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    next_attempt_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vector_deletion_queue_due
ON vector_deletion_queue(next_attempt_at, enqueued_at);

CREATE TRIGGER IF NOT EXISTS artifact_vector_queue_delete
AFTER DELETE ON artifact_vector_index
BEGIN
    INSERT OR IGNORE INTO vector_deletion_queue (
        qdrant_point_id, source_type, reason, enqueued_at
    )
    VALUES (
        old.qdrant_point_id,
        'document',
        'artifact_vector_replaced_or_deleted',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
    );
END;

CREATE TRIGGER IF NOT EXISTS bake_document_queue_vectors_on_soft_delete
AFTER UPDATE OF deleted_at ON bake_documents
WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL
BEGIN
    DELETE FROM artifact_vector_index WHERE document_id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS bake_document_queue_vectors_before_delete
BEFORE DELETE ON bake_documents
BEGIN
    INSERT OR IGNORE INTO vector_deletion_queue (
        qdrant_point_id, source_type, reason, enqueued_at
    )
    SELECT
        qdrant_point_id,
        'document',
        'bake_document_deleted',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM artifact_vector_index
    WHERE document_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS bake_document_remove_vector_ledger_after_delete
AFTER DELETE ON bake_documents
BEGIN
    DELETE FROM artifact_vector_index WHERE document_id = old.id;
END;
