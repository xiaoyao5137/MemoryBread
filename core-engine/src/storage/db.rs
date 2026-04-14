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
    ("001_init",                  include_str!("migrations/001_init.sql")),
    ("002_seed_defaults",         include_str!("migrations/002_seed_defaults.sql")),
    ("003_views",                 include_str!("migrations/003_views.sql")),
    ("004_captures_knowledge_id", include_str!("../../../shared/db-schema/migrations/004_captures_knowledge_id.sql")),
    ("005_monitor_tables",        include_str!("../../../shared/db-schema/migrations/005_monitor_tables.sql")),
    ("006_monitor_metric_scopes", include_str!("../../../shared/db-schema/migrations/006_monitor_metric_scopes.sql")),
    ("007_vector_index_rag_metadata", include_str!("../../../shared/db-schema/migrations/007_vector_index_rag_metadata.sql")),
    ("008_knowledge_semantic_metadata", include_str!("../../../shared/db-schema/migrations/008_knowledge_semantic_metadata.sql")),
    ("009_bake_templates", include_str!("migrations/009_bake_templates.sql")),
    ("010_knowledge_entries", include_str!("migrations/010_knowledge_entries.sql")),
    ("011_bake_pipeline", include_str!("migrations/011_bake_pipeline.sql")),
    ("012_fix_knowledge_fts_triggers", include_str!("migrations/012_fix_knowledge_fts_triggers.sql")),
    ("013_rebuild_knowledge_fts", include_str!("migrations/013_rebuild_knowledge_fts.sql")),
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
            std::fs::create_dir_all(parent).map_err(|e| {
                StorageError::MigrationFailed {
                    version: "open",
                    reason:  e.to_string(),
                }
            })?;
        }

        let conn = Connection::open(db_path)?;
        Self::configure_connection(&conn)?;

        let mgr = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        mgr.run_migrations()?;

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

            info!("执行迁移: {}", version);
            conn.execute_batch(sql).map_err(|e| StorageError::MigrationFailed {
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
