use rusqlite::{params, Connection};

use crate::storage::{
    db::current_ts_ms,
    error::StorageError,
    models_bake::{
        BakeArticleRecord, BakeKnowledgeRecord, BakeMemorySourceRecord, BakeSopRecord,
        EpisodicMemoryRecord, KnowledgeEntryRecord, NewBakeArticle, NewBakeKnowledge,
        NewBakeSop, NewEpisodicMemory, NewKnowledgeEntry,
    },
    StorageManager,
};

impl StorageManager {
    /// 向后兼容函数：根据 category 查询对应的表
    pub fn list_knowledge_by_category(&self, category: &str) -> Result<Vec<KnowledgeEntryRecord>, StorageError> {
        match category {
            "bake_article" => {
                // 查询 bake_articles 表并转换为 KnowledgeEntryRecord
                let articles = self.list_bake_articles_paginated(5000, 0)?;
                Ok(articles.into_iter().map(|a| KnowledgeEntryRecord {
                    id: a.id,
                    capture_id: a.episodic_memory_id, // 使用 episodic_memory_id 作为 capture_id
                    summary: a.summary,
                    overview: Some(a.title),
                    details: a.content, // content 字段包含完整的 JSON（从迁移中继承）
                    entities: a.entities,
                    category: "bake_article".to_string(),
                    importance: a.importance,
                    occurrence_count: None,
                    observed_at: None,
                    event_time_start: None,
                    event_time_end: None,
                    history_view: false,
                    content_origin: None,
                    activity_type: None,
                    is_self_generated: false,
                    evidence_strength: None,
                    user_verified: a.user_verified,
                    user_edited: a.user_edited,
                    created_at: a.created_at,
                    updated_at: a.updated_at,
                    created_at_ms: a.created_at_ms,
                    updated_at_ms: a.updated_at_ms,
                }).collect())
            },
            "bake_knowledge" => {
                let knowledge = self.list_bake_knowledge_new(5000, 0)?;
                Ok(knowledge.into_iter().map(|k| KnowledgeEntryRecord {
                    id: k.id,
                    capture_id: k.episodic_memory_id,
                    summary: k.summary,
                    overview: Some(k.title),
                    details: k.content,
                    entities: k.entities,
                    category: "bake_knowledge".to_string(),
                    importance: k.importance,
                    occurrence_count: None,
                    observed_at: None,
                    event_time_start: None,
                    event_time_end: None,
                    history_view: false,
                    content_origin: None,
                    activity_type: None,
                    is_self_generated: false,
                    evidence_strength: None,
                    user_verified: k.user_verified,
                    user_edited: k.user_edited,
                    created_at: k.created_at,
                    updated_at: k.updated_at,
                    created_at_ms: k.created_at_ms,
                    updated_at_ms: k.updated_at_ms,
                }).collect())
            },
            "bake_sop" => {
                let sops = self.list_bake_sops_paginated(5000, 0)?;
                Ok(sops.into_iter().map(|s| KnowledgeEntryRecord {
                    id: s.id,
                    capture_id: s.episodic_memory_id,
                    summary: s.summary,
                    overview: Some(s.title),
                    details: s.content,
                    entities: s.entities,
                    category: "bake_sop".to_string(),
                    importance: s.importance,
                    occurrence_count: None,
                    observed_at: None,
                    event_time_start: None,
                    event_time_end: None,
                    history_view: false,
                    content_origin: None,
                    activity_type: None,
                    is_self_generated: false,
                    evidence_strength: None,
                    user_verified: s.user_verified,
                    user_edited: s.user_edited,
                    created_at: s.created_at,
                    updated_at: s.updated_at,
                    created_at_ms: s.created_at_ms,
                    updated_at_ms: s.updated_at_ms,
                }).collect())
            },
            _ => {
                // 查询 episodic_memories 表
                let memories = self.list_episodic_memories_paginated(Some(category), 5000, 0)?;
                Ok(memories.into_iter().map(|m| KnowledgeEntryRecord {
                    id: m.id,
                    capture_id: m.capture_id,
                    summary: m.summary,
                    overview: m.overview,
                    details: m.details,
                    entities: m.entities,
                    category: m.category,
                    importance: m.importance,
                    occurrence_count: m.occurrence_count,
                    observed_at: m.observed_at,
                    event_time_start: m.event_time_start,
                    event_time_end: m.event_time_end,
                    history_view: m.history_view,
                    content_origin: m.content_origin,
                    activity_type: m.activity_type,
                    is_self_generated: m.is_self_generated,
                    evidence_strength: m.evidence_strength,
                    user_verified: m.user_verified,
                    user_edited: m.user_edited,
                    created_at: m.created_at,
                    updated_at: m.updated_at,
                    created_at_ms: m.created_at_ms,
                    updated_at_ms: m.updated_at_ms,
                }).collect())
            }
        }
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
                        k.created_at_ms, k.updated_at_ms
                 FROM episodic_memories k
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
                sql.push_str(" AND COALESCE(k.observed_at, k.created_at_ms) >= ?");
                bind_values.push(Box::new(value));
            }
            if let Some(value) = to_ts {
                sql.push_str(" AND COALESCE(k.observed_at, k.created_at_ms) <= ?");
                bind_values.push(Box::new(value));
            }
            sql.push_str(" ORDER BY k.updated_at_ms DESC, k.id DESC LIMIT ? OFFSET ?");
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
                 FROM episodic_memories k
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
                sql.push_str(" AND COALESCE(k.observed_at, k.created_at_ms) >= ?");
                bind_values.push(Box::new(value));
            }
            if let Some(value) = to_ts {
                sql.push_str(" AND COALESCE(k.observed_at, k.created_at_ms) <= ?");
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
        // 使用新表，但返回旧格式以保持兼容
        let knowledge = self.list_bake_knowledge_new(limit, offset)?;
        Ok(knowledge.into_iter().map(|k| KnowledgeEntryRecord {
            id: k.id,
            capture_id: k.episodic_memory_id,
            summary: k.summary,
            overview: Some(k.title),
            details: k.content,
            entities: k.entities,
            category: "bake_knowledge".to_string(),
            importance: k.importance,
            occurrence_count: None,
            observed_at: None,
            event_time_start: None,
            event_time_end: None,
            history_view: false,
            content_origin: None,
            activity_type: None,
            is_self_generated: false,
            evidence_strength: None,
            user_verified: k.user_verified,
            user_edited: k.user_edited,
            created_at: k.created_at,
            updated_at: k.updated_at,
            created_at_ms: k.created_at_ms,
            updated_at_ms: k.updated_at_ms,
        }).collect())
    }

    /// 新的 bake_knowledge 查询函数（返回新类型）
    fn list_bake_knowledge_new(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<BakeKnowledgeRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, episodic_memory_id, title, summary, content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms
                 FROM bake_knowledge ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?"
            )?;
            let rows = stmt.query_map(params![limit as i64, offset as i64], |row| {
                Ok(row_to_bake_knowledge(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_bake_knowledge_filtered(&self, query: Option<&str>) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from("SELECT COUNT(*) FROM bake_knowledge");
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(q) = query {
                sql.push_str(" WHERE (summary LIKE ? OR COALESCE(title, '') LIKE ? OR COALESCE(content, '') LIKE ? OR COALESCE(entities, '') LIKE ?)");
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
                        created_at_ms, updated_at_ms
                 FROM episodic_memories
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
            sql.push_str(" ORDER BY updated_at_ms DESC, id DESC LIMIT ? OFFSET ?");
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
                "SELECT COUNT(*) FROM episodic_memories WHERE category NOT IN (?, ?, ?)",
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
                        created_at_ms, updated_at_ms
                 FROM episodic_memories
                 WHERE category NOT IN (?1, ?2, ?3)
                 ORDER BY updated_at_ms DESC, id DESC
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
                "SELECT COUNT(*) FROM episodic_memories WHERE category NOT IN (?1, ?2, ?3)",
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
                        k.created_at_ms, k.updated_at_ms,
                        c.ts, c.app_name, c.win_title, c.ax_text, c.ocr_text, c.input_text, c.audio_text
                 FROM episodic_memories k
                 INNER JOIN captures c ON c.id = k.capture_id
                 ORDER BY k.importance DESC, COALESCE(k.occurrence_count, 0) DESC, k.updated_at_ms DESC, k.id DESC
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], |row| {
                Ok(BakeMemorySourceRecord {
                    knowledge: row_to_episodic_memory_as_knowledge(row).map_err(|_| rusqlite::Error::InvalidQuery)?,
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
        if let Some(article) = self.get_bake_article(id)? {
            return Ok(Some(KnowledgeEntryRecord {
                id: article.id,
                capture_id: article.episodic_memory_id,
                summary: article.summary,
                overview: Some(article.title),
                details: article.content,
                entities: article.entities,
                category: "bake_article".to_string(),
                importance: article.importance,
                occurrence_count: None,
                observed_at: None,
                event_time_start: None,
                event_time_end: None,
                history_view: false,
                content_origin: None,
                activity_type: None,
                is_self_generated: false,
                evidence_strength: None,
                user_verified: article.user_verified,
                user_edited: article.user_edited,
                created_at: article.created_at,
                updated_at: article.updated_at,
                created_at_ms: article.created_at_ms,
                updated_at_ms: article.updated_at_ms,
            }));
        }

        if let Some(knowledge) = self.get_bake_knowledge(id)? {
            return Ok(Some(KnowledgeEntryRecord {
                id: knowledge.id,
                capture_id: knowledge.episodic_memory_id,
                summary: knowledge.summary,
                overview: Some(knowledge.title),
                details: knowledge.content,
                entities: knowledge.entities,
                category: "bake_knowledge".to_string(),
                importance: knowledge.importance,
                occurrence_count: None,
                observed_at: None,
                event_time_start: None,
                event_time_end: None,
                history_view: false,
                content_origin: None,
                activity_type: None,
                is_self_generated: false,
                evidence_strength: None,
                user_verified: knowledge.user_verified,
                user_edited: knowledge.user_edited,
                created_at: knowledge.created_at,
                updated_at: knowledge.updated_at,
                created_at_ms: knowledge.created_at_ms,
                updated_at_ms: knowledge.updated_at_ms,
            }));
        }

        if let Some(sop) = self.get_bake_sop(id)? {
            return Ok(Some(KnowledgeEntryRecord {
                id: sop.id,
                capture_id: sop.episodic_memory_id,
                summary: sop.summary,
                overview: Some(sop.title),
                details: sop.content,
                entities: sop.entities,
                category: "bake_sop".to_string(),
                importance: sop.importance,
                occurrence_count: None,
                observed_at: None,
                event_time_start: None,
                event_time_end: None,
                history_view: false,
                content_origin: None,
                activity_type: None,
                is_self_generated: false,
                evidence_strength: None,
                user_verified: sop.user_verified,
                user_edited: sop.user_edited,
                created_at: sop.created_at,
                updated_at: sop.updated_at,
                created_at_ms: sop.created_at_ms,
                updated_at_ms: sop.updated_at_ms,
            }));
        }

        if let Some(memory) = self.get_episodic_memory(id)? {
            return Ok(Some(KnowledgeEntryRecord {
                id: memory.id,
                capture_id: memory.capture_id,
                summary: memory.summary,
                overview: memory.overview,
                details: memory.details,
                entities: memory.entities,
                category: memory.category,
                importance: memory.importance,
                occurrence_count: memory.occurrence_count,
                observed_at: memory.observed_at,
                event_time_start: memory.event_time_start,
                event_time_end: memory.event_time_end,
                history_view: memory.history_view,
                content_origin: memory.content_origin,
                activity_type: memory.activity_type,
                is_self_generated: memory.is_self_generated,
                evidence_strength: memory.evidence_strength,
                user_verified: memory.user_verified,
                user_edited: memory.user_edited,
                created_at: memory.created_at,
                updated_at: memory.updated_at,
                created_at_ms: memory.created_at_ms,
                updated_at_ms: memory.updated_at_ms,
            }));
        }

        Ok(None)
    }

    pub fn update_knowledge_details(
        &self,
        id: i64,
        summary: &str,
        overview: Option<&str>,
        details: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        let Some(entry) = self.get_knowledge_entry(id)? else {
            return Ok(false);
        };

        match entry.category.as_str() {
            "bake_article" => {
                let title = overview.or(entry.overview.as_deref()).unwrap_or(summary);
                self.update_bake_article(id, title, summary, details, entities)
            }
            "bake_knowledge" => {
                let title = overview.or(entry.overview.as_deref()).unwrap_or(summary);
                self.update_bake_knowledge(id, title, summary, details, entities)
            }
            "bake_sop" => {
                let title = overview.or(entry.overview.as_deref()).unwrap_or(summary);
                self.update_bake_sop(id, title, summary, details, entities)
            }
            _ => self.update_episodic_memory(id, summary, overview, details, entities),
        }
    }

    pub fn update_knowledge_details_system(
        &self,
        id: i64,
        summary: &str,
        overview: Option<&str>,
        details: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        let Some(entry) = self.get_knowledge_entry(id)? else {
            return Ok(false);
        };

        self.with_conn(|conn| {
            let now = current_ts_ms();
            let title = overview.or(entry.overview.as_deref()).unwrap_or(summary);
            let affected = match entry.category.as_str() {
                "bake_article" => conn.execute(
                    "UPDATE bake_articles
                     SET title = ?1, summary = ?2, content = ?3, entities = ?4,
                         updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                     WHERE id = ?5",
                    params![title, summary, details, entities, id, now],
                )?,
                "bake_knowledge" => conn.execute(
                    "UPDATE bake_knowledge
                     SET title = ?1, summary = ?2, content = ?3, entities = ?4,
                         updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                     WHERE id = ?5",
                    params![title, summary, details, entities, id, now],
                )?,
                "bake_sop" => conn.execute(
                    "UPDATE bake_sops
                     SET title = ?1, summary = ?2, content = ?3, entities = ?4,
                         updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                     WHERE id = ?5",
                    params![title, summary, details, entities, id, now],
                )?,
                _ => conn.execute(
                    "UPDATE episodic_memories
                     SET summary = ?1, overview = ?2, details = ?3, entities = ?4,
                         updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                     WHERE id = ?5",
                    params![summary, overview, details, entities, id, now],
                )?,
            };
            Ok(affected > 0)
        })
    }

    pub fn set_knowledge_verified(&self, id: i64, verified: bool) -> Result<bool, StorageError> {
        let Some(entry) = self.get_knowledge_entry(id)? else {
            return Ok(false);
        };

        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = match entry.category.as_str() {
                "bake_article" => conn.execute(
                    "UPDATE bake_articles SET user_verified = ?1,
                     updated_at = datetime(?3 / 1000, 'unixepoch'), updated_at_ms = ?3
                     WHERE id = ?2",
                    params![verified, id, now],
                )?,
                "bake_knowledge" => conn.execute(
                    "UPDATE bake_knowledge SET user_verified = ?1,
                     updated_at = datetime(?3 / 1000, 'unixepoch'), updated_at_ms = ?3
                     WHERE id = ?2",
                    params![verified, id, now],
                )?,
                "bake_sop" => conn.execute(
                    "UPDATE bake_sops SET user_verified = ?1,
                     updated_at = datetime(?3 / 1000, 'unixepoch'), updated_at_ms = ?3
                     WHERE id = ?2",
                    params![verified, id, now],
                )?,
                _ => conn.execute(
                    "UPDATE episodic_memories SET user_verified = ?1,
                     updated_at = datetime(?3 / 1000, 'unixepoch'), updated_at_ms = ?3
                     WHERE id = ?2",
                    params![verified, id, now],
                )?,
            };
            Ok(affected > 0)
        })
    }

    pub fn delete_knowledge_entry(&self, id: i64) -> Result<bool, StorageError> {
        let Some(entry) = self.get_knowledge_entry(id)? else {
            return Ok(false);
        };

        match entry.category.as_str() {
            "bake_article" => self.delete_bake_article(id),
            "bake_knowledge" => self.delete_bake_knowledge(id),
            "bake_sop" => self.delete_bake_sop(id),
            _ => self.delete_episodic_memory(id),
        }
    }
}

fn insert_knowledge_entry_inner(conn: &Connection, entry: &NewKnowledgeEntry) -> Result<i64, StorageError> {
    let now = current_ts_ms();
    conn.execute(
        "INSERT INTO knowledge_entries (
            capture_id, summary, overview, details, entities, category, importance,
            occurrence_count, observed_at, event_time_start, event_time_end,
            history_view, content_origin, activity_type, is_self_generated,
            evidence_strength, user_verified, user_edited,
            created_at, updated_at, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 0,
                   datetime(?17 / 1000, 'unixepoch'), datetime(?17 / 1000, 'unixepoch'), ?17, ?17)",
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

/// 将 episodic_memory 行转换为 KnowledgeEntryRecord（用于向后兼容）
fn row_to_episodic_memory_as_knowledge(row: &rusqlite::Row<'_>) -> Result<KnowledgeEntryRecord, StorageError> {
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

// ============================================================================
// 新表操作函数 - Episodic Memories
// ============================================================================

impl StorageManager {
    /// 插入情节记忆
    pub fn insert_episodic_memory(&self, entry: &NewEpisodicMemory) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_episodic_memory_inner(conn, entry))
    }

    /// 查询情节记忆（分页）
    pub fn list_episodic_memories_paginated(
        &self,
        category: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<EpisodicMemoryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        created_at_ms, updated_at_ms
                 FROM episodic_memories"
            );
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![];

            if let Some(cat) = category {
                sql.push_str(" WHERE category = ?");
                params.push(Box::new(cat.to_string()));
            }

            sql.push_str(" ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?");
            params.push(Box::new(limit as i64));
            params.push(Box::new(offset as i64));

            let mut stmt = conn.prepare(&sql)?;
            let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), |row| {
                Ok(row_to_episodic_memory(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    /// 统计情节记忆数量
    pub fn count_episodic_memories(&self, category: Option<&str>) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(cat) = category {
                ("SELECT COUNT(*) FROM episodic_memories WHERE category = ?".to_string(), vec![Box::new(cat.to_string())])
            } else {
                ("SELECT COUNT(*) FROM episodic_memories".to_string(), vec![])
            };

            let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
            conn.query_row(&sql, param_refs.as_slice(), |row| row.get(0)).map_err(StorageError::Sqlite)
        })
    }

    /// 获取单条情节记忆
    pub fn get_episodic_memory(&self, id: i64) -> Result<Option<EpisodicMemoryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        created_at_ms, updated_at_ms
                 FROM episodic_memories WHERE id = ?1"
            )?;
            match stmt.query_row(params![id], |row| {
                row_to_episodic_memory(row).map_err(|_| rusqlite::Error::InvalidQuery)
            }) {
                Ok(entry) => Ok(Some(entry)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(StorageError::Sqlite(e)),
            }
        })
    }

    /// 更新情节记忆
    pub fn update_episodic_memory(
        &self,
        id: i64,
        summary: &str,
        overview: Option<&str>,
        details: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = conn.execute(
                "UPDATE episodic_memories
                 SET summary = ?1, overview = ?2, details = ?3, entities = ?4, user_edited = 1,
                     updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                 WHERE id = ?5",
                params![summary, overview, details, entities, id, now],
            )?;
            Ok(affected > 0)
        })
    }

    /// 设置情节记忆验证状态
    pub fn set_episodic_memory_verified(&self, id: i64, verified: bool) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = conn.execute(
                "UPDATE episodic_memories SET user_verified = ?1,
                 updated_at = datetime(?3 / 1000, 'unixepoch'), updated_at_ms = ?3
                 WHERE id = ?2",
                params![verified, id, now],
            )?;
            Ok(affected > 0)
        })
    }

    /// 删除情节记忆
    pub fn delete_episodic_memory(&self, id: i64) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "DELETE FROM episodic_memories WHERE id = ?1",
                params![id],
            )?;
            Ok(affected > 0)
        })
    }
}

fn insert_episodic_memory_inner(conn: &Connection, entry: &NewEpisodicMemory) -> Result<i64, StorageError> {
    let now = current_ts_ms();
    conn.execute(
        "INSERT INTO episodic_memories (
            capture_id, summary, overview, details, entities, category, importance,
            occurrence_count, observed_at, event_time_start, event_time_end,
            history_view, content_origin, activity_type, is_self_generated,
            evidence_strength, user_verified, user_edited,
            created_at, updated_at, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 0,
                   datetime(?17 / 1000, 'unixepoch'), datetime(?17 / 1000, 'unixepoch'), ?17, ?17)",
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

fn row_to_episodic_memory(row: &rusqlite::Row<'_>) -> Result<EpisodicMemoryRecord, StorageError> {
    Ok(EpisodicMemoryRecord {
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

// ============================================================================
// Bake Articles 操作
// ============================================================================

impl StorageManager {
    pub fn insert_bake_article(&self, article: &NewBakeArticle) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            conn.execute(
                "INSERT INTO bake_articles (
                    episodic_memory_id, title, summary, content, entities, importance,
                    user_verified, user_edited,
                    created_at, updated_at, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0,
                           datetime(?7 / 1000, 'unixepoch'), datetime(?7 / 1000, 'unixepoch'), ?7, ?7)",
                params![
                    article.episodic_memory_id,
                    article.title,
                    article.summary,
                    article.content,
                    article.entities,
                    article.importance,
                    now,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn list_bake_articles_paginated(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<BakeArticleRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, episodic_memory_id, title, summary, content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms
                 FROM bake_articles ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?"
            )?;
            let rows = stmt.query_map(params![limit as i64, offset as i64], |row| {
                Ok(row_to_bake_article(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_bake_articles(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM bake_articles", [], |row| row.get(0))
                .map_err(StorageError::Sqlite)
        })
    }

    pub fn get_bake_article(&self, id: i64) -> Result<Option<BakeArticleRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, episodic_memory_id, title, summary, content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms
                 FROM bake_articles WHERE id = ?1"
            )?;
            match stmt.query_row(params![id], |row| {
                row_to_bake_article(row).map_err(|_| rusqlite::Error::InvalidQuery)
            }) {
                Ok(article) => Ok(Some(article)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(StorageError::Sqlite(e)),
            }
        })
    }

    pub fn update_bake_article(
        &self,
        id: i64,
        title: &str,
        summary: &str,
        content: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = conn.execute(
                "UPDATE bake_articles
                 SET title = ?1, summary = ?2, content = ?3, entities = ?4, user_edited = 1,
                     updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                 WHERE id = ?5",
                params![title, summary, content, entities, id, now],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn delete_bake_article(&self, id: i64) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute("DELETE FROM bake_articles WHERE id = ?1", params![id])?;
            Ok(affected > 0)
        })
    }
}

fn row_to_bake_article(row: &rusqlite::Row<'_>) -> Result<BakeArticleRecord, StorageError> {
    Ok(BakeArticleRecord {
        id: row.get(0)?,
        episodic_memory_id: row.get(1)?,
        title: row.get(2)?,
        summary: row.get(3)?,
        content: row.get(4)?,
        entities: row.get(5)?,
        importance: row.get::<_, Option<i64>>(6)?.unwrap_or(3),
        user_verified: row.get::<_, Option<bool>>(7)?.unwrap_or(false),
        user_edited: row.get::<_, Option<bool>>(8)?.unwrap_or(false),
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        created_at_ms: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
        updated_at_ms: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
    })
}

// ============================================================================
// Bake Knowledge 操作
// ============================================================================

impl StorageManager {
    pub fn insert_bake_knowledge(&self, knowledge: &NewBakeKnowledge) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            conn.execute(
                "INSERT INTO bake_knowledge (
                    episodic_memory_id, title, summary, content, entities, importance,
                    user_verified, user_edited,
                    created_at, updated_at, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0,
                           datetime(?7 / 1000, 'unixepoch'), datetime(?7 / 1000, 'unixepoch'), ?7, ?7)",
                params![
                    knowledge.episodic_memory_id,
                    knowledge.title,
                    knowledge.summary,
                    knowledge.content,
                    knowledge.entities,
                    knowledge.importance,
                    now,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn count_bake_knowledge(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM bake_knowledge", [], |row| row.get(0))
                .map_err(StorageError::Sqlite)
        })
    }

    pub fn get_bake_knowledge(&self, id: i64) -> Result<Option<BakeKnowledgeRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, episodic_memory_id, title, summary, content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms
                 FROM bake_knowledge WHERE id = ?1"
            )?;
            match stmt.query_row(params![id], |row| {
                row_to_bake_knowledge(row).map_err(|_| rusqlite::Error::InvalidQuery)
            }) {
                Ok(knowledge) => Ok(Some(knowledge)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(StorageError::Sqlite(e)),
            }
        })
    }

    pub fn update_bake_knowledge(
        &self,
        id: i64,
        title: &str,
        summary: &str,
        content: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = conn.execute(
                "UPDATE bake_knowledge
                 SET title = ?1, summary = ?2, content = ?3, entities = ?4, user_edited = 1,
                     updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                 WHERE id = ?5",
                params![title, summary, content, entities, id, now],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn delete_bake_knowledge(&self, id: i64) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute("DELETE FROM bake_knowledge WHERE id = ?1", params![id])?;
            Ok(affected > 0)
        })
    }
}

fn row_to_bake_knowledge(row: &rusqlite::Row<'_>) -> Result<BakeKnowledgeRecord, StorageError> {
    Ok(BakeKnowledgeRecord {
        id: row.get(0)?,
        episodic_memory_id: row.get(1)?,
        title: row.get(2)?,
        summary: row.get(3)?,
        content: row.get(4)?,
        entities: row.get(5)?,
        importance: row.get::<_, Option<i64>>(6)?.unwrap_or(3),
        user_verified: row.get::<_, Option<bool>>(7)?.unwrap_or(false),
        user_edited: row.get::<_, Option<bool>>(8)?.unwrap_or(false),
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        created_at_ms: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
        updated_at_ms: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
    })
}

// ============================================================================
// Bake SOPs 操作
// ============================================================================

impl StorageManager {
    pub fn insert_bake_sop(&self, sop: &NewBakeSop) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            conn.execute(
                "INSERT INTO bake_sops (
                    episodic_memory_id, title, summary, content, entities, importance,
                    user_verified, user_edited,
                    created_at, updated_at, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0,
                           datetime(?7 / 1000, 'unixepoch'), datetime(?7 / 1000, 'unixepoch'), ?7, ?7)",
                params![
                    sop.episodic_memory_id,
                    sop.title,
                    sop.summary,
                    sop.content,
                    sop.entities,
                    sop.importance,
                    now,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn list_bake_sops_paginated(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<BakeSopRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, episodic_memory_id, title, summary, content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms
                 FROM bake_sops ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?"
            )?;
            let rows = stmt.query_map(params![limit as i64, offset as i64], |row| {
                Ok(row_to_bake_sop(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_bake_sops(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM bake_sops", [], |row| row.get(0))
                .map_err(StorageError::Sqlite)
        })
    }

    pub fn get_bake_sop(&self, id: i64) -> Result<Option<BakeSopRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, episodic_memory_id, title, summary, content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms
                 FROM bake_sops WHERE id = ?1"
            )?;
            match stmt.query_row(params![id], |row| {
                row_to_bake_sop(row).map_err(|_| rusqlite::Error::InvalidQuery)
            }) {
                Ok(sop) => Ok(Some(sop)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(StorageError::Sqlite(e)),
            }
        })
    }

    pub fn update_bake_sop(
        &self,
        id: i64,
        title: &str,
        summary: &str,
        content: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = conn.execute(
                "UPDATE bake_sops
                 SET title = ?1, summary = ?2, content = ?3, entities = ?4, user_edited = 1,
                     updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                 WHERE id = ?5",
                params![title, summary, content, entities, id, now],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn delete_bake_sop(&self, id: i64) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute("DELETE FROM bake_sops WHERE id = ?1", params![id])?;
            Ok(affected > 0)
        })
    }
}

fn row_to_bake_sop(row: &rusqlite::Row<'_>) -> Result<BakeSopRecord, StorageError> {
    Ok(BakeSopRecord {
        id: row.get(0)?,
        episodic_memory_id: row.get(1)?,
        title: row.get(2)?,
        summary: row.get(3)?,
        content: row.get(4)?,
        entities: row.get(5)?,
        importance: row.get::<_, Option<i64>>(6)?.unwrap_or(3),
        user_verified: row.get::<_, Option<bool>>(7)?.unwrap_or(false),
        user_edited: row.get::<_, Option<bool>>(8)?.unwrap_or(false),
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        created_at_ms: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
        updated_at_ms: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
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
