ALTER TABLE creation_history ADD COLUMN root_request TEXT;
ALTER TABLE creation_history ADD COLUMN parent_history_id INTEGER;
ALTER TABLE creation_history ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE creation_history ADD COLUMN edit_operation TEXT NOT NULL DEFAULT 'create_document';
ALTER TABLE creation_history ADD COLUMN document_patch_json TEXT;

CREATE INDEX IF NOT EXISTS idx_creation_history_session_revision
    ON creation_history(session_id, revision_no DESC, created_at DESC);
