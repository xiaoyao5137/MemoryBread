//! action_logs 表的 CRUD 操作

use rusqlite::{params, Connection};

use crate::storage::{
    error::StorageError,
    models::{ActionLogRecord, ActionStatus, NewActionLog},
    StorageManager,
};

// ─────────────────────────────────────────────────────────────────────────────
// 写操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 插入一条动作日志，返回新行 id。状态初始为 pending。
    pub fn insert_action_log(&self, log: &NewActionLog) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_action_log_inner(conn, log))
    }

    /// 更新动作执行状态。
    pub fn update_action_status(&self, id: i64, status: &ActionStatus) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE action_logs SET status = ?1 WHERE id = ?2",
                params![status.as_str(), id],
            )?;
            Ok(())
        })
    }

    /// 记录用户对 AI 输出的修改内容，并将状态标记为 success。
    pub fn record_user_correction(&self, id: i64, correction: &str) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE action_logs SET user_correction = ?1, status = 'success' WHERE id = ?2",
                params![correction, id],
            )?;
            Ok(())
        })
    }

    /// 记录动作执行失败原因。
    pub fn record_action_error(&self, id: i64, error_msg: &str) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE action_logs SET status = 'failed', error_msg = ?1 WHERE id = ?2",
                params![error_msg, id],
            )?;
            Ok(())
        })
    }
}

fn insert_action_log_inner(conn: &Connection, log: &NewActionLog) -> Result<i64, StorageError> {
    conn.execute(
        "INSERT INTO action_logs
            (ts, trigger_source, app_name, action_type, action_payload, confirmed_by_user, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
        params![
            log.ts,
            log.trigger_source,
            log.app_name,
            log.action_type,
            log.action_payload,
            log.confirmed_by_user as i64,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// ─────────────────────────────────────────────────────────────────────────────
// 读操作
// ─────────────────────────────────────────────────────────────────────────────

/// 动作日志查询过滤条件
#[derive(Debug, Default)]
pub struct ActionLogFilter {
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
    pub app_name: Option<String>,
    pub status: Option<String>,
    pub limit: usize,
    pub offset: usize,
}

impl ActionLogFilter {
    pub fn new() -> Self {
        Self {
            limit: 100,
            ..Default::default()
        }
    }
}

impl StorageManager {
    /// 按 id 获取单条动作日志。
    pub fn get_action_log(&self, id: i64) -> Result<Option<ActionLogRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, trigger_source, app_name, action_type, action_payload,
                        confirmed_by_user, status, user_correction, error_msg
                 FROM action_logs WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_action_log(row)?))
            } else {
                Ok(None)
            }
        })
    }

    /// 按过滤条件列举动作日志，按 ts 倒序。
    pub fn list_action_logs(
        &self,
        filter: &ActionLogFilter,
    ) -> Result<Vec<ActionLogRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut wheres: Vec<String> = Vec::new();
            if filter.from_ts.is_some() {
                wheres.push("ts >= ?".into());
            }
            if filter.to_ts.is_some() {
                wheres.push("ts <= ?".into());
            }
            if filter.app_name.is_some() {
                wheres.push("app_name = ?".into());
            }
            if filter.status.is_some() {
                wheres.push("status = ?".into());
            }

            let where_clause = if wheres.is_empty() {
                "1=1".into()
            } else {
                wheres.join(" AND ")
            };
            let sql = format!(
                "SELECT id, ts, trigger_source, app_name, action_type, action_payload,
                        confirmed_by_user, status, user_correction, error_msg
                 FROM action_logs WHERE {} ORDER BY ts DESC LIMIT ? OFFSET ?",
                where_clause
            );

            let mut stmt = conn.prepare(&sql)?;
            let mut bind: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(v) = filter.from_ts {
                bind.push(Box::new(v));
            }
            if let Some(v) = filter.to_ts {
                bind.push(Box::new(v));
            }
            if let Some(ref v) = filter.app_name {
                bind.push(Box::new(v.clone()));
            }
            if let Some(ref v) = filter.status {
                bind.push(Box::new(v.clone()));
            }
            bind.push(Box::new(filter.limit as i64));
            bind.push(Box::new(filter.offset as i64));

            let params: Vec<&dyn rusqlite::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(row_to_action_log(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    /// 统计成功率（近 N 条）。
    pub fn action_success_rate(&self, recent_n: usize) -> Result<f64, StorageError> {
        self.with_conn(|conn| {
            let total: i64 = conn.query_row(
                "SELECT COUNT(*) FROM (SELECT 1 FROM action_logs ORDER BY ts DESC LIMIT ?1)",
                params![recent_n as i64],
                |r| r.get(0),
            )?;
            if total == 0 {
                return Ok(0.0);
            }
            let success: i64 = conn.query_row(
                "SELECT COUNT(*) FROM (
                    SELECT status FROM action_logs ORDER BY ts DESC LIMIT ?1
                 ) WHERE status = 'success'",
                params![recent_n as i64],
                |r| r.get(0),
            )?;
            Ok(success as f64 / total as f64)
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 行映射辅助
// ─────────────────────────────────────────────────────────────────────────────

fn row_to_action_log(row: &rusqlite::Row<'_>) -> Result<ActionLogRecord, StorageError> {
    Ok(ActionLogRecord {
        id: row.get(0)?,
        ts: row.get(1)?,
        trigger_source: row.get(2)?,
        app_name: row.get(3)?,
        action_type: row.get(4)?,
        action_payload: row.get(5)?,
        confirmed_by_user: row.get::<_, i64>(6)? != 0,
        status: row.get(7)?,
        user_correction: row.get(8)?,
        error_msg: row.get(9)?,
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

    fn sample_log() -> NewActionLog {
        NewActionLog {
            ts: 1_700_000_000_000,
            trigger_source: "auto".into(),
            app_name: Some("Feishu".into()),
            action_type: "type_text".into(),
            action_payload: r#"{"text":"你好","target_ax_id":"input-1"}"#.into(),
            confirmed_by_user: false,
        }
    }

    #[test]
    fn test_insert_and_get() {
        let mgr = make_mgr();
        let id = mgr.insert_action_log(&sample_log()).unwrap();
        assert!(id > 0);

        let rec = mgr.get_action_log(id).unwrap().unwrap();
        assert_eq!(rec.action_type, "type_text");
        assert_eq!(rec.status, "pending");
        assert!(!rec.confirmed_by_user);
    }

    #[test]
    fn test_update_status() {
        let mgr = make_mgr();
        let id = mgr.insert_action_log(&sample_log()).unwrap();
        mgr.update_action_status(id, &ActionStatus::Success)
            .unwrap();

        let rec = mgr.get_action_log(id).unwrap().unwrap();
        assert_eq!(rec.status, "success");
    }

    #[test]
    fn test_record_error() {
        let mgr = make_mgr();
        let id = mgr.insert_action_log(&sample_log()).unwrap();
        mgr.record_action_error(id, "目标元素不可见").unwrap();

        let rec = mgr.get_action_log(id).unwrap().unwrap();
        assert_eq!(rec.status, "failed");
        assert_eq!(rec.error_msg.as_deref(), Some("目标元素不可见"));
    }

    #[test]
    fn test_list_and_filter() {
        let mgr = make_mgr();
        mgr.insert_action_log(&sample_log()).unwrap();
        let id2 = mgr.insert_action_log(&sample_log()).unwrap();
        mgr.update_action_status(id2, &ActionStatus::Success)
            .unwrap();

        let all = mgr.list_action_logs(&ActionLogFilter::new()).unwrap();
        assert_eq!(all.len(), 2);

        let filter = ActionLogFilter {
            status: Some("success".into()),
            limit: 10,
            ..Default::default()
        };
        let success_list = mgr.list_action_logs(&filter).unwrap();
        assert_eq!(success_list.len(), 1);
    }
}
