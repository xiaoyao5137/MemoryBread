//! 数据清理模块
//!
//! 负责定期清理过期截图文件和历史采集记录，并记录到 data_cleanup_log 表。
//!
//! # 设计策略
//!
//! - 截图文件（screenshot_purge）：按用户配置删除过期且未关联时间线的 JPEG 文件，并更新 captures 中的路径为 NULL
//! - 旧采集记录（old_captures）：按用户配置删除过期采集行及其截图文件；时间线、知识和操作记录不参与删除
//! - VACUUM：整理 SQLite 碎片空间，建议每周运行一次

use std::path::Path;

use rusqlite::params;
use tracing::{info, warn};

use super::{db::current_ts_ms, error::StorageError, StorageManager};

// ─────────────────────────────────────────────────────────────────────────────
// 清理入口
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 清理过期截图文件。
    ///
    /// 步骤：
    /// 1. 查找 `captures.screenshot_path IS NOT NULL AND ts < older_than_ms AND timeline_id IS NULL` 的记录
    /// 2. 尝试删除对应的文件
    /// 3. 将 captures.screenshot_path 置为 NULL
    /// 4. 写入 data_cleanup_log
    ///
    /// 返回 `(deleted_file_count, freed_bytes)`
    pub fn run_screenshot_purge(
        &self,
        older_than_ms: i64,
        captures_dir: &Path,
    ) -> Result<(usize, u64), StorageError> {
        // 只清理未被时间线使用的孤立截图；已提炼/已关联的 capture 需要保留截图路径作为证据链。
        let rows = self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, screenshot_path FROM captures
                 WHERE screenshot_path IS NOT NULL
                   AND ts < ?1
                   AND timeline_id IS NULL",
            )?;
            let result = stmt
                .query_map(params![older_than_ms], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })?;

        let mut deleted_count = 0usize;
        let mut freed_bytes = 0u64;

        for (id, rel_path) in &rows {
            let full_path = captures_dir.join(rel_path);
            match std::fs::metadata(&full_path) {
                Ok(meta) => {
                    freed_bytes += meta.len();
                    if let Err(e) = std::fs::remove_file(&full_path) {
                        warn!("删除截图文件失败 {:?}: {}", full_path, e);
                        continue;
                    }
                    deleted_count += 1;
                }
                Err(_) => {
                    // 文件已不存在，直接清除路径
                    deleted_count += 1;
                }
            }

            // 将数据库中的路径置为 NULL
            self.with_conn(|conn| {
                conn.execute(
                    "UPDATE captures
                     SET screenshot_path = NULL,
                         screenshot_source = NULL
                     WHERE id = ?1
                       AND timeline_id IS NULL",
                    params![id],
                )?;
                Ok(())
            })?;
        }

        // 2. 写清理日志
        let now = current_ts_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO data_cleanup_log (ts, cleanup_type, affected_count, freed_bytes, detail)
                 VALUES (?1, 'screenshot_purge', ?2, ?3, ?4)",
                params![
                    now,
                    deleted_count as i64,
                    freed_bytes as i64,
                    format!("older_than_ms={older_than_ms}"),
                ],
            )?;
            Ok(())
        })?;

        info!(
            "screenshot_purge 完成: 删除 {} 个文件，释放 {} bytes",
            deleted_count, freed_bytes
        );
        Ok((deleted_count, freed_bytes))
    }

    /// 清理过期采集记录。
    ///
    /// 只删除原始 captures、其向量索引元数据和对应截图文件；时间线、知识、
    /// 操作记录等提炼物不会被删除。快照恢复生成的 `snapshot_ref` 只是跨设备
    /// 重建引用占位，不包含原始采集内容，也不应被采集保留期清理掉。历史 schema
    /// 中 timelines.capture_id 是外键，因此这里临时关闭外键检查以允许“原始证据
    /// 过期，提炼物保留”的产品语义。
    ///
    /// 返回 `(deleted_capture_count, deleted_screenshot_count, freed_bytes)`。
    pub fn run_old_captures_cleanup(
        &self,
        older_than_ms: i64,
        captures_dir: &Path,
    ) -> Result<(usize, usize, u64), StorageError> {
        let rows = self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, screenshot_path FROM captures
                 WHERE ts < ?1
                   AND (event_type IS NULL OR event_type <> 'snapshot_ref')",
            )?;
            let result = stmt
                .query_map(params![older_than_ms], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })?;

        if rows.is_empty() {
            self.write_cleanup_log(
                "old_captures",
                0,
                0,
                format!("older_than_ms={older_than_ms}"),
            )?;
            return Ok((0, 0, 0));
        }

        let mut deleted_screenshot_count = 0usize;
        let mut freed_bytes = 0u64;

        for (_, rel_path) in &rows {
            let Some(rel_path) = rel_path else {
                continue;
            };
            let full_path = captures_dir.join(rel_path);
            match std::fs::metadata(&full_path) {
                Ok(meta) => {
                    freed_bytes += meta.len();
                    if let Err(e) = std::fs::remove_file(&full_path) {
                        warn!("删除过期采集截图文件失败 {:?}: {}", full_path, e);
                        continue;
                    }
                    deleted_screenshot_count += 1;
                }
                Err(_) => {
                    deleted_screenshot_count += 1;
                }
            }
        }

        let affected = self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM vector_index
                 WHERE capture_id IN (
                    SELECT id FROM captures
                    WHERE ts < ?1
                      AND (event_type IS NULL OR event_type <> 'snapshot_ref')
                 )",
                params![older_than_ms],
            )?;

            conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
            let delete_result = conn.execute(
                "DELETE FROM captures
                 WHERE ts < ?1
                   AND (event_type IS NULL OR event_type <> 'snapshot_ref')",
                params![older_than_ms],
            );
            let restore_result = conn.execute_batch("PRAGMA foreign_keys = ON;");

            match (delete_result, restore_result) {
                (Ok(n), Ok(())) => Ok(n),
                (Err(err), _) => Err(StorageError::Sqlite(err)),
                (Ok(_), Err(err)) => Err(StorageError::Sqlite(err)),
            }
        })?;

        let now = current_ts_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO data_cleanup_log (ts, cleanup_type, affected_count, freed_bytes, detail)
                 VALUES (?1, 'old_captures', ?2, ?3, ?4)",
                params![
                    now,
                    affected as i64,
                    freed_bytes as i64,
                    format!(
                        "older_than_ms={older_than_ms}; deleted_screenshots={deleted_screenshot_count}; freed_bytes={freed_bytes}"
                    ),
                ],
            )?;
            Ok(())
        })?;

        info!(
            "old_captures 清理完成: 删除 {} 行，清理 {} 个截图文件，释放 {} bytes",
            affected, deleted_screenshot_count, freed_bytes
        );
        Ok((affected, deleted_screenshot_count, freed_bytes))
    }

    fn write_cleanup_log(
        &self,
        cleanup_type: &str,
        affected_count: i64,
        freed_bytes: i64,
        detail: String,
    ) -> Result<(), StorageError> {
        let now = current_ts_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO data_cleanup_log (ts, cleanup_type, affected_count, freed_bytes, detail)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![now, cleanup_type, affected_count, freed_bytes, detail],
            )?;
            Ok(())
        })
    }

    /// 执行 VACUUM，释放碎片空间。
    ///
    /// 注意：VACUUM 在 WAL 模式下仍可执行，但会产生一定的 I/O 压力。
    /// 建议在业务低峰期（深夜）执行。
    pub fn run_vacuum(&self) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute_batch("VACUUM;")?;
            Ok(())
        })?;

        let now = current_ts_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO data_cleanup_log (ts, cleanup_type, affected_count, freed_bytes, detail)
                 VALUES (?1, 'vacuum', 0, 0, 'manual vacuum')",
                params![now],
            )?;
            Ok(())
        })?;

        info!("VACUUM 完成");
        Ok(())
    }

    /// 查询清理历史记录，按 ts 倒序。
    pub fn list_cleanup_logs(&self, limit: usize) -> Result<Vec<CleanupLogRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, cleanup_type, affected_count, freed_bytes, detail
                 FROM data_cleanup_log ORDER BY ts DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], |row| {
                Ok(CleanupLogRecord {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    cleanup_type: row.get(2)?,
                    affected_count: row.get(3)?,
                    freed_bytes: row.get(4)?,
                    detail: row.get(5)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 数据模型
// ─────────────────────────────────────────────────────────────────────────────

/// data_cleanup_log 表的读取模型
#[derive(Debug, Clone)]
pub struct CleanupLogRecord {
    pub id: i64,
    pub ts: i64,
    pub cleanup_type: String,
    pub affected_count: i64,
    pub freed_bytes: i64,
    pub detail: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::models::{EventType, NewCapture};
    use tempfile::tempdir;

    fn make_mgr() -> StorageManager {
        StorageManager::open_in_memory().expect("内存数据库初始化失败")
    }

    #[test]
    fn test_old_captures_cleanup() {
        let mgr = make_mgr();
        let dir = tempdir().unwrap();

        // 插入一条 "180天前" 的记录
        let old_ts = current_ts_ms() - 180 * 24 * 3600 * 1000 - 1;
        mgr.with_conn(|conn| {
            conn.execute(
                "INSERT INTO captures (ts, event_type) VALUES (?1, 'auto')",
                params![old_ts],
            )?;
            Ok(())
        })
        .unwrap();

        // 插入一条 "刚才" 的记录
        mgr.with_conn(|conn| {
            conn.execute(
                "INSERT INTO captures (ts, event_type) VALUES (?1, 'auto')",
                params![current_ts_ms()],
            )?;
            Ok(())
        })
        .unwrap();

        let cutoff = current_ts_ms() - 180 * 24 * 3600 * 1000;
        let (deleted, deleted_screenshots, freed) =
            mgr.run_old_captures_cleanup(cutoff, dir.path()).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(deleted_screenshots, 0);
        assert_eq!(freed, 0);

        // 验证清理日志
        let logs = mgr.list_cleanup_logs(10).unwrap();
        assert!(!logs.is_empty());
        assert_eq!(logs[0].cleanup_type, "old_captures");
        assert_eq!(logs[0].affected_count, 1);
    }

    #[test]
    fn test_old_captures_cleanup_keeps_snapshot_refs() {
        let mgr = make_mgr();
        let dir = tempdir().unwrap();
        let old_ts = current_ts_ms() - 180 * 24 * 3600 * 1000 - 1;

        mgr.with_conn(|conn| {
            conn.execute(
                "INSERT INTO captures (ts, event_type, is_sensitive, pii_scrubbed)
                 VALUES (?1, 'snapshot_ref', 1, 1)",
                params![old_ts],
            )?;
            conn.execute(
                "INSERT INTO captures (ts, event_type, ax_text)
                 VALUES (?1, 'auto', 'raw')",
                params![old_ts],
            )?;
            Ok(())
        })
        .unwrap();

        let cutoff = current_ts_ms() - 180 * 24 * 3600 * 1000;
        let (deleted, deleted_screenshots, freed) =
            mgr.run_old_captures_cleanup(cutoff, dir.path()).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(deleted_screenshots, 0);
        assert_eq!(freed, 0);

        let snapshot_refs: i64 = mgr
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM captures WHERE event_type = 'snapshot_ref'",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::Sqlite)
            })
            .unwrap();
        assert_eq!(snapshot_refs, 1);
    }

    #[test]
    fn test_screenshot_purge_missing_file() {
        let mgr = make_mgr();
        let dir = tempdir().unwrap();

        // 插入一条带截图路径的旧记录
        let old_ts = current_ts_ms() - 91 * 24 * 3600 * 1000;
        mgr.with_conn(|conn| {
            conn.execute(
                "INSERT INTO captures (ts, event_type, screenshot_path) VALUES (?1, 'auto', ?2)",
                params![old_ts, "nonexistent/shot.jpg"],
            )?;
            Ok(())
        })
        .unwrap();

        let cutoff = current_ts_ms() - 90 * 24 * 3600 * 1000;
        let (deleted, freed) = mgr.run_screenshot_purge(cutoff, dir.path()).unwrap();
        assert_eq!(deleted, 1); // 文件不存在，但仍计为"已清理"
        assert_eq!(freed, 0); // 没有实际文件，释放 0 字节

        // 验证数据库路径已清除
        let row: Option<String> = mgr
            .with_conn(|conn| {
                conn.query_row("SELECT screenshot_path FROM captures LIMIT 1", [], |r| {
                    r.get(0)
                })
                .map_err(StorageError::Sqlite)
            })
            .unwrap();
        assert!(row.is_none());
    }

    #[test]
    fn test_vacuum() {
        let mgr = make_mgr();
        mgr.run_vacuum().unwrap();

        let logs = mgr.list_cleanup_logs(10).unwrap();
        assert!(!logs.is_empty());
        assert_eq!(logs[0].cleanup_type, "vacuum");
    }

    #[test]
    fn test_insert_and_cleanup_uses_capture_helper() {
        let mgr = make_mgr();
        let dir = tempdir().unwrap();
        let cap = NewCapture {
            ts: 1_700_000_000_000,
            app_name: Some("TestApp".into()),
            app_bundle_id: None,
            win_title: None,
            event_type: EventType::Auto,
            ax_text: Some("test".into()),
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
        };
        mgr.insert_capture(&cap).unwrap();

        // 清理比该记录更新的时间（不应删除任何东西）
        let (deleted, _, _) = mgr
            .run_old_captures_cleanup(1_000_000_000_000, dir.path())
            .unwrap();
        assert_eq!(deleted, 0);
    }

    #[test]
    fn test_old_captures_cleanup_keeps_timeline_extracts() {
        let mgr = make_mgr();
        let dir = tempdir().unwrap();
        let old_ts = current_ts_ms() - 15 * 24 * 3600 * 1000;
        let capture_id = mgr
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO captures (ts, event_type, ax_text) VALUES (?1, 'auto', 'raw')",
                    params![old_ts],
                )?;
                Ok(conn.last_insert_rowid())
            })
            .unwrap();

        mgr.with_conn(|conn| {
            conn.execute(
                "INSERT INTO timelines (capture_id, summary, category)
                 VALUES (?1, 'timeline extract', 'meeting')",
                params![capture_id],
            )?;
            Ok(())
        })
        .unwrap();

        let cutoff = current_ts_ms() - 14 * 24 * 3600 * 1000;
        let (deleted, _, _) = mgr.run_old_captures_cleanup(cutoff, dir.path()).unwrap();
        assert_eq!(deleted, 1);

        let timeline_count: i64 = mgr
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM timelines", [], |row| row.get(0))
                    .map_err(StorageError::Sqlite)
            })
            .unwrap();
        assert_eq!(timeline_count, 1);
    }
}
