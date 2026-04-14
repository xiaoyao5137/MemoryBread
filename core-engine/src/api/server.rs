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
        bake::{
            adopt_bake_sop,
            create_bake_template,
            delete_bake_knowledge,
            delete_bake_sop,
            delete_bake_template,
            get_bake_capture,
            get_bake_capture_screenshot,
            get_bake_memory_preview,
            get_bake_overview,
            get_bake_style_config,
            ignore_bake_knowledge,
            ignore_bake_memory,
            ignore_bake_sop,
            initialize_bake_memories,
            list_bake_memories,
            list_bake_captures,
            list_bake_knowledge,
            list_bake_sops,
            list_bake_templates,
            promote_bake_memory_to_sop,
            promote_bake_memory_to_template,
            run_bake_pipeline,
            toggle_bake_template_status,
            update_bake_style_config,
            update_bake_template,
        },
        captures::list_captures,
        debug::{clear_extraction_queue, debug_log_content, debug_log_files, system_stats, vector_status},
        health::health_handler,
        knowledge::{delete_knowledge, extract_knowledge, list_knowledge, verify_knowledge},
        monitor::{monitor_overview, monitor_system},
        pii::pii_scrub,
        preferences::{list_preferences, run_screenshot_cleanup_now, update_preference},
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
        .route("/preferences/screenshot-cleanup/run", post(run_screenshot_cleanup_now))
        .route("/preferences/:key",      put(update_preference))
        .route("/pii/scrub",             post(pii_scrub))
        .route("/api/vector/status",     get(vector_status))
        .route("/api/stats",             get(system_stats))
        .route("/api/debug/log-files", get(debug_log_files))
        .route("/api/debug/log-files/:key", get(debug_log_content))
        .route("/api/debug/clear-extraction-queue", post(clear_extraction_queue))
        .route("/api/knowledge",         get(list_knowledge))
        .route("/api/knowledge/extract", post(extract_knowledge))
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
        .route("/api/bake/overview",    get(get_bake_overview))
        .route("/api/bake/run",         post(run_bake_pipeline))
        .route("/api/bake/style-config", get(get_bake_style_config).put(update_bake_style_config))
        .route("/api/bake/templates",   get(list_bake_templates).post(create_bake_template))
        .route("/api/bake/templates/:id", put(update_bake_template).delete(delete_bake_template))
        .route("/api/bake/templates/:id/toggle-status", post(toggle_bake_template_status))
        .route("/api/bake/sops",        get(list_bake_sops))
        .route("/api/bake/sops/:id",    axum::routing::delete(delete_bake_sop))
        .route("/api/bake/sops/:id/adopt", post(adopt_bake_sop))
        .route("/api/bake/sops/:id/ignore", post(ignore_bake_sop))
        .route("/api/bake/articles",    get(list_bake_memories))
        .route("/api/bake/memories",    get(list_bake_memories))
        .route("/api/bake/knowledge",   get(list_bake_knowledge))
        .route("/api/bake/knowledge/:id", axum::routing::delete(delete_bake_knowledge))
        .route("/api/bake/knowledge/:id/ignore", post(ignore_bake_knowledge))
        .route("/api/bake/captures",    get(list_bake_captures))
        .route("/api/bake/captures/:id", get(get_bake_capture))
        .route("/api/bake/captures/:id/screenshot", get(get_bake_capture_screenshot))
        .route("/api/bake/articles/init", post(initialize_bake_memories))
        .route("/api/bake/memories/init", post(initialize_bake_memories))
        .route("/api/bake/articles/:id/ignore", post(ignore_bake_memory))
        .route("/api/bake/memories/:id/ignore", post(ignore_bake_memory))
        .route("/api/bake/articles/:id/promote-template", post(promote_bake_memory_to_template))
        .route("/api/bake/memories/:id/promote-template", post(promote_bake_memory_to_template))
        .route("/api/bake/articles/:id/promote-sop", post(promote_bake_memory_to_sop))
        .route("/api/bake/memories/:id/promote-sop", post(promote_bake_memory_to_sop))
        .route("/api/bake/articles/:id/preview", get(get_bake_memory_preview))
        .route("/api/bake/memories/:id/preview", get(get_bake_memory_preview))
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
    info!("记忆面包 API 服务已启动，监听地址: http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
