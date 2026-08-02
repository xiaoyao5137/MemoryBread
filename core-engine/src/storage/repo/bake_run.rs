use rusqlite::{params, Connection};

use crate::storage::{
    db::current_ts_ms,
    error::StorageError,
    models_bake::{BakeRunRecord, BakeWatermarkRecord, NewBakeRun},
    StorageManager,
};

const STALE_RUNNING_BAKE_RUN_MS: i64 = 35 * 60 * 1000;
const RECOVERABLE_BAKE_FAILURE_PREDICATE: &str = r#"
    last_error LIKE 'upstream error (429%'
    OR last_error LIKE 'upstream error (502%'
    OR last_error LIKE 'upstream error (503%'
    OR (
        last_error LIKE 'internal error: 解析 merge_document 响应失败:%'
        AND last_error LIKE '%missing field `title`%'
    )
    OR (
        last_error LIKE 'internal error: 解析 bake knowledge payload 失败:%'
        AND last_error LIKE '%missing field `summary`%'
    )
    OR last_error LIKE 'internal error: 解析 bake sop payload 失败: invalid type:%'
    OR last_error LIKE 'internal error: 解析 bake design payload 失败: invalid type:%'
"#;

impl StorageManager {
    pub fn insert_bake_run(&self, run: &NewBakeRun) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_bake_run_inner(conn, run))
    }

    pub fn get_latest_bake_run(&self) -> Result<Option<BakeRunRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, trigger_reason, status, started_at, completed_at,
                        processed_episode_count, auto_created_count, candidate_count, discarded_count,
                        knowledge_created_count, design_created_count, sop_created_count,
                        error_message, latency_ms
                 FROM bake_runs
                 ORDER BY started_at DESC, id DESC
                 LIMIT 1",
            )?;
            let mut rows = stmt.query([])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_bake_run(row)?))
            } else {
                Ok(None)
            }
        })
    }

    /// 返回当前处于 running 状态的 bake run 数量。
    /// 用于并发保护：限制同时运行的 bake run 数量，避免过多 run 竞争 sidecar LLM。
    pub fn count_running_bake_runs(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let fresh_after_ms = current_ts_ms() - STALE_RUNNING_BAKE_RUN_MS;
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM bake_runs
                 WHERE status = 'running'
                   AND started_at >= ?1",
                params![fresh_after_ms],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    /// 进程启动时收敛所有遗留 running run。
    ///
    /// bake worker 只存在于进程内且没有持久化租约；新进程不可能接管旧 run。
    /// 因此启动时无论 started_at 多新，数据库中的 running 都一定是孤儿。
    pub fn fail_orphaned_running_bake_runs_on_startup(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let affected = conn.execute(
                "UPDATE bake_runs
                 SET status = 'failed',
                     completed_at = COALESCE(completed_at, ?1),
                     error_message = CASE
                         WHEN COALESCE(error_message, '') = ''
                         THEN 'orphaned running bake run recovered on startup'
                         ELSE error_message
                     END,
                     latency_ms = COALESCE(latency_ms, MAX(0, ?1 - started_at))
                 WHERE status = 'running'",
                params![now],
            )?;
            Ok(affected as i64)
        })
    }

    /// 将已超过正常批次上限、但因进程退出未写终态的 run 收敛为 failed。
    ///
    /// 启动恢复存在一个窗口：进程重启时未满 35 分钟的遗留 run 当时仍算 fresh，
    /// 之后才会变 stale。因此除了启动时调用，运行期触发和监控也需要按需调用。
    pub fn fail_stale_running_bake_runs(&self) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            let fresh_after_ms = now - STALE_RUNNING_BAKE_RUN_MS;
            let affected = conn.execute(
                "UPDATE bake_runs
                 SET status = 'failed',
                     completed_at = COALESCE(completed_at, ?1),
                     error_message = CASE
                         WHEN COALESCE(error_message, '') = ''
                         THEN 'stale running bake run reconciled after runtime limit'
                         ELSE error_message
                     END,
                     latency_ms = COALESCE(latency_ms, MAX(0, ?1 - started_at))
                 WHERE status = 'running'
                   AND started_at < ?2",
                params![now, fresh_after_ms],
            )?;
            Ok(affected as i64)
        })
    }

    /// 更新 bake run 的实时进度字段（candidate_count / processed_episode_count），
    /// 用于监控页实时展示"提炼中"数量，不改变 run 状态。
    pub fn update_bake_run_progress(
        &self,
        id: i64,
        candidate_count: i64,
        processed_episode_count: i64,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE bake_runs
                 SET candidate_count = ?1,
                     processed_episode_count = ?2
                 WHERE id = ?3
                   AND status = 'running'",
                params![candidate_count, processed_episode_count, id],
            )?;
            Ok(affected > 0)
        })
    }

    /// 将 run 标记为失败，但保留已实时写入的候选数和处理进度。
    ///
    /// 一个批次可能在成功持久化若干候选后被 P0 抢占；若用全 0 覆盖终态，
    /// 监控会错误显示本轮毫无进展。
    pub fn fail_bake_run_preserving_progress(
        &self,
        id: i64,
        completed_at: i64,
        error_message: &str,
        latency_ms: Option<i64>,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE bake_runs
                 SET status = 'failed',
                     completed_at = ?1,
                     error_message = ?2,
                     latency_ms = ?3
                 WHERE id = ?4
                   AND status = 'running'",
                params![completed_at, error_message, latency_ms, id],
            )?;
            Ok(affected > 0)
        })
    }

    /// 上游资源竞争或 P0 抢占时把 run 标记为 deferred，并保留已落盘进度。
    ///
    /// deferred 不是内容失败；watermark 会停在尚未完成的候选之前，下一轮从该
    /// 候选继续，不增加 bake_retry_state 的失败次数。
    pub fn defer_bake_run_preserving_progress(
        &self,
        id: i64,
        completed_at: i64,
        reason: &str,
        latency_ms: Option<i64>,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE bake_runs
                 SET status = 'deferred',
                     completed_at = ?1,
                     error_message = ?2,
                     latency_ms = ?3
                 WHERE id = ?4
                   AND status = 'running'",
                params![completed_at, reason, latency_ms, id],
            )?;
            Ok(affected > 0)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete_bake_run(
        &self,
        id: i64,
        status: &str,
        completed_at: i64,
        processed_episode_count: i64,
        auto_created_count: i64,
        candidate_count: i64,
        discarded_count: i64,
        knowledge_created_count: i64,
        document_created_count: i64,
        sop_created_count: i64,
        error_message: Option<&str>,
        latency_ms: Option<i64>,
    ) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE bake_runs
                 SET status = ?1,
                     completed_at = ?2,
                     processed_episode_count = ?3,
                     auto_created_count = ?4,
                     candidate_count = ?5,
                     discarded_count = ?6,
                     knowledge_created_count = ?7,
                     design_created_count = ?8,
                     sop_created_count = ?9,
                     error_message = ?10,
                     latency_ms = ?11
                 WHERE id = ?12
                   AND status = 'running'",
                params![
                    status,
                    completed_at,
                    processed_episode_count,
                    auto_created_count,
                    candidate_count,
                    discarded_count,
                    knowledge_created_count,
                    document_created_count,
                    sop_created_count,
                    error_message,
                    latency_ms,
                    id,
                ],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn get_bake_watermark(
        &self,
        pipeline_name: &str,
    ) -> Result<Option<BakeWatermarkRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT pipeline_name, last_processed_ts, updated_at
                 FROM bake_watermarks
                 WHERE pipeline_name = ?1",
            )?;
            let mut rows = stmt.query(params![pipeline_name])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_bake_watermark(row)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn upsert_bake_watermark(
        &self,
        pipeline_name: &str,
        last_processed_ts: i64,
    ) -> Result<(), StorageError> {
        let updated_at = current_ts_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO bake_watermarks (pipeline_name, last_processed_ts, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(pipeline_name) DO UPDATE SET
                     last_processed_ts = excluded.last_processed_ts,
                     updated_at = excluded.updated_at",
                params![pipeline_name, last_processed_ts, updated_at],
            )?;
            Ok(())
        })
    }

    /// 记录单条 timeline 的烘焙失败。
    ///
    /// failure_count 由 BakeService 用于有界重试；达到服务端上限后才成为终态。
    pub fn bump_bake_retry_failure(
        &self,
        timeline_id: i64,
        last_error: &str,
    ) -> Result<i64, StorageError> {
        let now = current_ts_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO bake_retry_state (timeline_id, failure_count, last_error, last_failed_at_ms)
                 VALUES (?1, 1, ?2, ?3)
                 ON CONFLICT(timeline_id) DO UPDATE SET
                     failure_count = bake_retry_state.failure_count + 1,
                     last_error = excluded.last_error,
                     last_failed_at_ms = excluded.last_failed_at_ms",
                params![timeline_id, last_error, now],
            )?;
            let count: i64 = conn.query_row(
                "SELECT failure_count FROM bake_retry_state WHERE timeline_id = ?1",
                params![timeline_id],
                |r| r.get(0),
            )?;
            Ok(count)
        })
    }

    /// 返回候选已记录的失败次数；尚未失败时为 0。
    pub fn get_bake_retry_failure_count(&self, timeline_id: i64) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT COALESCE(
                    (SELECT failure_count FROM bake_retry_state WHERE timeline_id = ?1),
                    0
                 )",
                params![timeline_id],
                |row| row.get(0),
            )
            .map_err(StorageError::from)
        })
    }

    /// 候选成功处理后移除旧失败记录，避免历史失败继续污染监控或后续增量处理。
    pub fn clear_bake_retry_failure(&self, timeline_id: i64) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let changed = conn.execute(
                "DELETE FROM bake_retry_state WHERE timeline_id = ?1",
                params![timeline_id],
            )?;
            Ok(changed > 0)
        })
    }

    /// 恢复由资源竞争或旧兼容性问题造成的历史失败记录。
    ///
    /// 删除误写的死信之前先找到最早受影响候选，并把 unified watermark
    /// 回退到它之前。否则只删失败标记仍会因为 watermark 已跨过候选而无法补偿。
    /// 新错误会以 `bake_error code=... status=...` 保存，不匹配这组仅用于
    /// 一次性历史修复的旧字符串，避免每次重启都把有界重试计数清零。
    pub fn clear_recoverable_bake_retry_failures(&self) -> Result<usize, StorageError> {
        self.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let earliest_candidate_ts = tx.query_row(
                &format!(
                    "SELECT MIN(
                        MAX(
                            COALESCE(t.updated_at_ms, 0),
                            COALESCE(
                                (SELECT MAX(c.ts) FROM captures c WHERE c.timeline_id = t.id),
                                0
                            )
                        )
                     )
                     FROM bake_retry_state r
                     JOIN timelines t ON t.id = r.timeline_id
                     WHERE {}",
                    RECOVERABLE_BAKE_FAILURE_PREDICATE
                ),
                [],
                |row| row.get::<_, Option<i64>>(0),
            )?;
            let changed = tx.execute(
                &format!(
                    "DELETE FROM bake_retry_state WHERE {}",
                    RECOVERABLE_BAKE_FAILURE_PREDICATE
                ),
                [],
            )?;
            if changed > 0 {
                if let Some(earliest) = earliest_candidate_ts {
                    let resume_before = earliest.saturating_sub(1).max(0);
                    tx.execute(
                        "UPDATE bake_watermarks
                         SET last_processed_ts = MIN(last_processed_ts, ?1),
                             updated_at = ?2
                         WHERE pipeline_name = 'unified'",
                        params![resume_before, current_ts_ms()],
                    )?;
                }
            }
            tx.commit()?;
            Ok(changed)
        })
    }
}

fn insert_bake_run_inner(conn: &Connection, run: &NewBakeRun) -> Result<i64, StorageError> {
    conn.execute(
        "INSERT INTO bake_runs (
            trigger_reason,
            status,
            started_at,
            processed_episode_count,
            auto_created_count,
            candidate_count,
            discarded_count,
            knowledge_created_count,
            design_created_count,
            sop_created_count
         ) VALUES (?1, ?2, ?3, 0, 0, 0, 0, 0, 0, 0)",
        params![run.trigger_reason, run.status, run.started_at],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_bake_run(row: &rusqlite::Row<'_>) -> Result<BakeRunRecord, StorageError> {
    Ok(BakeRunRecord {
        id: row.get(0)?,
        trigger_reason: row.get(1)?,
        status: row.get(2)?,
        started_at: row.get(3)?,
        completed_at: row.get(4)?,
        processed_episode_count: row.get(5)?,
        auto_created_count: row.get(6)?,
        candidate_count: row.get(7)?,
        discarded_count: row.get(8)?,
        knowledge_created_count: row.get(9)?,
        document_created_count: row.get(10)?,
        sop_created_count: row.get(11)?,
        error_message: row.get(12)?,
        latency_ms: row.get(13)?,
    })
}

fn row_to_bake_watermark(row: &rusqlite::Row<'_>) -> Result<BakeWatermarkRecord, StorageError> {
    Ok(BakeWatermarkRecord {
        pipeline_name: row.get(0)?,
        last_processed_ts: row.get(1)?,
        updated_at: row.get(2)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_mgr() -> StorageManager {
        StorageManager::open_in_memory().expect("内存数据库初始化失败")
    }

    #[test]
    fn test_insert_and_complete_bake_run() {
        let mgr = make_mgr();
        let id = mgr
            .insert_bake_run(&NewBakeRun {
                trigger_reason: "manual_debug".to_string(),
                status: "running".to_string(),
                started_at: 123,
            })
            .unwrap();

        assert!(mgr
            .complete_bake_run(id, "completed", 456, 3, 1, 1, 1, 1, 0, 0, None, Some(333),)
            .unwrap());

        let latest = mgr.get_latest_bake_run().unwrap().unwrap();
        assert_eq!(latest.id, id);
        assert_eq!(latest.status, "completed");
        assert_eq!(latest.processed_episode_count, 3);
        assert_eq!(latest.latency_ms, Some(333));
    }

    #[test]
    fn test_defer_bake_run_preserves_progress() {
        let mgr = make_mgr();
        let id = mgr
            .insert_bake_run(&NewBakeRun {
                trigger_reason: "automatic".to_string(),
                status: "running".to_string(),
                started_at: 100,
            })
            .unwrap();
        mgr.update_bake_run_progress(id, 20, 4).unwrap();

        assert!(mgr
            .defer_bake_run_preserving_progress(id, 250, "interactive preemption", Some(150))
            .unwrap());

        let latest = mgr.get_latest_bake_run().unwrap().unwrap();
        assert_eq!(latest.status, "deferred");
        assert_eq!(latest.candidate_count, 20);
        assert_eq!(latest.processed_episode_count, 4);
        assert_eq!(
            latest.error_message.as_deref(),
            Some("interactive preemption")
        );
    }

    #[test]
    fn test_clear_retry_failure_and_recoverable_history() {
        let mgr = make_mgr();
        mgr.with_conn(|conn| {
            for id in [101_i64, 102, 103, 104, 105, 106, 107, 108] {
                conn.execute(
                    "INSERT INTO captures (id, ts, event_type) VALUES (?1, ?1, 'manual')",
                    params![id],
                )?;
                conn.execute(
                    "INSERT INTO timelines (id, capture_id, summary) VALUES (?1, ?1, 'test')",
                    params![id],
                )?;
                conn.execute(
                    "UPDATE timelines SET updated_at_ms = ?1 WHERE id = ?1",
                    params![id],
                )?;
            }
            Ok(())
        })
        .unwrap();
        mgr.upsert_bake_watermark("unified", 1_000).unwrap();
        mgr.bump_bake_retry_failure(101, "upstream error (503 Service Unavailable): busy")
            .unwrap();
        mgr.bump_bake_retry_failure(
            102,
            "internal error: 解析 merge_document 响应失败: missing field `title`",
        )
        .unwrap();
        mgr.bump_bake_retry_failure(103, "internal error: invalid permanent payload")
            .unwrap();
        mgr.bump_bake_retry_failure(
            104,
            "internal error: 解析 bake sop payload 失败: invalid type: map, expected a string",
        )
        .unwrap();
        mgr.bump_bake_retry_failure(105, "upstream error (504 Gateway Timeout): bake 提炼超时")
            .unwrap();
        mgr.bump_bake_retry_failure(
            106,
            "internal error: 解析 bake knowledge payload 失败: missing field `summary`",
        )
        .unwrap();
        mgr.bump_bake_retry_failure(107, "upstream error (429 Too Many Requests): busy")
            .unwrap();
        mgr.bump_bake_retry_failure(
            108,
            "bake_error code=BAKE_UNCLASSIFIED_UPSTREAM_ERROR status=502",
        )
        .unwrap();

        assert_eq!(mgr.get_bake_retry_failure_count(105).unwrap(), 1);
        assert_eq!(mgr.get_bake_retry_failure_count(999).unwrap(), 0);
        assert_eq!(mgr.clear_recoverable_bake_retry_failures().unwrap(), 5);
        assert_eq!(
            mgr.get_bake_watermark("unified")
                .unwrap()
                .unwrap()
                .last_processed_ts,
            100
        );
        assert!(!mgr.clear_bake_retry_failure(101).unwrap());
        assert!(!mgr.clear_bake_retry_failure(104).unwrap());
        assert!(!mgr.clear_bake_retry_failure(106).unwrap());
        assert!(!mgr.clear_bake_retry_failure(107).unwrap());
        assert_eq!(mgr.get_bake_retry_failure_count(108).unwrap(), 1);
        assert!(mgr.clear_bake_retry_failure(105).unwrap());
        assert!(mgr.clear_bake_retry_failure(103).unwrap());
        assert!(!mgr.clear_bake_retry_failure(103).unwrap());
    }

    #[test]
    fn test_fail_bake_run_preserves_recorded_progress() {
        let mgr = make_mgr();
        let id = mgr
            .insert_bake_run(&NewBakeRun {
                trigger_reason: "preempted".to_string(),
                status: "running".to_string(),
                started_at: 100,
            })
            .unwrap();
        mgr.update_bake_run_progress(id, 7, 2).unwrap();
        mgr.fail_bake_run_preserving_progress(id, 300, "retry later", Some(200))
            .unwrap();

        let run = mgr.get_latest_bake_run().unwrap().unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(run.candidate_count, 7);
        assert_eq!(run.processed_episode_count, 2);
        assert_eq!(run.error_message.as_deref(), Some("retry later"));
        assert_eq!(run.latency_ms, Some(200));
    }

    #[test]
    fn test_upsert_and_get_bake_watermark() {
        let mgr = make_mgr();
        mgr.upsert_bake_watermark("unified", 100).unwrap();
        mgr.upsert_bake_watermark("unified", 200).unwrap();
        let watermark = mgr.get_bake_watermark("unified").unwrap().unwrap();
        assert_eq!(watermark.pipeline_name, "unified");
        assert_eq!(watermark.last_processed_ts, 200);
    }

    #[test]
    fn test_fail_stale_running_bake_runs_preserves_fresh_run() {
        let mgr = make_mgr();
        let now = current_ts_ms();
        let stale_id = mgr
            .insert_bake_run(&NewBakeRun {
                trigger_reason: "stale".to_string(),
                status: "running".to_string(),
                started_at: now - STALE_RUNNING_BAKE_RUN_MS - 1,
            })
            .unwrap();
        let fresh_id = mgr
            .insert_bake_run(&NewBakeRun {
                trigger_reason: "fresh".to_string(),
                status: "running".to_string(),
                started_at: now,
            })
            .unwrap();

        assert_eq!(mgr.fail_stale_running_bake_runs().unwrap(), 1);
        let (stale_status, stale_completed, fresh_status): (String, Option<i64>, String) = mgr
            .with_conn(|conn| {
                let (stale_status, stale_completed) = conn.query_row(
                    "SELECT status, completed_at FROM bake_runs WHERE id = ?1",
                    params![stale_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let fresh_status = conn.query_row(
                    "SELECT status FROM bake_runs WHERE id = ?1",
                    params![fresh_id],
                    |row| row.get(0),
                )?;
                Ok((stale_status, stale_completed, fresh_status))
            })
            .unwrap();
        assert_eq!(stale_status, "failed");
        assert!(stale_completed.is_some());
        assert_eq!(fresh_status, "running");
    }

    #[test]
    fn test_startup_recovery_fails_even_fresh_orphaned_run() {
        let mgr = make_mgr();
        let now = current_ts_ms();
        let id = mgr
            .insert_bake_run(&NewBakeRun {
                trigger_reason: "orphaned_by_restart".to_string(),
                status: "running".to_string(),
                started_at: now,
            })
            .unwrap();
        mgr.update_bake_run_progress(id, 15, 3).unwrap();

        assert_eq!(mgr.fail_orphaned_running_bake_runs_on_startup().unwrap(), 1);
        assert_eq!(mgr.count_running_bake_runs().unwrap(), 0);

        let run = mgr.get_latest_bake_run().unwrap().unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(run.candidate_count, 15);
        assert_eq!(run.processed_episode_count, 3);
        assert_eq!(
            run.error_message.as_deref(),
            Some("orphaned running bake run recovered on startup")
        );
    }

    #[test]
    fn test_stale_terminal_run_rejects_late_progress_and_completion() {
        let mgr = make_mgr();
        let now = current_ts_ms();
        let stale_id = mgr
            .insert_bake_run(&NewBakeRun {
                trigger_reason: "orphaned_by_restart".to_string(),
                status: "running".to_string(),
                started_at: now - STALE_RUNNING_BAKE_RUN_MS - 1,
            })
            .unwrap();

        assert_eq!(mgr.fail_stale_running_bake_runs().unwrap(), 1);
        assert!(!mgr.update_bake_run_progress(stale_id, 10, 3).unwrap());
        assert!(!mgr
            .complete_bake_run(
                stale_id,
                "completed",
                now,
                3,
                1,
                1,
                0,
                1,
                0,
                0,
                None,
                Some(STALE_RUNNING_BAKE_RUN_MS),
            )
            .unwrap());

        let run = mgr.get_latest_bake_run().unwrap().unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(run.candidate_count, 0);
        assert_eq!(run.processed_episode_count, 0);
    }
}
