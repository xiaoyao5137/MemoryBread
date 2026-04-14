//! captures 表的 CRUD 操作
//!
//! 所有方法以 `StorageManager` 的方法形式提供，通过 `with_conn` 持有锁后操作。

use rusqlite::{params, Connection};

use crate::storage::{
    db::current_ts_ms,
    error::StorageError,
    models::{CaptureRecord, NewCapture},
    StorageManager,
};

// ─────────────────────────────────────────────────────────────────────────────
// 写操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 插入一条采集记录，返回新行的 id。
    pub fn insert_capture(&self, c: &NewCapture) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_capture_inner(conn, c))
    }

    /// 异步版本（在 spawn_blocking 中执行，不阻塞 tokio 运行时）。
    pub async fn insert_capture_async(&self, c: NewCapture) -> Result<i64, StorageError> {
        self.with_conn_async(move |conn| insert_capture_inner(conn, &c))
            .await
    }

    /// 在 Sidecar 完成 OCR 后，将结果回写到 captures 表。
    pub fn update_ocr_text(
        &self,
        id:         i64,
        ocr_text:   &str,
        confidence: f32,
    ) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            // confidence 存入 user_preferences 或日志，此处仅更新 ocr_text
            let _ = confidence; // 暂保留以备后续扩展
            conn.execute(
                "UPDATE captures SET ocr_text = ?1 WHERE id = ?2",
                params![ocr_text, id],
            )?;
            Ok(())
        })
    }

    /// 在 Sidecar 完成 ASR 后，将音频转录文本回写。
    pub fn update_audio_text(&self, id: i64, audio_text: &str) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE captures SET audio_text = ?1 WHERE id = ?2",
                params![audio_text, id],
            )?;
            Ok(())
        })
    }

    /// 标记该条记录已完成 PII 脱敏。
    pub fn mark_pii_scrubbed(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE captures SET pii_scrubbed = 1 WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        })
    }
}

fn insert_capture_inner(conn: &Connection, c: &NewCapture) -> Result<i64, StorageError> {
    conn.execute(
        "INSERT INTO captures
            (ts, app_name, app_bundle_id, win_title, event_type,
             ax_text, ax_focused_role, ax_focused_id,
             screenshot_path, input_text, is_sensitive)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            c.ts,
            c.app_name,
            c.app_bundle_id,
            c.win_title,
            c.event_type.as_str(),
            c.ax_text,
            c.ax_focused_role,
            c.ax_focused_id,
            c.screenshot_path,
            c.input_text,
            c.is_sensitive as i64,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// ─────────────────────────────────────────────────────────────────────────────
// 读操作
// ─────────────────────────────────────────────────────────────────────────────

/// captures 查询过滤条件
#[derive(Debug, Default)]
pub struct CaptureFilter {
    /// 起始时间（Unix ms，含）
    pub from_ts:  Option<i64>,
    /// 结束时间（Unix ms，含）
    pub to_ts:    Option<i64>,
    /// 按应用名过滤
    pub app_name: Option<String>,
    /// 关键词搜索
    pub query: Option<String>,
    /// 按单个 capture id 限定
    pub capture_id: Option<i64>,
    /// 是否过滤掉隐私记录（默认 true）
    pub exclude_sensitive: bool,
    /// 最多返回条数
    pub limit:    usize,
    /// 偏移
    pub offset:   usize,
}

impl CaptureFilter {
    pub fn new() -> Self {
        Self {
            exclude_sensitive: true,
            limit: 100,
            ..Default::default()
        }
    }
    pub fn last_24h() -> Self {
        let now = current_ts_ms();
        Self {
            from_ts: Some(now - 86_400_000),
            exclude_sensitive: true,
            limit: 500,
            ..Default::default()
        }
    }
}

impl StorageManager {
    /// 按 id 获取单条记录。
    pub fn get_capture(&self, id: i64) -> Result<Option<CaptureRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, app_name, app_bundle_id, win_title, event_type,
                        ax_text, ax_focused_role, ax_focused_id,
                        ocr_text, screenshot_path, input_text, audio_text,
                        is_sensitive, pii_scrubbed
                 FROM captures WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_capture(row)?))
            } else {
                Ok(None)
            }
        })
    }

    /// 按过滤条件列举采集记录，按 ts 倒序。
    pub fn list_captures(&self, filter: &CaptureFilter) -> Result<Vec<CaptureRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT c.id, c.ts, c.app_name, c.app_bundle_id, c.win_title, c.event_type,
                        c.ax_text, c.ax_focused_role, c.ax_focused_id,
                        c.ocr_text, c.screenshot_path, c.input_text, c.audio_text,
                        c.is_sensitive, c.pii_scrubbed
                 FROM captures c",
            );
            let query_pattern = filter.query.as_ref().map(|value| format!("%{}%", value));
            sql.push_str(" WHERE ");

            let mut wheres: Vec<String> = Vec::new();
            if filter.query.is_some() {
                wheres.push("(COALESCE(c.win_title, '') LIKE ? OR c.id IN (SELECT rowid FROM captures_fts WHERE captures_fts MATCH ?))".into());
            }
            if filter.from_ts.is_some() { wheres.push("c.ts >= ?".into()); }
            if filter.to_ts.is_some() { wheres.push("c.ts <= ?".into()); }
            if filter.app_name.is_some() { wheres.push("c.app_name = ?".into()); }
            if filter.capture_id.is_some() { wheres.push("c.id = ?".into()); }
            if filter.exclude_sensitive { wheres.push("c.is_sensitive = 0".into()); }

            let where_clause = if wheres.is_empty() { "1=1".to_string() } else { wheres.join(" AND ") };
            sql.push_str(&where_clause);
            sql.push_str(" ORDER BY c.ts DESC LIMIT ? OFFSET ?");

            let mut stmt = conn.prepare(&sql)?;
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(ref pattern) = query_pattern {
                bind_values.push(Box::new(pattern.clone()));
            }
            if let Some(ref query) = filter.query {
                bind_values.push(Box::new(query.clone()));
            }
            if let Some(v) = filter.from_ts { bind_values.push(Box::new(v)); }
            if let Some(v) = filter.to_ts { bind_values.push(Box::new(v)); }
            if let Some(ref v) = filter.app_name { bind_values.push(Box::new(v.clone())); }
            if let Some(v) = filter.capture_id { bind_values.push(Box::new(v)); }
            bind_values.push(Box::new(filter.limit as i64));
            bind_values.push(Box::new(filter.offset as i64));

            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(row_to_capture(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;

            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_captures(&self, filter: &CaptureFilter) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let mut sql = String::from("SELECT COUNT(*) FROM captures c");
            let query_pattern = filter.query.as_ref().map(|value| format!("%{}%", value));
            sql.push_str(" WHERE ");

            let mut wheres: Vec<String> = Vec::new();
            if filter.query.is_some() {
                wheres.push("(COALESCE(c.win_title, '') LIKE ? OR c.id IN (SELECT rowid FROM captures_fts WHERE captures_fts MATCH ?))".into());
            }
            if filter.from_ts.is_some() { wheres.push("c.ts >= ?".into()); }
            if filter.to_ts.is_some() { wheres.push("c.ts <= ?".into()); }
            if filter.app_name.is_some() { wheres.push("c.app_name = ?".into()); }
            if filter.capture_id.is_some() { wheres.push("c.id = ?".into()); }
            if filter.exclude_sensitive { wheres.push("c.is_sensitive = 0".into()); }

            let where_clause = if wheres.is_empty() { "1=1".to_string() } else { wheres.join(" AND ") };
            sql.push_str(&where_clause);

            let mut stmt = conn.prepare(&sql)?;
            let mut bind_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(ref pattern) = query_pattern {
                bind_values.push(Box::new(pattern.clone()));
            }
            if let Some(ref query) = filter.query {
                bind_values.push(Box::new(query.clone()));
            }
            if let Some(v) = filter.from_ts { bind_values.push(Box::new(v)); }
            if let Some(v) = filter.to_ts { bind_values.push(Box::new(v)); }
            if let Some(ref v) = filter.app_name { bind_values.push(Box::new(v.clone())); }
            if let Some(v) = filter.capture_id { bind_values.push(Box::new(v)); }
            let params: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();

            stmt.query_row(params.as_slice(), |row| row.get(0)).map_err(StorageError::Sqlite)
        })
    }

    pub fn search_captures_paginated(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<CaptureRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.ts, c.app_name, c.app_bundle_id, c.win_title, c.event_type,
                        c.ax_text, c.ax_focused_role, c.ax_focused_id,
                        c.ocr_text, c.screenshot_path, c.input_text, c.audio_text,
                        c.is_sensitive, c.pii_scrubbed
                 FROM captures c
                 JOIN captures_fts f ON f.rowid = c.id
                 WHERE captures_fts MATCH ?1
                   AND c.is_sensitive = 0
                 ORDER BY rank
                 LIMIT ?2 OFFSET ?3",
            )?;
            let rows = stmt.query_map(params![query, limit as i64, offset as i64], |row| {
                Ok(row_to_capture(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    pub fn count_search_captures(&self, query: &str) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*)
                 FROM captures c
                 JOIN captures_fts f ON f.rowid = c.id
                 WHERE captures_fts MATCH ?1
                   AND c.is_sensitive = 0",
                params![query],
                |row| row.get(0),
            ).map_err(StorageError::Sqlite)
        })
    }

    /// 简单列举最近的 N 条采集记录（用于调试面板）。
    pub fn list_capture_knowledge_links(
        &self,
        capture_ids: &[i64],
    ) -> Result<std::collections::HashMap<i64, (i64, String)>, StorageError> {
        if capture_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }

        self.with_conn(|conn| {
            let placeholders = std::iter::repeat("?")
                .take(capture_ids.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT capture_id, id, summary
                 FROM knowledge_entries
                 WHERE capture_id IN ({})
                   AND category = 'bake_knowledge'
                 ORDER BY updated_at DESC, id DESC",
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = capture_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;

            let mut result = std::collections::HashMap::new();
            for row in rows {
                let (capture_id, knowledge_id, summary) = row?;
                result.entry(capture_id).or_insert((knowledge_id, summary));
            }
            Ok(result)
        })
    }

    /// 简单列举最近的 N 条采集记录（用于调试面板）。
    pub fn list_recent(&self, limit: usize, offset: usize) -> Result<Vec<CaptureRecord>, StorageError> {
        let filter = CaptureFilter {
            exclude_sensitive: false,
            limit,
            offset,
            ..Default::default()
        };
        self.list_captures(&filter)
    }

    /// 统计总采集数（用于调试面板）。
    pub fn count(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM captures",
                [],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    /// FTS5 全文检索（关键词搜索）。
    pub fn search_captures(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<CaptureRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.ts, c.app_name, c.app_bundle_id, c.win_title, c.event_type,
                        c.ax_text, c.ax_focused_role, c.ax_focused_id,
                        c.ocr_text, c.screenshot_path, c.input_text, c.audio_text,
                        c.is_sensitive, c.pii_scrubbed
                 FROM captures c
                 JOIN captures_fts f ON f.rowid = c.id
                 WHERE captures_fts MATCH ?1
                   AND c.is_sensitive = 0
                 ORDER BY rank
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![query, limit as i64], |row| {
                Ok(row_to_capture(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 行映射辅助
// ─────────────────────────────────────────────────────────────────────────────

fn row_to_capture(row: &rusqlite::Row<'_>) -> Result<CaptureRecord, StorageError> {
    Ok(CaptureRecord {
        id:              row.get(0)?,
        ts:              row.get(1)?,
        app_name:        row.get(2)?,
        app_bundle_id:   row.get(3)?,
        win_title:       row.get(4)?,
        event_type:      row.get(5)?,
        ax_text:         row.get(6)?,
        ax_focused_role: row.get(7)?,
        ax_focused_id:   row.get(8)?,
        ocr_text:        row.get(9)?,
        screenshot_path: row.get(10)?,
        input_text:      row.get(11)?,
        audio_text:      row.get(12)?,
        is_sensitive:    row.get::<_, i64>(13)? != 0,
        pii_scrubbed:    row.get::<_, i64>(14)? != 0,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::models::EventType;

    fn make_mgr() -> StorageManager {
        StorageManager::open_in_memory().expect("内存数据库初始化失败")
    }

    fn sample_capture() -> NewCapture {
        NewCapture {
            ts:              1_700_000_000_000,
            app_name:        Some("Feishu".into()),
            app_bundle_id:   Some("com.feishu.feishu".into()),
            win_title:       Some("飞书 - 工作群".into()),
            event_type:      EventType::MouseClick,
            ax_text:         Some("欢迎使用飞书".into()),
            ax_focused_role: Some("AXTextField".into()),
            ax_focused_id:   Some("input-1".into()),
            screenshot_path: Some("2026/03/04/test.jpg".into()),
            input_text:      Some("你好".into()),
            is_sensitive:    false,
        }
    }

    #[test]
    fn test_insert_and_get() {
        let mgr = make_mgr();
        let id = mgr.insert_capture(&sample_capture()).unwrap();
        assert!(id > 0);

        let rec = mgr.get_capture(id).unwrap().expect("记录应存在");
        assert_eq!(rec.app_name.as_deref(), Some("Feishu"));
        assert_eq!(rec.ax_text.as_deref(), Some("欢迎使用飞书"));
        assert_eq!(rec.best_text(), Some("欢迎使用飞书"));
    }

    #[test]
    fn test_update_ocr_text() {
        let mgr = make_mgr();
        let id = mgr.insert_capture(&sample_capture()).unwrap();
        mgr.update_ocr_text(id, "OCR识别的文字", 0.92).unwrap();

        let rec = mgr.get_capture(id).unwrap().unwrap();
        assert_eq!(rec.ocr_text.as_deref(), Some("OCR识别的文字"));
    }

    #[test]
    fn test_list_captures() {
        let mgr = make_mgr();
        mgr.insert_capture(&sample_capture()).unwrap();
        mgr.insert_capture(&sample_capture()).unwrap();

        let filter = CaptureFilter::new();
        let list = mgr.list_captures(&filter).unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn test_fts_search() {
        let mgr = make_mgr();
        mgr.insert_capture(&sample_capture()).unwrap();

        // unicode61 分词器把连续汉字视为整个 token，"你好"存入 input_text，
        // FTS 对精确 token 的查询能命中。
        let results = mgr.search_captures("你好", 10).unwrap();
        assert!(!results.is_empty(), "FTS 应找到包含'你好'的记录");
    }

    #[test]
    fn test_sensitive_capture_excluded() {
        let mgr = make_mgr();
        let mut c = sample_capture();
        c.is_sensitive = true;
        c.ax_text = None;
        mgr.insert_capture(&c).unwrap();

        let filter = CaptureFilter::new(); // exclude_sensitive = true
        let list = mgr.list_captures(&filter).unwrap();
        assert_eq!(list.len(), 0, "敏感记录应被过滤");
    }
}
