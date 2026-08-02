use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::storage::{
    db::current_ts_ms, error::StorageError, models_data::CreationEvidenceAssetRecord,
    StorageManager,
};

#[derive(Debug, Clone)]
pub struct NewCreationEvidenceAsset {
    pub id: String,
    pub run_id: String,
    pub session_id: String,
    pub source_id: i64,
    pub data_snapshot_id: Option<i64>,
    pub source_url: String,
    pub page_title: String,
    pub captured_at: i64,
    pub image_path: String,
    pub mime_type: String,
    pub width: i64,
    pub height: i64,
    pub content_hash: String,
    pub screenshot_source: String,
}

impl StorageManager {
    pub fn save_creation_evidence_asset(
        &self,
        asset: &NewCreationEvidenceAsset,
    ) -> Result<CreationEvidenceAssetRecord, StorageError> {
        self.with_conn(|conn| {
            let now = current_ts_ms();
            conn.execute(
                "INSERT INTO creation_evidence_assets (
                    id, run_id, session_id, source_id, data_snapshot_id, source_url,
                    page_title, captured_at, image_path, mime_type, width, height,
                    content_hash, screenshot_source, validation_status, validation_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                           ?13, ?14, 'pending', '{}', ?15, ?15)",
                params![
                    asset.id,
                    asset.run_id,
                    asset.session_id,
                    asset.source_id,
                    asset.data_snapshot_id,
                    asset.source_url,
                    asset.page_title,
                    asset.captured_at,
                    asset.image_path,
                    asset.mime_type,
                    asset.width,
                    asset.height,
                    asset.content_hash,
                    asset.screenshot_source,
                    now,
                ],
            )?;
            get_by_id(conn, &asset.id)?
                .ok_or_else(|| StorageError::NotFound(format!("creation evidence {}", asset.id)))
        })
    }

    pub fn get_creation_evidence_asset(
        &self,
        id: &str,
    ) -> Result<Option<CreationEvidenceAssetRecord>, StorageError> {
        self.with_conn(|conn| get_by_id(conn, id))
    }

    pub fn validate_creation_evidence_asset(
        &self,
        id: &str,
        status: &str,
        validation: &Value,
    ) -> Result<Option<CreationEvidenceAssetRecord>, StorageError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE creation_evidence_assets
                 SET validation_status = ?2, validation_json = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![
                    id,
                    status,
                    serde_json::to_string(validation)?,
                    current_ts_ms()
                ],
            )?;
            get_by_id(conn, id)
        })
    }
}

pub fn attach_to_history(
    conn: &Connection,
    history_id: i64,
    evidence_ids: &[String],
) -> Result<(), StorageError> {
    for id in evidence_ids {
        conn.execute(
            "UPDATE creation_evidence_assets SET history_id = ?2, updated_at = ?3
             WHERE id = ?1",
            params![id, history_id, current_ts_ms()],
        )?;
    }
    Ok(())
}

fn get_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<CreationEvidenceAssetRecord>, StorageError> {
    conn.query_row(
        "SELECT id, run_id, session_id, history_id, source_id, data_snapshot_id,
                source_url, page_title, captured_at, image_path, mime_type, width,
                height, content_hash, screenshot_source, validation_status, validation_json
         FROM creation_evidence_assets WHERE id = ?1",
        [id],
        |row| {
            let validation_json: String = row.get(16)?;
            Ok(CreationEvidenceAssetRecord {
                id: row.get(0)?,
                run_id: row.get(1)?,
                session_id: row.get(2)?,
                history_id: row.get(3)?,
                source_id: row.get(4)?,
                data_snapshot_id: row.get(5)?,
                source_url: row.get(6)?,
                page_title: row.get(7)?,
                captured_at: row.get(8)?,
                image_path: row.get(9)?,
                mime_type: row.get(10)?,
                width: row.get(11)?,
                height: row.get(12)?,
                content_hash: row.get(13)?,
                screenshot_source: row.get(14)?,
                validation_status: row.get(15)?,
                validation: serde_json::from_str(&validation_json)
                    .unwrap_or_else(|_| serde_json::json!({})),
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persists_and_validates_creation_owned_evidence() {
        let storage = StorageManager::open_in_memory().unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO data_sources (
                        canonical_key, title, source_kind, source_url, access_mode,
                        refresh_policy, realtime_level, first_seen_at, last_seen_at,
                        created_at, updated_at
                     ) VALUES (
                        'report:https://bi.example.com/dashboard', '经营看板', 'report_url',
                        'https://bi.example.com/dashboard', 'browser_session', 'on_demand',
                        'live', 1, 1, 1, 1
                     )",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let asset = storage
            .save_creation_evidence_asset(&NewCreationEvidenceAsset {
                id: "evidence-test".to_string(),
                run_id: "run-test".to_string(),
                session_id: "session-test".to_string(),
                source_id: 1,
                data_snapshot_id: None,
                source_url: "https://bi.example.com/dashboard".to_string(),
                page_title: "经营看板".to_string(),
                captured_at: 100,
                image_path: "evidence-test.jpg".to_string(),
                mime_type: "image/jpeg".to_string(),
                width: 1200,
                height: 800,
                content_hash: "image-hash".to_string(),
                screenshot_source: "browser_window".to_string(),
            })
            .unwrap();
        assert_eq!(asset.validation_status, "pending");
        assert!(asset.data_snapshot_id.is_none());

        let verified = storage
            .validate_creation_evidence_asset(
                "evidence-test",
                "verified",
                &json!({"verified_claims": [{"label": "订单", "value": "1200"}]}),
            )
            .unwrap()
            .unwrap();
        assert_eq!(verified.validation_status, "verified");
        assert_eq!(verified.validation["verified_claims"][0]["value"], "1200");
    }
}
