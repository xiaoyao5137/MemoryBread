use crate::storage::{
    db::StorageManager,
    error::StorageError,
    models::{DiaryRecord, NewDiaryEntry},
};
use rusqlite::params;

impl StorageManager {
    pub fn upsert_diary_entry(&self, new: &NewDiaryEntry) -> Result<i64, StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO diaries (
                    period_type, period_start, period_end, diary_date, content,
                    source_timeline_ids, source_diary_ids, generation_status, is_system_generated
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(period_type, diary_date) DO UPDATE SET
                    period_start = excluded.period_start,
                    period_end = excluded.period_end,
                    content = excluded.content,
                    source_timeline_ids = excluded.source_timeline_ids,
                    source_diary_ids = excluded.source_diary_ids,
                    generation_status = excluded.generation_status,
                    is_system_generated = excluded.is_system_generated,
                    updated_at = datetime('now')",
                params![
                    &new.period_type,
                    &new.period_start,
                    &new.period_end,
                    &new.diary_date,
                    &new.content,
                    &new.source_timeline_ids,
                    &new.source_diary_ids,
                    &new.generation_status,
                    new.is_system_generated as i32,
                ],
            )?;

            let id = conn.query_row(
                "SELECT id FROM diaries WHERE period_type = ?1 AND diary_date = ?2",
                params![&new.period_type, &new.diary_date],
                |row| row.get(0),
            )?;
            Ok(id)
        })
    }

    pub fn get_diary(&self, id: i64) -> Result<Option<DiaryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, period_type, period_start, period_end, diary_date, content,
                        source_timeline_ids, source_diary_ids, generation_status,
                        is_system_generated, created_at, updated_at
                 FROM diaries WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_diary(row)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn get_diary_by_date(
        &self,
        period_type: &str,
        diary_date: &str,
    ) -> Result<Option<DiaryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, period_type, period_start, period_end, diary_date, content,
                        source_timeline_ids, source_diary_ids, generation_status,
                        is_system_generated, created_at, updated_at
                 FROM diaries WHERE period_type = ?1 AND diary_date = ?2",
            )?;
            let mut rows = stmt.query(params![period_type, diary_date])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_diary(row)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn list_diaries(
        &self,
        period_type: Option<&str>,
        limit: usize,
    ) -> Result<Vec<DiaryRecord>, StorageError> {
        self.with_conn(|conn| {
            if let Some(t) = period_type {
                let mut stmt = conn.prepare(
                    "SELECT id, period_type, period_start, period_end, diary_date, content,
                            source_timeline_ids, source_diary_ids, generation_status,
                            is_system_generated, created_at, updated_at
                     FROM diaries WHERE period_type = ?1
                     ORDER BY diary_date DESC, id DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![t, limit as i64], row_to_diary)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
            } else {
                let mut stmt = conn.prepare(
                    "SELECT id, period_type, period_start, period_end, diary_date, content,
                            source_timeline_ids, source_diary_ids, generation_status,
                            is_system_generated, created_at, updated_at
                     FROM diaries ORDER BY diary_date DESC, id DESC LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit as i64], row_to_diary)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
            }
        })
    }

    pub fn update_diary_content(&self, id: i64, content: &str) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE diaries
                 SET content = ?1,
                     is_system_generated = 0,
                     generation_status = 'edited',
                     updated_at = datetime('now')
                 WHERE id = ?2",
                params![content, id],
            )?;
            Ok(())
        })
    }

    pub fn get_latest_diary(&self, period_type: &str) -> Result<Option<DiaryRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, period_type, period_start, period_end, diary_date, content,
                        source_timeline_ids, source_diary_ids, generation_status,
                        is_system_generated, created_at, updated_at
                 FROM diaries WHERE period_type = ?1
                 ORDER BY diary_date DESC, id DESC LIMIT 1",
            )?;
            let mut rows = stmt.query(params![period_type])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_diary(row)?))
            } else {
                Ok(None)
            }
        })
    }
}

fn row_to_diary(row: &rusqlite::Row<'_>) -> rusqlite::Result<DiaryRecord> {
    Ok(DiaryRecord {
        id: row.get(0)?,
        period_type: row.get(1)?,
        period_start: row.get(2)?,
        period_end: row.get(3)?,
        diary_date: row.get(4)?,
        content: row.get(5)?,
        source_timeline_ids: row.get(6)?,
        source_diary_ids: row.get(7)?,
        generation_status: row.get(8)?,
        is_system_generated: row.get::<_, i32>(9)? != 0,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> StorageManager {
        StorageManager::open_in_memory().expect("内存数据库初始化失败")
    }

    fn sample(date: &str) -> NewDiaryEntry {
        NewDiaryEntry {
            period_type: "daily".to_string(),
            period_start: date.to_string(),
            period_end: date.to_string(),
            diary_date: date.to_string(),
            content: json!({
                "title": "工作日记",
                "work_outputs": ["完成了日记表设计"]
            })
            .to_string(),
            source_timeline_ids: "[1,2]".to_string(),
            source_diary_ids: "[]".to_string(),
            generation_status: "ready".to_string(),
            is_system_generated: true,
        }
    }

    #[test]
    fn upsert_diary_entry_reuses_same_date() {
        let mgr = setup();
        let first_id = mgr.upsert_diary_entry(&sample("2026-07-07")).unwrap();
        let mut updated = sample("2026-07-07");
        updated.content = json!({"title": "更新后的日记"}).to_string();

        let second_id = mgr.upsert_diary_entry(&updated).unwrap();

        assert_eq!(first_id, second_id);
        let record = mgr.get_diary(first_id).unwrap().unwrap();
        assert_eq!(record.period_type, "daily");
        assert!(record.content.contains("更新后的日记"));
    }

    #[test]
    fn list_diaries_filters_by_period_type() {
        let mgr = setup();
        mgr.upsert_diary_entry(&sample("2026-07-06")).unwrap();
        mgr.upsert_diary_entry(&sample("2026-07-07")).unwrap();

        let records = mgr.list_diaries(Some("daily"), 10).unwrap();

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].diary_date, "2026-07-07");
    }
}
