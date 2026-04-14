use rusqlite::{params, Connection};

use crate::storage::{
    db::current_ts_ms,
    error::StorageError,
    models_bake::{BakeTemplateRecord, NewBakeTemplate},
    StorageManager,
};

impl StorageManager {
    pub fn insert_bake_template(&self, template: &NewBakeTemplate) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_bake_template_inner(conn, template))
    }

    pub fn get_bake_template(&self, id: i64) -> Result<Option<BakeTemplateRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, category, status, tags, applicable_tasks, source_article_ids,
                        source_capture_ids, source_episode_ids, linked_knowledge_ids,
                        structure_sections, style_phrases, replacement_rules,
                        prompt_hint, diagram_code, image_assets, usage_count,
                        match_score, match_level, creation_mode, review_status,
                        evidence_summary, generation_version, deleted_at,
                        created_at, updated_at
                 FROM bake_templates WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_bake_template(row)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn list_bake_templates_paginated(
        &self,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<BakeTemplateRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT id, name, category, status, tags, applicable_tasks, source_article_ids,
                        source_capture_ids, source_episode_ids, linked_knowledge_ids,
                        structure_sections, style_phrases, replacement_rules,
                        prompt_hint, diagram_code, image_assets, usage_count,
                        match_score, match_level, creation_mode, review_status,
                        evidence_summary, generation_version, deleted_at,
                        created_at, updated_at
                 FROM bake_templates WHERE deleted_at IS NULL",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(q) = query {
                sql.push_str(" AND (name LIKE ? OR category LIKE ? OR COALESCE(prompt_hint, '') LIKE ?)");
                let pattern = format!("%{}%", q);
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern));
            }
            sql.push_str(" ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?");
            bind_values.push(Box::new(limit as i64));
            bind_values.push(Box::new(offset as i64));

            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(row_to_bake_template(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_bake_templates_filtered(&self, query: Option<&str>) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from("SELECT COUNT(*) FROM bake_templates WHERE deleted_at IS NULL");
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(q) = query {
                sql.push_str(" AND (name LIKE ? OR category LIKE ? OR COALESCE(prompt_hint, '') LIKE ?)");
                let pattern = format!("%{}%", q);
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern));
            }

            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
            stmt.query_row(params.as_slice(), |row| row.get(0)).map_err(StorageError::Sqlite)
        })
    }

    pub fn list_bake_templates(&self) -> Result<Vec<BakeTemplateRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, category, status, tags, applicable_tasks, source_article_ids,
                        source_capture_ids, source_episode_ids, linked_knowledge_ids,
                        structure_sections, style_phrases, replacement_rules,
                        prompt_hint, diagram_code, image_assets, usage_count,
                        match_score, match_level, creation_mode, review_status,
                        evidence_summary, generation_version, deleted_at,
                        created_at, updated_at
                 FROM bake_templates
                 WHERE deleted_at IS NULL
                 ORDER BY updated_at DESC, id DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(row_to_bake_template(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn update_bake_template(&self, id: i64, template: &NewBakeTemplate) -> Result<bool, StorageError> {
        let updated_at = current_ts_ms();
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE bake_templates
                 SET name = ?1, category = ?2, status = ?3, tags = ?4, applicable_tasks = ?5,
                     source_article_ids = ?6, source_capture_ids = ?7, source_episode_ids = ?8,
                     linked_knowledge_ids = ?9, structure_sections = ?10,
                     style_phrases = ?11, replacement_rules = ?12, prompt_hint = ?13, diagram_code = ?14,
                     image_assets = ?15, usage_count = ?16, match_score = ?17, match_level = ?18,
                     creation_mode = ?19, review_status = ?20, evidence_summary = ?21,
                     generation_version = ?22, deleted_at = ?23, updated_at = ?24
                 WHERE id = ?25",
                params![
                    template.name,
                    template.category,
                    template.status,
                    template.tags,
                    template.applicable_tasks,
                    template.source_memory_ids,
                    template.source_capture_ids,
                    template.source_episode_ids,
                    template.linked_knowledge_ids,
                    template.structure_sections,
                    template.style_phrases,
                    template.replacement_rules,
                    template.prompt_hint,
                    template.diagram_code,
                    template.image_assets,
                    template.usage_count,
                    template.match_score,
                    template.match_level,
                    template.creation_mode,
                    template.review_status,
                    template.evidence_summary,
                    template.generation_version,
                    template.deleted_at,
                    updated_at,
                    id,
                ],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn toggle_bake_template_status(&self, id: i64) -> Result<Option<BakeTemplateRecord>, StorageError> {
        let maybe_template = self.get_bake_template(id)?;
        let Some(template) = maybe_template else {
            return Ok(None);
        };

        let next_status = if template.status == "enabled" { "disabled" } else { "enabled" };
        let updated_at = current_ts_ms();
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE bake_templates SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![next_status, updated_at, id],
            )?;
            Ok(())
        })?;

        self.get_bake_template(id)
    }

    pub fn soft_delete_bake_template(&self, id: i64) -> Result<bool, StorageError> {
        let deleted_at = current_ts_ms();
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE bake_templates SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![deleted_at, id],
            )?;
            Ok(affected > 0)
        })
    }
}

fn insert_bake_template_inner(conn: &Connection, template: &NewBakeTemplate) -> Result<i64, StorageError> {
    let now = current_ts_ms();
    conn.execute(
        "INSERT INTO bake_templates (
            name, category, status, tags, applicable_tasks, source_article_ids,
            source_capture_ids, source_episode_ids, linked_knowledge_ids,
            structure_sections, style_phrases, replacement_rules, prompt_hint, diagram_code,
            image_assets, usage_count, match_score, match_level, creation_mode, review_status,
            evidence_summary, generation_version, deleted_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
        params![
            template.name,
            template.category,
            template.status,
            template.tags,
            template.applicable_tasks,
            template.source_memory_ids,
            template.source_capture_ids,
            template.source_episode_ids,
            template.linked_knowledge_ids,
            template.structure_sections,
            template.style_phrases,
            template.replacement_rules,
            template.prompt_hint,
            template.diagram_code,
            template.image_assets,
            template.usage_count,
            template.match_score,
            template.match_level,
            template.creation_mode,
            template.review_status,
            template.evidence_summary,
            template.generation_version,
            template.deleted_at,
            now,
            now,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_bake_template(row: &rusqlite::Row<'_>) -> Result<BakeTemplateRecord, StorageError> {
    Ok(BakeTemplateRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        category: row.get(2)?,
        status: row.get(3)?,
        tags: row.get(4)?,
        applicable_tasks: row.get(5)?,
        source_memory_ids: row.get(6)?,
        source_capture_ids: row.get(7)?,
        source_episode_ids: row.get(8)?,
        linked_knowledge_ids: row.get(9)?,
        structure_sections: row.get(10)?,
        style_phrases: row.get(11)?,
        replacement_rules: row.get(12)?,
        prompt_hint: row.get(13)?,
        diagram_code: row.get(14)?,
        image_assets: row.get(15)?,
        usage_count: row.get(16)?,
        match_score: row.get(17)?,
        match_level: row.get(18)?,
        creation_mode: row.get(19)?,
        review_status: row.get(20)?,
        evidence_summary: row.get(21)?,
        generation_version: row.get(22)?,
        deleted_at: row.get(23)?,
        created_at: row.get(24)?,
        updated_at: row.get(25)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_mgr() -> StorageManager {
        StorageManager::open_in_memory().expect("内存数据库初始化失败")
    }

    fn sample_template() -> NewBakeTemplate {
        NewBakeTemplate {
            name: "技术方案结构版".to_string(),
            category: "技术方案".to_string(),
            status: "draft".to_string(),
            tags: r#"[\"方案\"]"#.to_string(),
            applicable_tasks: r#"[\"creation\"]"#.to_string(),
            source_memory_ids: r#"[\"1\"]"#.to_string(),
            source_capture_ids: r#"[\"11\"]"#.to_string(),
            source_episode_ids: r#"[\"ep-1\"]"#.to_string(),
            linked_knowledge_ids: r#"[\"1\",\"2\"]"#.to_string(),
            structure_sections: r#"[{\"title\":\"背景\",\"keywords\":[\"现状\"]}]"#.to_string(),
            style_phrases: r#"[\"整体看\"]"#.to_string(),
            replacement_rules: r#"[{\"from\":\"综上\",\"to\":\"整体看\"}]"#.to_string(),
            prompt_hint: Some("优先输出结构化方案".to_string()),
            diagram_code: None,
            image_assets: "[]".to_string(),
            usage_count: 0,
            match_score: Some(0.82),
            match_level: Some("high".to_string()),
            creation_mode: "auto".to_string(),
            review_status: "auto_created".to_string(),
            evidence_summary: Some("多次出现稳定结构".to_string()),
            generation_version: Some("bake-v1".to_string()),
            deleted_at: None,
        }
    }

    #[test]
    fn test_insert_and_get_bake_template() {
        let mgr = make_mgr();
        let id = mgr.insert_bake_template(&sample_template()).unwrap();
        let template = mgr.get_bake_template(id).unwrap().unwrap();
        assert_eq!(template.name, "技术方案结构版");
        assert_eq!(template.category, "技术方案");
        assert_eq!(template.creation_mode, "auto");
        assert_eq!(template.review_status, "auto_created");
    }

    #[test]
    fn test_update_bake_template() {
        let mgr = make_mgr();
        let id = mgr.insert_bake_template(&sample_template()).unwrap();
        let mut updated = sample_template();
        updated.name = "周报模板".to_string();
        updated.status = "enabled".to_string();
        updated.review_status = "accepted".to_string();
        assert!(mgr.update_bake_template(id, &updated).unwrap());
        let template = mgr.get_bake_template(id).unwrap().unwrap();
        assert_eq!(template.name, "周报模板");
        assert_eq!(template.status, "enabled");
        assert_eq!(template.review_status, "accepted");
    }

    #[test]
    fn test_toggle_bake_template_status() {
        let mgr = make_mgr();
        let id = mgr.insert_bake_template(&sample_template()).unwrap();
        let toggled = mgr.toggle_bake_template_status(id).unwrap().unwrap();
        assert_eq!(toggled.status, "enabled");
    }
}
