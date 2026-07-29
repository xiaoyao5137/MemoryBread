use rusqlite::params;

use super::models::{NewNotificationChannel, NotificationChannel, UpdateNotificationChannel};
use crate::storage::{StorageError, StorageManager};

pub struct NotificationChannelRepo;

impl NotificationChannelRepo {
    pub fn list(storage: &StorageManager) -> Result<Vec<NotificationChannel>, StorageError> {
        storage.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, name, channel_type, webhook_url, enabled, created_at, updated_at
                 FROM notification_channels
                 ORDER BY enabled DESC, id",
            )?;
            let rows = statement.query_map([], Self::row_to_channel)?;
            Ok(rows.filter_map(Result::ok).collect())
        })
    }

    pub fn get(
        storage: &StorageManager,
        id: i64,
    ) -> Result<Option<NotificationChannel>, StorageError> {
        storage.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, name, channel_type, webhook_url, enabled, created_at, updated_at
                 FROM notification_channels
                 WHERE id = ?1",
            )?;
            let mut rows = statement.query_map(params![id], Self::row_to_channel)?;
            Ok(rows.next().and_then(Result::ok))
        })
    }

    pub fn create(
        storage: &StorageManager,
        channel: &NewNotificationChannel,
        now_ms: i64,
    ) -> Result<i64, StorageError> {
        storage.with_conn(|conn| {
            conn.execute(
                "INSERT INTO notification_channels
                   (name, channel_type, webhook_url, enabled, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    channel.name,
                    channel.channel_type,
                    channel.webhook_url,
                    channel.enabled as i64,
                    now_ms,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn update(
        storage: &StorageManager,
        id: i64,
        patch: &UpdateNotificationChannel,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        storage.with_conn(|conn| {
            let affected = conn.execute(
                "UPDATE notification_channels SET
                   name = COALESCE(?1, name),
                   channel_type = COALESCE(?2, channel_type),
                   webhook_url = COALESCE(?3, webhook_url),
                   enabled = COALESCE(?4, enabled),
                   updated_at = ?5
                 WHERE id = ?6",
                params![
                    patch.name,
                    patch.channel_type,
                    patch.webhook_url,
                    patch.enabled.map(i64::from),
                    now_ms,
                    id,
                ],
            )?;
            Ok(affected > 0)
        })
    }

    pub fn delete(storage: &StorageManager, id: i64) -> Result<bool, StorageError> {
        storage.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            let task_channels = {
                let mut statement = transaction.prepare(
                    "SELECT id, notification_channel_ids
                     FROM scheduled_tasks
                     WHERE notification_channel_ids <> '[]'",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?;
                rows.filter_map(Result::ok).collect::<Vec<_>>()
            };
            for (task_id, encoded_ids) in task_channels {
                let mut ids = serde_json::from_str::<Vec<i64>>(&encoded_ids).unwrap_or_default();
                let previous_len = ids.len();
                ids.retain(|channel_id| *channel_id != id);
                if ids.len() != previous_len {
                    transaction.execute(
                        "UPDATE scheduled_tasks
                         SET notification_channel_ids = ?1
                         WHERE id = ?2",
                        params![
                            serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into()),
                            task_id
                        ],
                    )?;
                }
            }
            let affected = transaction.execute(
                "DELETE FROM notification_channels WHERE id = ?1",
                params![id],
            )?;
            transaction.commit()?;
            Ok(affected > 0)
        })
    }

    pub fn all_exist(storage: &StorageManager, ids: &[i64]) -> Result<bool, StorageError> {
        if ids.is_empty() {
            return Ok(true);
        }
        storage.with_conn(|conn| {
            let mut statement = conn.prepare("SELECT id FROM notification_channels ORDER BY id")?;
            let existing = statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .filter_map(Result::ok)
                .collect::<std::collections::BTreeSet<_>>();
            Ok(ids.iter().all(|id| existing.contains(id)))
        })
    }

    fn row_to_channel(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotificationChannel> {
        Ok(NotificationChannel {
            id: row.get(0)?,
            name: row.get(1)?,
            channel_type: row.get(2)?,
            webhook_url: row.get(3)?,
            enabled: row.get::<_, i64>(4)? != 0,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    }
}
