//! 定时任务数据库操作

use rusqlite::params;

use super::models::{NewScheduledTask, ScheduledTask, TaskExecution, UpdateScheduledTask};
use crate::storage::{StorageError, StorageManager};

pub struct TaskRepo;

impl TaskRepo {
    /// 创建任务，返回新 id
    pub fn create(
        storage: &StorageManager,
        task: &NewScheduledTask,
        now_ms: i64,
    ) -> Result<i64, StorageError> {
        storage.with_conn(|conn| {
            conn.execute(
                "INSERT INTO scheduled_tasks
                 (name, user_instruction, cron_expression, template_id, enabled, run_count, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?5)",
                params![task.name, task.user_instruction, task.cron_expression, task.template_id, now_ms],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    /// 查询所有启用的任务
    pub fn list_enabled(storage: &StorageManager) -> Result<Vec<ScheduledTask>, StorageError> {
        storage.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, user_instruction, cron_expression, enabled, template_id,
                        run_count, last_run_at, last_run_status, next_run_at, created_at, updated_at
                 FROM scheduled_tasks WHERE enabled = 1 ORDER BY id",
            )?;
            let rows = stmt.query_map([], |row| Self::row_to_task(row))?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    /// 查询所有任务（含禁用）
    pub fn list_all(storage: &StorageManager) -> Result<Vec<ScheduledTask>, StorageError> {
        storage.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, user_instruction, cron_expression, enabled, template_id,
                        run_count, last_run_at, last_run_status, next_run_at, created_at, updated_at
                 FROM scheduled_tasks ORDER BY id",
            )?;
            let rows = stmt.query_map([], |row| Self::row_to_task(row))?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    /// 按 id 查询单个任务
    pub fn get(storage: &StorageManager, id: i64) -> Result<Option<ScheduledTask>, StorageError> {
        storage.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, user_instruction, cron_expression, enabled, template_id,
                        run_count, last_run_at, last_run_status, next_run_at, created_at, updated_at
                 FROM scheduled_tasks WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(params![id], |row| Self::row_to_task(row))?;
            Ok(rows.next().and_then(|r| r.ok()))
        })
    }

    /// 更新任务字段
    pub fn update(
        storage: &StorageManager,
        id: i64,
        patch: &UpdateScheduledTask,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        storage.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE scheduled_tasks SET
                   name             = COALESCE(?1, name),
                   user_instruction = COALESCE(?2, user_instruction),
                   cron_expression  = COALESCE(?3, cron_expression),
                   enabled          = COALESCE(?4, enabled),
                   updated_at       = ?5
                 WHERE id = ?6",
                params![
                    patch.name,
                    patch.user_instruction,
                    patch.cron_expression,
                    patch.enabled.map(|b| b as i64),
                    now_ms,
                    id,
                ],
            )?;
            Ok(affected > 0)
        })
    }

    /// 删除任务（级联删除执行历史）
    pub fn delete(storage: &StorageManager, id: i64) -> Result<bool, StorageError> {
        storage.with_conn(|conn| {
            let affected =
                conn.execute("DELETE FROM scheduled_tasks WHERE id = ?1", params![id])?;
            Ok(affected > 0)
        })
    }

    /// 更新 next_run_at
    pub fn set_next_run(
        storage: &StorageManager,
        id: i64,
        next_ms: i64,
    ) -> Result<(), StorageError> {
        storage.with_conn(|conn| {
            conn.execute(
                "UPDATE scheduled_tasks SET next_run_at = ?1 WHERE id = ?2",
                params![next_ms, id],
            )?;
            Ok(())
        })
    }

    /// 将历史五段 cron 规范化，并把下一次执行时间推进到未来。
    pub fn repair_schedule(
        storage: &StorageManager,
        id: i64,
        cron_expression: &str,
        next_ms: i64,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        storage.with_conn(|conn| {
            conn.execute(
                "UPDATE scheduled_tasks
                 SET cron_expression = ?1, next_run_at = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![cron_expression, next_ms, now_ms, id],
            )?;
            Ok(())
        })
    }

    /// 无效 cron 必须停止调度，避免 next_run_at 卡在过去并持续重试。
    pub fn disable_invalid_schedule(
        storage: &StorageManager,
        id: i64,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        storage.with_conn(|conn| {
            conn.execute(
                "UPDATE scheduled_tasks
                 SET enabled = 0,
                     last_run_status = 'invalid_schedule',
                     next_run_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2",
                params![now_ms, id],
            )?;
            Ok(())
        })
    }

    /// 查询任务的执行历史
    pub fn list_executions(
        storage: &StorageManager,
        task_id: i64,
        limit: i64,
    ) -> Result<Vec<TaskExecution>, StorageError> {
        storage.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, task_id, started_at, completed_at, status,
                        knowledge_count, token_used, result_text, error_message, latency_ms
                 FROM task_executions WHERE task_id = ?1
                 ORDER BY started_at DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![task_id, limit], |row| {
                Ok(TaskExecution {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    started_at: row.get(2)?,
                    completed_at: row.get(3)?,
                    status: row.get(4)?,
                    knowledge_count: row.get(5)?,
                    token_used: row.get(6)?,
                    result_text: row.get(7)?,
                    error_message: row.get(8)?,
                    latency_ms: row.get(9)?,
                })
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduledTask> {
        Ok(ScheduledTask {
            id: row.get(0)?,
            name: row.get(1)?,
            user_instruction: row.get(2)?,
            cron_expression: row.get(3)?,
            enabled: row.get::<_, i64>(4)? != 0,
            template_id: row.get(5)?,
            run_count: row.get(6)?,
            last_run_at: row.get(7)?,
            last_run_status: row.get(8)?,
            next_run_at: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    }
}
