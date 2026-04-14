use rusqlite::{params, Connection};

use crate::storage::{
    db::current_ts_ms,
    error::StorageError,
    models_bake::{BakeMemorySourceRecord, KnowledgeEntryRecord, NewKnowledgeEntry},
    StorageManager,
};

impl StorageManager {
    pub fn list_knowledge_by_category(&self, category: &str) -> Result<Vec<KnowledgeEntryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                        CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                 FROM knowledge_entries WHERE category = ?1 ORDER BY updated_at DESC, id DESC",
            )?;
            let rows = stmt.query_map(params![category], |row| {
                Ok(row_to_knowledge_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn list_bake_memories_paginated(
        &self,
        query: Option<&str>,
        from_ts: Option<i64>,
        to_ts: Option<i64>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<KnowledgeEntryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT k.id, k.capture_id, k.summary, k.overview, k.details, k.entities, k.category, k.importance,
                        k.occurrence_count, k.observed_at, k.event_time_start, k.event_time_end,
                        k.history_view, k.content_origin, k.activity_type, k.is_self_generated,
                        k.evidence_strength, k.user_verified, k.user_edited, k.created_at, k.updated_at,
                        CAST(strftime('%s', k.created_at) AS INTEGER) * 1000,
                        CAST(strftime('%s', k.updated_at) AS INTEGER) * 1000
                 FROM knowledge_entries k
                 INNER JOIN captures c ON c.id = k.capture_id
                 WHERE k.category = ?",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new("bake_article".to_string())];
            if let Some(q) = query {
                sql.push_str(" AND (k.summary LIKE ? OR COALESCE(k.overview, '') LIKE ? OR COALESCE(k.details, '') LIKE ?)");
                let pattern = format!("%{}%", q);
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern));
            }
            if let Some(value) = from_ts {
                sql.push_str(" AND c.ts >= ?");
                bind_values.push(Box::new(value));
            }
            if let Some(value) = to_ts {
                sql.push_str(" AND c.ts <= ?");
                bind_values.push(Box::new(value));
            }
            sql.push_str(" ORDER BY c.ts DESC, k.updated_at DESC, k.id DESC LIMIT ? OFFSET ?");
            bind_values.push(Box::new(limit as i64));
            bind_values.push(Box::new(offset as i64));

            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(row_to_knowledge_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_bake_memories_filtered(
        &self,
        query: Option<&str>,
        from_ts: Option<i64>,
        to_ts: Option<i64>,
    ) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT COUNT(*)
                 FROM knowledge_entries k
                 INNER JOIN captures c ON c.id = k.capture_id
                 WHERE k.category = ?",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new("bake_article".to_string())];
            if let Some(q) = query {
                sql.push_str(" AND (k.summary LIKE ? OR COALESCE(k.overview, '') LIKE ? OR COALESCE(k.details, '') LIKE ?)");
                let pattern = format!("%{}%", q);
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern));
            }
            if let Some(value) = from_ts {
                sql.push_str(" AND c.ts >= ?");
                bind_values.push(Box::new(value));
            }
            if let Some(value) = to_ts {
                sql.push_str(" AND c.ts <= ?");
                bind_values.push(Box::new(value));
            }

            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
            stmt.query_row(params.as_slice(), |row| row.get(0)).map_err(StorageError::Sqlite)
        })
    }

    pub fn list_bake_knowledge_paginated(
        &self,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<KnowledgeEntryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                        CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                 FROM knowledge_entries
                 WHERE category = ?",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new("bake_knowledge".to_string()),
            ];
            if let Some(q) = query {
                sql.push_str(" AND (summary LIKE ? OR COALESCE(overview, '') LIKE ? OR COALESCE(details, '') LIKE ? OR COALESCE(category, '') LIKE ?)");
                let pattern = format!("%{}%", q);
                bind_values.push(Box::new(pattern.clone()));
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
                Ok(row_to_knowledge_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_bake_knowledge_filtered(&self, query: Option<&str>) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT COUNT(*) FROM knowledge_entries WHERE category = ?",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new("bake_knowledge".to_string()),
            ];
            if let Some(q) = query {
                sql.push_str(" AND (summary LIKE ? OR COALESCE(overview, '') LIKE ? OR COALESCE(details, '') LIKE ? OR COALESCE(category, '') LIKE ?)");
                let pattern = format!("%{}%", q);
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern));
            }

            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
            stmt.query_row(params.as_slice(), |row| row.get(0)).map_err(StorageError::Sqlite)
        })
    }

    pub fn count_bake_knowledge(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM knowledge_entries WHERE category = ?1",
                params!["bake_knowledge"],
                |row| row.get(0),
            ).map_err(StorageError::Sqlite)
        })
    }

    pub fn list_non_bake_knowledge_paginated(
        &self,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<KnowledgeEntryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                        CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                 FROM knowledge_entries
                 WHERE category NOT IN (?, ?, ?)",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new("bake_article".to_string()),
                Box::new("bake_sop".to_string()),
                Box::new("bake_knowledge".to_string()),
            ];
            if let Some(q) = query {
                sql.push_str(" AND (summary LIKE ? OR COALESCE(overview, '') LIKE ? OR COALESCE(details, '') LIKE ? OR COALESCE(category, '') LIKE ?)");
                let pattern = format!("%{}%", q);
                bind_values.push(Box::new(pattern.clone()));
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
                Ok(row_to_knowledge_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_non_bake_knowledge_filtered(&self, query: Option<&str>) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT COUNT(*) FROM knowledge_entries WHERE category NOT IN (?, ?, ?)",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new("bake_article".to_string()),
                Box::new("bake_sop".to_string()),
                Box::new("bake_knowledge".to_string()),
            ];
            if let Some(q) = query {
                sql.push_str(" AND (summary LIKE ? OR COALESCE(overview, '') LIKE ? OR COALESCE(details, '') LIKE ? OR COALESCE(category, '') LIKE ?)");
                let pattern = format!("%{}%", q);
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern.clone()));
                bind_values.push(Box::new(pattern));
            }

            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
            stmt.query_row(params.as_slice(), |row| row.get(0)).map_err(StorageError::Sqlite)
        })
    }

    pub fn list_non_bake_knowledge(&self, limit: usize, offset: usize) -> Result<Vec<KnowledgeEntryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                        CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                 FROM knowledge_entries
                 WHERE category NOT IN (?1, ?2, ?3)
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?4 OFFSET ?5",
            )?;
            let rows = stmt.query_map(params!["bake_article", "bake_sop", "bake_knowledge", limit as i64, offset as i64], |row| {
                Ok(row_to_knowledge_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_non_bake_knowledge(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM knowledge_entries WHERE category NOT IN (?1, ?2, ?3)",
                params!["bake_article", "bake_sop", "bake_knowledge"],
                |row| row.get(0),
            ).map_err(StorageError::Sqlite)
        })
    }

    pub fn list_bake_memory_init_candidates(&self, limit: usize) -> Result<Vec<BakeMemorySourceRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT k.id, k.capture_id, k.summary, k.overview, k.details, k.entities, k.category, k.importance,
                        k.occurrence_count, k.observed_at, k.event_time_start, k.event_time_end,
                        k.history_view, k.content_origin, k.activity_type, k.is_self_generated,
                        k.evidence_strength, k.user_verified, k.user_edited, k.created_at, k.updated_at,
                        CAST(strftime('%s', k.created_at) AS INTEGER) * 1000,
                        CAST(strftime('%s', k.updated_at) AS INTEGER) * 1000,
                        c.ts, c.app_name, c.win_title, c.ax_text, c.ocr_text, c.input_text, c.audio_text
                 FROM knowledge_entries k
                 INNER JOIN captures c ON c.id = k.capture_id
                 WHERE k.category NOT IN (?1, ?2, ?3)
                 ORDER BY k.importance DESC, COALESCE(k.occurrence_count, 0) DESC, k.updated_at DESC, k.id DESC
                 LIMIT ?4",
            )?;
            let rows = stmt.query_map(params!["bake_article", "bake_sop", "bake_knowledge", limit as i64], |row| {
                Ok(BakeMemorySourceRecord {
                    knowledge: row_to_knowledge_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?,
                    capture_ts: row.get(23)?,
                    capture_app_name: row.get(24)?,
                    capture_win_title: row.get(25)?,
                    capture_ax_text: row.get(26)?,
                    capture_ocr_text: row.get(27)?,
                    capture_input_text: row.get(28)?,
                    capture_audio_text: row.get(29)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn get_knowledge_entry(&self, id: i64) -> Result<Option<KnowledgeEntryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                        CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                 FROM knowledge_entries WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_knowledge_entry(row)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn insert_knowledge_entry(&self, entry: &NewKnowledgeEntry) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_knowledge_entry_inner(conn, entry))
    }

    pub fn update_knowledge_details(
        &self,
        id: i64,
        summary: &str,
        overview: Option<&str>,
        details: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE knowledge_entries
                 SET summary = ?1, overview = ?2, details = ?3, entities = ?4, user_edited = 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?5",
                params![summary, overview, details, entities, id],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn update_knowledge_details_system(
        &self,
        id: i64,
        summary: &str,
        overview: Option<&str>,
        details: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE knowledge_entries
                 SET summary = ?1, overview = ?2, details = ?3, entities = ?4, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?5",
                params![summary, overview, details, entities, id],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn set_knowledge_verified(&self, id: i64, verified: bool) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE knowledge_entries SET user_verified = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![verified, id],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn delete_knowledge_entry(&self, id: i64) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "DELETE FROM knowledge_entries WHERE id = ?1",
                params![id],
            )?;
            Ok(affected > 0)
        })
    }
}

fn insert_knowledge_entry_inner(conn: &Connection, entry: &NewKnowledgeEntry) -> Result<i64, StorageError> {
    let now = current_ts_ms();
    conn.execute(
        "INSERT INTO knowledge_entries (
            capture_id, summary, overview, details, entities, category, importance,
            occurrence_count, observed_at, event_time_start, event_time_end,
            history_view, content_origin, activity_type, is_self_generated,
            evidence_strength, user_verified, user_edited, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 0, datetime(?17 / 1000, 'unixepoch'), datetime(?17 / 1000, 'unixepoch'))",
        params![
            entry.capture_id,
            entry.summary,
            entry.overview,
            entry.details,
            entry.entities,
            entry.category,
            entry.importance,
            entry.occurrence_count,
            entry.observed_at,
            entry.event_time_start,
            entry.event_time_end,
            entry.history_view,
            entry.content_origin,
            entry.activity_type,
            entry.is_self_generated,
            entry.evidence_strength,
            now,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_knowledge_entry(row: &rusqlite::Row<'_>) -> Result<KnowledgeEntryRecord, StorageError> {
    Ok(KnowledgeEntryRecord {
        id: row.get(0)?,
        capture_id: row.get(1)?,
        summary: row.get(2)?,
        overview: row.get(3)?,
        details: row.get(4)?,
        entities: row.get(5)?,
        category: row.get(6)?,
        importance: row.get::<_, Option<i64>>(7)?.unwrap_or(3),
        occurrence_count: row.get(8)?,
        observed_at: row.get(9)?,
        event_time_start: row.get(10)?,
        event_time_end: row.get(11)?,
        history_view: row.get::<_, Option<bool>>(12)?.unwrap_or(false),
        content_origin: row.get(13)?,
        activity_type: row.get(14)?,
        is_self_generated: row.get::<_, Option<bool>>(15)?.unwrap_or(false),
        evidence_strength: row.get(16)?,
        user_verified: row.get::<_, Option<bool>>(17)?.unwrap_or(false),
        user_edited: row.get::<_, Option<bool>>(18)?.unwrap_or(false),
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        created_at_ms: row.get::<_, Option<i64>>(21)?.unwrap_or(0),
        updated_at_ms: row.get::<_, Option<i64>>(22)?.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::storage::models::{EventType, NewCapture};

    fn make_mgr() -> StorageManager {
        StorageManager::open_in_memory().expect("内存数据库初始化失败")
    }

    fn seed_capture(mgr: &StorageManager) -> i64 {
        mgr.insert_capture(&NewCapture {
            ts: 1_700_000_000_000,
            app_name: Some("Chrome".to_string()),
            app_bundle_id: Some("com.google.Chrome".to_string()),
            win_title: Some("知识条目来源".to_string()),
            event_type: EventType::Manual,
            ax_text: Some("知识来源内容".to_string()),
            ax_focused_role: None,
            ax_focused_id: None,
            screenshot_path: None,
            input_text: None,
            is_sensitive: false,
        }).expect("插入 capture 失败")
    }

    fn sample_entry(mgr: &StorageManager, category: &str) -> NewKnowledgeEntry {
        NewKnowledgeEntry {
            capture_id: seed_capture(mgr),
            summary: "客服问题处理".to_string(),
            overview: Some("标准处理流程".to_string()),
            details: Some(r#"{"steps":["确认问题类型"]}"#.to_string()),
            entities: r#"["客服","SOP"]"#.to_string(),
            category: category.to_string(),
            importance: 4,
            occurrence_count: Some(3),
            observed_at: Some(1_700_000_000_000),
            event_time_start: None,
            event_time_end: None,
            history_view: false,
            content_origin: Some("manual".to_string()),
            activity_type: Some("support".to_string()),
            is_self_generated: false,
            evidence_strength: Some("high".to_string()),
        }
    }

    #[test]
    fn test_insert_and_list_knowledge_by_category() {
        let mgr = make_mgr();
        mgr.insert_knowledge_entry(&sample_entry(&mgr, "bake_sop")).unwrap();
        let entries = mgr.list_knowledge_by_category("bake_sop").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].summary, "客服问题处理");
    }

    #[test]
    fn test_set_knowledge_verified() {
        let mgr = make_mgr();
        let id = mgr.insert_knowledge_entry(&sample_entry(&mgr, "bake_article")).unwrap();
        assert!(mgr.set_knowledge_verified(id, true).unwrap());
        let entry = mgr.get_knowledge_entry(id).unwrap().unwrap();
        assert!(entry.user_verified);
    }

    #[test]
    fn test_count_non_bake_knowledge_filtered_excludes_bake_knowledge() {
        let mgr = make_mgr();
        mgr.insert_knowledge_entry(&sample_entry(&mgr, "bake_knowledge")).unwrap();
        mgr.insert_knowledge_entry(&sample_entry(&mgr, "meeting")).unwrap();

        assert_eq!(mgr.count_non_bake_knowledge_filtered(None).unwrap(), 1);
        assert_eq!(mgr.count_non_bake_knowledge_filtered(Some("客服")).unwrap(), 1);
    }

    #[test]
    fn test_list_bake_memory_init_candidates_excludes_bake_knowledge() {
        let mgr = make_mgr();
        mgr.insert_knowledge_entry(&sample_entry(&mgr, "bake_knowledge")).unwrap();
        mgr.insert_knowledge_entry(&sample_entry(&mgr, "meeting")).unwrap();

        let candidates = mgr.list_bake_memory_init_candidates(10).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].knowledge.category, "meeting");
    }
}
