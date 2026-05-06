//! style_samples 表的 CRUD 操作

use rusqlite::{params, Connection};

use crate::storage::{
    error::StorageError,
    models::{NewStyleSample, StyleSampleRecord},
    StorageManager,
};

// ─────────────────────────────────────────────────────────────────────────────
// 写操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 插入一条写作风格样本，返回新行 id。
    pub fn insert_style_sample(&self, s: &NewStyleSample) -> Result<i64, StorageError> {
        self.with_conn(|conn| insert_style_sample_inner(conn, s))
    }

    /// 批量插入风格样本（提升写入效率）。
    pub fn insert_style_samples_batch(
        &self,
        samples: &[NewStyleSample],
    ) -> Result<Vec<i64>, StorageError> {
        self.with_conn(|conn| {
            let mut ids = Vec::with_capacity(samples.len());
            for s in samples {
                ids.push(insert_style_sample_inner(conn, s)?);
            }
            Ok(ids)
        })
    }

    /// 更新样本质量评分（AI 评估后回写）。
    pub fn update_sample_quality(&self, id: i64, quality: f64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE style_samples SET quality = ?1 WHERE id = ?2",
                params![quality, id],
            )?;
            Ok(())
        })
    }

    /// 删除低质量样本（quality < threshold），释放存储空间。
    pub fn delete_low_quality_samples(&self, threshold: f64) -> Result<usize, StorageError> {
        self.with_conn(|conn| {
            let affected = conn.execute(
                "DELETE FROM style_samples WHERE quality < ?1",
                params![threshold],
            )?;
            Ok(affected)
        })
    }
}

fn insert_style_sample_inner(conn: &Connection, s: &NewStyleSample) -> Result<i64, StorageError> {
    let word_count = s.content.chars().count() as i64;
    conn.execute(
        "INSERT INTO style_samples (ts, scene_type, content, app_name, quality, word_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            s.ts,
            s.scene_type,
            s.content,
            s.app_name,
            s.quality,
            word_count
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// ─────────────────────────────────────────────────────────────────────────────
// 读操作
// ─────────────────────────────────────────────────────────────────────────────

impl StorageManager {
    /// 按 id 获取单条样本。
    pub fn get_style_sample(&self, id: i64) -> Result<Option<StyleSampleRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, scene_type, content, app_name, quality, word_count
                 FROM style_samples WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row_to_style_sample(row)?))
            } else {
                Ok(None)
            }
        })
    }

    /// 随机抽取指定场景的高质量样本（用于 few-shot Prompt 注入）。
    ///
    /// `min_quality`：质量阈值（建议 0.7+）
    /// `limit`：最多返回条数
    pub fn sample_style_for_scene(
        &self,
        scene_type: &str,
        min_quality: f64,
        limit: usize,
    ) -> Result<Vec<StyleSampleRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, scene_type, content, app_name, quality, word_count
                 FROM style_samples
                 WHERE scene_type = ?1 AND quality >= ?2
                 ORDER BY RANDOM() LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![scene_type, min_quality, limit as i64], |row| {
                Ok(row_to_style_sample(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    /// 列举指定场景最新的样本（按 ts 倒序）。
    pub fn list_style_samples(
        &self,
        scene_type: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<StyleSampleRecord>, StorageError> {
        self.with_conn(|conn| {
            let (sql, has_scene) = match scene_type {
                Some(_) => (
                    "SELECT id, ts, scene_type, content, app_name, quality, word_count
                     FROM style_samples WHERE scene_type = ?1
                     ORDER BY ts DESC LIMIT ?2 OFFSET ?3",
                    true,
                ),
                None => (
                    "SELECT id, ts, scene_type, content, app_name, quality, word_count
                     FROM style_samples ORDER BY ts DESC LIMIT ?1 OFFSET ?2",
                    false,
                ),
            };

            let rows: Vec<StyleSampleRecord> = if has_scene {
                let mut stmt = conn.prepare(sql)?;
                let collected = stmt
                    .query_map(
                        params![scene_type.unwrap(), limit as i64, offset as i64],
                        |row| {
                            Ok(row_to_style_sample(row)
                                .map_err(|_| rusqlite::Error::InvalidQuery)?)
                        },
                    )?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::Sqlite)?;
                collected
            } else {
                let mut stmt = conn.prepare(sql)?;
                let collected = stmt
                    .query_map(params![limit as i64, offset as i64], |row| {
                        Ok(row_to_style_sample(row).map_err(|_| rusqlite::Error::InvalidQuery)?)
                    })?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::Sqlite)?;
                collected
            };
            Ok(rows)
        })
    }

    /// 返回每个场景的样本数量统计。
    pub fn count_style_samples_by_scene(&self) -> Result<Vec<(String, i64)>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT scene_type, COUNT(*) FROM style_samples GROUP BY scene_type")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 行映射辅助
// ─────────────────────────────────────────────────────────────────────────────

fn row_to_style_sample(row: &rusqlite::Row<'_>) -> Result<StyleSampleRecord, StorageError> {
    Ok(StyleSampleRecord {
        id: row.get(0)?,
        ts: row.get(1)?,
        scene_type: row.get(2)?,
        content: row.get(3)?,
        app_name: row.get(4)?,
        quality: row.get(5)?,
        word_count: row.get(6)?,
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

    fn sample(scene: &str, content: &str, quality: f64) -> NewStyleSample {
        NewStyleSample {
            ts: 1_700_000_000_000,
            scene_type: scene.into(),
            content: content.into(),
            app_name: Some("Feishu".into()),
            quality,
        }
    }

    #[test]
    fn test_insert_and_get() {
        let mgr = make_mgr();
        let id = mgr
            .insert_style_sample(&sample("im_reply", "收到，稍后处理", 0.8))
            .unwrap();
        assert!(id > 0);

        let rec = mgr.get_style_sample(id).unwrap().unwrap();
        assert_eq!(rec.scene_type, "im_reply");
        assert_eq!(rec.word_count, 7); // "收到，稍后处理" = 7 chars
    }

    #[test]
    fn test_update_quality() {
        let mgr = make_mgr();
        let id = mgr
            .insert_style_sample(&sample("doc_writing", "项目进展顺利", 0.5))
            .unwrap();
        mgr.update_sample_quality(id, 0.95).unwrap();

        let rec = mgr.get_style_sample(id).unwrap().unwrap();
        assert!((rec.quality - 0.95).abs() < 1e-6);
    }

    #[test]
    fn test_sample_for_scene() {
        let mgr = make_mgr();
        mgr.insert_style_sample(&sample("im_reply", "好的", 0.9))
            .unwrap();
        mgr.insert_style_sample(&sample("im_reply", "明白了", 0.3))
            .unwrap();
        mgr.insert_style_sample(&sample("doc_writing", "文档内容", 0.8))
            .unwrap();

        let results = mgr.sample_style_for_scene("im_reply", 0.7, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "好的");
    }

    #[test]
    fn test_delete_low_quality() {
        let mgr = make_mgr();
        mgr.insert_style_sample(&sample("im_reply", "一般", 0.4))
            .unwrap();
        mgr.insert_style_sample(&sample("im_reply", "很好", 0.9))
            .unwrap();

        let deleted = mgr.delete_low_quality_samples(0.7).unwrap();
        assert_eq!(deleted, 1);

        let list = mgr.list_style_samples(None, 10, 0).unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_batch_insert() {
        let mgr = make_mgr();
        let samples = vec![
            sample("im_reply", "已收到", 0.8),
            sample("im_reply", "好的好的", 0.7),
        ];
        let ids = mgr.insert_style_samples_batch(&samples).unwrap();
        assert_eq!(ids.len(), 2);
    }
}
