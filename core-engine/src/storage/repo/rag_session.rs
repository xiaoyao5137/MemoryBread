//! rag_sessions 表的 CRUD 操作

use rusqlite::{params, Connection};

use crate::storage::{
    error::StorageError,
    models::{NewRagSession, RagSessionRecord},
    StorageManager,
};

// ─────────────────────────────────────────────────────────────────────────────
// 写操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 插入一条 RAG 会话记录，返回新行 id。
    pub fn insert_rag_session(&self, s: &NewRagSession) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_rag_session_inner(conn, s))
    }

    /// 会话结束后，将 LLM 响应和延迟回写。
    pub fn update_rag_response(
        &self,
        id: i64,
        llm_response: &str,
        latency_ms: i64,
    ) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE rag_sessions SET llm_response = ?1, latency_ms = ?2 WHERE id = ?3",
                params![llm_response, latency_ms, id],
            )?;
            Ok(())
        })
    }

    /// 记录用户对 RAG 结果的反馈/修改。
    pub fn record_rag_feedback(&self, id: i64, feedback: &str) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE rag_sessions SET user_feedback = ?1 WHERE id = ?2",
                params![feedback, id],
            )?;
            Ok(())
        })
    }
}

fn insert_rag_session_inner(conn: &Connection, s: &NewRagSession) -> Result<i64, StorageError> {
    conn.execute(
        "INSERT INTO rag_sessions
            (ts, scene_type, user_query, retrieved_ids, prompt_used, llm_response, latency_ms, model)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            s.ts,
            s.scene_type,
            s.user_query,
            s.retrieved_ids,
            s.prompt_used,
            s.llm_response,
            s.latency_ms,
            s.model,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// ─────────────────────────────────────────────────────────────────────────────
// 读操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 按 id 获取单条 RAG 会话。
    pub fn get_rag_session(&self, id: i64) -> Result<Option<RagSessionRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, scene_type, user_query, retrieved_ids,
                        prompt_used, llm_response, user_feedback, latency_ms, model
                 FROM rag_sessions WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_rag_session(row)?))
            } else {
                Ok(None)
            }
        })
    }

    /// 列举最近的 RAG 会话，按 ts 倒序。
    pub fn list_rag_sessions(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<RagSessionRecord>, StorageError> {
        self.list_rag_sessions_page(None, limit, offset)
            .map(|(records, _)| records)
    }

    /// 分页检索 RAG 会话；关键词同时匹配用户问题和模型回答。
    pub fn list_rag_sessions_page(
        &self,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<RagSessionRecord>, usize), StorageError> {
        self.with_conn(|conn| {
            let query = query.map(str::trim).filter(|value| !value.is_empty());
            if let Some(query) = query {
                let predicate = "(instr(lower(COALESCE(user_query, '')), lower(?1)) > 0
                                  OR instr(lower(COALESCE(llm_response, '')), lower(?1)) > 0)";
                let total = conn.query_row(
                    &format!("SELECT COUNT(*) FROM rag_sessions WHERE {predicate}"),
                    params![query],
                    |row| row.get::<_, i64>(0),
                )?;
                let mut stmt = conn.prepare(&format!(
                    "SELECT id, ts, scene_type, user_query, retrieved_ids,
                            prompt_used, llm_response, user_feedback, latency_ms, model
                     FROM rag_sessions WHERE {predicate}
                     ORDER BY ts DESC, id DESC LIMIT ?2 OFFSET ?3"
                ))?;
                let rows = stmt.query_map(params![query, limit as i64, offset as i64], |row| {
                    Ok(row_to_rag_session(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
                })?;
                let records = rows
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::Sqlite)?;
                Ok((records, total.max(0) as usize))
            } else {
                let total = conn.query_row("SELECT COUNT(*) FROM rag_sessions", [], |row| {
                    row.get::<_, i64>(0)
                })?;
                let mut stmt = conn.prepare(
                    "SELECT id, ts, scene_type, user_query, retrieved_ids,
                            prompt_used, llm_response, user_feedback, latency_ms, model
                     FROM rag_sessions ORDER BY ts DESC, id DESC LIMIT ?1 OFFSET ?2",
                )?;
                let rows = stmt.query_map(params![limit as i64, offset as i64], |row| {
                    Ok(row_to_rag_session(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
                })?;
                let records = rows
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::Sqlite)?;
                Ok((records, total.max(0) as usize))
            }
        })
    }

    /// 按场景类型列举 RAG 会话（用于生成 Prompt 时抽样历史）。
    pub fn list_rag_sessions_by_scene(
        &self,
        scene_type: &str,
        limit: usize,
    ) -> Result<Vec<RagSessionRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, scene_type, user_query, retrieved_ids,
                        prompt_used, llm_response, user_feedback, latency_ms, model
                 FROM rag_sessions WHERE scene_type = ?1 ORDER BY ts DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![scene_type, limit as i64], |row| {
                Ok(row_to_rag_session(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    /// 获取有用户修改反馈的会话（用于微调/强化学习）。
    pub fn list_rag_sessions_with_feedback(
        &self,
        limit: usize,
    ) -> Result<Vec<RagSessionRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, scene_type, user_query, retrieved_ids,
                        prompt_used, llm_response, user_feedback, latency_ms, model
                 FROM rag_sessions WHERE user_feedback IS NOT NULL ORDER BY ts DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], |row| {
                Ok(row_to_rag_session(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 行映射辅助
// ─────────────────────────────────────────────────────────────────────────────

fn row_to_rag_session(row: &rusqlite::Row<'_>) -> Result<RagSessionRecord, StorageError> {
    Ok(RagSessionRecord {
        id: row.get(0)?,
        ts: row.get(1)?,
        scene_type: row.get(2)?,
        user_query: row.get(3)?,
        retrieved_ids: row.get(4)?,
        prompt_used: row.get(5)?,
        llm_response: row.get(6)?,
        user_feedback: row.get(7)?,
        latency_ms: row.get(8)?,
        model: row.get(9)?,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_mgr() -> StorageManager {
        StorageManager::open_in_memory().expect("内存数据库初始化失败")
    }

    fn sample_session() -> NewRagSession {
        NewRagSession {
            ts: 1_700_000_000_000,
            scene_type: Some("weekly_report".into()),
            user_query: "帮我写本周工作总结".into(),
            retrieved_ids: Some("[1,2,3]".into()),
            prompt_used: Some("你是一名助手...".into()),
            llm_response: None,
            latency_ms: None,
            model: Some("mbcd-std-v1".into()),
        }
    }

    #[test]
    fn test_insert_and_get() {
        let mgr = make_mgr();
        let id = mgr.insert_rag_session(&sample_session()).unwrap();
        assert!(id > 0);

        let rec = mgr.get_rag_session(id).unwrap().unwrap();
        assert_eq!(rec.user_query, "帮我写本周工作总结");
        assert_eq!(rec.scene_type.as_deref(), Some("weekly_report"));
    }

    #[test]
    fn test_update_response() {
        let mgr = make_mgr();
        let id = mgr.insert_rag_session(&sample_session()).unwrap();
        mgr.update_rag_response(id, "本周主要完成了...", 320)
            .unwrap();

        let rec = mgr.get_rag_session(id).unwrap().unwrap();
        assert_eq!(rec.llm_response.as_deref(), Some("本周主要完成了..."));
        assert_eq!(rec.latency_ms, Some(320));
    }

    #[test]
    fn test_record_feedback() {
        let mgr = make_mgr();
        let id = mgr.insert_rag_session(&sample_session()).unwrap();
        mgr.record_rag_feedback(id, "修改后的内容更好").unwrap();

        let rec = mgr.get_rag_session(id).unwrap().unwrap();
        assert_eq!(rec.user_feedback.as_deref(), Some("修改后的内容更好"));
    }

    #[test]
    fn test_list_by_scene() {
        let mgr = make_mgr();
        mgr.insert_rag_session(&sample_session()).unwrap();
        let other = NewRagSession {
            scene_type: Some("sop".into()),
            user_query: "帮我写SOP".into(),
            ..sample_session()
        };
        mgr.insert_rag_session(&other).unwrap();

        let weekly = mgr.list_rag_sessions_by_scene("weekly_report", 10).unwrap();
        assert_eq!(weekly.len(), 1);
    }

    #[test]
    fn test_list_with_feedback() {
        let mgr = make_mgr();
        let id = mgr.insert_rag_session(&sample_session()).unwrap();
        mgr.record_rag_feedback(id, "有修改").unwrap();
        mgr.insert_rag_session(&sample_session()).unwrap(); // 无反馈

        let feedback_list = mgr.list_rag_sessions_with_feedback(10).unwrap();
        assert_eq!(feedback_list.len(), 1);
    }

    #[test]
    fn test_search_and_paginate_sessions() {
        let mgr = make_mgr();
        for (index, query) in ["年度规划", "项目复盘", "路线规划"].into_iter().enumerate()
        {
            let session = NewRagSession {
                ts: 1_700_000_000_000 + index as i64,
                user_query: query.into(),
                llm_response: Some(
                    if index == 1 {
                        "包含年度目标"
                    } else {
                        "普通回答"
                    }
                    .into(),
                ),
                ..sample_session()
            };
            mgr.insert_rag_session(&session).unwrap();
        }

        let (first_page, total) = mgr.list_rag_sessions_page(Some("年度"), 1, 0).unwrap();
        assert_eq!(total, 2);
        assert_eq!(first_page.len(), 1);

        let (second_page, total) = mgr.list_rag_sessions_page(Some("年度"), 1, 1).unwrap();
        assert_eq!(total, 2);
        assert_eq!(second_page.len(), 1);
        assert_ne!(first_page[0].id, second_page[0].id);
    }
}
