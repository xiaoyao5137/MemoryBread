use crate::storage::{error::StorageError, models_bake::BakeDesignRecord};
use rusqlite::Connection;

impl crate::storage::StorageManager {
    pub fn list_bake_designs(&self) -> Result<Vec<BakeDesignRecord>, StorageError> {
        let conn = self.conn.lock()?;
        list_bake_designs_impl(&conn)
    }
}

fn list_bake_designs_impl(conn: &Connection) -> Result<Vec<BakeDesignRecord>, StorageError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, summary, content, design_type, status, tags, key_decisions,
                technologies, entities, diagram_code, source_capture_ids, source_episode_ids,
                match_score, match_level, creation_mode, review_status, evidence_summary,
                generation_version, created_at, updated_at, deleted_at
         FROM bake_designs
         WHERE deleted_at IS NULL
         ORDER BY created_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(BakeDesignRecord {
            id: row.get(0)?,
            title: row.get(1)?,
            summary: row.get(2)?,
            content: row.get(3)?,
            design_type: row.get(4)?,
            status: row.get(5)?,
            tags: row.get(6)?,
            key_decisions: row.get(7)?,
            technologies: row.get(8)?,
            entities: row.get(9)?,
            diagram_code: row.get(10)?,
            source_capture_ids: row.get(11)?,
            source_episode_ids: row.get(12)?,
            match_score: row.get(13)?,
            match_level: row.get(14)?,
            creation_mode: row.get(15)?,
            review_status: row.get(16)?,
            evidence_summary: row.get(17)?,
            generation_version: row.get(18)?,
            created_at: row.get(19)?,
            updated_at: row.get(20)?,
            deleted_at: row.get(21)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}
