use rusqlite::{params, Connection};

use crate::storage::{
    db::current_ts_ms,
    error::StorageError,
    models_bake::{BakeRunRecord, BakeWatermarkRecord, NewBakeRun},
    StorageManager,
};

impl StorageManager {
    pub fn insert_bake_run(&self, run: &NewBakeRun) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_bake_run_inner(conn, run))
    }

    pub fn get_latest_bake_run(&self) -> Result<Option<BakeRunRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, trigger_reason, status, started_at, completed_at,
                        processed_episode_count, auto_created_count, candidate_count, discarded_count,
                        knowledge_created_count, template_created_count, sop_created_count,
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
        template_created_count: i64,
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
                     template_created_count = ?8,
                     sop_created_count = ?9,
                     error_message = ?10,
                     latency_ms = ?11
                 WHERE id = ?12",
                params![
                    status,
                    completed_at,
                    processed_episode_count,
                    auto_created_count,
                    candidate_count,
                    discarded_count,
                    knowledge_created_count,
                    template_created_count,
                    sop_created_count,
                    error_message,
                    latency_ms,
                    id,
                ],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn get_bake_watermark(&self, pipeline_name: &str) -> Result<Option<BakeWatermarkRecord>, StorageError> {
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

    pub fn upsert_bake_watermark(&self, pipeline_name: &str, last_processed_ts: i64) -> Result<(), StorageError> {
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
            template_created_count,
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
        template_created_count: row.get(10)?,
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
        let id = mgr.insert_bake_run(&NewBakeRun {
            trigger_reason: "manual_debug".to_string(),
            status: "running".to_string(),
            started_at: 123,
        }).unwrap();

        assert!(mgr.complete_bake_run(
            id,
            "completed",
            456,
            3,
            1,
            1,
            1,
            1,
            0,
            0,
            None,
            Some(333),
        ).unwrap());

        let latest = mgr.get_latest_bake_run().unwrap().unwrap();
        assert_eq!(latest.id, id);
        assert_eq!(latest.status, "completed");
        assert_eq!(latest.processed_episode_count, 3);
        assert_eq!(latest.latency_ms, Some(333));
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
}
