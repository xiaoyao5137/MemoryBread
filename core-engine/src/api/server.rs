//! axum Router 组装与服务启动

use std::sync::Arc;

use axum::{
    routing::{get, post, put},
    Router,
};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use super::{
    handlers::{
        action::execute_action,
        captures::list_captures,
        debug::{system_stats, vector_status},
        health::health_handler,
        knowledge::{delete_knowledge, list_knowledge, verify_knowledge},
        monitor::{monitor_overview, monitor_system},
        pii::pii_scrub,
        preferences::{list_preferences, update_preference},
        query::rag_query,
        tasks::{create_task, delete_task, get_task, list_executions, list_tasks, trigger_task, update_task},
    },
    state::AppState,
};

/// 构造 axum Router（不启动监听）。
///
/// 测试中直接使用此函数构造 router，无需真实 TCP 端口。
pub fn create_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/health",                get(health_handler))
        .route("/api/captures",          get(list_captures))
        .route("/captures",              get(list_captures))
        .route("/query",                 post(rag_query))
        .route("/action/execute",        post(execute_action))
        .route("/preferences",           get(list_preferences))
        .route("/preferences/:key",      put(update_preference))
        .route("/pii/scrub",             post(pii_scrub))
        .route("/api/vector/status",     get(vector_status))
        .route("/api/stats",             get(system_stats))
        .route("/api/knowledge",         get(list_knowledge))
        .route("/api/knowledge/:id/verify", post(verify_knowledge))
        .route("/api/knowledge/:id",     axum::routing::delete(delete_knowledge))
        // 定时任务
        .route("/api/tasks",             get(list_tasks).post(create_task))
        .route("/api/tasks/:id",         get(get_task).put(update_task).delete(delete_task))
        .route("/api/tasks/:id/executions", get(list_executions))
        .route("/api/tasks/:id/trigger", post(trigger_task))
        // 监控
        .route("/api/monitor/overview",  get(monitor_overview))
        .route("/api/monitor/system",    get(monitor_system))
        .layer(cors)
        .with_state(state)
}

/// 启动 HTTP 服务器（绑定到 addr，阻塞直到关闭）。
///
/// `addr` 默认为 `"127.0.0.1:7070"`。
pub async fn start_server(
    state: Arc<AppState>,
    addr:  &str,
) -> anyhow::Result<()> {
    let app      = create_router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("WorkBuddy API 服务已启动，监听地址: http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
