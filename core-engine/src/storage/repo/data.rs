use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::storage::{
    db::current_ts_ms,
    error::StorageError,
    models_data::{DataExtractionSummary, DataSearchResult, DataSnapshotRecord, DataSourceRecord},
    StorageManager,
};

const REPORT_FRESH_SECONDS: i64 = 15 * 60;
const DATA_TEXT_MAX_CHARS: usize = 80_000;

#[derive(Debug)]
struct CaptureCandidate {
    id: i64,
    ts: i64,
    app_name: Option<String>,
    win_title: Option<String>,
    webpage_title: Option<String>,
    url: Option<String>,
    text: String,
    timeline_id: Option<i64>,
    timeline_summary: Option<String>,
    timeline_overview: Option<String>,
    timeline_details: Option<String>,
    timeline_updated_at_ms: Option<i64>,
}

#[derive(Debug)]
struct TimelineDataContext {
    content: String,
    capture_ids: Vec<i64>,
    observed_at: i64,
    metric_statements: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemanticMetricRow {
    dimension: String,
    metric: String,
    value: String,
    note: String,
    statement: String,
    observed_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct SemanticDataView {
    summary: String,
    rows: Vec<SemanticMetricRow>,
    statements: Vec<Value>,
}

impl StorageManager {
    pub fn list_data_sources(
        &self,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<DataSourceRecord>, i64), StorageError> {
        self.with_conn(|conn| {
            let mut candidates = Vec::new();
            let mut stmt = conn.prepare(
                "SELECT id, title, source_kind, source_url, access_mode, refresh_policy,
                        realtime_level, source_app_name, source_window_title, tags,
                        first_seen_at, last_seen_at, last_collected_at, last_success_at,
                        last_error_code, status, created_at, updated_at
                 FROM data_sources
                 WHERE deleted_at IS NULL
                 ORDER BY last_seen_at DESC, id DESC",
            )?;
            let rows = stmt.query_map([], map_data_source_row)?;
            for row in rows {
                candidates.push(row?);
            }
            for record in &mut candidates {
                record.latest_snapshot = latest_snapshot(conn, record.id)?;
            }
            candidates.retain(is_presentable_data_source);
            if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
                candidates.retain(|source| data_source_matches_query(source, query));
            }
            let total = candidates.len() as i64;
            let records = candidates.into_iter().skip(offset).take(limit).collect();
            Ok((records, total))
        })
    }

    pub fn list_pending_data_sources(
        &self,
        query: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<DataSourceRecord>, i64), StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, source_kind, source_url, access_mode, refresh_policy,
                        realtime_level, source_app_name, source_window_title, tags,
                        first_seen_at, last_seen_at, last_collected_at, last_success_at,
                        last_error_code, status, created_at, updated_at
                 FROM data_sources
                 WHERE deleted_at IS NULL
                   AND source_kind = 'report_url'
                   AND NOT EXISTS (
                       SELECT 1 FROM data_snapshots snapshot
                       WHERE snapshot.source_id = data_sources.id
                   )
                 ORDER BY last_seen_at DESC, id DESC",
            )?;
            let rows = stmt.query_map([], map_data_source_row)?;
            let mut pending = rows.collect::<Result<Vec<_>, _>>()?;
            if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
                pending.retain(|source| data_source_matches_query(source, query));
            }
            let total = pending.len() as i64;
            pending.truncate(limit.clamp(1, 5000));
            Ok((pending, total))
        })
    }

    pub fn get_data_source(&self, id: i64) -> Result<Option<DataSourceRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut record = conn
                .query_row(
                    "SELECT id, title, source_kind, source_url, access_mode, refresh_policy,
                            realtime_level, source_app_name, source_window_title, tags,
                            first_seen_at, last_seen_at, last_collected_at, last_success_at,
                            last_error_code, status, created_at, updated_at
                     FROM data_sources WHERE id = ?1 AND deleted_at IS NULL",
                    [id],
                    map_data_source_row,
                )
                .optional()?;
            if let Some(record) = &mut record {
                record.latest_snapshot = latest_snapshot(conn, record.id)?;
            }
            Ok(record)
        })
    }

    pub fn save_data_snapshot(
        &self,
        source_id: i64,
        collector: &str,
        title: Option<&str>,
        content_text: &str,
        structured_data: &Value,
        collected_at: i64,
    ) -> Result<DataSnapshotRecord, StorageError> {
        self.with_conn(|conn| {
            let source_exists = conn.query_row(
                "SELECT COUNT(*) > 0 FROM data_sources
                     WHERE id = ?1 AND deleted_at IS NULL",
                [source_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !source_exists {
                return Err(StorageError::NotFound(format!("data source {source_id}")));
            }
            let normalized_content = clip_text(content_text, DATA_TEXT_MAX_CHARS);
            let structured_json = serde_json::to_string(structured_data)?;
            let content_hash = hash_text(&format!("{normalized_content}\n{structured_json}"));
            let provenance = json!({
                "collector": collector,
                "cookie_persisted": false,
                "local_only": true
            });
            conn.execute(
                "INSERT INTO data_snapshots (
                    source_id, collected_at, observed_at, collector, content_text,
                    structured_data, content_hash, freshness_ttl_seconds, provenance,
                    source_capture_ids, source_timeline_ids, status, created_at
                 ) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', '[]', 'success', ?2)
                 ON CONFLICT(source_id) DO UPDATE SET
                    collected_at = excluded.collected_at,
                    observed_at = excluded.observed_at,
                    collector = excluded.collector,
                    content_text = excluded.content_text,
                    structured_data = excluded.structured_data,
                    content_hash = excluded.content_hash,
                    freshness_ttl_seconds = excluded.freshness_ttl_seconds,
                    provenance = excluded.provenance,
                    source_capture_ids = excluded.source_capture_ids,
                    source_timeline_ids = excluded.source_timeline_ids,
                    status = excluded.status,
                    created_at = excluded.created_at",
                params![
                    source_id,
                    collected_at,
                    collector,
                    normalized_content,
                    structured_json,
                    content_hash,
                    REPORT_FRESH_SECONDS,
                    provenance.to_string(),
                ],
            )?;
            if let Some(title) = title.map(str::trim).filter(|value| !value.is_empty()) {
                conn.execute(
                    "UPDATE data_sources SET title = ?2, last_collected_at = ?3,
                            last_success_at = ?3, last_error_code = NULL, status = 'active',
                            updated_at = ?3 WHERE id = ?1",
                    params![source_id, clip_text(title, 240), collected_at],
                )?;
            } else {
                conn.execute(
                    "UPDATE data_sources SET last_collected_at = ?2, last_success_at = ?2,
                            last_error_code = NULL, status = 'active', updated_at = ?2
                     WHERE id = ?1",
                    params![source_id, collected_at],
                )?;
            }
            latest_snapshot(conn, source_id)?.ok_or_else(|| {
                StorageError::NotFound(format!("data snapshot for source {source_id}"))
            })
        })
    }

    pub fn mark_data_source_error(
        &self,
        source_id: i64,
        error_code: &str,
    ) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE data_sources SET last_error_code = ?2, status = 'unavailable',
                        updated_at = ?3 WHERE id = ?1",
                params![source_id, error_code, current_ts_ms()],
            )?;
            Ok(())
        })
    }

    pub fn delete_data_source(&self, source_id: i64) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let changed = conn.execute(
                "UPDATE data_sources
                 SET status = 'disabled', deleted_at = ?2, updated_at = ?2
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![source_id, now],
            )?;
            Ok(changed > 0)
        })
    }

    pub fn extract_data_candidates(
        &self,
        limit: usize,
    ) -> Result<DataExtractionSummary, StorageError> {
        self.with_conn(|conn| {
            let (candidates, newest_capture_id, backfill_before_capture_id) =
                load_capture_candidates(conn, limit.clamp(1, 5000))?;
            let mut summary = DataExtractionSummary {
                scanned_count: candidates.len(),
                ..DataExtractionSummary::default()
            };
            let mut handled_work_timelines = HashSet::new();
            for candidate in candidates {
                let mut candidate_created = false;
                let active_url = candidate
                    .url
                    .as_deref()
                    .and_then(canonical_data_url)
                    .filter(|url| {
                        looks_like_data_url(url, candidate_title(&candidate), &candidate.text)
                    });
                if let Some(url) = active_url {
                    let created = upsert_report_source(conn, &candidate, &url, "active_url")?;
                    summary.source_created_count += usize::from(created);
                    summary.source_updated_count += usize::from(!created);
                    candidate_created = true;
                }

                for embedded in extract_http_urls(&candidate.text).into_iter().take(12) {
                    let Some(url) = canonical_data_url(&embedded) else {
                        continue;
                    };
                    if candidate
                        .url
                        .as_deref()
                        .and_then(canonical_data_url)
                        .as_deref()
                        == Some(url.as_str())
                        || !looks_like_data_url(&url, candidate_title(&candidate), &candidate.text)
                    {
                        continue;
                    }
                    let created = upsert_report_source(conn, &candidate, &url, "embedded_url")?;
                    summary.source_created_count += usize::from(created);
                    summary.source_updated_count += usize::from(!created);
                    candidate_created = true;
                }

                if let Some(timeline_id) = candidate.timeline_id {
                    if !handled_work_timelines.contains(&timeline_id) {
                        handled_work_timelines.insert(timeline_id);
                        let context = load_timeline_data_context(conn, &candidate, timeline_id)?;
                        if !context.metric_statements.is_empty() {
                            let (created, snapshot_created) =
                                upsert_work_memory(conn, &candidate, timeline_id, &context)?;
                            summary.source_created_count += usize::from(created);
                            summary.source_updated_count += usize::from(!created);
                            summary.snapshot_created_count += usize::from(snapshot_created);
                            candidate_created = true;
                        }
                    }
                }

                if !candidate_created {
                    summary.skipped_count += 1;
                }
            }
            save_data_extraction_cursor(conn, newest_capture_id, backfill_before_capture_id)?;
            Ok(summary)
        })
    }

    pub fn search_data_sources(
        &self,
        query: &str,
        need_fresh: bool,
        as_of_ms: i64,
        limit: usize,
    ) -> Result<Vec<DataSearchResult>, StorageError> {
        let (mut sources, _) = self.list_data_sources(None, 5000, 0)?;
        let (pending, _) = self.list_pending_data_sources(None, 5000)?;
        sources.extend(pending);
        let terms = keyword_terms(query);
        let mut results = sources
            .into_iter()
            .filter(|source| source.status != "disabled")
            .map(|source| score_data_source(source, query, &terms, need_fresh, as_of_ms))
            .filter(|result| result.relevance_score >= 0.12 || terms.is_empty())
            .collect::<Vec<_>>();
        results.sort_by(|left, right| {
            right
                .final_score
                .partial_cmp(&left.final_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| right.collected_at.cmp(&left.collected_at))
        });
        results.truncate(limit.clamp(1, 20));
        Ok(results)
    }
}

fn load_capture_candidates(
    conn: &Connection,
    limit: usize,
) -> Result<(Vec<CaptureCandidate>, i64, Option<i64>), StorageError> {
    let global_max_id = conn.query_row("SELECT COALESCE(MAX(id), 0) FROM captures", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let cursor = conn
        .query_row(
            "SELECT newest_capture_id, backfill_before_capture_id
             FROM data_extraction_state WHERE singleton_id = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;

    if cursor.is_none() {
        let candidates = query_capture_candidates(conn, "c.id >= ?1", 0, limit, "DESC")?;
        let backfill_before = if candidates.len() < limit {
            None
        } else {
            candidates.iter().map(|item| item.id).min()
        };
        return Ok((candidates, global_max_id, backfill_before));
    }

    let (current_newest, current_backfill_before) = cursor.unwrap_or_default();
    let new_budget = ((limit * 3) / 4).max(1);
    let mut candidates =
        query_capture_candidates(conn, "c.id > ?1", current_newest, new_budget, "ASC")?;
    let next_newest = if candidates.len() < new_budget {
        global_max_id
    } else {
        candidates
            .iter()
            .map(|item| item.id)
            .max()
            .unwrap_or(current_newest)
    };

    let remaining = limit.saturating_sub(candidates.len());
    let mut next_backfill_before = current_backfill_before;
    if remaining > 0 {
        if let Some(before_id) = current_backfill_before.filter(|value| *value > 0) {
            let mut backfill =
                query_capture_candidates(conn, "c.id < ?1", before_id, remaining, "DESC")?;
            next_backfill_before = if backfill.len() < remaining {
                None
            } else {
                backfill.iter().map(|item| item.id).min()
            };
            candidates.append(&mut backfill);
        }
    }
    Ok((candidates, next_newest, next_backfill_before))
}

fn query_capture_candidates(
    conn: &Connection,
    cursor_predicate: &str,
    cursor_value: i64,
    limit: usize,
    direction: &str,
) -> Result<Vec<CaptureCandidate>, StorageError> {
    debug_assert!(matches!(direction, "ASC" | "DESC"));
    let sql = format!(
        "SELECT c.id, c.ts, c.app_name, c.win_title, c.webpage_title, c.url,
                COALESCE(c.ax_text, ''), COALESCE(c.ocr_text, ''),
                COALESCE(c.input_text, ''), COALESCE(c.audio_text, ''),
                c.timeline_id, t.summary, t.overview, t.details, t.updated_at_ms
         FROM captures c
         LEFT JOIN timelines t ON t.id = c.timeline_id
         WHERE c.is_sensitive = 0
           AND ({cursor_predicate})
           AND (COALESCE(c.url, '') <> ''
                OR c.timeline_id IS NOT NULL
                OR COALESCE(c.ax_text, '') <> ''
                OR COALESCE(c.ocr_text, '') <> ''
                OR COALESCE(c.input_text, '') <> ''
                OR COALESCE(c.audio_text, '') <> '')
         ORDER BY c.id {direction} LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![cursor_value, limit as i64], |row| {
        let text = [
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
        ]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        Ok(CaptureCandidate {
            id: row.get(0)?,
            ts: row.get(1)?,
            app_name: row.get(2)?,
            win_title: row.get(3)?,
            webpage_title: row.get(4)?,
            url: row.get(5)?,
            text,
            timeline_id: row.get(10)?,
            timeline_summary: row.get(11)?,
            timeline_overview: row.get(12)?,
            timeline_details: row.get(13)?,
            timeline_updated_at_ms: row.get(14)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn save_data_extraction_cursor(
    conn: &Connection,
    newest_capture_id: i64,
    backfill_before_capture_id: Option<i64>,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO data_extraction_state (
            singleton_id, newest_capture_id, backfill_before_capture_id, updated_at
         ) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(singleton_id) DO UPDATE SET
            newest_capture_id = excluded.newest_capture_id,
            backfill_before_capture_id = excluded.backfill_before_capture_id,
            updated_at = excluded.updated_at",
        params![
            newest_capture_id,
            backfill_before_capture_id,
            current_ts_ms()
        ],
    )?;
    Ok(())
}

fn upsert_report_source(
    conn: &Connection,
    candidate: &CaptureCandidate,
    url: &str,
    link_kind: &str,
) -> Result<bool, StorageError> {
    let key = format!("report:{url}");
    let existed = source_exists(conn, &key)?;
    let title = clip_text(candidate_title(candidate), 240);
    let now = current_ts_ms();
    conn.execute(
        "INSERT INTO data_sources (
            canonical_key, title, source_kind, source_url, access_mode, refresh_policy,
            realtime_level, source_app_name, source_window_title, tags, first_seen_at,
            last_seen_at, status, created_at, updated_at
         ) VALUES (?1, ?2, 'report_url', ?3, 'browser_session', 'on_demand', 'live',
                   ?4, ?5, '[\"report\"]', ?6, ?6, 'active', ?7, ?7)
         ON CONFLICT(canonical_key) DO UPDATE SET
            title = CASE WHEN LENGTH(excluded.title) > LENGTH(data_sources.title)
                         THEN excluded.title ELSE data_sources.title END,
            source_url = excluded.source_url,
            source_app_name = COALESCE(excluded.source_app_name, data_sources.source_app_name),
            source_window_title = COALESCE(excluded.source_window_title, data_sources.source_window_title),
            last_seen_at = MAX(data_sources.last_seen_at, excluded.last_seen_at),
            updated_at = excluded.updated_at",
        params![
            key,
            title,
            url,
            candidate.app_name,
            candidate.win_title,
            candidate.ts,
            now,
        ],
    )?;
    let source_id = source_id_for_key(conn, &key)?;
    let ref_key = format!("capture:{}:{link_kind}:{}", candidate.id, hash_text(url));
    conn.execute(
        "INSERT OR IGNORE INTO data_source_links (
            source_id, source_ref_key, capture_id, timeline_id, link_kind, observed_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            source_id,
            ref_key,
            candidate.id,
            candidate.timeline_id,
            link_kind,
            candidate.ts,
            now,
        ],
    )?;
    Ok(!existed)
}

fn upsert_work_memory(
    conn: &Connection,
    candidate: &CaptureCandidate,
    timeline_id: i64,
    context: &TimelineDataContext,
) -> Result<(bool, bool), StorageError> {
    let key = format!("memory:timeline:{timeline_id}");
    let existed = source_exists(conn, &key)?;
    let title = clip_text(
        candidate
            .timeline_summary
            .as_deref()
            .unwrap_or_else(|| candidate_title(candidate)),
        240,
    );
    let now = current_ts_ms();
    conn.execute(
        "INSERT INTO data_sources (
            canonical_key, title, source_kind, access_mode, refresh_policy, realtime_level,
            source_app_name, source_window_title, tags, first_seen_at, last_seen_at,
            status, created_at, updated_at
         ) VALUES (?1, ?2, 'work_memory', 'memory_only', 'never', 'observed',
                   ?3, ?4, '[\"work_memory\"]', ?5, ?5, 'active', ?6, ?6)
         ON CONFLICT(canonical_key) DO UPDATE SET
            title = excluded.title,
            last_seen_at = MAX(data_sources.last_seen_at, excluded.last_seen_at),
            updated_at = excluded.updated_at",
        params![
            key,
            title,
            candidate.app_name,
            candidate.win_title,
            candidate.ts,
            now
        ],
    )?;
    let source_id = source_id_for_key(conn, &key)?;
    for capture_id in &context.capture_ids {
        let ref_key = format!("timeline:{timeline_id}:work_memory:{capture_id}");
        conn.execute(
            "INSERT OR IGNORE INTO data_source_links (
                source_id, source_ref_key, capture_id, timeline_id, link_kind, observed_at, created_at
             ) VALUES (?1, ?2, ?3, ?4, 'work_memory', ?5, ?6)",
            params![
                source_id,
                ref_key,
                capture_id,
                timeline_id,
                context.observed_at,
                now
            ],
        )?;
    }
    let content = clip_text(&context.content, DATA_TEXT_MAX_CHARS);
    let structured = semantic_view_from_statements(&context.metric_statements)
        .map(semantic_view_to_json)
        .unwrap_or_else(|| json!({}));
    let content_hash = hash_text(&format!("{content}\n{structured}"));
    let previous_hash = conn
        .query_row(
            "SELECT content_hash FROM data_snapshots WHERE source_id = ?1 LIMIT 1",
            [source_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    conn.execute(
        "INSERT INTO data_snapshots (
            source_id, collected_at, observed_at, collector, content_text, structured_data,
            content_hash, freshness_ttl_seconds, provenance, source_capture_ids,
            source_timeline_ids, status, created_at
         ) VALUES (?1, ?2, ?2, 'memory_extract', ?3, ?4, ?5, 0, ?6, ?7, ?8, 'success', ?9)
         ON CONFLICT(source_id) DO UPDATE SET
            collected_at = excluded.collected_at,
            observed_at = excluded.observed_at,
            collector = excluded.collector,
            content_text = excluded.content_text,
            structured_data = excluded.structured_data,
            content_hash = excluded.content_hash,
            freshness_ttl_seconds = excluded.freshness_ttl_seconds,
            provenance = excluded.provenance,
            source_capture_ids = excluded.source_capture_ids,
            source_timeline_ids = excluded.source_timeline_ids,
            status = excluded.status,
            created_at = excluded.created_at",
        params![
            source_id,
            context.observed_at,
            content,
            structured.to_string(),
            content_hash,
            json!({"source": "timeline", "observed_at_is_lower_bound": true}).to_string(),
            serde_json::to_string(&context.capture_ids)?,
            serde_json::to_string(&vec![timeline_id])?,
            now,
        ],
    )?;
    let snapshot_changed = previous_hash.as_deref() != Some(content_hash.as_str());
    conn.execute(
        "UPDATE data_sources SET last_collected_at = MAX(COALESCE(last_collected_at, 0), ?2),
                last_success_at = MAX(COALESCE(last_success_at, 0), ?2), updated_at = ?3
         WHERE id = ?1",
        params![source_id, context.observed_at, now],
    )?;
    Ok((!existed, snapshot_changed))
}

fn load_timeline_data_context(
    conn: &Connection,
    candidate: &CaptureCandidate,
    timeline_id: i64,
) -> Result<TimelineDataContext, StorageError> {
    let timeline_text = [
        candidate.timeline_summary.as_deref(),
        candidate.timeline_overview.as_deref(),
        candidate.timeline_details.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let mut content_parts = if timeline_text.is_empty() {
        Vec::new()
    } else {
        vec![timeline_text.clone()]
    };
    let timeline_observed_at = candidate.timeline_updated_at_ms.unwrap_or(candidate.ts);
    let mut statements = metric_statements(&timeline_text, timeline_observed_at);
    let mut observed_at = if statements.is_empty() {
        0
    } else {
        timeline_observed_at
    };
    let mut capture_ids = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.ts, COALESCE(c.ax_text, ''), COALESCE(c.ocr_text, ''),
                COALESCE(c.input_text, ''), COALESCE(c.audio_text, '')
         FROM captures c
         WHERE c.is_sensitive = 0
           AND (c.timeline_id = ?1 OR c.id = (
                SELECT capture_id FROM timelines WHERE id = ?1
           ))
         ORDER BY c.ts ASC, c.id ASC",
    )?;
    let rows = stmt.query_map([timeline_id], |row| {
        let text = [
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, text))
    })?;
    for row in rows {
        let (capture_id, capture_ts, text) = row?;
        capture_ids.push(capture_id);
        if !text.trim().is_empty() {
            content_parts.push(text.clone());
        }
        let mut capture_statements = metric_statements(&text, capture_ts);
        if !capture_statements.is_empty() {
            observed_at = observed_at.max(capture_ts);
            statements.append(&mut capture_statements);
        }
    }
    capture_ids.sort_unstable();
    capture_ids.dedup();
    statements.truncate(80);
    Ok(TimelineDataContext {
        content: content_parts.join("\n"),
        capture_ids,
        observed_at,
        metric_statements: statements,
    })
}

fn is_presentable_data_source(source: &DataSourceRecord) -> bool {
    let Some(snapshot) = source.latest_snapshot.as_ref() else {
        return false;
    };
    snapshot
        .structured_data
        .get("metric_rows")
        .and_then(Value::as_array)
        .is_some_and(|rows| !rows.is_empty())
}

fn data_source_matches_query(source: &DataSourceRecord, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return true;
    }
    let snapshot_text = source
        .latest_snapshot
        .as_ref()
        .map(|snapshot| format!("{}\n{}", snapshot.content_text, snapshot.structured_data))
        .unwrap_or_default();
    format!(
        "{}\n{}\n{}\n{}",
        source.title,
        source.source_url.as_deref().unwrap_or_default(),
        source.source_app_name.as_deref().unwrap_or_default(),
        snapshot_text
    )
    .to_lowercase()
    .contains(&query)
}

fn semantic_view_from_statements(statements: &[Value]) -> Option<SemanticDataView> {
    let mut rows = Vec::new();
    let mut accepted_statements = Vec::new();
    let mut best_summary = String::new();
    let mut best_score = 0_usize;

    for statement_value in statements.iter().take(160) {
        let statement = statement_value
            .as_str()
            .or_else(|| statement_value.get("statement").and_then(Value::as_str))
            .unwrap_or_default();
        let observed_at = statement_value.get("observed_at").and_then(Value::as_i64);
        let Some((statement_rows, summary)) = semantic_statement(statement, observed_at) else {
            continue;
        };
        let summary_score = statement_rows.len() * 10 + summary.chars().count().min(180);
        if summary_score > best_score {
            best_score = summary_score;
            best_summary = summary;
        }
        for row in statement_rows {
            if !rows.iter().any(|existing: &SemanticMetricRow| {
                existing.dimension.eq_ignore_ascii_case(&row.dimension)
                    && existing.metric.eq_ignore_ascii_case(&row.metric)
                    && existing.value.eq_ignore_ascii_case(&row.value)
            }) {
                rows.push(row);
            }
        }
        accepted_statements.push(json!({
            "statement": clip_text(statement, 500),
            "observed_at": observed_at,
        }));
    }

    if rows.is_empty() || best_summary.trim().is_empty() {
        return None;
    }
    rows.truncate(120);
    accepted_statements.truncate(80);
    Some(SemanticDataView {
        summary: clip_text(&best_summary, 220),
        rows,
        statements: accepted_statements,
    })
}

fn semantic_view_to_json(view: SemanticDataView) -> Value {
    json!({
        "extraction_version": "data-memory.v2",
        "summary": view.summary,
        "metric_rows": view.rows.into_iter().map(|row| json!({
            "dimension": row.dimension,
            "metric": row.metric,
            "value": row.value,
            "note": row.note,
            "statement": row.statement,
            "observed_at": row.observed_at,
        })).collect::<Vec<_>>(),
        "metric_statements": view.statements,
    })
}

fn semantic_view_for_snapshot(snapshot: &DataSnapshotRecord) -> Option<Value> {
    if let Some(existing) = semantic_view_from_existing_v2(&snapshot.structured_data) {
        return Some(semantic_view_to_json(existing));
    }

    let mut statements = snapshot
        .structured_data
        .get("metric_statements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(labels) = snapshot
        .structured_data
        .get("metric_labels")
        .and_then(Value::as_array)
    {
        statements.extend(labels.iter().cloned());
    }
    statements.extend(
        snapshot
            .content_text
            .split(['\n', '。', '；', ';'])
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .take(160)
            .map(|statement| json!({"statement": statement, "observed_at": snapshot.observed_at})),
    );
    if let Some(view) = semantic_view_from_statements(&statements) {
        return Some(semantic_view_to_json(view));
    }

    semantic_view_from_tables(&snapshot.structured_data, snapshot.observed_at)
        .map(semantic_view_to_json)
}

fn semantic_view_from_existing_v2(structured: &Value) -> Option<SemanticDataView> {
    let summary = structured.get("summary").and_then(Value::as_str)?.trim();
    let raw_rows = structured.get("metric_rows")?.as_array()?;
    let rows = raw_rows
        .iter()
        .filter_map(|row| {
            let metric = row.get("metric")?.as_str()?.trim();
            let value = row.get("value")?.as_str()?.trim();
            if !metric_is_meaningful(metric)
                || value.is_empty()
                || !value.chars().any(|ch| ch.is_ascii_digit())
            {
                return None;
            }
            Some(SemanticMetricRow {
                dimension: row
                    .get("dimension")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                metric: metric.to_string(),
                value: value.to_string(),
                note: row
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                statement: row
                    .get("statement")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                observed_at: row.get("observed_at").and_then(Value::as_i64),
            })
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return None;
    }
    Some(SemanticDataView {
        summary: summary.to_string(),
        rows,
        statements: structured
            .get("metric_statements")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

fn semantic_view_from_tables(
    structured: &Value,
    observed_at: Option<i64>,
) -> Option<SemanticDataView> {
    let tables = structured.get("tables")?.as_array()?;
    let mut semantic_rows = Vec::new();
    for table in tables.iter().take(20) {
        let Some(raw_rows) = table.as_array() else {
            continue;
        };
        let rows = raw_rows
            .iter()
            .filter_map(Value::as_array)
            .map(|row| {
                row.iter()
                    .map(|cell| value_as_text(cell).trim().to_string())
                    .collect::<Vec<_>>()
            })
            .filter(|row| row.iter().any(|cell| !cell.is_empty()))
            .collect::<Vec<_>>();
        if rows.is_empty() {
            continue;
        }
        let header = rows.first().filter(|row| {
            row.iter()
                .all(|cell| !cell.chars().any(|ch| ch.is_ascii_digit()))
        });
        let data_rows = if header.is_some() {
            &rows[1..]
        } else {
            &rows[..]
        };
        for row in data_rows.iter().take(200) {
            let Some(label) = row.iter().find(|cell| {
                metric_is_meaningful(cell) && !cell.chars().any(|ch| ch.is_ascii_digit())
            }) else {
                continue;
            };
            for (index, value) in row.iter().enumerate() {
                if !value.chars().any(|ch| ch.is_ascii_digit()) {
                    continue;
                }
                let metric = header
                    .and_then(|cells| cells.get(index))
                    .filter(|cell| metric_is_meaningful(cell))
                    .cloned()
                    .unwrap_or_else(|| label.clone());
                let dimension = if metric == *label {
                    String::new()
                } else {
                    label.clone()
                };
                semantic_rows.push(SemanticMetricRow {
                    dimension,
                    metric,
                    value: value.clone(),
                    note: String::new(),
                    statement: row.join(" / "),
                    observed_at,
                });
            }
        }
    }
    if semantic_rows.is_empty() {
        return None;
    }
    semantic_rows.truncate(120);
    let summary = summarize_rows(&semantic_rows, None);
    Some(SemanticDataView {
        summary,
        rows: semantic_rows,
        statements: Vec::new(),
    })
}

fn value_as_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

fn score_data_source(
    source: DataSourceRecord,
    query: &str,
    terms: &[String],
    need_fresh: bool,
    as_of_ms: i64,
) -> DataSearchResult {
    let snapshot = source.latest_snapshot.as_ref();
    let content = snapshot
        .map(|item| item.content_text.as_str())
        .unwrap_or("");
    let structured_text = snapshot
        .map(|item| item.structured_data.to_string())
        .unwrap_or_default();
    let content_relevance = relevance_score(
        &format!("{}\n{}\n{}", source.title, content, structured_text),
        terms,
    );
    let identity_relevance = source_identity_score(&source, query);
    let relevance_score = content_relevance.max(identity_relevance);
    let collected_at = snapshot.map(|item| item.collected_at);
    let observed_at = snapshot
        .and_then(|item| item.observed_at)
        .or(Some(source.last_seen_at));
    let reference_time = collected_at.or(observed_at);
    let age_seconds = reference_time
        .map(|timestamp| as_of_ms.saturating_sub(timestamp) / 1000)
        .unwrap_or(i64::MAX);
    let (freshness_class, freshness_score) = freshness_for(&source.source_kind, age_seconds);
    let refresh_required = source.source_kind == "report_url"
        && source.refresh_policy != "never"
        && (collected_at.is_none() || age_seconds > REPORT_FRESH_SECONDS);
    let can_use = snapshot.is_some() && !(need_fresh && refresh_required);
    let source_score = if source.source_kind == "report_url" {
        0.95
    } else {
        0.68
    };
    // Top-K 统一按“与当前任务的相关性”排序。refresh_required 是进入
    // Top-K 后的动作状态，不能反过来把唯一可刷新的来源挤出候选。
    let final_score = relevance_score * 0.78 + freshness_score * 0.12 + source_score * 0.10;
    DataSearchResult {
        source_id: source.id,
        title: source.title,
        source_kind: source.source_kind,
        source_url: source.source_url,
        access_mode: source.access_mode,
        refresh_policy: source.refresh_policy,
        observed_at,
        collected_at,
        freshness_class: freshness_class.to_string(),
        freshness_score,
        relevance_score,
        final_score: final_score.clamp(0.0, 1.0),
        refresh_required,
        can_use,
        content_excerpt: snapshot.map(|item| clip_text(&item.content_text, 2400)),
        structured_data: snapshot.map(|item| item.structured_data.clone()),
        provenance: snapshot.map(|item| item.provenance.clone()),
    }
}

fn source_identity_score(source: &DataSourceRecord, query: &str) -> f64 {
    let normalized_title = normalize_identity_text(&source.title);
    let query_lines = query
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();

    if let Some(source_url) = source.source_url.as_deref().and_then(canonical_data_url) {
        let query_urls = extract_http_urls(query)
            .into_iter()
            .filter_map(|url| canonical_data_url(&url));
        if query_urls.into_iter().any(|url| url == source_url) {
            return 1.0;
        }
    }

    if !normalized_title.is_empty()
        && query_lines
            .iter()
            .any(|line| normalize_identity_text(line) == normalized_title)
    {
        return 0.96;
    }
    0.0
}

fn normalize_identity_text(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_ascii_punctuation())
        .flat_map(char::to_lowercase)
        .collect()
}

fn freshness_for(source_kind: &str, age_seconds: i64) -> (&'static str, f64) {
    if age_seconds == i64::MAX {
        return ("missing", 0.0);
    }
    if source_kind == "report_url" {
        match age_seconds {
            age if age <= REPORT_FRESH_SECONDS => ("live", 1.0),
            age if age <= 2 * 3600 => ("fresh", 0.78),
            age if age <= 24 * 3600 => ("aging", 0.46),
            _ => ("stale", 0.16),
        }
    } else {
        match age_seconds {
            age if age <= 24 * 3600 => ("fresh", 0.82),
            age if age <= 7 * 24 * 3600 => ("aging", 0.60),
            age if age <= 30 * 24 * 3600 => ("aging", 0.34),
            _ => ("stale", 0.10),
        }
    }
}

fn relevance_score(text: &str, terms: &[String]) -> f64 {
    if terms.is_empty() {
        return 0.25;
    }
    let lowered = text.to_lowercase();
    let matched = terms
        .iter()
        .filter(|term| lowered.contains(&term.to_lowercase()))
        .count();
    if matched == 0 {
        return 0.0;
    }
    (0.28 + 0.72 * matched as f64 / terms.len() as f64).min(1.0)
}

fn keyword_terms(query: &str) -> Vec<String> {
    let mut terms = query
        .split(|ch: char| {
            ch.is_whitespace() || ch.is_ascii_punctuation() || "，。；：、（）【】《》".contains(ch)
        })
        .map(str::trim)
        .filter(|value| value.chars().count() >= 2)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if terms.len() == 1
        && terms[0].chars().count() >= 3
        && terms[0].chars().any(|ch| !ch.is_ascii())
    {
        let chars = terms[0].chars().collect::<Vec<_>>();
        for window in chars.windows(2) {
            let term = window.iter().collect::<String>();
            if !terms.contains(&term) {
                terms.push(term);
            }
        }
    }
    terms.truncate(24);
    terms
}

fn candidate_title(candidate: &CaptureCandidate) -> &str {
    candidate
        .webpage_title
        .as_deref()
        .or(candidate.win_title.as_deref())
        .or(candidate.timeline_summary.as_deref())
        .unwrap_or("数据来源")
}

fn looks_like_data_url(url: &str, title: &str, text: &str) -> bool {
    let url_lower = url.to_lowercase();
    let title_lower = title.to_lowercase();
    let url_markers = [
        "dashboard",
        "report",
        "analytics",
        "metric",
        "grafana",
        "tableau",
        "powerbi",
        "metabase",
        "superset",
        "quickbi",
        "datastudio",
        "/bi/",
        "bi.",
        "/chart",
        "/board",
        "/monitor",
        "feishu.cn/base",
    ];
    let title_markers = [
        "报表",
        "看板",
        "仪表盘",
        "数据平台",
        "数据中心",
        "经营分析",
        "业务分析",
        "指标",
        "监控",
        "dashboard",
        "report",
        "analytics",
    ];
    url_markers.iter().any(|marker| url_lower.contains(marker))
        || title_markers
            .iter()
            .any(|marker| title_lower.contains(marker))
        || (is_concrete_data_statement(text)
            && ["sheet", "spreadsheet", "base", "table"]
                .iter()
                .any(|marker| url_lower.contains(marker)))
}

fn is_concrete_data_statement(text: &str) -> bool {
    semantic_statement(text, None).is_some()
}

#[derive(Debug, Clone)]
struct NumericToken {
    start: usize,
    end: usize,
    value: String,
}

fn semantic_statement(
    text: &str,
    observed_at: Option<i64>,
) -> Option<(Vec<SemanticMetricRow>, String)> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let char_count = normalized.chars().count();
    if !(4..=280).contains(&char_count) || !normalized.chars().any(|ch| ch.is_ascii_digit()) {
        return None;
    }

    let lower = normalized.to_lowercase();
    let ui_noise = [
        "comments (",
        "go to the first comment",
        "reply...",
        "upload log",
        "help center",
        "keyboard shortcuts",
        "saved to cloud",
        "type '/' for",
    ];
    if ui_noise.iter().any(|marker| lower.contains(marker)) {
        return None;
    }
    let mut rows = Vec::new();
    let mut inherited_metric = String::new();
    let mut inherited_dimension = String::new();
    for clause in normalized.split(['，', ',', '；', ';']) {
        let clause = clause.trim();
        if clause.is_empty() {
            continue;
        }
        for token in numeric_tokens(clause) {
            let prefix = &clause[..token.start];
            let dimension = detect_dimension(prefix)
                .or_else(|| (!inherited_dimension.is_empty()).then(|| inherited_dimension.clone()))
                .unwrap_or_default();
            let Some(metric) = metric_for_token(clause, &token, &dimension, &inherited_metric)
            else {
                continue;
            };
            if !metric_is_meaningful(&metric) {
                continue;
            }
            if !dimension.is_empty() {
                inherited_dimension = dimension.clone();
            }
            inherited_metric = metric.clone();
            rows.push(SemanticMetricRow {
                dimension,
                metric,
                value: token.value,
                note: String::new(),
                statement: normalized.clone(),
                observed_at,
            });
        }
    }
    rows.dedup_by(|left, right| {
        left.dimension.eq_ignore_ascii_case(&right.dimension)
            && left.metric.eq_ignore_ascii_case(&right.metric)
            && left.value.eq_ignore_ascii_case(&right.value)
    });
    if rows.is_empty() {
        return None;
    }
    let insight = extract_statement_insight(&normalized);
    if let (Some(first), Some(insight)) = (rows.first_mut(), insight.as_ref()) {
        first.note = insight.clone();
    }
    let summary = summarize_rows(&rows, insight.as_deref());
    (!summary.trim().is_empty()).then_some((rows, summary))
}

fn numeric_tokens(text: &str) -> Vec<NumericToken> {
    const UNITS: &[&str] = &[
        "个百分点",
        "万元",
        "亿元",
        "毫秒",
        "分钟",
        "小时",
        "％",
        "%",
        "gb",
        "tb",
        "mb",
        "kb",
        "qps",
        "元",
        "核",
        "个",
        "次",
        "条",
        "类",
        "人",
        "集",
        "秒",
    ];
    let chars = text.char_indices().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let (start, ch) = chars[index];
        if !ch.is_ascii_digit() || (index > 0 && chars[index - 1].1.is_ascii_digit()) {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        while cursor < chars.len() {
            let current = chars[cursor].1;
            if current.is_ascii_digit()
                || matches!(current, '.' | ',' | '，')
                || (matches!(current, '-' | '~' | '～')
                    && chars
                        .get(cursor + 1)
                        .is_some_and(|(_, next)| next.is_ascii_digit()))
            {
                cursor += 1;
            } else {
                break;
            }
        }
        let number_end = chars
            .get(cursor)
            .map(|(byte, _)| *byte)
            .unwrap_or(text.len());
        let whitespace_len = text[number_end..].len() - text[number_end..].trim_start().len();
        let unit_start = number_end + whitespace_len;
        let unit_tail = text[unit_start..].to_lowercase();
        let unit = UNITS
            .iter()
            .filter(|unit| unit_tail.starts_with(**unit))
            .max_by_key(|unit| unit.len())
            .copied()
            .unwrap_or_default();
        let mut end = if unit.is_empty() {
            number_end
        } else {
            unit_start + unit.len()
        };
        let range_tail = text[end..].trim_start();
        if matches!(range_tail.chars().next(), Some('-' | '~' | '～')) {
            let separator_len = range_tail.chars().next().map(char::len_utf8).unwrap_or(0);
            let after_separator = range_tail[separator_len..].trim_start();
            let range_digits = after_separator
                .char_indices()
                .take_while(|(_, current)| current.is_ascii_digit() || matches!(current, '.' | ','))
                .last()
                .map(|(position, current)| position + current.len_utf8())
                .unwrap_or(0);
            if range_digits > 0 {
                let range_unit_tail = after_separator[range_digits..].trim_start().to_lowercase();
                let range_unit = UNITS
                    .iter()
                    .filter(|candidate| range_unit_tail.starts_with(**candidate))
                    .max_by_key(|candidate| candidate.len())
                    .copied()
                    .unwrap_or_default();
                if !unit.is_empty() || !range_unit.is_empty() {
                    let absolute_separator = text.len() - range_tail.len();
                    let absolute_after_separator = text.len() - after_separator.len();
                    end = absolute_after_separator + range_digits + range_unit.len();
                    if range_unit.is_empty() && !unit.is_empty() {
                        end = absolute_after_separator + range_digits;
                    }
                    if absolute_separator >= start {
                        // `end` now spans the complete range, such as `10%-31%`.
                    }
                }
            }
        }
        let value = text[start..end].trim().to_string();
        if !value.is_empty() {
            tokens.push(NumericToken { start, end, value });
        }
        while index < chars.len() && chars[index].0 < end {
            index += 1;
        }
    }
    tokens
}

fn metric_for_token(
    clause: &str,
    token: &NumericToken,
    dimension: &str,
    inherited_metric: &str,
) -> Option<String> {
    let prefix = clause[..token.start].trim_end();
    let suffix = clause[token.end..].trim_start();
    if ["需达到", "目标", "基准", "要求达到"]
        .iter()
        .any(|marker| prefix.ends_with(marker))
        && !inherited_metric.is_empty()
    {
        return Some(format!("{}目标", inherited_metric.trim_end_matches("目标")));
    }

    if let Some(metric) = known_metric_near(suffix, 0, 14) {
        return Some(metric);
    }

    let relation_markers = ["被认为", "仅为", "约为", "达到", "约", "为", "占", "是"];
    for relation in relation_markers {
        let Some(index) = prefix.rfind(relation) else {
            continue;
        };
        if prefix[index + relation.len()..].chars().count() > 3 {
            continue;
        }
        let raw_label = clean_metric_label(&prefix[..index], dimension);
        if raw_label.is_empty() && !inherited_metric.is_empty() {
            return Some(inherited_metric.to_string());
        }
        if relation == "占" && metric_is_subject(&raw_label) {
            return Some(format!("{raw_label}占比"));
        }
        if metric_is_meaningful(&raw_label) {
            return Some(canonical_metric_label(&raw_label));
        }
    }

    if let Some(metric) = known_metric_near(clause, token.start, 36) {
        return Some(metric);
    }
    if (!dimension.is_empty()
        || ["为", "约", "达到", "仅", "占"]
            .iter()
            .any(|marker| prefix.ends_with(marker)))
        && !inherited_metric.is_empty()
    {
        return Some(inherited_metric.to_string());
    }
    None
}

fn known_metric_near(text: &str, token_start: usize, max_distance: usize) -> Option<String> {
    const MARKERS: &[(&str, &str)] = &[
        ("gpu 利用率", "GPU 利用率"),
        ("gpu利用率", "GPU 利用率"),
        ("smacc", "SMACC"),
        ("smact", "SMACT"),
        ("smocc", "SMOCC"),
        ("gputl", "GPUTL"),
        ("同比增长", "同比增长"),
        ("环比增长", "环比增长"),
        ("同比下降", "同比下降"),
        ("环比下降", "环比下降"),
        ("转化率", "转化率"),
        ("完成率", "完成率"),
        ("达成率", "达成率"),
        ("增长率", "增长率"),
        ("下降率", "下降率"),
        ("利用率", "利用率"),
        ("点击率", "点击率"),
        ("错误率", "错误率"),
        ("成功率", "成功率"),
        ("命中率", "命中率"),
        ("留存率", "留存率"),
        ("占比", "占比"),
        ("比例", "比例"),
        ("销售额", "销售额"),
        ("客单价", "客单价"),
        ("订单数", "订单数"),
        ("新增用户", "新增用户"),
        ("活跃用户", "活跃用户"),
        ("用户数", "用户数"),
        ("客户数", "客户数"),
        ("错误数", "错误数"),
        ("成功数", "成功数"),
        ("失败数", "失败数"),
        ("请求数", "请求数"),
        ("工单数", "工单数"),
        ("告警数", "告警数"),
        ("响应时间", "响应时间"),
        ("处理时长", "处理时长"),
        ("执行时长", "执行时长"),
        ("收入", "收入"),
        ("营收", "营收"),
        ("成本", "成本"),
        ("利润", "利润"),
        ("毛利", "毛利"),
        ("订单", "订单"),
        ("销量", "销量"),
        ("库存", "库存"),
        ("预算", "预算"),
        ("金额", "金额"),
        ("余额", "余额"),
        ("汇率", "汇率"),
        ("单价", "单价"),
        ("延迟", "延迟"),
        ("耗时", "耗时"),
        ("cpu", "CPU"),
        ("内存", "内存"),
        ("存储", "存储"),
        ("容量", "容量"),
        ("用量", "用量"),
        ("负载", "负载"),
        ("dau", "DAU"),
        ("mau", "MAU"),
        ("gmv", "GMV"),
        ("qps", "QPS"),
        ("pv", "PV"),
        ("uv", "UV"),
    ];
    let lower = text.to_lowercase();
    MARKERS
        .iter()
        .filter_map(|(marker, display)| {
            lower
                .match_indices(marker)
                .filter_map(|(position, _)| {
                    let distance = position.abs_diff(token_start);
                    (distance <= max_distance).then_some((distance, marker.len(), *display))
                })
                .min()
        })
        .min_by_key(|(distance, marker_len, _)| (*distance, std::cmp::Reverse(*marker_len)))
        .map(|(_, _, display)| display.to_string())
}

fn detect_dimension(prefix: &str) -> Option<String> {
    const DIMENSIONS: &[&str] = &[
        "国内",
        "海外",
        "本周",
        "上周",
        "本月",
        "上月",
        "本季度",
        "上季度",
        "今年",
        "去年",
        "当前",
        "昨日",
        "今日",
        "日峰",
        "峰值",
        "平均",
        "整体",
    ];
    DIMENSIONS
        .iter()
        .filter(|dimension| prefix.contains(**dimension))
        .max_by_key(|dimension| dimension.chars().count())
        .map(|dimension| (*dimension).to_string())
}

fn clean_metric_label(raw: &str, dimension: &str) -> String {
    let mut label = raw
        .trim_matches(|ch: char| ch.is_whitespace() || "：:|/（）()【】[]".contains(ch))
        .to_string();
    for prefix in [
        "背景显示",
        "数据显示",
        "数据表明",
        "结果显示",
        "对比发现",
        "其中",
        "其次",
        "另外",
    ] {
        if label.starts_with(prefix) {
            label = label[prefix.len()..].trim().to_string();
        }
    }
    if !dimension.is_empty() {
        label = label
            .strip_prefix(dimension)
            .unwrap_or(&label)
            .trim()
            .to_string();
    }
    for suffix in ["被认为", "认为需", "认为", "需要", "仅", "大约"] {
        if label.ends_with(suffix) {
            label.truncate(label.len() - suffix.len());
            label = label.trim().to_string();
        }
    }
    if label.chars().count() > 48 {
        label = label
            .chars()
            .rev()
            .take(48)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
    label
}

fn metric_is_subject(value: &str) -> bool {
    let meaningful_chars = value.chars().filter(|ch| ch.is_alphabetic()).count();
    meaningful_chars >= 2 && !matches!(value.trim(), "数据" | "指标" | "类别" | "类型")
}

fn metric_is_meaningful(value: &str) -> bool {
    let value = value.trim();
    if !metric_is_subject(value) || value.chars().any(|ch| ch.is_ascii_digit()) {
        return false;
    }
    let lower = value.to_lowercase();
    if matches!(
        lower.as_str(),
        "背景" | "数据显示" | "数据" | "类别" | "类型" | "类"
    ) {
        return false;
    }
    const SEMANTIC_HINTS: &[&str] = &[
        "率",
        "占比",
        "比例",
        "收入",
        "营收",
        "成本",
        "利润",
        "毛利",
        "订单",
        "销量",
        "销售额",
        "客单价",
        "用户",
        "客户",
        "活跃",
        "留存",
        "同比",
        "环比",
        "增幅",
        "降幅",
        "库存",
        "预算",
        "金额",
        "余额",
        "汇率",
        "单价",
        "错误",
        "成功",
        "失败",
        "请求",
        "工单",
        "告警",
        "延迟",
        "耗时",
        "时长",
        "cpu",
        "gpu",
        "内存",
        "存储",
        "容量",
        "用量",
        "负载",
        "dau",
        "mau",
        "gmv",
        "qps",
        "pv",
        "uv",
        "smacc",
        "smact",
        "smocc",
        "gputl",
    ];
    SEMANTIC_HINTS.iter().any(|hint| lower.contains(hint))
        || (value.chars().all(|ch| ch.is_ascii_alphabetic()) && value.len() >= 2)
}

fn canonical_metric_label(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "cpu" => "CPU".to_string(),
        "gpu" | "gpu利用率" | "gpu 利用率" => "GPU 利用率".to_string(),
        "dau" => "DAU".to_string(),
        "mau" => "MAU".to_string(),
        "gmv" => "GMV".to_string(),
        "qps" => "QPS".to_string(),
        "pv" => "PV".to_string(),
        "uv" => "UV".to_string(),
        "smacc" => "SMACC".to_string(),
        "smact" => "SMACT".to_string(),
        "smocc" => "SMOCC".to_string(),
        "gputl" => "GPUTL".to_string(),
        _ => value.trim().to_string(),
    }
}

fn extract_statement_insight(statement: &str) -> Option<String> {
    let marker = ["但", "表明", "说明", "意味着", "因此", "所以"]
        .iter()
        .filter_map(|marker| statement.find(marker).map(|position| (position, *marker)))
        .min_by_key(|(position, _)| *position)?;
    let mut insight = statement[marker.0 + marker.1.len()..]
        .trim_matches(|ch: char| ch.is_whitespace() || "，,：:。；;".contains(ch))
        .to_string();
    insight = insight
        .replace("存在掩盖低效的事实", "可能掩盖实际低效")
        .replace("存在掩盖低效的情况", "可能掩盖实际低效");
    (!insight.is_empty()).then_some(clip_text(&insight, 120))
}

fn summarize_rows(rows: &[SemanticMetricRow], insight: Option<&str>) -> String {
    let mut summary = String::new();
    if let Some(first) = rows.first() {
        let comparable = rows
            .iter()
            .filter(|row| row.metric == first.metric && !row.dimension.is_empty())
            .take(4)
            .collect::<Vec<_>>();
        if comparable.len() >= 2 {
            summary = format!(
                "{}：{}",
                first.metric,
                comparable
                    .iter()
                    .map(|row| format!("{} {}", row.dimension, row.value))
                    .collect::<Vec<_>>()
                    .join("，")
            );
        }
    }
    if summary.is_empty() {
        summary = rows
            .iter()
            .take(4)
            .map(|row| {
                if row.dimension.is_empty() {
                    format!("{} {}", row.metric, row.value)
                } else {
                    format!("{}{} {}", row.dimension, row.metric, row.value)
                }
            })
            .collect::<Vec<_>>()
            .join("，");
    }
    if let Some(insight) = insight.filter(|value| !value.is_empty()) {
        summary.push_str("；");
        summary.push_str(insight);
    }
    clip_text(&summary, 220)
}

fn metric_statements(text: &str, observed_at: i64) -> Vec<Value> {
    text.split(['\n', '。', '；', ';'])
        .map(str::trim)
        .filter(|line| semantic_statement(line, Some(observed_at)).is_some())
        .take(80)
        .map(|line| json!({"statement": clip_text(line, 500), "observed_at": observed_at}))
        .collect()
}

fn extract_http_urls(text: &str) -> Vec<String> {
    let mut results = Vec::new();
    let mut remaining = text;
    while let Some(start) = [remaining.find("https://"), remaining.find("http://")]
        .into_iter()
        .flatten()
        .min()
    {
        let tail = &remaining[start..];
        let end = tail
            .char_indices()
            .find(|(_, ch)| ch.is_whitespace() || "\"'<>（）()【】[]，。；、".contains(*ch))
            .map(|(index, _)| index)
            .unwrap_or(tail.len());
        let url = tail[..end]
            .trim_end_matches(['.', ',', ';', ':'])
            .to_string();
        if !url.is_empty() && !results.contains(&url) {
            results.push(url);
        }
        remaining = &tail[end..];
        if end == 0 {
            break;
        }
    }
    results
}

fn canonical_data_url(raw: &str) -> Option<String> {
    let mut parsed = reqwest::Url::parse(raw.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let filtered_pairs = parsed
        .query_pairs()
        .filter(|(key, _)| !is_sensitive_url_parameter(key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if parsed.query().is_some() {
        parsed.set_query(None);
        if !filtered_pairs.is_empty() {
            parsed.query_pairs_mut().extend_pairs(&filtered_pairs);
        }
    }
    if parsed
        .fragment()
        .map(|fragment| {
            let lowered = fragment.to_lowercase();
            lowered.contains("access_token=")
                || lowered.contains("id_token=")
                || lowered.contains("api_key=")
                || lowered.contains("signature=")
        })
        .unwrap_or(false)
    {
        parsed.set_fragment(None);
    }
    if parsed.path().len() > 1 && parsed.path().ends_with('/') {
        let trimmed = parsed.path().trim_end_matches('/').to_string();
        parsed.set_path(&trimmed);
    }
    Some(parsed.to_string())
}

fn is_sensitive_url_parameter(key: &str) -> bool {
    let key = key.to_lowercase();
    matches!(
        key.as_str(),
        "token"
            | "access_token"
            | "id_token"
            | "refresh_token"
            | "api_key"
            | "apikey"
            | "authorization"
            | "password"
            | "passwd"
            | "secret"
            | "signature"
            | "sig"
            | "credential"
            | "oauth_code"
    ) || key.ends_with("_token")
        || key.contains("signature")
        || key.contains("credential")
}

fn source_exists(conn: &Connection, key: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM data_sources WHERE canonical_key = ?1",
        [key],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn source_id_for_key(conn: &Connection, key: &str) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT id FROM data_sources WHERE canonical_key = ?1",
        [key],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn latest_snapshot(
    conn: &Connection,
    source_id: i64,
) -> Result<Option<DataSnapshotRecord>, StorageError> {
    let mut snapshot = conn
        .query_row(
            "SELECT id, source_id, collected_at, observed_at, collector, content_text,
                structured_data, content_hash, freshness_ttl_seconds, provenance,
                source_capture_ids, source_timeline_ids, status
         FROM data_snapshots WHERE source_id = ?1
         ORDER BY collected_at DESC, id DESC LIMIT 1",
            [source_id],
            |row| {
                Ok(DataSnapshotRecord {
                    id: row.get(0)?,
                    source_id: row.get(1)?,
                    collected_at: row.get(2)?,
                    observed_at: row.get(3)?,
                    collector: row.get(4)?,
                    content_text: row.get(5)?,
                    structured_data: parse_json_value(row.get::<_, String>(6)?, json!({})),
                    content_hash: row.get(7)?,
                    freshness_ttl_seconds: row.get(8)?,
                    provenance: parse_json_value(row.get::<_, String>(9)?, json!({})),
                    source_capture_ids: parse_json_i64(row.get::<_, String>(10)?),
                    source_timeline_ids: parse_json_i64(row.get::<_, String>(11)?),
                    status: row.get(12)?,
                })
            },
        )
        .optional()?;
    if let Some(snapshot) = &mut snapshot {
        let mut stmt = conn.prepare(
            "SELECT capture_id, timeline_id
             FROM data_source_links
             WHERE source_id = ?1
             ORDER BY observed_at DESC, id DESC",
        )?;
        let links = stmt.query_map([source_id], |row| {
            Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?))
        })?;
        for link in links {
            let (capture_id, timeline_id) = link?;
            if let Some(capture_id) = capture_id {
                snapshot.source_capture_ids.push(capture_id);
            }
            if let Some(timeline_id) = timeline_id {
                snapshot.source_timeline_ids.push(timeline_id);
            }
        }
        snapshot.source_capture_ids.sort_unstable();
        snapshot.source_capture_ids.dedup();
        snapshot.source_timeline_ids.sort_unstable();
        snapshot.source_timeline_ids.dedup();
        if let Some(semantic) = semantic_view_for_snapshot(snapshot) {
            merge_semantic_view(&mut snapshot.structured_data, semantic);
        }
    }
    Ok(snapshot)
}

fn merge_semantic_view(structured: &mut Value, semantic: Value) {
    if !structured.is_object() {
        *structured = json!({});
    }
    let Some(target) = structured.as_object_mut() else {
        return;
    };
    let Some(fields) = semantic.as_object() else {
        return;
    };
    for key in [
        "extraction_version",
        "summary",
        "metric_rows",
        "metric_statements",
    ] {
        if let Some(value) = fields.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
}

fn map_data_source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DataSourceRecord> {
    Ok(DataSourceRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        source_kind: row.get(2)?,
        source_url: row.get(3)?,
        access_mode: row.get(4)?,
        refresh_policy: row.get(5)?,
        realtime_level: row.get(6)?,
        source_app_name: row.get(7)?,
        source_window_title: row.get(8)?,
        tags: parse_json_strings(row.get::<_, String>(9)?),
        first_seen_at: row.get(10)?,
        last_seen_at: row.get(11)?,
        last_collected_at: row.get(12)?,
        last_success_at: row.get(13)?,
        last_error_code: row.get(14)?,
        status: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        latest_snapshot: None,
    })
}

fn parse_json_value(raw: String, fallback: Value) -> Value {
    serde_json::from_str(&raw).unwrap_or(fallback)
}

fn parse_json_strings(raw: String) -> Vec<String> {
    serde_json::from_str(&raw).unwrap_or_default()
}

fn parse_json_i64(raw: String) -> Vec<i64> {
    serde_json::from_str(&raw).unwrap_or_default()
}

fn hash_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn clip_text(text: &str, max_chars: usize) -> String {
    let normalized = text.trim();
    if normalized.chars().count() <= max_chars {
        return normalized.to_string();
    }
    normalized.chars().take(max_chars).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_report_urls_and_metric_statements() {
        assert!(looks_like_data_url(
            "https://bi.example.com/dashboard/weekly",
            "经营看板",
            ""
        ));
        assert!(is_concrete_data_statement("本周订单 1200，环比增长 8%"));
        assert!(is_concrete_data_statement(
            "数据库实例配置为 4 核 CPU、8GB 内存和 50GB 存储"
        ));
        assert!(is_concrete_data_statement(
            "服务器内存用量为 864MB，当前负载较高"
        ));
        assert!(!is_concrete_data_statement("完成订单模块重构"));
        assert!(!is_concrete_data_statement("规划 1000 集历史短剧生产流程"));
        assert!(!is_concrete_data_statement("鲜嘉麒、王海威等 5 人参加会议"));
        assert!(!is_concrete_data_statement("第 2/5 步，7 个文件已更改"));
        assert!(!is_concrete_data_statement(
            "用户在 2026 年 8 月 1 日 13:29 打开访达"
        ));
        assert!(!is_concrete_data_statement(
            "Comments (1) Go to the first comment Reply... 0 words Upload Log Help Center Keyboard Shortcuts"
        ));
        assert!(!is_concrete_data_statement("9类 43%"));
        assert!(!is_concrete_data_statement("7类33%"));
        assert!(!is_concrete_data_statement("文本推理资产 5类|24%"));
        assert!(is_concrete_data_statement(
            "生成与理解占76%，是跨BU复用的首要抓手"
        ));
    }

    #[test]
    fn builds_explainable_gpu_summary_and_metric_table() {
        let statement = "背景显示国内日均 GPU 利用率为 42%，海外为 47%，但 GPUTL 无法反映硅片内 SM 的实际使用情况，存在掩盖低效的事实";
        let (rows, summary) = semantic_statement(statement, Some(1700000000000)).unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].dimension, "国内");
        assert_eq!(rows[0].metric, "日均 GPU 利用率");
        assert_eq!(rows[0].value, "42%");
        assert_eq!(rows[1].dimension, "海外");
        assert_eq!(rows[1].metric, "日均 GPU 利用率");
        assert_eq!(rows[1].value, "47%");
        assert_eq!(
            summary,
            "日均 GPU 利用率：国内 42%，海外 47%；GPUTL 无法反映硅片内 SM 的实际使用情况，可能掩盖实际低效"
        );
    }

    #[test]
    fn keeps_comparison_values_as_semantic_table_rows() {
        let (rows, _) = semantic_statement("本周订单 1200，环比增长 8%", None).unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].metric, "订单");
        assert_eq!(rows[0].value, "1200");
        assert_eq!(rows[1].metric, "环比增长");
        assert_eq!(rows[1].value, "8%");
    }

    #[test]
    fn deleted_data_stays_hidden_and_is_not_automatically_restored() {
        let storage = StorageManager::open_in_memory().unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO data_sources (
                        canonical_key, title, source_kind, access_mode, refresh_policy,
                        realtime_level, tags, first_seen_at, last_seen_at, status,
                        created_at, updated_at
                     ) VALUES (
                        'memory:timeline:88', 'GPU 指标', 'work_memory', 'memory_only',
                        'never', 'observed', '[\"work_memory\"]', 1700000000000,
                        1700000000000, 'active', 1700000000000, 1700000000000
                     )",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO data_snapshots (
                        source_id, collected_at, observed_at, collector, content_text,
                        structured_data, content_hash, freshness_ttl_seconds, provenance,
                        source_capture_ids, source_timeline_ids, status, created_at
                     ) VALUES (
                        1, 1700000000000, 1700000000000, 'memory_extract',
                        '国内日均 GPU 利用率为 42%',
                        '{\"metric_statements\":[{\"statement\":\"国内日均 GPU 利用率为 42%\"}]}',
                        'gpu-hash', 0, '{}', '[]', '[88]', 'success', 1700000000000
                     )",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        assert_eq!(storage.list_data_sources(None, 20, 0).unwrap().1, 1);
        assert!(storage.delete_data_source(1).unwrap());
        assert_eq!(storage.list_data_sources(None, 20, 0).unwrap().1, 0);
        assert!(storage.get_data_source(1).unwrap().is_none());
    }

    #[test]
    fn historical_ui_noise_is_not_listed_or_recalled_as_data() {
        let storage = StorageManager::open_in_memory().unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO data_sources (
                        canonical_key, title, source_kind, access_mode, refresh_policy,
                        realtime_level, tags, first_seen_at, last_seen_at, status,
                        created_at, updated_at
                     ) VALUES (
                        'memory:timeline:99', '聊天界面', 'work_memory', 'memory_only',
                        'never', 'observed', '[\"work_memory\"]', 1700000000000,
                        1700000000000, 'active', 1700000000000, 1700000000000
                     )",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO data_snapshots (
                        source_id, collected_at, observed_at, collector, content_text,
                        structured_data, content_hash, freshness_ttl_seconds, provenance,
                        source_capture_ids, source_timeline_ids, status, created_at
                     ) VALUES (
                        1, 1700000000000, 1700000000000, 'memory_extract',
                        '用户在 2026 年 8 月 1 日 13:29 打开访达',
                        '{\"metric_statements\":[{\"statement\":\"用户在 2026 年 8 月 1 日 13:29 打开访达\"}]}',
                        'noise-hash', 0, '{}', '[]', '[99]', 'success', 1700000000000
                     )",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let (listed, total) = storage.list_data_sources(None, 20, 0).unwrap();
        let recalled = storage
            .search_data_sources("访达", false, 1700000001000, 10)
            .unwrap();

        assert_eq!(total, 0);
        assert!(listed.is_empty());
        assert!(recalled.is_empty());
    }

    #[test]
    fn canonical_url_keeps_filters_and_spa_route_but_drops_credentials() {
        assert_eq!(
            canonical_data_url("https://bi.example.com/report/?team=a&access_token=secret#chart")
                .as_deref(),
            Some("https://bi.example.com/report?team=a#chart")
        );
        assert!(canonical_data_url("file:///tmp/report.html").is_none());
    }

    #[test]
    fn freshness_weights_live_reports_and_decays_work_memory() {
        assert_eq!(freshness_for("report_url", 60), ("live", 1.0));
        assert_eq!(freshness_for("report_url", 2 * 24 * 3600).0, "stale");
        assert!(
            freshness_for("work_memory", 2 * 24 * 3600).1
                > freshness_for("work_memory", 40 * 24 * 3600).1
        );
    }

    #[test]
    fn browser_attach_snapshot_is_accepted_by_the_migration_contract() {
        let storage = StorageManager::open_in_memory().unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO data_sources (
                        canonical_key, title, source_kind, source_url, access_mode,
                        refresh_policy, realtime_level, first_seen_at, last_seen_at,
                        created_at, updated_at
                     ) VALUES (
                        'url:https://bi.example.com/dashboard', '经营看板', 'report_url',
                        'https://bi.example.com/dashboard', 'browser_session', 'on_demand',
                        'live', 1700000000000, 1700000000000, 1700000000000, 1700000000000
                     )",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let snapshot = storage
            .save_data_snapshot(
                1,
                "browser_attach",
                Some("经营看板"),
                "本周订单 1200",
                &json!({"tables": [["指标", "值"], ["订单", "1200"]]}),
                1700000001000,
            )
            .unwrap();

        assert_eq!(snapshot.collector, "browser_attach");
        assert_eq!(snapshot.content_text, "本周订单 1200");

        let replaced = storage
            .save_data_snapshot(
                1,
                "browser_attach",
                Some("经营看板"),
                "本周订单 1350",
                &json!({"tables": [["指标", "值"], ["订单", "1350"]]}),
                1700000002000,
            )
            .unwrap();
        let snapshot_count = storage
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM data_snapshots WHERE source_id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(snapshot_count, 1);
        assert_eq!(replaced.id, snapshot.id);
        assert_eq!(replaced.content_text, "本周订单 1350");
    }

    #[test]
    fn exact_report_url_participates_in_the_same_top_k_ranking() {
        let storage = StorageManager::open_in_memory().unwrap();
        storage
            .with_conn(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO data_sources (
                        id, canonical_key, title, source_kind, source_url, access_mode,
                        refresh_policy, realtime_level, tags, first_seen_at, last_seen_at,
                        status, created_at, updated_at
                    ) VALUES
                        (1, 'report:https://bi.example.com/dashboard/gpu?team=a', 'GPU 实时看板',
                         'report_url', 'https://bi.example.com/dashboard/gpu?team=a',
                         'browser_session', 'on_demand', 'live', '["report"]', 1, 1,
                         'active', 1, 1),
                        (2, 'memory:timeline:2', 'GPU 利用率治理复盘', 'work_memory', NULL,
                         'memory_only', 'never', 'observed', '["work_memory"]', 2, 2,
                         'active', 2, 2);
                    INSERT INTO data_snapshots (
                        source_id, collected_at, observed_at, collector, content_text,
                        structured_data, content_hash, freshness_ttl_seconds, provenance,
                        source_capture_ids, source_timeline_ids, status, created_at
                    ) VALUES (
                        2, 2, 2, 'memory_extract', 'GPU 利用率治理方案与历史复盘',
                        '{"metric_rows":[{"metric":"GPU 利用率","value":"42%"}]}',
                        'memory', 0, '{}', '[]', '[2]', 'success', 2
                    );
                    "#,
                )?;
                Ok(())
            })
            .unwrap();

        let results = storage
            .search_data_sources(
                "https://bi.example.com/dashboard/gpu?team=a\n请使用最新 GPU 数据",
                true,
                1700000000000,
                1,
            )
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].source_id, 1);
        assert_eq!(results[0].relevance_score, 1.0);
        assert!(results[0].refresh_required);
    }

    #[test]
    fn extraction_is_idempotent_and_searches_snapshot_content() {
        let storage = StorageManager::open_in_memory().unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO captures (
                        id, ts, app_name, win_title, event_type, ax_text, url,
                        webpage_title, is_sensitive, pii_scrubbed
                     ) VALUES (
                        1, 1700000000000, 'Google Chrome', '经营看板', 'manual',
                        '本周订单 1200，环比增长 8%',
                        'https://bi.example.com/dashboard/weekly', '经营数据看板', 0, 0
                     )",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO timelines (
                        id, capture_id, summary, overview, details, entities, category,
                        importance, created_at_ms, updated_at_ms
                     ) VALUES (
                        7, 1, '本周经营复盘', '订单 1200，环比增长 8%',
                        '{\"period\":\"weekly\"}', '[]', 'work', 4,
                        1700000000000, 1700000000000
                     )",
                    [],
                )?;
                conn.execute("UPDATE captures SET timeline_id = 7 WHERE id = 1", [])?;
                conn.execute(
                    "INSERT INTO captures (
                        id, ts, app_name, win_title, event_type, ax_text, timeline_id,
                        is_sensitive, pii_scrubbed
                     ) VALUES (
                        2, 1700000060000, 'Feishu', '项目群', 'manual',
                        '讨论下周计划，不含新的指标值', 7, 0, 0
                     )",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let first = storage.extract_data_candidates(100).unwrap();
        let second = storage.extract_data_candidates(100).unwrap();
        let (sources, total) = storage.list_data_sources(None, 20, 0).unwrap();
        let (matched, matched_total) = storage.list_data_sources(Some("订单 1200"), 20, 0).unwrap();
        let report_results = storage
            .search_data_sources("经营看板", true, 1700000001000, 10)
            .unwrap();

        assert_eq!(first.source_created_count, 2);
        assert_eq!(first.snapshot_created_count, 1);
        assert_eq!(second.source_created_count, 0);
        assert_eq!(second.snapshot_created_count, 0);
        assert_eq!(total, 1);
        assert_eq!(sources.len(), 1);
        let (pending, pending_total) = storage.list_pending_data_sources(None, 20).unwrap();
        assert_eq!(pending_total, 1);
        assert_eq!(pending.len(), 1);
        assert_eq!(matched_total, 1);
        assert_eq!(matched[0].source_kind, "work_memory");
        assert_eq!(
            matched[0]
                .latest_snapshot
                .as_ref()
                .map(|snapshot| snapshot.collected_at),
            Some(1700000000000)
        );
        let report = report_results
            .iter()
            .find(|item| item.source_kind == "report_url")
            .expect("report source is recalled");
        assert!(report.refresh_required);
        assert!(!report.can_use);
    }

    #[test]
    fn extraction_cursor_backfills_history_without_starving_new_captures() {
        let storage = StorageManager::open_in_memory().unwrap();
        storage
            .with_conn(|conn| {
                for id in 1_i64..=5 {
                    conn.execute(
                        "INSERT INTO captures (
                            id, ts, app_name, win_title, event_type, url,
                            webpage_title, is_sensitive, pii_scrubbed
                         ) VALUES (?1, ?2, 'Google Chrome', '经营看板', 'manual', ?3,
                                   '经营看板', 0, 0)",
                        params![
                            id,
                            1700000000000_i64 + id,
                            format!("https://bi.example.com/dashboard/{id}")
                        ],
                    )?;
                }
                Ok(())
            })
            .unwrap();

        assert_eq!(
            storage
                .extract_data_candidates(2)
                .unwrap()
                .source_created_count,
            2
        );
        assert_eq!(
            storage
                .extract_data_candidates(2)
                .unwrap()
                .source_created_count,
            2
        );

        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO captures (
                        id, ts, app_name, win_title, event_type, url,
                        webpage_title, is_sensitive, pii_scrubbed
                     ) VALUES (6, 1700000000006, 'Google Chrome', '经营看板', 'manual',
                               'https://bi.example.com/dashboard/6', '经营看板', 0, 0)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let mixed_batch = storage.extract_data_candidates(2).unwrap();
        assert_eq!(mixed_batch.source_created_count, 2);
        let (_, total) = storage.list_data_sources(None, 20, 0).unwrap();
        let (_, pending_total) = storage.list_pending_data_sources(None, 20).unwrap();
        assert_eq!(total, 0);
        assert_eq!(pending_total, 6);
    }
}
