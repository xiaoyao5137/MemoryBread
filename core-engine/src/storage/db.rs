//! StorageManager — 数据库连接管理与迁移执行
//!
//! # 设计要点
//!
//! - 使用 `Arc<Mutex<Connection>>` 在多线程间共享单一写连接
//! - WAL 模式允许读操作与写操作并发，不互相阻塞
//! - 所有阻塞 SQLite 调用通过 `tokio::task::spawn_blocking` 移出 async 线程
//! - 迁移 SQL 内嵌于二进制，应用启动时自动执行，无需外部文件

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use tracing::{debug, info};

use super::error::StorageError;

// ─────────────────────────────────────────────────────────────────────────────
// 内嵌迁移 SQL
// ─────────────────────────────────────────────────────────────────────────────

/// 按版本顺序排列的迁移列表：(版本号, SQL)
static MIGRATIONS: &[(&str, &str)] = &[
    ("001_init", include_str!("migrations/001_init.sql")),
    (
        "002_seed_defaults",
        include_str!("migrations/002_seed_defaults.sql"),
    ),
    ("003_views", include_str!("migrations/003_views.sql")),
    (
        "004_captures_knowledge_id",
        include_str!("../../../shared/db-schema/migrations/004_captures_knowledge_id.sql"),
    ),
    (
        "005_monitor_tables",
        include_str!("../../../shared/db-schema/migrations/005_monitor_tables.sql"),
    ),
    (
        "006_monitor_metric_scopes",
        include_str!("../../../shared/db-schema/migrations/006_monitor_metric_scopes.sql"),
    ),
    (
        "007_vector_index_rag_metadata",
        include_str!("../../../shared/db-schema/migrations/007_vector_index_rag_metadata.sql"),
    ),
    (
        "008_knowledge_semantic_metadata",
        include_str!("../../../shared/db-schema/migrations/008_knowledge_semantic_metadata.sql"),
    ),
    (
        "009_bake_templates",
        include_str!("migrations/009_bake_templates.sql"),
    ),
    (
        "010_knowledge_entries",
        include_str!("migrations/010_knowledge_entries.sql"),
    ),
    (
        "011_bake_pipeline",
        include_str!("migrations/011_bake_pipeline.sql"),
    ),
    (
        "012_fix_knowledge_fts_triggers",
        include_str!("migrations/012_fix_knowledge_fts_triggers.sql"),
    ),
    (
        "013_rebuild_knowledge_fts",
        include_str!("migrations/013_rebuild_knowledge_fts.sql"),
    ),
    (
        "014_add_knowledge_timestamp_ms",
        include_str!("migrations/014_add_knowledge_timestamp_ms.sql"),
    ),
    (
        "015_split_knowledge_tables",
        include_str!("migrations/015_split_knowledge_tables.sql"),
    ),
    (
        "016_fix_split_tables_fts_triggers",
        include_str!("migrations/016_fix_split_tables_fts_triggers.sql"),
    ),
    (
        "018_create_bake_designs",
        include_str!("migrations/018_create_bake_designs.sql"),
    ),
    (
        "019_rename_to_timelines",
        include_str!("migrations/019_rename_to_timelines.sql"),
    ),
    (
        "020_add_detailed_content",
        include_str!("migrations/020_add_detailed_content.sql"),
    ),
    (
        "021_unify_bake_designs",
        include_str!("migrations/021_unify_bake_designs.sql"),
    ),
    (
        "022_fix_bake_fts_delete_triggers",
        include_str!("migrations/022_fix_bake_fts_delete_triggers.sql"),
    ),
    (
        "023_rename_bake_run_design_count",
        include_str!("migrations/023_rename_bake_run_design_count.sql"),
    ),
    (
        "024_create_bake_documents",
        include_str!("migrations/024_create_bake_documents.sql"),
    ),
    (
        "025_add_capture_web_source",
        include_str!("migrations/025_add_capture_web_source.sql"),
    ),
    (
        "026_add_capture_screenshot_source",
        include_str!("migrations/026_add_capture_screenshot_source.sql"),
    ),
    (
        "027_bake_retry_state",
        include_str!("migrations/027_bake_retry_state.sql"),
    ),
    (
        "028_remove_bake_manual_review",
        include_str!("migrations/028_remove_bake_manual_review.sql"),
    ),
    (
        "029_rename_capture_knowledge_id_to_timeline_id",
        include_str!("migrations/029_rename_capture_knowledge_id_to_timeline_id.sql"),
    ),
    (
        "030_archive_legacy_bake_article_timelines",
        include_str!("migrations/030_archive_legacy_bake_article_timelines.sql"),
    ),
    (
        "031_ensure_full_schema",
        include_str!("migrations/031_ensure_full_schema.sql"),
    ),
    (
        "032_restore_bake_article_from_legacy",
        include_str!("migrations/032_restore_bake_article_from_legacy.sql"),
    ),
    (
        "033_drop_bake_episodic_memory_id",
        include_str!("migrations/033_drop_bake_episodic_memory_id.sql"),
    ),
    (
        "034_create_creation_history",
        include_str!("migrations/034_create_creation_history.sql"),
    ),
    (
        "035_seed_privacy_defaults",
        include_str!("migrations/035_seed_privacy_defaults.sql"),
    ),
    (
        "036_seed_capture_retention_days",
        include_str!("migrations/036_seed_capture_retention_days.sql"),
    ),
];

// ─────────────────────────────────────────────────────────────────────────────
// StorageManager
// ─────────────────────────────────────────────────────────────────────────────

/// 持有 SQLite 连接的核心管理器。
///
/// 设计为可跨线程共享（`Clone` 复制的是 `Arc`，不复制连接本身）。
#[derive(Clone)]
pub struct StorageManager {
    pub(crate) conn: Arc<Mutex<Connection>>,
}

impl StorageManager {
    // ── 初始化 ───────────────────────────────────────────────────────────────

    /// 打开（或创建）数据库，执行所有待执行的迁移，返回管理器实例。
    ///
    /// `db_path` 通常为 `~/.memory-bread/memory-bread.db`。
    pub fn open(db_path: &Path) -> Result<Self, StorageError> {
        // 确保父目录存在
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| StorageError::MigrationFailed {
                version: "open",
                reason: e.to_string(),
            })?;
        }

        let conn = Connection::open(db_path)?;
        Self::configure_connection(&conn)?;

        let mgr = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        mgr.run_migrations()?;
        mgr.with_conn(|conn| {
            conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
            Ok(())
        })?;

        info!("StorageManager 初始化完成: {}", db_path.display());
        Ok(mgr)
    }

    /// 打开内存数据库（仅用于测试）。
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory()?;
        Self::configure_connection(&conn)?;
        let mgr = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        mgr.run_migrations()?;
        Ok(mgr)
    }

    // ── 连接配置 ─────────────────────────────────────────────────────────────

    fn configure_connection(conn: &Connection) -> Result<(), StorageError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous   = NORMAL;
             PRAGMA temp_store    = MEMORY;
             PRAGMA mmap_size     = 268435456;", // 256 MB mmap，提升读性能
        )?;
        debug!("SQLite PRAGMA 配置完成");
        Ok(())
    }

    // ── 迁移执行 ─────────────────────────────────────────────────────────────

    fn run_migrations(&self) -> Result<(), StorageError> {
        let conn = self.conn.lock()?;

        // 确保迁移记录表存在（迁移前的最小依赖）
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version    TEXT    PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
        )?;

        for (version, sql) in MIGRATIONS {
            let already_applied: bool = conn.query_row(
                "SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1",
                rusqlite::params![version],
                |row| row.get(0),
            )?;

            if already_applied {
                debug!("迁移 {} 已执行，跳过", version);
                continue;
            }

            if *version == "019_rename_to_timelines"
                && self.timelines_table_already_exists(&conn)?
            {
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                    rusqlite::params![version, current_ts_ms()],
                )?;
                info!("迁移 {} 已由现有 schema 满足，登记后跳过", version);
                continue;
            }

            if *version == "029_rename_capture_knowledge_id_to_timeline_id"
                && self.capture_timeline_column_already_renamed(&conn)?
            {
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                    rusqlite::params![version, current_ts_ms()],
                )?;
                info!("迁移 {} 已由现有 schema 满足，登记后跳过", version);
                continue;
            }

            if *version == "033_drop_bake_episodic_memory_id"
                && self.bake_legacy_memory_columns_already_dropped(&conn)?
            {
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                    rusqlite::params![version, current_ts_ms()],
                )?;
                info!("迁移 {} 已由现有 schema 满足，登记后跳过", version);
                continue;
            }

            if *version == "031_ensure_full_schema" {
                self.run_ensure_full_schema(&conn)?;
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
                    rusqlite::params![version],
                    |row| row.get(0),
                )?;
                if count == 0 {
                    conn.execute(
                        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                        rusqlite::params![version, current_ts_ms()],
                    )?;
                }
                info!("迁移 {} 执行成功", version);
                continue;
            }

            info!("执行迁移: {}", version);
            conn.execute_batch(sql)
                .map_err(|e| StorageError::MigrationFailed {
                    version,
                    reason: e.to_string(),
                })?;

            // 如果迁移 SQL 本身没有插入迁移记录，这里补插
            // （001_init.sql 末尾已有 INSERT，此处做幂等保护）
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
                rusqlite::params![version],
                |row| row.get(0),
            )?;
            if count == 0 {
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                    rusqlite::params![version, current_ts_ms()],
                )?;
            }

            info!("迁移 {} 执行成功", version);
        }

        Ok(())
    }

    fn has_column(conn: &Connection, table: &str, col: &str) -> Result<bool, StorageError> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            rusqlite::params![table, col],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    fn add_column_if_missing(
        conn: &Connection,
        table: &str,
        col: &str,
        col_def: &str,
    ) -> Result<(), StorageError> {
        if !Self::has_column(conn, table, col)? {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {col_def};"))?;
        }
        Ok(())
    }

    fn run_ensure_full_schema(&self, conn: &Connection) -> Result<(), StorageError> {
        // timelines 补列
        Self::add_column_if_missing(conn, "timelines", "created_at_ms", "INTEGER")?;
        Self::add_column_if_missing(conn, "timelines", "updated_at_ms", "INTEGER")?;
        Self::add_column_if_missing(conn, "timelines", "time_range_start", "INTEGER")?;
        Self::add_column_if_missing(conn, "timelines", "time_range_end", "INTEGER")?;
        Self::add_column_if_missing(conn, "timelines", "key_timestamps", "TEXT")?;

        // captures 补列
        Self::add_column_if_missing(conn, "captures", "url", "TEXT")?;
        Self::add_column_if_missing(conn, "captures", "webpage_title", "TEXT")?;
        Self::add_column_if_missing(conn, "captures", "screenshot_source", "TEXT")?;
        Self::add_column_if_missing(conn, "captures", "timeline_id", "INTEGER")?;

        // bake_knowledge 补列
        Self::add_column_if_missing(conn, "bake_knowledge", "detailed_content", "TEXT")?;
        Self::add_column_if_missing(conn, "bake_knowledge", "document_id", "INTEGER")?;
        Self::add_column_if_missing(conn, "bake_knowledge", "section_ids", "TEXT DEFAULT '[]'")?;
        Self::add_column_if_missing(
            conn,
            "bake_knowledge",
            "source_timeline_ids",
            "TEXT DEFAULT '[]'",
        )?;
        Self::add_column_if_missing(
            conn,
            "bake_knowledge",
            "source_capture_ids",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        // 023 迁移可能未真正执行：episodic_memory_id → timeline_id
        if Self::has_column(conn, "bake_knowledge", "episodic_memory_id")?
            && !Self::has_column(conn, "bake_knowledge", "timeline_id")?
        {
            conn.execute_batch(
                "ALTER TABLE bake_knowledge ADD COLUMN timeline_id INTEGER;
                 UPDATE bake_knowledge SET timeline_id = episodic_memory_id WHERE timeline_id IS NULL;",
            )?;
        }

        // 023 迁移可能未真正执行：template_created_count → design_created_count
        if Self::has_column(conn, "bake_runs", "template_created_count")?
            && !Self::has_column(conn, "bake_runs", "design_created_count")?
        {
            conn.execute_batch(
                "ALTER TABLE bake_runs ADD COLUMN design_created_count INTEGER NOT NULL DEFAULT 0;
                 UPDATE bake_runs SET design_created_count = template_created_count WHERE design_created_count = 0;",
            )?;
        }

        // bake_sops 补列
        Self::add_column_if_missing(conn, "bake_sops", "timeline_id", "INTEGER")?;
        Self::add_column_if_missing(conn, "bake_sops", "detailed_content", "TEXT")?;
        Self::add_column_if_missing(conn, "bake_sops", "source_capture_ids", "TEXT DEFAULT '[]'")?;

        // vector_index 补列
        Self::add_column_if_missing(conn, "vector_index", "document_id", "INTEGER")?;
        Self::add_column_if_missing(conn, "vector_index", "section_id", "INTEGER")?;

        // 缺失的表（CREATE TABLE IF NOT EXISTS 本身幂等，直接执行 SQL 片段）
        conn.execute_batch(include_str!("migrations/031_ensure_full_schema.sql"))?;

        Ok(())
    }

    fn timelines_table_already_exists(&self, conn: &Connection) -> Result<bool, StorageError> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='timelines'",
            [],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    fn capture_timeline_column_already_renamed(
        &self,
        conn: &Connection,
    ) -> Result<bool, StorageError> {
        let mut stmt = conn.prepare("PRAGMA table_info(captures)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        let has_timeline_id = columns.iter().any(|name| name == "timeline_id");
        let has_knowledge_id = columns.iter().any(|name| name == "knowledge_id");
        Ok(has_timeline_id && !has_knowledge_id)
    }

    fn bake_legacy_memory_columns_already_dropped(
        &self,
        conn: &Connection,
    ) -> Result<bool, StorageError> {
        Ok(Self::has_column(conn, "bake_knowledge", "timeline_id")?
            && !Self::has_column(conn, "bake_knowledge", "episodic_memory_id")?
            && Self::has_column(conn, "bake_sops", "timeline_id")?
            && !Self::has_column(conn, "bake_sops", "episodic_memory_id")?)
    }

    // ── 工具方法 ─────────────────────────────────────────────────────────────

    /// 在持有连接锁的情况下执行一个同步闭包。
    ///
    /// 所有 repo 方法都通过此函数访问连接，避免到处 `lock().unwrap()`。
    pub fn with_conn<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&Connection) -> Result<T, StorageError>,
    {
        let conn = self.conn.lock()?;
        f(&conn)
    }

    /// 将同步 `with_conn` 包装为 async，内部使用 `spawn_blocking`。
    ///
    /// 调用者传入的闭包在独立线程池线程上执行，不会阻塞 tokio 运行时。
    pub async fn with_conn_async<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&Connection) -> Result<T, StorageError> + Send + 'static,
        T: Send + 'static,
    {
        let conn_arc = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn_arc.lock()?;
            f(&conn)
        })
        .await?
    }

    /// 获取数据库文件路径（用于调试和统计）。
    pub fn db_path(&self) -> String {
        self.with_conn(|conn| {
            conn.path()
                .map(|p| p.to_string())
                .ok_or_else(|| StorageError::NotFound("数据库路径".to_string()))
        })
        .unwrap_or_else(|_| ":memory:".to_string())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

pub fn current_ts_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
