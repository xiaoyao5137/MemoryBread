use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreationHistory {
    pub id: i64,
    pub prompt: String,
    pub generated_content: String,
    pub doc_type: Option<String>,
    pub audience: Option<String>,
    pub reference_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn insert(conn: &Connection, prompt: &str, content: &str, doc_type: Option<&str>, audience: Option<&str>, ref_count: i64) -> Result<i64> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO creation_history (prompt, generated_content, doc_type, audience, reference_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![prompt, content, doc_type, audience, ref_count, now, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_recent(conn: &Connection, limit: i64) -> Result<Vec<CreationHistory>> {
    let mut stmt = conn.prepare("SELECT id, prompt, generated_content, doc_type, audience, reference_count, created_at, updated_at FROM creation_history ORDER BY created_at DESC LIMIT ?")?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(CreationHistory {
            id: row.get(0)?,
            prompt: row.get(1)?,
            generated_content: row.get(2)?,
            doc_type: row.get(3)?,
            audience: row.get(4)?,
            reference_count: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;
    rows.collect()
}
