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
    #[serde(default)]
    pub references_json: Option<String>,
    pub model: Option<String>,
    pub latency_ms: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn insert(
    conn: &Connection,
    prompt: &str,
    content: &str,
    doc_type: Option<&str>,
    audience: Option<&str>,
    ref_count: i64,
    references_json: Option<&str>,
    model: Option<&str>,
    latency_ms: Option<i64>,
) -> Result<i64> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO creation_history (prompt, generated_content, doc_type, audience, reference_count, references_json, model, latency_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![prompt, content, doc_type, audience, ref_count, references_json, model, latency_ms, now, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_recent(conn: &Connection, limit: i64) -> Result<Vec<CreationHistory>> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    list_page(conn, None, limit as usize, 0).map(|(items, _)| items)
}

pub fn list_page(
    conn: &Connection,
    query: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<(Vec<CreationHistory>, usize)> {
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    let select = "SELECT id, prompt, generated_content, doc_type, audience, reference_count,
                         references_json, model, latency_ms, created_at, updated_at
                  FROM creation_history";

    if let Some(query) = query {
        let predicate = "(instr(lower(COALESCE(prompt, '')), lower(?1)) > 0
                          OR instr(lower(COALESCE(generated_content, '')), lower(?1)) > 0
                          OR instr(lower(COALESCE(doc_type, '')), lower(?1)) > 0
                          OR instr(lower(COALESCE(audience, '')), lower(?1)) > 0)";
        let total = conn.query_row(
            &format!("SELECT COUNT(*) FROM creation_history WHERE {predicate}"),
            params![query],
            |row| row.get::<_, i64>(0),
        )?;
        let mut stmt = conn.prepare(&format!(
            "{select} WHERE {predicate} ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = stmt.query_map(params![query, limit as i64, offset as i64], map_history_row)?;
        Ok((rows.collect::<Result<Vec<_>>>()?, total.max(0) as usize))
    } else {
        let total = conn.query_row("SELECT COUNT(*) FROM creation_history", [], |row| {
            row.get::<_, i64>(0)
        })?;
        let mut stmt = conn.prepare(&format!(
            "{select} ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2"
        ))?;
        let rows = stmt.query_map(params![limit as i64, offset as i64], map_history_row)?;
        Ok((rows.collect::<Result<Vec<_>>>()?, total.max(0) as usize))
    }
}

fn map_history_row(row: &rusqlite::Row<'_>) -> Result<CreationHistory> {
    Ok(CreationHistory {
        id: row.get(0)?,
        prompt: row.get(1)?,
        generated_content: row.get(2)?,
        doc_type: row.get(3)?,
        audience: row.get(4)?,
        reference_count: row.get(5)?,
        references_json: row.get(6)?,
        model: row.get(7)?,
        latency_ms: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE creation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt TEXT NOT NULL,
                generated_content TEXT NOT NULL,
                doc_type TEXT,
                audience TEXT,
                reference_count INTEGER DEFAULT 0,
                references_json TEXT,
                model TEXT,
                latency_ms INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn search_and_paginate_history() {
        let conn = connection();
        for (index, (prompt, content)) in [
            ("年度方案", "第一版"),
            ("项目复盘", "包含年度目标"),
            ("技术文档", "普通内容"),
        ]
        .into_iter()
        .enumerate()
        {
            conn.execute(
                "INSERT INTO creation_history
                 (prompt, generated_content, reference_count, created_at, updated_at)
                 VALUES (?1, ?2, 0, ?3, ?3)",
                params![prompt, content, index as i64],
            )
            .unwrap();
        }

        let (first_page, total) = list_page(&conn, Some("年度"), 1, 0).unwrap();
        assert_eq!(total, 2);
        assert_eq!(first_page.len(), 1);

        let (second_page, total) = list_page(&conn, Some("年度"), 1, 1).unwrap();
        assert_eq!(total, 2);
        assert_eq!(second_page.len(), 1);
        assert_ne!(first_page[0].id, second_page[0].id);
    }
}
