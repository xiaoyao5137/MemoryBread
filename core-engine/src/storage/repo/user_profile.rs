use crate::storage::{
    db::StorageManager,
    error::StorageError,
    models::{NewUserProfile, UserProfileRecord},
};
use rusqlite::params;

impl StorageManager {
    pub fn create_user_profile(&self, new: &NewUserProfile) -> Result<i64, StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO user_profiles (snapshot_type, snapshot_date, content, is_system_generated)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                &new.snapshot_type,
                &new.snapshot_date,
                &new.content,
                new.is_system_generated as i32
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_user_profile(&self, id: i64) -> Result<Option<UserProfileRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, snapshot_type, snapshot_date, content, is_system_generated, created_at, updated_at
             FROM user_profiles WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(UserProfileRecord {
                id: row.get(0)?,
                snapshot_type: row.get(1)?,
                snapshot_date: row.get(2)?,
                content: row.get(3)?,
                is_system_generated: row.get::<_, i32>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_user_profiles(
        &self,
        snapshot_type: Option<&str>,
        limit: usize,
    ) -> Result<Vec<UserProfileRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();

        if let Some(t) = snapshot_type {
            let mut stmt = conn.prepare(
                "SELECT id, snapshot_type, snapshot_date, content, is_system_generated, created_at, updated_at
                 FROM user_profiles WHERE snapshot_type = ?1 ORDER BY snapshot_date DESC LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![t, limit as i64], |row| {
                Ok(UserProfileRecord {
                    id: row.get(0)?,
                    snapshot_type: row.get(1)?,
                    snapshot_date: row.get(2)?,
                    content: row.get(3)?,
                    is_system_generated: row.get::<_, i32>(4)? != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, snapshot_type, snapshot_date, content, is_system_generated, created_at, updated_at
                 FROM user_profiles ORDER BY snapshot_date DESC LIMIT ?1"
            )?;
            let rows = stmt.query_map(params![limit as i64], |row| {
                Ok(UserProfileRecord {
                    id: row.get(0)?,
                    snapshot_type: row.get(1)?,
                    snapshot_date: row.get(2)?,
                    content: row.get(3)?,
                    is_system_generated: row.get::<_, i32>(4)? != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        }
    }

    pub fn update_user_profile_content(&self, id: i64, content: &str) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE user_profiles SET content = ?1, is_system_generated = 0, updated_at = datetime('now')
             WHERE id = ?2",
            params![content, id],
        )?;
        Ok(())
    }

    pub fn get_latest_profile(
        &self,
        snapshot_type: &str,
    ) -> Result<Option<UserProfileRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, snapshot_type, snapshot_date, content, is_system_generated, created_at, updated_at
             FROM user_profiles WHERE snapshot_type = ?1 ORDER BY snapshot_date DESC LIMIT 1",
        )?;
        let mut rows = stmt.query(params![snapshot_type])?;
        if let Some(row) = rows.next()? {
            Ok(Some(UserProfileRecord {
                id: row.get(0)?,
                snapshot_type: row.get(1)?,
                snapshot_date: row.get(2)?,
                content: row.get(3)?,
                is_system_generated: row.get::<_, i32>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            }))
        } else {
            Ok(None)
        }
    }
}
