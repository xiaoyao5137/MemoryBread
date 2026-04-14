CREATE TABLE IF NOT EXISTS bake_templates (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT    NOT NULL,
    category            TEXT    NOT NULL,
    status              TEXT    NOT NULL,
    tags                TEXT    NOT NULL DEFAULT '[]',
    applicable_tasks    TEXT    NOT NULL DEFAULT '[]',
    source_article_ids  TEXT    NOT NULL DEFAULT '[]',
    linked_knowledge_ids TEXT   NOT NULL DEFAULT '[]',
    structure_sections  TEXT    NOT NULL DEFAULT '[]',
    style_phrases       TEXT    NOT NULL DEFAULT '[]',
    replacement_rules   TEXT    NOT NULL DEFAULT '[]',
    prompt_hint         TEXT,
    diagram_code        TEXT,
    image_assets        TEXT    NOT NULL DEFAULT '[]',
    usage_count         INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bake_templates_status ON bake_templates(status);
CREATE INDEX IF NOT EXISTS idx_bake_templates_category ON bake_templates(category);
CREATE INDEX IF NOT EXISTS idx_bake_templates_updated_at ON bake_templates(updated_at);
