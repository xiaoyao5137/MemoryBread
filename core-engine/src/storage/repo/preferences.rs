//! user_preferences 表的 CRUD 操作

use rusqlite::{params, Connection};

use crate::storage::{
    db::current_ts_ms, error::StorageError, models::PreferenceRecord, StorageManager,
};

// ─────────────────────────────────────────────────────────────────────────────
// 写操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 插入或更新一条偏好记录（upsert）。
    /// 若 key 已存在则更新 value/confidence/updated_at/sample_count。
    pub fn upsert_preference(
        &self,
        key: &str,
        value: &str,
        source: &str,
        confidence: f64,
    ) -> Result<(), StorageError> {
        let now = current_ts_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO user_preferences (key, value, source, confidence, updated_at, sample_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)
                 ON CONFLICT(key) DO UPDATE SET
                     value        = excluded.value,
                     source       = excluded.source,
                     confidence   = excluded.confidence,
                     updated_at   = excluded.updated_at,
                     sample_count = sample_count + 1",
                params![key, value, source, confidence, now],
            )?;
            Ok(())
        })
    }

    /// 仅更新已存在偏好的值，不改变 source/confidence。
    pub fn update_preference_value(&self, key: &str, value: &str) -> Result<bool, StorageError> {
        let now = current_ts_ms();
        self.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE user_preferences SET value = ?1, updated_at = ?2 WHERE key = ?3",
                params![value, now, key],
            )?;
            Ok(affected > 0)
        })
    }

    /// 删除一条偏好记录。
    pub fn delete_preference(&self, key: &str) -> Result<bool, StorageError> {
        self.with_conn(|conn| {
            let affected =
                conn.execute("DELETE FROM user_preferences WHERE key = ?1", params![key])?;
            Ok(affected > 0)
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 读操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 按 key 获取单条偏好记录。
    pub fn get_preference(&self, key: &str) -> Result<Option<PreferenceRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, key, value, source, confidence, updated_at, sample_count
                 FROM user_preferences WHERE key = ?1",
            )?;
            let mut rows = stmt.query(params![key])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_preference(row)?))
            } else {
                Ok(None)
            }
        })
    }

    /// 获取偏好值字符串（快捷方法，Key 不存在返回 None）。
    pub fn get_preference_value(&self, key: &str) -> Result<Option<String>, StorageError> {
        Ok(self.get_preference(key)?.map(|p| p.value))
    }

    /// 列举所有偏好记录，按 key 升序。
    pub fn list_preferences(&self) -> Result<Vec<PreferenceRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, key, value, source, confidence, updated_at, sample_count
                 FROM user_preferences ORDER BY key ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(row_to_preference(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    /// 按 source 过滤，返回对应来源的偏好列表。
    pub fn list_preferences_by_source(
        &self,
        source: &str,
    ) -> Result<Vec<PreferenceRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, key, value, source, confidence, updated_at, sample_count
                 FROM user_preferences WHERE source = ?1 ORDER BY key ASC",
            )?;
            let rows = stmt.query_map(params![source], |row| {
                Ok(row_to_preference(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 行映射辅助
// ─────────────────────────────────────────────────────────────────────────────

fn row_to_preference(row: &rusqlite::Row<'_>) -> Result<PreferenceRecord, StorageError> {
    Ok(PreferenceRecord {
        id: row.get(0)?,
        key: row.get(1)?,
        value: row.get(2)?,
        source: row.get(3)?,
        confidence: row.get(4)?,
        updated_at: row.get(5)?,
        sample_count: row.get(6)?,
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

    #[test]
    fn test_upsert_and_get() {
        let mgr = make_mgr();
        mgr.upsert_preference("style.greeting", "嗨", "learned", 0.8)
            .unwrap();

        let p = mgr.get_preference("style.greeting").unwrap().unwrap();
        assert_eq!(p.key, "style.greeting");
        assert_eq!(p.value, "嗨");
        assert_eq!(p.source, "learned");
        assert!((p.confidence - 0.8).abs() < 1e-6);
        assert_eq!(p.sample_count, 1);
    }

    #[test]
    fn test_upsert_increments_sample_count() {
        let mgr = make_mgr();
        mgr.upsert_preference("style.greeting", "嗨", "learned", 0.7)
            .unwrap();
        mgr.upsert_preference("style.greeting", "你好", "learned", 0.9)
            .unwrap();

        let p = mgr.get_preference("style.greeting").unwrap().unwrap();
        assert_eq!(p.value, "你好");
        assert_eq!(p.sample_count, 2);
    }

    #[test]
    fn test_get_preference_value() {
        let mgr = make_mgr();
        mgr.upsert_preference("format.list_style", "markdown", "manual", 1.0)
            .unwrap();

        let v = mgr.get_preference_value("format.list_style").unwrap();
        assert_eq!(v.as_deref(), Some("markdown"));

        let missing = mgr.get_preference_value("nonexistent").unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn test_list_preferences() {
        let mgr = make_mgr();
        mgr.upsert_preference("a.key", "v1", "manual", 1.0).unwrap();
        mgr.upsert_preference("b.key", "v2", "learned", 0.5)
            .unwrap();

        // list_preferences 返回全部偏好（含 002_seed_defaults 预置的 28 条）
        let list = mgr.list_preferences().unwrap();
        assert!(list.iter().any(|p| p.key == "a.key"), "应包含 a.key");
        assert!(list.iter().any(|p| p.key == "b.key"), "应包含 b.key");

        // 通过 source 精确验证：只有本次插入的 b.key 的 source 是 "learned"
        let by_src = mgr.list_preferences_by_source("learned").unwrap();
        assert_eq!(by_src.len(), 1);
        assert_eq!(by_src[0].key, "b.key");
    }

    #[test]
    fn test_delete_preference() {
        let mgr = make_mgr();
        mgr.upsert_preference("tmp.key", "val", "manual", 1.0)
            .unwrap();
        let deleted = mgr.delete_preference("tmp.key").unwrap();
        assert!(deleted);

        let p = mgr.get_preference("tmp.key").unwrap();
        assert!(p.is_none());
    }
}
