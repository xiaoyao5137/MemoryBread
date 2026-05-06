//! vector_index 表的 CRUD 操作
//!
//! SQLite 仅存储向量元数据（capture_id / qdrant_point_id / chunk_text 等），
//! 真实向量数据存储在 Qdrant，通过 qdrant_point_id 关联。

use rusqlite::{params, Connection};

use crate::storage::{
    error::StorageError,
    models::{NewVectorIndex, VectorIndexRecord},
    StorageManager,
};

// ─────────────────────────────────────────────────────────────────────────────
// 写操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 插入一条向量索引元数据，返回新行 id。
    pub fn insert_vector_index(&self, v: &NewVectorIndex) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_vector_index_inner(conn, v))
    }

    /// 批量插入向量索引元数据（一次 capture 可能被分成多个 chunk）。
    pub fn insert_vector_indices_batch(
        &self,
        indices: &[NewVectorIndex],
    ) -> Result<Vec<i64>, StorageError> {
        self.with_conn(|conn| {
            let mut ids = Vec::with_capacity(indices.len());
            for v in indices {
                ids.push(insert_vector_index_inner(conn, v)?);
            }
            Ok(ids)
        })
    }

    /// 删除指定 capture 的所有向量索引记录（capture 被删除时级联清理）。
    pub fn delete_vector_indices_by_capture(&self, capture_id: i64) -> Result<usize, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "DELETE FROM vector_index WHERE capture_id = ?1",
                params![capture_id],
            )?;
            Ok(affected)
        })
    }

    /// 删除指定 Qdrant point_id 的元数据。
    pub fn delete_vector_index_by_point_id(
        &self,
        qdrant_point_id: &str,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "DELETE FROM vector_index WHERE qdrant_point_id = ?1",
                params![qdrant_point_id],
            )?;
            Ok(affected > 0)
        })
    }
}

fn insert_vector_index_inner(conn: &Connection, v: &NewVectorIndex) -> Result<i64, StorageError> {
    conn.execute(
        "INSERT INTO vector_index
            (capture_id, qdrant_point_id, chunk_index, chunk_text, model_name, created_at,
             doc_key, source_type, knowledge_id, time, start_time, end_time,
             observed_at, event_time_start, event_time_end, history_view,
             content_origin, activity_type, is_self_generated, evidence_strength,
             app_name, win_title, category, user_verified)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        params![
            v.capture_id,
            v.qdrant_point_id,
            v.chunk_index,
            v.chunk_text,
            v.model_name,
            v.created_at,
            v.doc_key,
            v.source_type,
            v.knowledge_id,
            v.time,
            v.start_time,
            v.end_time,
            v.observed_at,
            v.event_time_start,
            v.event_time_end,
            v.history_view,
            v.content_origin,
            v.activity_type,
            v.is_self_generated,
            v.evidence_strength,
            v.app_name,
            v.win_title,
            v.category,
            v.user_verified,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// ─────────────────────────────────────────────────────────────────────────────
// 读操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 按 id 获取单条向量索引记录。
    pub fn get_vector_index(&self, id: i64) -> Result<Option<VectorIndexRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, qdrant_point_id, chunk_index, chunk_text, model_name, created_at,
                        doc_key, source_type, knowledge_id, time, start_time, end_time,
                        observed_at, event_time_start, event_time_end, history_view,
                        content_origin, activity_type, is_self_generated, evidence_strength,
                        app_name, win_title, category, user_verified
                 FROM vector_index WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_vector_index(row)?))
            } else {
                Ok(None)
            }
        })
    }

    /// 获取指定 capture 的所有向量索引记录，按 chunk_index 升序。
    pub fn get_vector_indices_by_capture(
        &self,
        capture_id: i64,
    ) -> Result<Vec<VectorIndexRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, qdrant_point_id, chunk_index, chunk_text, model_name, created_at,
                        doc_key, source_type, knowledge_id, time, start_time, end_time,
                        observed_at, event_time_start, event_time_end, history_view,
                        content_origin, activity_type, is_self_generated, evidence_strength,
                        app_name, win_title, category, user_verified
                 FROM vector_index WHERE capture_id = ?1 ORDER BY chunk_index ASC",
            )?;
            let rows = stmt.query_map(params![capture_id], |row| {
                Ok(row_to_vector_index(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    /// 按 qdrant_point_id 查找元数据（Qdrant 检索后反查 SQLite 上下文）。
    pub fn get_vector_index_by_point_id(
        &self,
        qdrant_point_id: &str,
    ) -> Result<Option<VectorIndexRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, qdrant_point_id, chunk_index, chunk_text, model_name, created_at,
                        doc_key, source_type, knowledge_id, time, start_time, end_time,
                        observed_at, event_time_start, event_time_end, history_view,
                        content_origin, activity_type, is_self_generated, evidence_strength,
                        app_name, win_title, category, user_verified
                 FROM vector_index WHERE qdrant_point_id = ?1",
            )?;
            let mut rows = stmt.query(params![qdrant_point_id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_vector_index(row)?))
            } else {
                Ok(None)
            }
        })
    }

    /// 批量按 qdrant_point_id 列表反查元数据（RAG 检索后批量获取上下文）。
    pub fn get_vector_indices_by_point_ids(
        &self,
        point_ids: &[String],
    ) -> Result<Vec<VectorIndexRecord>, StorageError> {
        if point_ids.is_empty() {
            return Ok(vec![]);
        }
        self.with_conn(|conn| {
            let placeholders = point_ids
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", i + 1))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT id, capture_id, qdrant_point_id, chunk_index, chunk_text, model_name, created_at,
                        doc_key, source_type, knowledge_id, time, start_time, end_time,
                        observed_at, event_time_start, event_time_end, history_view,
                        content_origin, activity_type, is_self_generated, evidence_strength,
                        app_name, win_title, category, user_verified
                 FROM vector_index WHERE qdrant_point_id IN ({})",
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> =
                point_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(row_to_vector_index(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
        })
    }

    /// 检查某个 capture 是否已完成向量化。
    pub fn is_capture_vectorized(&self, capture_id: i64) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM vector_index WHERE capture_id = ?1 AND source_type = 'capture'",
                params![capture_id],
                |row| row.get(0),
            )?;
            Ok(count > 0)
        })
    }

    /// 列举尚未向量化的 capture id（用于批处理任务调度）。
    pub fn list_unvectorized_capture_ids(&self, limit: usize) -> Result<Vec<i64>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT c.id FROM captures c
                 LEFT JOIN vector_index v ON v.capture_id = c.id AND v.source_type = 'capture'
                 WHERE v.id IS NULL AND c.is_sensitive = 0
                 ORDER BY c.ts ASC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], |row| row.get::<_, i64>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    /// 统计已向量化的 capture 数量（用于调试面板）。
    pub fn count_vectorized(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(DISTINCT doc_key) FROM vector_index",
                [],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    /// 根据 capture_id 获取向量索引记录（用于调试面板）。
    pub fn get_by_capture_id(&self, capture_id: i64) -> Result<VectorIndexRecord, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, qdrant_point_id, chunk_index, chunk_text, model_name, created_at,
                        doc_key, source_type, knowledge_id, time, start_time, end_time,
                        observed_at, event_time_start, event_time_end, history_view,
                        content_origin, activity_type, is_self_generated, evidence_strength,
                        app_name, win_title, category, user_verified
                 FROM vector_index
                 WHERE capture_id = ?1
                 LIMIT 1",
            )?;
            let record = stmt.query_row(params![capture_id], |row| {
                Ok(row_to_vector_index(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            Ok(record)
        })
    }
}

fn row_to_vector_index(row: &rusqlite::Row<'_>) -> Result<VectorIndexRecord, StorageError> {
    Ok(VectorIndexRecord {
        id: row.get(0)?,
        capture_id: row.get(1)?,
        qdrant_point_id: row.get(2)?,
        chunk_index: row.get(3)?,
        chunk_text: row.get(4)?,
        model_name: row.get(5)?,
        created_at: row.get(6)?,
        doc_key: row.get(7)?,
        source_type: row.get(8)?,
        knowledge_id: row.get(9)?,
        time: row.get(10)?,
        start_time: row.get(11)?,
        end_time: row.get(12)?,
        observed_at: row.get(13)?,
        event_time_start: row.get(14)?,
        event_time_end: row.get(15)?,
        history_view: row.get(16)?,
        content_origin: row.get(17)?,
        activity_type: row.get(18)?,
        is_self_generated: row.get(19)?,
        evidence_strength: row.get(20)?,
        app_name: row.get(21)?,
        win_title: row.get(22)?,
        category: row.get(23)?,
        user_verified: row.get(24)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        db::current_ts_ms,
        models::{EventType, NewCapture},
    };

    fn make_mgr() -> StorageManager {
        StorageManager::open_in_memory().expect("内存数据库初始化失败")
    }

    fn insert_test_capture(mgr: &StorageManager) -> i64 {
        mgr.insert_capture(&NewCapture {
            ts: current_ts_ms(),
            app_name: Some("TestApp".into()),
            app_bundle_id: None,
            win_title: None,
            event_type: EventType::Auto,
            ax_text: Some("测试文本".into()),
            ax_focused_role: None,
            ax_focused_id: None,
            ocr_text: None,
            screenshot_path: None,
            input_text: None,
            is_sensitive: false,
        })
        .unwrap()
    }

    fn sample_index(capture_id: i64, point_id: &str, chunk_idx: i64) -> NewVectorIndex {
        NewVectorIndex {
            capture_id,
            qdrant_point_id: point_id.into(),
            chunk_index: chunk_idx,
            chunk_text: "测试分块文本".into(),
            model_name: "bge-m3".into(),
            created_at: current_ts_ms(),
            doc_key: format!("capture:{}", capture_id),
            source_type: "capture".into(),
            knowledge_id: None,
            time: Some(current_ts_ms()),
            start_time: None,
            end_time: None,
            observed_at: None,
            event_time_start: None,
            event_time_end: None,
            history_view: false,
            content_origin: None,
            activity_type: None,
            is_self_generated: false,
            evidence_strength: None,
            app_name: Some("TestApp".into()),
            win_title: Some("Test Window".into()),
            category: None,
            user_verified: false,
        }
    }

    #[test]
    fn test_insert_and_get() {
        let mgr = make_mgr();
        let capture_id = insert_test_capture(&mgr);
        let id = mgr
            .insert_vector_index(&sample_index(capture_id, "uuid-001", 0))
            .unwrap();
        assert!(id > 0);

        let rec = mgr.get_vector_index(id).unwrap().unwrap();
        assert_eq!(rec.capture_id, capture_id);
        assert_eq!(rec.qdrant_point_id, "uuid-001");
        assert_eq!(rec.model_name, "bge-m3");
        assert_eq!(rec.doc_key, format!("capture:{}", capture_id));
        assert_eq!(rec.source_type, "capture");
    }

    #[test]
    fn test_get_by_capture() {
        let mgr = make_mgr();
        let capture_id = insert_test_capture(&mgr);
        mgr.insert_vector_index(&sample_index(capture_id, "uuid-001", 0))
            .unwrap();
        mgr.insert_vector_index(&sample_index(capture_id, "uuid-002", 1))
            .unwrap();

        let indices = mgr.get_vector_indices_by_capture(capture_id).unwrap();
        assert_eq!(indices.len(), 2);
        assert_eq!(indices[0].chunk_index, 0);
    }

    #[test]
    fn test_get_by_point_id() {
        let mgr = make_mgr();
        let capture_id = insert_test_capture(&mgr);
        mgr.insert_vector_index(&sample_index(capture_id, "uuid-abc", 0))
            .unwrap();

        let rec = mgr.get_vector_index_by_point_id("uuid-abc").unwrap();
        assert!(rec.is_some());

        let missing = mgr.get_vector_index_by_point_id("uuid-missing").unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn test_is_vectorized() {
        let mgr = make_mgr();
        let capture_id = insert_test_capture(&mgr);

        assert!(!mgr.is_capture_vectorized(capture_id).unwrap());
        mgr.insert_vector_index(&sample_index(capture_id, "uuid-xyz", 0))
            .unwrap();
        assert!(mgr.is_capture_vectorized(capture_id).unwrap());
    }

    #[test]
    fn test_list_unvectorized() {
        let mgr = make_mgr();
        let c1 = insert_test_capture(&mgr);
        let c2 = insert_test_capture(&mgr);

        mgr.insert_vector_index(&sample_index(c1, "uuid-001", 0))
            .unwrap();

        let unvectorized = mgr.list_unvectorized_capture_ids(10).unwrap();
        assert_eq!(unvectorized.len(), 1);
        assert_eq!(unvectorized[0], c2);
    }

    #[test]
    fn test_delete_by_capture() {
        let mgr = make_mgr();
        let capture_id = insert_test_capture(&mgr);
        mgr.insert_vector_index(&sample_index(capture_id, "uuid-d1", 0))
            .unwrap();
        mgr.insert_vector_index(&sample_index(capture_id, "uuid-d2", 1))
            .unwrap();

        let deleted = mgr.delete_vector_indices_by_capture(capture_id).unwrap();
        assert_eq!(deleted, 2);
        assert!(!mgr.is_capture_vectorized(capture_id).unwrap());
    }

    #[test]
    fn test_batch_query_by_point_ids() {
        let mgr = make_mgr();
        let capture_id = insert_test_capture(&mgr);
        mgr.insert_vector_index(&sample_index(capture_id, "p-001", 0))
            .unwrap();
        mgr.insert_vector_index(&sample_index(capture_id, "p-002", 1))
            .unwrap();

        let results = mgr
            .get_vector_indices_by_point_ids(&["p-001".into(), "p-002".into()])
            .unwrap();
        assert_eq!(results.len(), 2);
    }
}
