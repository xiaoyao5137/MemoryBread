use rusqlite::{params, Connection};

use crate::storage::{
    db::current_ts_ms,
    error::StorageError,
    models_bake::{
        BakeDocumentRecord, BakeKnowledgeRecord, BakeMemorySourceRecord, BakeSopRecord,
        EpisodicMemoryRecord, NewBakeKnowledge, NewBakeSop, NewEpisodicMemory, NewTimeline,
        TimelineRecord,
    },
    StorageManager,
};

fn keyword_terms(query: &str) -> Vec<String> {
    let mut terms = query
        .split(|ch: char| ch.is_whitespace() || ch.is_ascii_punctuation())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    if terms.len() == 1 && terms[0].chars().count() >= 5 {
        let chars = terms[0].chars().collect::<Vec<_>>();
        if chars.iter().any(|ch| !ch.is_ascii()) {
            for window in chars.windows(2) {
                let term = window.iter().collect::<String>();
                if !terms.contains(&term) {
                    terms.push(term);
                }
            }
        }
    }

    terms
}

fn extract_document_identity(url: &str) -> String {
    let url = url.trim();
    if url.is_empty() {
        return url.to_string();
    }

    let doc_markers = [
        "docs.corp",
        "/docs/",
        "docs.google",
        "/document/",
        "yuque.com",
        "feishu.cn/docx",
        "feishu.cn/wiki",
        "notion.so",
        "confluence",
        "/wiki/",
        "shimo.im",
        "/d/home/",
        "/s/home/",
    ];

    let lowered = url.to_lowercase();
    if !doc_markers.iter().any(|m| lowered.contains(m)) {
        return url.to_string();
    }

    let without_protocol = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);

    if let Some((host, rest)) = without_protocol.split_once('/') {
        let path = rest.split('?').next().unwrap_or(rest).trim_end_matches('/');

        if path.is_empty() {
            return host.to_lowercase();
        }

        if let Some(last_segment) = path.rsplit('/').next() {
            if last_segment.len() >= 6 {
                return format!("{}::{}", host.to_lowercase(), last_segment);
            }
        }

        format!("{}::{}", host.to_lowercase(), path.to_lowercase())
    } else {
        without_protocol.to_lowercase()
    }
}

impl StorageManager {
    pub fn get_document_templates(
        &self,
        limit: Option<usize>,
    ) -> Result<Vec<BakeDocumentRecord>, StorageError> {
        self.with_conn(|conn| {
            let lim = limit.unwrap_or(10);
            let mut stmt = conn.prepare(
                "SELECT id, title, doc_type, status, tags, applicable_tasks, source_memory_ids,
                        source_capture_ids, source_episode_ids, linked_knowledge_ids,
                        sections_json, style_phrases, replacement_rules, summary, full_content,
                        structured_content, prompt_hint, diagram_code, image_assets,
                        source_app_name, source_win_title, source_url, content_hash, language,
                        usage_count, match_score, match_level, creation_mode, review_status,
                        evidence_summary, generation_version, deleted_at,
                        created_at, updated_at
                 FROM bake_documents
                 WHERE deleted_at IS NULL AND status IN ('active', 'enabled')
                 ORDER BY COALESCE(match_score, 0) DESC, updated_at DESC
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map([lim], |row| {
                Ok(BakeDocumentRecord {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    doc_type: row.get(2)?,
                    status: row.get(3)?,
                    tags: row.get(4)?,
                    applicable_tasks: row.get(5)?,
                    source_memory_ids: row.get(6)?,
                    source_capture_ids: row.get(7)?,
                    source_episode_ids: row.get(8)?,
                    linked_knowledge_ids: row.get(9)?,
                    sections_json: row.get(10)?,
                    style_phrases: row.get(11)?,
                    replacement_rules: row.get(12)?,
                    summary: row.get(13)?,
                    full_content: row.get(14)?,
                    structured_content: row.get(15)?,
                    prompt_hint: row.get(16)?,
                    diagram_code: row.get(17)?,
                    image_assets: row.get(18)?,
                    source_app_name: row.get(19)?,
                    source_win_title: row.get(20)?,
                    source_url: row.get(21)?,
                    content_hash: row.get(22)?,
                    language: row.get(23)?,
                    usage_count: row.get(24)?,
                    match_score: row.get(25)?,
                    match_level: row.get(26)?,
                    creation_mode: row.get(27)?,
                    review_status: row.get(28)?,
                    evidence_summary: row.get(29)?,
                    generation_version: row.get(30)?,
                    deleted_at: row.get(31)?,
                    created_at: row.get(32)?,
                    updated_at: row.get(33)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
    }

    pub fn insert_timeline_entry(&self, entry: &NewTimeline) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            match entry.category.as_str() {
                "bake_knowledge" | "bake_sop" => {
                    let source = NewEpisodicMemory {
                        capture_id: entry.capture_id,
                        summary: entry.summary.clone(),
                        overview: entry.overview.clone(),
                        details: entry.details.clone(),
                        entities: entry.entities.clone(),
                        category: "bake_article".to_string(),
                        importance: entry.importance,
                        occurrence_count: entry.occurrence_count,
                        observed_at: entry.observed_at,
                        event_time_start: entry.event_time_start,
                        event_time_end: entry.event_time_end,
                        history_view: entry.history_view,
                        content_origin: entry.content_origin.clone(),
                        activity_type: entry.activity_type.clone(),
                        is_self_generated: entry.is_self_generated,
                        evidence_strength: entry.evidence_strength.clone(),
                        capture_ids: None,
                        start_time: None,
                        end_time: None,
                        duration_minutes: None,
                        frag_app_name: None,
                        frag_win_title: None,
                        time_range_start: None,
                        time_range_end: None,
                        key_timestamps: None,
                    };
                    let source_id = insert_episodic_memory_inner(conn, &source)?;
                    let now = current_ts_ms();
                    let title = entry.overview.as_deref().unwrap_or(&entry.summary);
                    let sql = if entry.category == "bake_knowledge" {
                        "INSERT INTO bake_knowledge (
                            timeline_id, title, summary, content, detailed_content, entities, importance,
                            user_verified, user_edited,
                            created_at, updated_at, created_at_ms, updated_at_ms
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0,
                                   datetime(?8 / 1000, 'unixepoch'), datetime(?8 / 1000, 'unixepoch'), ?8, ?8)"
                    } else {
                        "INSERT INTO bake_sops (
                            timeline_id, title, summary, content, detailed_content, entities, importance,
                            user_verified, user_edited,
                            created_at, updated_at, created_at_ms, updated_at_ms
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0,
                                   datetime(?8 / 1000, 'unixepoch'), datetime(?8 / 1000, 'unixepoch'), ?8, ?8)"
                    };
                    conn.execute(
                        sql,
                        params![
                            source_id,
                            title,
                            entry.summary,
                            entry.details,
                            entry.details,
                            entry.entities,
                            entry.importance,
                            now,
                        ],
                    )?;
                    Ok(conn.last_insert_rowid())
                }
                _ => insert_episodic_memory_inner(conn, entry),
            }
        })
    }

    /// 向后兼容函数：根据 category 查询对应的表
    pub fn list_timelines_by_category(
        &self,
        category: &str,
    ) -> Result<Vec<TimelineRecord>, StorageError> {
        match category {
            "bake_article" => {
                let memories = self.list_timelines_paginated(Some("bake_article"), 5000, 0)?;
                Ok(memories
                    .into_iter()
                    .map(|m| TimelineRecord {
                        id: m.id,
                        capture_id: m.capture_id,
                        summary: m.summary,
                        overview: m.overview,
                        details: m.details,
                        detailed_content: m.detailed_content,
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
                        capture_ids: None,
                        start_time: None,
                        end_time: None,
                        duration_minutes: None,
                        frag_app_name: None,
                        frag_win_title: None,
                        time_range_start: None,
                        time_range_end: None,
                        key_timestamps: None,
                    })
                    .collect())
            }
            "bake_knowledge" => {
                let knowledge = self.list_bake_knowledge_new(5000, 0)?;
                Ok(knowledge
                    .into_iter()
                    .map(|k| TimelineRecord {
                        id: k.id,
                        capture_id: k.timeline_id,
                        summary: k.summary,
                        overview: Some(k.title),
                        details: k.content,
                        detailed_content: k.detailed_content,
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
                        capture_ids: None,
                        start_time: None,
                        end_time: None,
                        duration_minutes: None,
                        frag_app_name: None,
                        frag_win_title: None,
                        time_range_start: None,
                        time_range_end: None,
                        key_timestamps: None,
                    })
                    .collect())
            }
            "bake_sop" => {
                let sops = self.list_bake_sops_paginated(5000, 0)?;
                Ok(sops
                    .into_iter()
                    .map(|s| TimelineRecord {
                        id: s.id,
                        capture_id: s.timeline_id,
                        summary: s.summary,
                        overview: Some(s.title),
                        details: s.content,
                        detailed_content: s.detailed_content,
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
                        capture_ids: None,
                        start_time: None,
                        end_time: None,
                        duration_minutes: None,
                        frag_app_name: None,
                        frag_win_title: None,
                        time_range_start: None,
                        time_range_end: None,
                        key_timestamps: None,
                    })
                    .collect())
            }
            _ => {
                // 查询 timelines 表
                let memories = self.list_timelines_paginated(Some(category), 5000, 0)?;
                Ok(memories
                    .into_iter()
                    .map(|m| TimelineRecord {
                        id: m.id,
                        capture_id: m.capture_id,
                        summary: m.summary,
                        overview: m.overview,
                        details: m.details,
                        detailed_content: m.detailed_content,
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
                        capture_ids: None,
                        start_time: None,
                        end_time: None,
                        duration_minutes: None,
                        frag_app_name: None,
                        frag_win_title: None,
                        time_range_start: None,
                        time_range_end: None,
                        key_timestamps: None,
                    })
                    .collect())
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
    ) -> Result<Vec<TimelineRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT k.id, k.capture_id, k.summary, k.overview, k.details, k.entities, k.category, k.importance,
                        k.occurrence_count, k.observed_at, k.event_time_start, k.event_time_end,
                        k.history_view, k.content_origin, k.activity_type, k.is_self_generated,
                        k.evidence_strength, k.user_verified, k.user_edited, k.created_at, k.updated_at,
                        k.created_at_ms, k.updated_at_ms, k.capture_ids, k.start_time, k.end_time, k.duration_minutes,
                        k.frag_app_name, k.frag_win_title, k.time_range_start, k.time_range_end, k.key_timestamps
                 FROM timelines k
                 WHERE k.category = 'bake_article'",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![];
            let query_terms = query.map(keyword_terms).unwrap_or_default();
            if !query_terms.is_empty() {
                let query_clause = query_terms
                    .iter()
                    .map(|_| {
                        "(k.summary LIKE ? OR COALESCE(k.overview, '') LIKE ? OR COALESCE(k.details, '') LIKE ? OR COALESCE(k.frag_win_title, '') LIKE ? OR EXISTS (
                            SELECT 1 FROM captures c
                            WHERE (c.id = k.capture_id OR COALESCE(k.capture_ids, '') LIKE ('%' || c.id || '%'))
                              AND (COALESCE(c.win_title, '') LIKE ? OR COALESCE(c.webpage_title, '') LIKE ? OR COALESCE(c.url, '') LIKE ? OR COALESCE(c.ax_text, '') LIKE ? OR COALESCE(c.ocr_text, '') LIKE ? OR COALESCE(c.input_text, '') LIKE ? OR COALESCE(c.audio_text, '') LIKE ?)
                        ))".to_string()
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ");
                sql.push_str(" AND (");
                sql.push_str(&query_clause);
                sql.push(')');
                for term in &query_terms {
                    let pattern = format!("%{}%", term);
                    for _ in 0..11 {
                        bind_values.push(Box::new(pattern.clone()));
                    }
                }
            }
            if let Some(value) = from_ts {
                sql.push_str(" AND k.created_at_ms >= ?");
                bind_values.push(Box::new(value));
            }
            if let Some(value) = to_ts {
                sql.push_str(" AND k.created_at_ms <= ?");
                bind_values.push(Box::new(value));
            }
            sql.push_str(" ORDER BY k.updated_at_ms DESC, k.id DESC LIMIT ? OFFSET ?");
            bind_values.push(Box::new(limit as i64));
            bind_values.push(Box::new(offset as i64));

            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(row_to_timeline_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
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
                 FROM timelines k
                 WHERE k.category = 'bake_article'",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![];
            let query_terms = query.map(keyword_terms).unwrap_or_default();
            if !query_terms.is_empty() {
                let query_clause = query_terms
                    .iter()
                    .map(|_| {
                        "(k.summary LIKE ? OR COALESCE(k.overview, '') LIKE ? OR COALESCE(k.details, '') LIKE ? OR COALESCE(k.frag_win_title, '') LIKE ? OR EXISTS (
                            SELECT 1 FROM captures c
                            WHERE (c.id = k.capture_id OR COALESCE(k.capture_ids, '') LIKE ('%' || c.id || '%'))
                              AND (COALESCE(c.win_title, '') LIKE ? OR COALESCE(c.webpage_title, '') LIKE ? OR COALESCE(c.url, '') LIKE ? OR COALESCE(c.ax_text, '') LIKE ? OR COALESCE(c.ocr_text, '') LIKE ? OR COALESCE(c.input_text, '') LIKE ? OR COALESCE(c.audio_text, '') LIKE ?)
                        ))".to_string()
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ");
                sql.push_str(" AND (");
                sql.push_str(&query_clause);
                sql.push(')');
                for term in &query_terms {
                    let pattern = format!("%{}%", term);
                    for _ in 0..11 {
                        bind_values.push(Box::new(pattern.clone()));
                    }
                }
            }
            if let Some(value) = from_ts {
                sql.push_str(" AND k.created_at_ms >= ?");
                bind_values.push(Box::new(value));
            }
            if let Some(value) = to_ts {
                sql.push_str(" AND k.created_at_ms <= ?");
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
    ) -> Result<Vec<TimelineRecord>, StorageError> {
        // 使用新表，但返回旧格式以保持兼容
        let knowledge = self.list_bake_knowledge_new(limit, offset)?;
        Ok(knowledge
            .into_iter()
            .map(|k| TimelineRecord {
                id: k.id,
                capture_id: k.timeline_id,
                summary: k.summary,
                overview: Some(k.title),
                details: k.content,
                detailed_content: k.detailed_content,
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
                capture_ids: None,
                start_time: None,
                end_time: None,
                duration_minutes: None,
                frag_app_name: None,
                frag_win_title: None,
                time_range_start: None,
                time_range_end: None,
                key_timestamps: None,
            })
            .collect())
    }

    pub fn find_document_by_source_url(
        &self,
        url: &str,
    ) -> Result<Option<BakeDocumentRecord>, StorageError> {
        if url.trim().is_empty() {
            return Ok(None);
        }
        let doc_id = extract_document_identity(url);
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, doc_type, status, tags, applicable_tasks, source_memory_ids,
                        source_capture_ids, source_episode_ids, linked_knowledge_ids,
                        sections_json, style_phrases, replacement_rules, summary, full_content,
                        structured_content, prompt_hint, diagram_code, image_assets,
                        source_app_name, source_win_title, source_url, content_hash, language,
                        usage_count, match_score, match_level, creation_mode, review_status,
                        evidence_summary, generation_version, deleted_at,
                        created_at, updated_at
                 FROM bake_documents
                 WHERE deleted_at IS NULL AND source_url IS NOT NULL
                   AND (source_url = ?1 OR instr(source_url, ?2) > 0)
                 LIMIT 1",
            )?;
            let mut rows = stmt.query(rusqlite::params![url, &doc_id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(BakeDocumentRecord {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    doc_type: row.get(2)?,
                    status: row.get(3)?,
                    tags: row.get(4)?,
                    applicable_tasks: row.get(5)?,
                    source_memory_ids: row.get(6)?,
                    source_capture_ids: row.get(7)?,
                    source_episode_ids: row.get(8)?,
                    linked_knowledge_ids: row.get(9)?,
                    sections_json: row.get(10)?,
                    style_phrases: row.get(11)?,
                    replacement_rules: row.get(12)?,
                    summary: row.get(13)?,
                    full_content: row.get(14)?,
                    structured_content: row.get(15)?,
                    prompt_hint: row.get(16)?,
                    diagram_code: row.get(17)?,
                    image_assets: row.get(18)?,
                    source_app_name: row.get(19)?,
                    source_win_title: row.get(20)?,
                    source_url: row.get(21)?,
                    content_hash: row.get(22)?,
                    language: row.get(23)?,
                    usage_count: row.get(24)?,
                    match_score: row.get(25)?,
                    match_level: row.get(26)?,
                    creation_mode: row.get(27)?,
                    review_status: row.get(28)?,
                    evidence_summary: row.get(29)?,
                    generation_version: row.get(30)?,
                    deleted_at: row.get(31)?,
                    created_at: row.get(32)?,
                    updated_at: row.get(33)?,
                }))
            } else {
                Ok(None)
            }
        })
    }

    /// 新的 bake_knowledge 查询函数（返回新类型）
    fn list_bake_knowledge_new(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<BakeKnowledgeRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, timeline_id, title, summary, content, detailed_content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms, source_capture_ids
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
    ) -> Result<Vec<TimelineRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        created_at_ms, updated_at_ms, capture_ids, start_time, end_time,
                        duration_minutes, frag_app_name, frag_win_title, time_range_start,
                        time_range_end, key_timestamps
                 FROM timelines
                 WHERE category NOT IN (?, ?, ?, ?)",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new("bake_article".to_string()),
                Box::new("bake_sop".to_string()),
                Box::new("bake_knowledge".to_string()),
                Box::new("legacy_bake_candidate".to_string()),
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
                Ok(row_to_timeline_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_non_bake_knowledge_filtered(
        &self,
        query: Option<&str>,
    ) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT COUNT(*) FROM timelines WHERE category NOT IN (?, ?, ?, ?)",
            );
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new("bake_article".to_string()),
                Box::new("bake_sop".to_string()),
                Box::new("bake_knowledge".to_string()),
                Box::new("legacy_bake_candidate".to_string()),
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

    pub fn list_non_bake_knowledge(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<TimelineRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        created_at_ms, updated_at_ms, capture_ids, start_time, end_time,
                        duration_minutes, frag_app_name, frag_win_title, time_range_start,
                        time_range_end, key_timestamps
                 FROM timelines
                 WHERE category NOT IN (?1, ?2, ?3, ?4)
                 ORDER BY updated_at_ms DESC, id DESC
                 LIMIT ?5 OFFSET ?6",
            )?;
            let rows = stmt.query_map(
                params![
                    "bake_article",
                    "bake_sop",
                    "bake_knowledge",
                    "legacy_bake_candidate",
                    limit as i64,
                    offset as i64
                ],
                |row| Ok(row_to_timeline_entry(row).map_err(|_| rusqlite::Error::InvalidQuery)?),
            )?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    pub fn count_non_bake_knowledge(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM timelines WHERE category NOT IN (?1, ?2, ?3, ?4)",
                params![
                    "bake_article",
                    "bake_sop",
                    "bake_knowledge",
                    "legacy_bake_candidate"
                ],
                |row| row.get(0),
            )
            .map_err(StorageError::Sqlite)
        })
    }

    pub fn list_bake_memory_init_candidates(
        &self,
        since_ts_ms: i64,
        limit: usize,
    ) -> Result<Vec<BakeMemorySourceRecord>, StorageError> {
        self.list_bake_memory_init_candidates_with_max_failures(since_ts_ms, limit, i64::MAX)
    }

    /// 与 [`list_bake_memory_init_candidates`] 相同，但额外按 `bake_retry_state.failure_count`
    /// 过滤：失败次数 >= `max_failures` 的 timeline 会被永久跳过，避免毒丸候选反复触发整轮失败。
    pub fn list_bake_memory_init_candidates_with_max_failures(
        &self,
        since_ts_ms: i64,
        limit: usize,
        max_failures: i64,
    ) -> Result<Vec<BakeMemorySourceRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT k.id, k.capture_id, k.summary, k.overview, k.details, k.entities, k.category, k.importance,
                        k.occurrence_count, k.observed_at, k.event_time_start, k.event_time_end,
                        k.history_view, k.content_origin, k.activity_type, k.is_self_generated,
                        k.evidence_strength, k.user_verified, k.user_edited, k.created_at, k.updated_at,
                        k.created_at_ms,
                        MAX(k.updated_at_ms, COALESCE((SELECT MAX(c2.ts) FROM captures c2 WHERE c2.timeline_id = k.id), 0)),
                        k.capture_ids, k.start_time, k.end_time,
                        k.duration_minutes, k.frag_app_name, k.frag_win_title, k.time_range_start,
                        k.time_range_end, k.key_timestamps,
                        c.ts, c.app_name, c.win_title, c.ax_text, c.ocr_text, c.input_text, c.audio_text,
                        c.url, c.webpage_title
                 FROM timelines k
                 INNER JOIN captures c ON c.id = k.capture_id
                 LEFT JOIN bake_retry_state r ON r.timeline_id = k.id
                 WHERE k.category NOT IN ('bake_article', 'bake_knowledge', 'bake_sop', 'legacy_bake_candidate')
                   AND (
                     MAX(k.updated_at_ms, COALESCE((SELECT MAX(c2.ts) FROM captures c2 WHERE c2.timeline_id = k.id), 0)) > ?1
                     OR EXISTS (
                       SELECT 1
                       FROM bake_documents d
                       JOIN captures c3 ON c3.timeline_id = k.id
                       WHERE d.deleted_at IS NULL
                         AND (
                           d.source_memory_ids = ('[\"' || k.id || '\"]')
                           OR d.source_memory_ids LIKE ('[\"' || k.id || '\",%')
                           OR d.source_memory_ids LIKE ('%,\"' || k.id || '\",%')
                           OR d.source_memory_ids LIKE ('%,\"' || k.id || '\"]')
                         )
                         AND instr(d.source_capture_ids, '\"' || c3.id || '\"') = 0
                     )
                   )
                   AND COALESCE(r.failure_count, 0) < ?3
                 ORDER BY MAX(k.updated_at_ms, COALESCE((SELECT MAX(c2.ts) FROM captures c2 WHERE c2.timeline_id = k.id), 0)) ASC, k.id ASC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![since_ts_ms, limit as i64, max_failures], |row| {
                Ok(BakeMemorySourceRecord {
                    timeline: row_to_timeline_record(row).map_err(|_| rusqlite::Error::InvalidQuery)?,
                    capture_ts: row.get(32)?,
                    capture_app_name: row.get(33)?,
                    capture_win_title: row.get(34)?,
                    capture_ax_text: row.get(35)?,
                    capture_ocr_text: row.get(36)?,
                    capture_input_text: row.get(37)?,
                    capture_audio_text: row.get(38)?,
                    capture_url: row.get::<_, Option<String>>(39)?.and_then(|s| {
                        let t = s.trim();
                        if t.is_empty() { None } else { Some(t.to_string()) }
                    }),
                    capture_webpage_title: row.get(40)?,
                    url_aggregated_text: None,
                    url_aggregated_capture_count: 0,
                })
            })?;
            let mut records: Vec<BakeMemorySourceRecord> =
                rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)?;
            for record in records.iter_mut() {
                let full_member_ids =
                    list_timeline_capture_ids(conn, record.timeline.id, record.timeline.capture_id)?;
                if !full_member_ids.is_empty() {
                    record.timeline.capture_ids = Some(to_json_array_string(&full_member_ids));
                }

                // 优先聚合 timeline 全部成员 capture 的内容（含文档型成员的正文），
                // 因为主 capture 常是 IM，代表不了 timeline 里浏览/编辑的文档。
                let member_ids = parse_capture_ids(record.timeline.capture_ids.as_deref());
                let member_aggregated = if member_ids.len() > 1 {
                    aggregate_member_capture_text(
                        conn,
                        &member_ids,
                        record.timeline.capture_id,
                    )?
                } else {
                    None
                };

                if let Some((aggregated, count)) = member_aggregated {
                    record.url_aggregated_text = Some(aggregated);
                    record.url_aggregated_capture_count = count;
                } else if let Some(url) = record.capture_url.clone() {
                    // 回退：单 capture 场景仍按主 capture 的 URL 聚合历史浏览。
                    if let Some((aggregated, count)) =
                        aggregate_url_capture_text(conn, &url, record.capture_ts)?
                    {
                        record.url_aggregated_text = Some(aggregated);
                        record.url_aggregated_capture_count = count;
                    }
                }
            }
            Ok(records)
        })
    }

    pub fn get_timeline_entry(&self, id: i64) -> Result<Option<TimelineRecord>, StorageError> {
        if let Some(knowledge) = self.get_bake_knowledge(id)? {
            return Ok(Some(TimelineRecord {
                id: knowledge.id,
                capture_id: knowledge.timeline_id,
                summary: knowledge.summary,
                overview: Some(knowledge.title),
                details: knowledge.content,
                detailed_content: knowledge.detailed_content,
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
                capture_ids: None,
                start_time: None,
                end_time: None,
                duration_minutes: None,
                frag_app_name: None,
                frag_win_title: None,
                time_range_start: None,
                time_range_end: None,
                key_timestamps: None,
            }));
        }

        if let Some(sop) = self.get_bake_sop(id)? {
            return Ok(Some(TimelineRecord {
                id: sop.id,
                capture_id: sop.timeline_id,
                summary: sop.summary,
                overview: Some(sop.title),
                details: sop.content,
                detailed_content: sop.detailed_content,
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
                capture_ids: None,
                start_time: None,
                end_time: None,
                duration_minutes: None,
                frag_app_name: None,
                frag_win_title: None,
                time_range_start: None,
                time_range_end: None,
                key_timestamps: None,
            }));
        }

        if let Some(memory) = self.get_episodic_memory(id)? {
            return Ok(Some(TimelineRecord {
                id: memory.id,
                capture_id: memory.capture_id,
                summary: memory.summary,
                overview: memory.overview,
                details: memory.details,
                detailed_content: memory.detailed_content,
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
                capture_ids: None,
                start_time: None,
                end_time: None,
                duration_minutes: None,
                frag_app_name: None,
                frag_win_title: None,
                time_range_start: None,
                time_range_end: None,
                key_timestamps: None,
            }));
        }

        Ok(None)
    }

    pub fn update_timeline_details(
        &self,
        id: i64,
        summary: &str,
        overview: Option<&str>,
        details: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        let Some(entry) = self.get_timeline_entry(id)? else {
            return Ok(false);
        };

        match entry.category.as_str() {
            "bake_article" => self.update_episodic_memory(id, summary, overview, details, entities),
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

    pub fn update_timeline_details_system(
        &self,
        id: i64,
        summary: &str,
        overview: Option<&str>,
        details: Option<&str>,
        entities: &str,
    ) -> Result<bool, StorageError> {
        let Some(entry) = self.get_timeline_entry(id)? else {
            return Ok(false);
        };

        self.with_conn(|conn| {
            let now = current_ts_ms();
            let title = overview.or(entry.overview.as_deref()).unwrap_or(summary);
            let affected = match entry.category.as_str() {
                "bake_article" => conn.execute(
                    "UPDATE timelines
                     SET summary = ?1, overview = ?2, details = ?3, entities = ?4,
                         updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                     WHERE id = ?5",
                    params![summary, overview, details, entities, id, now],
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
                    "UPDATE timelines
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
        let Some(entry) = self.get_timeline_entry(id)? else {
            return Ok(false);
        };

        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = match entry.category.as_str() {
                "bake_article" => conn.execute(
                    "UPDATE timelines SET user_verified = ?1,
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
                    "UPDATE timelines SET user_verified = ?1,
                     updated_at = datetime(?3 / 1000, 'unixepoch'), updated_at_ms = ?3
                     WHERE id = ?2",
                    params![verified, id, now],
                )?,
            };
            Ok(affected > 0)
        })
    }

    pub fn delete_knowledge_entry(&self, id: i64) -> Result<bool, StorageError> {
        let Some(entry) = self.get_timeline_entry(id)? else {
            return Ok(false);
        };

        match entry.category.as_str() {
            "bake_article" => self.delete_episodic_memory(id),
            "bake_knowledge" => self.delete_bake_knowledge(id),
            "bake_sop" => self.delete_bake_sop(id),
            _ => self.delete_episodic_memory(id),
        }
    }
}

const URL_AGGREGATION_LOOKBACK_MS: i64 = 30 * 24 * 3600 * 1000;
const URL_AGGREGATION_MAX_CAPTURES: i64 = 30;
const URL_AGGREGATION_TOTAL_BUDGET_CHARS: usize = 12000;
const URL_AGGREGATION_PER_CAPTURE_CAP_CHARS: usize = 4000;
const URL_AGGREGATION_DEDUP_HEAD_CHARS: usize = 200;

// 成员聚合：把一条 timeline 的 capture_ids 数组里所有成员的可见文本拼起来，
// 用于补充主 capture 之外的内容（尤其文档型成员，主 capture 常是 IM 无法代表）。
const MEMBER_AGGREGATION_MAX_CAPTURES: usize = 40;
const MEMBER_AGGREGATION_TOTAL_BUDGET_CHARS: usize = 12000;
const MEMBER_AGGREGATION_PER_CAPTURE_CAP_CHARS: usize = 2000;
const MEMBER_AGGREGATION_DEDUP_HEAD_CHARS: usize = 200;

/// 聚合一条 timeline 全部成员 capture 的可见文本。
///
/// 设计要点：
/// - 文档型成员（URL 含文档域名）优先靠前，保证有限预算下文档正文不被 IM/编码噪声挤掉；
/// - 同一份文档的多次 capture 按 head 去重，避免重复抄录；
/// - 返回 (聚合文本, 纳入的成员数)。成员数 <= 1 时返回 None（无聚合价值，回退到主 capture）。
fn aggregate_member_capture_text(
    conn: &Connection,
    capture_ids: &[i64],
    primary_capture_id: i64,
) -> Result<Option<(String, i64)>, StorageError> {
    if capture_ids.len() <= 1 {
        return Ok(None);
    }

    // 读取成员的文本与 URL；按时间序，文档型优先。
    let placeholders = capture_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, ts, ax_text, ocr_text, input_text, url
         FROM captures
         WHERE id IN ({placeholders})
         ORDER BY ts ASC
         LIMIT {MEMBER_AGGREGATION_MAX_CAPTURES}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> = capture_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt.query_map(params_vec.as_slice(), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;

    struct Member {
        cap_id: i64,
        ts: i64,
        text: String,
        is_doc: bool,
    }
    let mut members: Vec<Member> = Vec::new();
    for row in rows {
        let (cap_id, ts, ax_text, ocr_text, input_text, url) = row.map_err(StorageError::Sqlite)?;
        let combined = combine_capture_text_for_url(
            ax_text.as_deref(),
            ocr_text.as_deref(),
            input_text.as_deref(),
        );
        if combined.is_empty() {
            continue;
        }
        let is_doc = url.as_deref().map(is_document_url).unwrap_or(false);
        members.push(Member {
            cap_id,
            ts,
            text: combined,
            is_doc,
        });
    }

    if members.len() <= 1 {
        return Ok(None);
    }

    // 文档型优先（稳定排序：先 is_doc 降序，再时间升序），保证预算先喂文档正文。
    members.sort_by(|a, b| b.is_doc.cmp(&a.is_doc).then(a.ts.cmp(&b.ts)));

    let mut buf = String::new();
    let mut seen_heads: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut budget = MEMBER_AGGREGATION_TOTAL_BUDGET_CHARS;
    let mut included = 0_i64;
    for m in &members {
        let head: String = m
            .text
            .chars()
            .take(MEMBER_AGGREGATION_DEDUP_HEAD_CHARS)
            .collect();
        if !seen_heads.insert(head) {
            continue; // 同一份内容已收录，跳过重复
        }
        let allowed = budget.min(MEMBER_AGGREGATION_PER_CAPTURE_CAP_CHARS);
        if allowed == 0 {
            break;
        }
        let truncated: String = m.text.chars().take(allowed).collect();
        let used = truncated.chars().count();
        let tag = if m.is_doc { "doc" } else { "ctx" };
        let primary_mark = if m.cap_id == primary_capture_id {
            " primary"
        } else {
            ""
        };
        buf.push_str(&format!(
            "--- capture#{} ts={} [{}{}] ---\n",
            m.cap_id, m.ts, tag, primary_mark
        ));
        buf.push_str(&truncated);
        buf.push_str("\n\n");
        budget = budget.saturating_sub(used);
        included += 1;
        if budget == 0 {
            break;
        }
    }

    if included <= 1 {
        return Ok(None);
    }
    Ok(Some((buf, included)))
}

fn list_timeline_capture_ids(
    conn: &Connection,
    timeline_id: i64,
    primary_capture_id: i64,
) -> Result<Vec<i64>, StorageError> {
    let mut stmt = conn.prepare(
        "SELECT id FROM captures
         WHERE timeline_id = ?1 OR id = ?2
         ORDER BY ts ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![timeline_id, primary_capture_id], |row| {
        row.get::<_, i64>(0)
    })?;
    let mut ids = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::Sqlite)?;
    ids.dedup();
    Ok(ids)
}

fn to_json_array_string(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string())
}

/// 判断 URL 是否指向文档（用于成员聚合时优先文档型 capture）。
fn is_document_url(url: &str) -> bool {
    let u = url.trim().to_lowercase();
    if u.is_empty() {
        return false;
    }
    // 常见企业/通用文档域名与路径特征。
    const DOC_MARKERS: &[&str] = &[
        "docs.corp",
        "/docs/",
        "docs.google",
        "/document/",
        "yuque.com",
        "feishu.cn/docx",
        "feishu.cn/wiki",
        "notion.so",
        "confluence",
        "/wiki/",
        "shimo.im",
        "/d/home/",
        "/s/home/",
    ];
    DOC_MARKERS.iter().any(|marker| u.contains(marker))
}

/// 解析 timeline.capture_ids（JSON 数组，元素可能是数字或字符串）为 i64 列表。
fn parse_capture_ids(raw: Option<&str>) -> Vec<i64> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    match value {
        serde_json::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                serde_json::Value::Number(n) => n.as_i64(),
                serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn aggregate_url_capture_text(
    conn: &Connection,
    url: &str,
    anchor_ts: i64,
) -> Result<Option<(String, i64)>, StorageError> {
    let earliest = anchor_ts.saturating_sub(URL_AGGREGATION_LOOKBACK_MS);
    let mut stmt = conn.prepare(
        "SELECT id, ts, ax_text, ocr_text, input_text
         FROM captures
         WHERE TRIM(COALESCE(url, '')) = ?1
           AND ts >= ?2
           AND ts <= ?3
         ORDER BY ts ASC
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![url, earliest, anchor_ts, URL_AGGREGATION_MAX_CAPTURES],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        },
    )?;

    let mut buf = String::new();
    let mut last_head = String::new();
    let mut budget = URL_AGGREGATION_TOTAL_BUDGET_CHARS;
    let mut included = 0_i64;
    for row in rows {
        let (cap_id, ts, ax_text, ocr_text, input_text) = row.map_err(StorageError::Sqlite)?;
        let combined = combine_capture_text_for_url(
            ax_text.as_deref(),
            ocr_text.as_deref(),
            input_text.as_deref(),
        );
        if combined.is_empty() {
            continue;
        }
        let head: String = combined
            .chars()
            .take(URL_AGGREGATION_DEDUP_HEAD_CHARS)
            .collect();
        if !last_head.is_empty() && head == last_head {
            continue;
        }
        last_head = head;
        let allowed = budget.min(URL_AGGREGATION_PER_CAPTURE_CAP_CHARS);
        if allowed == 0 {
            break;
        }
        let truncated: String = combined.chars().take(allowed).collect();
        let used = truncated.chars().count();
        buf.push_str(&format!("--- capture#{} ts={} ---\n", cap_id, ts));
        buf.push_str(&truncated);
        buf.push_str("\n\n");
        budget = budget.saturating_sub(used);
        included += 1;
        if budget == 0 {
            break;
        }
    }
    if included <= 1 {
        return Ok(None);
    }
    Ok(Some((buf, included)))
}

fn combine_capture_text_for_url(
    ax_text: Option<&str>,
    ocr_text: Option<&str>,
    input_text: Option<&str>,
) -> String {
    let pieces = [ax_text, ocr_text, input_text]
        .iter()
        .filter_map(|p| p.map(str::trim).filter(|t| !t.is_empty()))
        .collect::<Vec<_>>();
    pieces.join("\n")
}

fn insert_timeline_entry_inner(
    conn: &Connection,
    entry: &NewTimeline,
) -> Result<i64, StorageError> {
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

fn row_to_timeline_entry(row: &rusqlite::Row<'_>) -> Result<TimelineRecord, StorageError> {
    Ok(TimelineRecord {
        id: row.get(0)?,
        capture_id: row.get(1)?,
        summary: row.get(2)?,
        overview: row.get(3)?,
        details: row.get(4)?,
        detailed_content: None,
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
        capture_ids: row.get(23)?,
        start_time: row.get(24)?,
        end_time: row.get(25)?,
        duration_minutes: row.get(26)?,
        frag_app_name: row.get(27)?,
        frag_win_title: row.get(28)?,
        time_range_start: row.get(29)?,
        time_range_end: row.get(30)?,
        key_timestamps: row.get(31)?,
    })
}

/// 将 episodic_memory 行转换为 TimelineRecord（用于向后兼容）
fn row_to_timeline_record(row: &rusqlite::Row<'_>) -> Result<TimelineRecord, StorageError> {
    Ok(TimelineRecord {
        id: row.get(0)?,
        capture_id: row.get(1)?,
        summary: row.get(2)?,
        overview: row.get(3)?,
        details: row.get(4)?,
        detailed_content: None,
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
        capture_ids: row.get(23)?,
        start_time: row.get(24)?,
        end_time: row.get(25)?,
        duration_minutes: row.get(26)?,
        frag_app_name: row.get(27)?,
        frag_win_title: row.get(28)?,
        time_range_start: row.get(29)?,
        time_range_end: row.get(30)?,
        key_timestamps: row.get(31)?,
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
    pub fn list_timelines_paginated(
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
                        created_at_ms, updated_at_ms, capture_ids, start_time, end_time,
                        duration_minutes, frag_app_name, frag_win_title, time_range_start,
                        time_range_end, key_timestamps
                 FROM timelines",
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
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    /// 统计情节记忆数量
    pub fn count_timelines(&self, category: Option<&str>) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(cat) = category
            {
                (
                    "SELECT COUNT(*) FROM timelines WHERE category = ?".to_string(),
                    vec![Box::new(cat.to_string())],
                )
            } else {
                ("SELECT COUNT(*) FROM timelines".to_string(), vec![])
            };

            let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
            conn.query_row(&sql, param_refs.as_slice(), |row| row.get(0))
                .map_err(StorageError::Sqlite)
        })
    }

    /// 获取单条情节记忆
    pub fn get_episodic_memory(
        &self,
        id: i64,
    ) -> Result<Option<EpisodicMemoryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                        occurrence_count, observed_at, event_time_start, event_time_end,
                        history_view, content_origin, activity_type, is_self_generated,
                        evidence_strength, user_verified, user_edited, created_at, updated_at,
                        created_at_ms, updated_at_ms, capture_ids, start_time, end_time,
                        duration_minutes, frag_app_name, frag_win_title, time_range_start,
                        time_range_end, key_timestamps
                 FROM timelines WHERE id = ?1",
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
                "UPDATE timelines
                 SET summary = ?1, overview = ?2, details = ?3, entities = ?4, user_edited = 1,
                     updated_at = datetime(?6 / 1000, 'unixepoch'), updated_at_ms = ?6
                 WHERE id = ?5",
                params![summary, overview, details, entities, id, now],
            )?;
            Ok(affected > 0)
        })
    }

    /// 设置情节记忆验证状态
    pub fn set_episodic_memory_verified(
        &self,
        id: i64,
        verified: bool,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = conn.execute(
                "UPDATE timelines SET user_verified = ?1,
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
            let affected = conn.execute("DELETE FROM timelines WHERE id = ?1", params![id])?;
            Ok(affected > 0)
        })
    }

    /// 获取时间线关联的Capture IDs
    pub fn get_timeline_capture_ids(&self, timeline_id: i64) -> Result<Vec<i64>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT capture_id, capture_ids FROM timelines WHERE id = ?1")?;
            match stmt.query_row(params![timeline_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
            }) {
                Ok((primary_capture_id, Some(json))) => {
                    let mut ids = list_timeline_capture_ids(conn, timeline_id, primary_capture_id)?;
                    for id in serde_json::from_str::<Vec<i64>>(&json).unwrap_or_default() {
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                    Ok(ids)
                }
                Ok((primary_capture_id, None)) => {
                    list_timeline_capture_ids(conn, timeline_id, primary_capture_id)
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(vec![]),
                Err(e) => Err(StorageError::Sqlite(e)),
            }
        })
    }

    /// 更新时间线的关联Capture IDs
    pub fn update_timeline_capture_ids(
        &self,
        timeline_id: i64,
        capture_ids: &[i64],
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let json = serde_json::to_string(capture_ids).unwrap_or_else(|_| "[]".to_string());
            let affected = conn.execute(
                "UPDATE timelines SET capture_ids = ?1 WHERE id = ?2",
                params![json, timeline_id],
            )?;
            Ok(affected > 0)
        })
    }
}

fn insert_episodic_memory_inner(
    conn: &Connection,
    entry: &NewEpisodicMemory,
) -> Result<i64, StorageError> {
    let now = current_ts_ms();
    conn.execute(
        "INSERT INTO timelines (
            capture_id, summary, overview, details, entities, category, importance,
            occurrence_count, observed_at, event_time_start, event_time_end,
            history_view, content_origin, activity_type, is_self_generated,
            evidence_strength, user_verified, user_edited,
            created_at, updated_at, created_at_ms, updated_at_ms,
            capture_ids, start_time, end_time, duration_minutes, frag_app_name,
            frag_win_title, time_range_start, time_range_end, key_timestamps
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 0,
                   datetime(?17 / 1000, 'unixepoch'), datetime(?17 / 1000, 'unixepoch'), ?17, ?17,
                   ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
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
            now, // ?17: 用于 created_at, updated_at, created_at_ms, updated_at_ms
            entry.capture_ids,
            entry.start_time,
            entry.end_time,
            entry.duration_minutes,
            entry.frag_app_name,
            entry.frag_win_title,
            entry.time_range_start,
            entry.time_range_end,
            entry.key_timestamps,
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
        detailed_content: None,
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
        capture_ids: row.get(23)?,
        start_time: row.get(24)?,
        end_time: row.get(25)?,
        duration_minutes: row.get(26)?,
        frag_app_name: row.get(27)?,
        frag_win_title: row.get(28)?,
        time_range_start: row.get(29)?,
        time_range_end: row.get(30)?,
        key_timestamps: row.get(31)?,
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
                // episodic_memory_id 是列重命名为 timeline_id 前的旧列，仍带 NOT NULL 约束。
                // 二者语义等价（见 db.rs 中 timeline_id = episodic_memory_id 的回填），
                // 这里同时写入旧列，避免 NOT NULL 约束导致 knowledge 提炼结果无法落库。
                // source_capture_ids 为 NOT NULL DEFAULT '[]'，但 build_bake_knowledge_entry
                // 可能传入 None；显式绑定 NULL 会覆盖 DEFAULT 触发约束失败，用 COALESCE 兜底。
                // （废弃列 episodic_memory_id 已由迁移 033 移除，无需再写入。）
                "INSERT INTO bake_knowledge (
                    timeline_id, title, summary, content, detailed_content, entities, importance,
                    user_verified, user_edited,
                    created_at, updated_at, created_at_ms, updated_at_ms, source_capture_ids
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0,
                           datetime(?8 / 1000, 'unixepoch'), datetime(?8 / 1000, 'unixepoch'), ?8, ?8, COALESCE(?9, '[]'))",
                params![
                    knowledge.timeline_id,
                    knowledge.title,
                    knowledge.summary,
                    knowledge.content,
                    knowledge.detailed_content,
                    knowledge.entities,
                    knowledge.importance,
                    now,
                    knowledge.source_capture_ids,
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
                "SELECT id, timeline_id, title, summary, content, detailed_content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms, source_capture_ids
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

    pub fn find_bake_knowledge_by_timeline_id(
        &self,
        timeline_id: i64,
    ) -> Result<Option<BakeKnowledgeRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, timeline_id, title, summary, content, detailed_content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms, source_capture_ids
                 FROM bake_knowledge WHERE timeline_id = ?1 ORDER BY updated_at_ms DESC, id DESC LIMIT 1"
            )?;
            match stmt.query_row(params![timeline_id], |row| {
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

    pub fn update_bake_knowledge_system(
        &self,
        id: i64,
        title: &str,
        summary: &str,
        content: Option<&str>,
        detailed_content: Option<&str>,
        entities: &str,
        importance: i64,
        source_capture_ids: Option<&str>,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = conn.execute(
                "UPDATE bake_knowledge
                 SET title = ?1, summary = ?2, content = ?3, detailed_content = ?4,
                     entities = ?5, importance = ?6,
                     source_capture_ids = COALESCE(?7, source_capture_ids, '[]'),
                     updated_at = datetime(?9 / 1000, 'unixepoch'), updated_at_ms = ?9
                 WHERE id = ?8",
                params![
                    title,
                    summary,
                    content,
                    detailed_content,
                    entities,
                    importance,
                    source_capture_ids,
                    id,
                    now,
                ],
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
        timeline_id: row.get(1)?,
        title: row.get(2)?,
        summary: row.get(3)?,
        content: row.get(4)?,
        detailed_content: row.get(5)?,
        entities: row.get(6)?,
        importance: row.get::<_, Option<i64>>(7)?.unwrap_or(3),
        user_verified: row.get::<_, Option<bool>>(8)?.unwrap_or(false),
        user_edited: row.get::<_, Option<bool>>(9)?.unwrap_or(false),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        created_at_ms: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
        updated_at_ms: row.get::<_, Option<i64>>(13)?.unwrap_or(0),
        source_capture_ids: row.get(14)?,
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
                // 废弃列 episodic_memory_id 已由迁移 033 移除；source_capture_ids 用 COALESCE 兜底。
                "INSERT INTO bake_sops (
                    timeline_id, title, summary, content, detailed_content, entities, importance,
                    user_verified, user_edited,
                    created_at, updated_at, created_at_ms, updated_at_ms, source_capture_ids
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0,
                           datetime(?8 / 1000, 'unixepoch'), datetime(?8 / 1000, 'unixepoch'), ?8, ?8, COALESCE(?9, '[]'))",
                params![
                    sop.timeline_id,
                    sop.title,
                    sop.summary,
                    sop.content,
                    sop.detailed_content,
                    sop.entities,
                    sop.importance,
                    now,
                    sop.source_capture_ids,
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
                "SELECT id, timeline_id, title, summary, content, detailed_content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms, source_capture_ids
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

    /// 给定候选 timeline_id 集合，返回其中已在 bake_knowledge 中有记录的 timeline_id 子集。
    /// 代替全量拉取所有 knowledge 再构建 HashSet，避免随数据增长内存和时间开销线性膨胀。
    pub fn find_existing_knowledge_timeline_ids(
        &self,
        candidate_ids: &[i64],
    ) -> Result<std::collections::HashSet<i64>, StorageError> {
        if candidate_ids.is_empty() {
            return Ok(std::collections::HashSet::new());
        }
        self.with_conn(|conn| {
            let placeholders = candidate_ids
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT timeline_id FROM bake_knowledge WHERE timeline_id IN ({})",
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = candidate_ids
                .iter()
                .map(|id| id as &dyn rusqlite::ToSql)
                .collect();
            let rows = stmt.query_map(params.as_slice(), |row| row.get::<_, i64>(0))?;
            rows.collect::<Result<std::collections::HashSet<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    /// 给定候选 timeline_id 集合，返回其中已在 bake_sops 中有记录的 timeline_id 子集。
    pub fn find_existing_sop_timeline_ids(
        &self,
        candidate_ids: &[i64],
    ) -> Result<std::collections::HashSet<i64>, StorageError> {
        if candidate_ids.is_empty() {
            return Ok(std::collections::HashSet::new());
        }
        self.with_conn(|conn| {
            let placeholders = candidate_ids
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT timeline_id FROM bake_sops WHERE timeline_id IN ({})",
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = candidate_ids
                .iter()
                .map(|id| id as &dyn rusqlite::ToSql)
                .collect();
            let rows = stmt.query_map(params.as_slice(), |row| row.get::<_, i64>(0))?;
            rows.collect::<Result<std::collections::HashSet<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    pub fn get_bake_sop(&self, id: i64) -> Result<Option<BakeSopRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, timeline_id, title, summary, content, detailed_content, entities, importance,
                        user_verified, user_edited, created_at, updated_at, created_at_ms, updated_at_ms, source_capture_ids
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
        id: row.get("id")?,
        timeline_id: row.get::<_, Option<i64>>("timeline_id")?.unwrap_or(0),
        title: row.get("title")?,
        summary: row.get("summary")?,
        content: row.get("content")?,
        detailed_content: row.get("detailed_content")?,
        entities: row
            .get::<_, Option<String>>("entities")?
            .unwrap_or_default(),
        importance: row.get::<_, Option<i64>>("importance")?.unwrap_or(3),
        user_verified: row
            .get::<_, Option<bool>>("user_verified")?
            .unwrap_or(false),
        user_edited: row.get::<_, Option<bool>>("user_edited")?.unwrap_or(false),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        created_at_ms: row.get::<_, Option<i64>>("created_at_ms")?.unwrap_or(0),
        updated_at_ms: row.get::<_, Option<i64>>("updated_at_ms")?.unwrap_or(0),
        source_capture_ids: row.get("source_capture_ids")?,
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
            ocr_text: None,
            screenshot_path: None,
            screenshot_source: None,
            input_text: None,
            is_sensitive: false,
            pii_scrubbed: false,
            url: None,
            webpage_title: None,
        })
        .expect("插入 capture 失败")
    }

    fn sample_entry(mgr: &StorageManager, category: &str) -> NewTimeline {
        NewTimeline {
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
            capture_ids: None,
            start_time: None,
            end_time: None,
            duration_minutes: None,
            frag_app_name: None,
            frag_win_title: None,
            time_range_start: None,
            time_range_end: None,
            key_timestamps: None,
        }
    }

    #[test]
    fn test_insert_and_list_timelines_by_category() {
        let mgr = make_mgr();
        mgr.insert_timeline_entry(&sample_entry(&mgr, "bake_sop"))
            .unwrap();
        let entries = mgr.list_timelines_by_category("bake_sop").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].summary, "客服问题处理");
    }

    #[test]
    fn test_set_knowledge_verified() {
        let mgr = make_mgr();
        let id = mgr
            .insert_timeline_entry(&sample_entry(&mgr, "bake_article"))
            .unwrap();
        assert!(mgr.set_knowledge_verified(id, true).unwrap());
        let entry = mgr.get_timeline_entry(id).unwrap().unwrap();
        assert!(entry.user_verified);
    }

    #[test]
    fn test_count_non_bake_knowledge_filtered_excludes_bake_knowledge() {
        let mgr = make_mgr();
        mgr.insert_timeline_entry(&sample_entry(&mgr, "bake_knowledge"))
            .unwrap();
        mgr.insert_timeline_entry(&sample_entry(&mgr, "meeting"))
            .unwrap();

        assert_eq!(mgr.count_non_bake_knowledge_filtered(None).unwrap(), 1);
        assert_eq!(
            mgr.count_non_bake_knowledge_filtered(Some("客服")).unwrap(),
            1
        );
    }

    #[test]
    fn test_list_bake_memory_init_candidates_excludes_bake_knowledge() {
        let mgr = make_mgr();
        mgr.insert_timeline_entry(&sample_entry(&mgr, "bake_knowledge"))
            .unwrap();
        mgr.insert_timeline_entry(&sample_entry(&mgr, "meeting"))
            .unwrap();

        let candidates = mgr.list_bake_memory_init_candidates(0, 10).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].timeline.category, "meeting");
    }

    #[test]
    fn test_update_bake_article_details_system_works() {
        let mgr = make_mgr();
        let id = mgr
            .insert_timeline_entry(&sample_entry(&mgr, "meeting"))
            .unwrap();

        assert!(mgr
            .update_timeline_details_system(
                id,
                "更新后的情节记忆",
                Some("新的概述"),
                Some(r#"{"template_match_score":0.89,"template_match_level":"high"}"#),
                r#"["模板"]"#,
            )
            .unwrap());
    }

    #[test]
    fn test_update_bake_sop_details_system_works() {
        let mgr = make_mgr();
        let source_id = mgr
            .insert_episodic_memory(&sample_entry(&mgr, "meeting"))
            .unwrap();
        let id = mgr
            .insert_bake_sop(&NewBakeSop {
                timeline_id: source_id,
                title: "原始 SOP".to_string(),
                summary: "原始 SOP".to_string(),
                content: Some(r#"{"status":"candidate"}"#.to_string()),
                detailed_content: None,
                entities: r#"["SOP"]"#.to_string(),
                importance: 4,
                source_capture_ids: None,
            })
            .unwrap();

        assert!(mgr
            .update_timeline_details_system(
                id,
                "更新后的 SOP",
                Some("新的概述"),
                Some(r#"{"status":"candidate"}"#),
                r#"["SOP"]"#,
            )
            .unwrap());
        assert!(mgr.set_knowledge_verified(id, true).unwrap());
    }
}
