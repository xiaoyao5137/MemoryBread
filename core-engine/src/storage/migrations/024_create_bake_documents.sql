-- 024_create_bake_documents.sql
-- 将“设计/模板”资产语义收敛为“文档”资产。
-- 兼容期内仍由旧 API/模型名访问，但底层主表改为 bake_documents。

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS bake_documents (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    title                TEXT    NOT NULL,
    doc_type             TEXT    NOT NULL DEFAULT 'article',
    status               TEXT    NOT NULL DEFAULT 'draft',
    tags                 TEXT    NOT NULL DEFAULT '[]',
    applicable_tasks     TEXT    NOT NULL DEFAULT '[]',
    source_memory_ids    TEXT    NOT NULL DEFAULT '[]',
    source_capture_ids   TEXT    NOT NULL DEFAULT '[]',
    source_episode_ids   TEXT    NOT NULL DEFAULT '[]',
    linked_knowledge_ids TEXT    NOT NULL DEFAULT '[]',
    sections_json        TEXT    NOT NULL DEFAULT '[]',
    style_phrases        TEXT    NOT NULL DEFAULT '[]',
    replacement_rules    TEXT    NOT NULL DEFAULT '[]',
    summary              TEXT,
    full_content         TEXT,
    structured_content   TEXT    NOT NULL DEFAULT '{}',
    prompt_hint          TEXT,
    diagram_code         TEXT,
    image_assets         TEXT    NOT NULL DEFAULT '[]',
    source_app_name      TEXT,
    source_win_title     TEXT,
    source_url           TEXT,
    content_hash         TEXT,
    language             TEXT,
    usage_count          INTEGER NOT NULL DEFAULT 0,
    match_score          REAL,
    match_level          TEXT,
    creation_mode        TEXT    NOT NULL DEFAULT 'manual',
    review_status        TEXT    NOT NULL DEFAULT 'draft',
    evidence_summary     TEXT,
    generation_version   TEXT,
    deleted_at           INTEGER,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bake_document_sections (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id          INTEGER NOT NULL REFERENCES bake_documents(id) ON DELETE CASCADE,
    section_index        INTEGER NOT NULL,
    section_path         TEXT    NOT NULL DEFAULT '[]',
    title                TEXT,
    content              TEXT,
    content_hash         TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);

INSERT INTO bake_documents (
    id, title, doc_type, status, tags, applicable_tasks, source_memory_ids,
    source_capture_ids, source_episode_ids, linked_knowledge_ids, sections_json,
    style_phrases, replacement_rules, full_content, structured_content, prompt_hint,
    diagram_code, image_assets, usage_count, match_score, match_level, creation_mode,
    review_status, evidence_summary, generation_version, deleted_at, created_at, updated_at
)
SELECT
    id,
    name,
    category,
    status,
    tags,
    applicable_tasks,
    source_memory_ids,
    source_capture_ids,
    source_episode_ids,
    linked_knowledge_ids,
    structure_sections,
    style_phrases,
    replacement_rules,
    detailed_content,
    json_object(
        'legacy_kind', 'bake_design',
        'structure_sections', structure_sections,
        'style_phrases', style_phrases,
        'replacement_rules', replacement_rules
    ),
    prompt_hint,
    diagram_code,
    image_assets,
    usage_count,
    match_score,
    match_level,
    creation_mode,
    review_status,
    evidence_summary,
    generation_version,
    deleted_at,
    created_at,
    updated_at
FROM bake_designs
WHERE NOT EXISTS (SELECT 1 FROM bake_documents WHERE bake_documents.id = bake_designs.id);

CREATE INDEX IF NOT EXISTS idx_bake_documents_status ON bake_documents(status);
CREATE INDEX IF NOT EXISTS idx_bake_documents_doc_type ON bake_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_bake_documents_updated_at ON bake_documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_bake_documents_review_status ON bake_documents(review_status);
CREATE INDEX IF NOT EXISTS idx_bake_documents_creation_mode ON bake_documents(creation_mode);
CREATE INDEX IF NOT EXISTS idx_bake_documents_content_hash ON bake_documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_bake_document_sections_document_id ON bake_document_sections(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS bake_documents_fts USING fts5(
    title,
    doc_type,
    summary,
    full_content,
    sections_json,
    structured_content,
    prompt_hint,
    content='bake_documents',
    content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS bake_document_sections_fts USING fts5(
    title,
    content,
    section_path,
    content='bake_document_sections',
    content_rowid='id'
);

INSERT INTO bake_documents_fts(rowid, title, doc_type, summary, full_content, sections_json, structured_content, prompt_hint)
SELECT id, title, doc_type, summary, full_content, sections_json, structured_content, prompt_hint
FROM bake_documents;

CREATE TRIGGER IF NOT EXISTS bake_documents_fts_insert AFTER INSERT ON bake_documents BEGIN
    INSERT INTO bake_documents_fts(rowid, title, doc_type, summary, full_content, sections_json, structured_content, prompt_hint)
    VALUES (new.id, new.title, new.doc_type, new.summary, new.full_content, new.sections_json, new.structured_content, new.prompt_hint);
END;

CREATE TRIGGER IF NOT EXISTS bake_documents_fts_update AFTER UPDATE ON bake_documents BEGIN
    INSERT INTO bake_documents_fts(bake_documents_fts, rowid, title, doc_type, summary, full_content, sections_json, structured_content, prompt_hint)
    VALUES ('delete', old.id, old.title, old.doc_type, old.summary, old.full_content, old.sections_json, old.structured_content, old.prompt_hint);
    INSERT INTO bake_documents_fts(rowid, title, doc_type, summary, full_content, sections_json, structured_content, prompt_hint)
    VALUES (new.id, new.title, new.doc_type, new.summary, new.full_content, new.sections_json, new.structured_content, new.prompt_hint);
END;

CREATE TRIGGER IF NOT EXISTS bake_documents_fts_delete AFTER DELETE ON bake_documents BEGIN
    INSERT INTO bake_documents_fts(bake_documents_fts, rowid, title, doc_type, summary, full_content, sections_json, structured_content, prompt_hint)
    VALUES ('delete', old.id, old.title, old.doc_type, old.summary, old.full_content, old.sections_json, old.structured_content, old.prompt_hint);
END;

CREATE TRIGGER IF NOT EXISTS bake_document_sections_fts_insert AFTER INSERT ON bake_document_sections BEGIN
    INSERT INTO bake_document_sections_fts(rowid, title, content, section_path)
    VALUES (new.id, new.title, new.content, new.section_path);
END;

CREATE TRIGGER IF NOT EXISTS bake_document_sections_fts_update AFTER UPDATE ON bake_document_sections BEGIN
    INSERT INTO bake_document_sections_fts(bake_document_sections_fts, rowid, title, content, section_path)
    VALUES ('delete', old.id, old.title, old.content, old.section_path);
    INSERT INTO bake_document_sections_fts(rowid, title, content, section_path)
    VALUES (new.id, new.title, new.content, new.section_path);
END;

CREATE TRIGGER IF NOT EXISTS bake_document_sections_fts_delete AFTER DELETE ON bake_document_sections BEGIN
    INSERT INTO bake_document_sections_fts(bake_document_sections_fts, rowid, title, content, section_path)
    VALUES ('delete', old.id, old.title, old.content, old.section_path);
END;

ALTER TABLE bake_knowledge ADD COLUMN document_id INTEGER;
ALTER TABLE bake_knowledge ADD COLUMN section_ids TEXT DEFAULT '[]';
ALTER TABLE bake_knowledge ADD COLUMN source_timeline_ids TEXT DEFAULT '[]';

ALTER TABLE vector_index ADD COLUMN document_id INTEGER;
ALTER TABLE vector_index ADD COLUMN section_id INTEGER;

PRAGMA foreign_keys = ON;
