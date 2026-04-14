//! 监控 API 处理器
//!
//! GET /api/monitor/overview?range=7d
//! 聚合返回：token 用量、采集流水、问答记录、定时任务执行

use std::collections::HashSet;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use chrono::{Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::api::{error::ApiError, state::AppState};

const SELF_GENERATED_APP_KEYWORDS: [&str; 2] = [
    "memory-bread",
    "记忆面包",
];
const SELF_GENERATED_WINDOW_KEYWORDS: [&str; 5] = [
    "memory-bread",
    "记忆面包",
    "KnowledgePanel",
    "MonitorPanel",
    "RagPanel",
];
const FALLBACK_NOISE_OVERVIEW_PREFIX: &str = "低价值工作片段（";
const SYSTEM_SCOPE: &str = "system_global";
const SUITE_SCOPE: &str = "app_suite_total";
const MODEL_SCOPE: &str = "model_process_total";
const MODEL_SERIES_SCOPE: &str = "model_runtime_series";

fn build_not_like_clause(column: &str, keywords: &[&str]) -> String {
    keywords
        .iter()
        .map(|keyword| format!("LOWER({column}) NOT LIKE '%{}%'", keyword.to_lowercase()))
        .collect::<Vec<_>>()
        .join(" AND ")
}

// ── 请求参数 ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct MonitorQuery {
    /// 时间范围：1d | 7d | 30d，默认 7d
    #[serde(default = "default_range")]
    pub range: String,
}

fn default_range() -> String { "7d".to_string() }

fn range_to_ms(range: &str) -> i64 {
    let days: i64 = match range {
        "1d"  => 1,
        "30d" => 30,
        _     => 7,
    };
    days * 24 * 3600 * 1000
}

fn local_day_start_ms(now_ms: i64) -> i64 {
    let now_local = chrono::DateTime::<Utc>::from_timestamp_millis(now_ms)
        .map(|dt| dt.with_timezone(&Local))
        .unwrap_or_else(Local::now);
    let naive_start = now_local.date_naive().and_hms_opt(0, 0, 0).unwrap();
    Local
        .from_local_datetime(&naive_start)
        .earliest()
        .or_else(|| Local.from_local_datetime(&naive_start).latest())
        .unwrap_or(now_local)
        .with_timezone(&Utc)
        .timestamp_millis()
}

fn trend_bucket_ms(range: &str) -> i64 {
    match range {
        "1d" => 60 * 1000,
        "30d" => 24 * 60 * 60 * 1000,
        _ => 6 * 60 * 60 * 1000,
    }
}

fn knowledge_bucket_ms(range: &str) -> i64 {
    match range {
        "1d" => 60 * 1000,
        "30d" => 24 * 60 * 60 * 1000,
        _ => 60 * 60 * 1000,
    }
}

fn system_bucket_ms(range: &str) -> i64 {
    match range {
        "1h" => 60 * 1000,
        "6h" => 3 * 60 * 1000,
        "24h" => 60 * 1000,
        "1d" => 60 * 1000,
        _ => 60 * 1000,
    }
}

fn bucket_label(range: &str, bucket_start_ms: i64) -> String {
    let local_dt = chrono::DateTime::<Utc>::from_timestamp_millis(bucket_start_ms)
        .map(|dt| dt.with_timezone(&Local))
        .unwrap_or_else(Local::now);
    match range {
        "1d" => local_dt.format("%H:%M").to_string(),
        _ => local_dt.format("%m-%d").to_string(),
    }
}

// ── 响应结构 ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MonitorOverview {
    pub db_size_bytes:   i64,
    pub capture_total_count: i64,
    pub token_usage:     TokenUsage,
    pub capture_flow:    CaptureFlow,
    pub knowledge_flow:  KnowledgeFlow,
    pub rag_sessions:    RagSessionStats,
    pub task_executions: TaskExecutionStats,
}

#[derive(Debug, Serialize)]
pub struct TokenUsage {
    pub total_period:    i64,
    pub total_today:     i64,
    pub by_model:        Vec<ModelUsage>,
    pub by_caller:       Vec<CallerUsage>,
    pub trend:           Vec<DayTrend>,
}

#[derive(Debug, Serialize)]
pub struct ModelUsage {
    pub model:  String,
    pub total:  i64,
    pub calls:  i64,
}

#[derive(Debug, Serialize)]
pub struct CallerUsage {
    pub caller: String,
    pub total:  i64,
    pub calls:  i64,
}

#[derive(Debug, Serialize)]
pub struct DayTrend {
    pub ts:    i64,
    pub date:   String,
    pub tokens: i64,
    pub calls:  i64,
}

#[derive(Debug, Serialize)]
pub struct CaptureFlow {
    pub today_count:                i64,
    pub period_count:               i64,
    pub eligible_count:             i64,
    pub vectorized_count:           i64,
    pub vectorization_rate:         f64,
    pub knowledge_generated_count:  i64,
    pub knowledge_generation_rate:  f64,
    pub knowledge_linked_count:     i64,
    pub knowledge_rate:             f64,
    pub by_hour:                    Vec<HourCount>,
    pub by_app:                     Vec<AppCount>,
    pub recent:                     Vec<CaptureItem>,
}

#[derive(Debug, Serialize)]
pub struct CaptureItem {
    pub id:        i64,
    pub ts:        i64,
    pub app_name:  String,
    pub win_title: String,
}

#[derive(Debug, Serialize)]
pub struct HourCount {
    pub hour:  i64,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct AppCount {
    pub app:   String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct KnowledgeFlow {
    pub today_count: i64,
    pub period_count: i64,
    pub pending_extraction_count: i64,
    pub by_time: Vec<KnowledgeTimePoint>,
    pub recent: Vec<KnowledgeItem>,
}

#[derive(Debug, Serialize, Clone)]
pub struct KnowledgeTimePoint {
    pub ts: i64,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct KnowledgeItem {
    pub id: i64,
    pub ts: i64,
    pub summary: String,
    pub category: String,
    pub importance: i64,
    pub app_name: String,
    pub win_title: String,
}

#[derive(Debug, Serialize)]
pub struct RagSessionStats {
    pub today_count:   i64,
    pub period_count:  i64,
    pub avg_latency_ms: i64,
    pub recent:        Vec<RagSessionItem>,
}

#[derive(Debug, Serialize)]
pub struct RagSessionItem {
    pub id:            i64,
    pub ts:            i64,
    pub query:         String,
    pub latency_ms:    Option<i64>,
    pub context_count: i64,
}

#[derive(Debug, Serialize)]
pub struct TaskExecutionStats {
    pub total:        i64,
    pub success:      i64,
    pub failed:       i64,
    pub success_rate: f64,
    pub recent:       Vec<TaskExecutionItem>,
}

#[derive(Debug, Serialize)]
pub struct TaskExecutionItem {
    pub id:              i64,
    pub task_name:       String,
    pub status:          String,
    pub started_at:      i64,
    pub latency_ms:      Option<i64>,
    pub knowledge_count: Option<i64>,
}

/// GET /api/monitor/overview
pub async fn monitor_overview(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MonitorQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let now_ms   = Utc::now().timestamp_millis();
    let range_ms = range_to_ms(&params.range);
    let from_ms  = now_ms - range_ms;
    let today_start = local_day_start_ms(now_ms);
    let token_bucket_ms = trend_bucket_ms(&params.range);
    let knowledge_bucket_ms = knowledge_bucket_ms(&params.range);
    let fallback_noise_pattern = format!("{}%", FALLBACK_NOISE_OVERVIEW_PREFIX);

    let overview = state.storage.with_conn_async(move |conn| {
        let db_size_bytes = conn.query_row("PRAGMA page_count", [], |r| r.get::<_, i64>(0)).unwrap_or(0)
            * conn.query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        let capture_total_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures",
            [],
            |r| r.get(0),
        ).unwrap_or(0);

        let total_period: i64 = conn.query_row(
            "SELECT COALESCE(SUM(total_tokens), 0) FROM llm_usage_logs WHERE ts >= ?1",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);

        let total_today: i64 = conn.query_row(
            "SELECT COALESCE(SUM(total_tokens), 0) FROM llm_usage_logs WHERE ts >= ?1",
            rusqlite::params![today_start],
            |r| r.get(0),
        ).unwrap_or(0);

        let mut by_model_stmt = conn.prepare(
            "SELECT model_name, COALESCE(SUM(total_tokens),0), COUNT(*)
             FROM llm_usage_logs WHERE ts >= ?1
             GROUP BY model_name ORDER BY COALESCE(SUM(total_tokens),0) DESC LIMIT 8"
        )?;
        let by_model = by_model_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(ModelUsage {
                    model: r.get::<_, String>(0)?,
                    total: r.get::<_, i64>(1)?,
                    calls: r.get::<_, i64>(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut by_caller_stmt = conn.prepare(
            "SELECT caller, COALESCE(SUM(total_tokens),0), COUNT(*)
             FROM llm_usage_logs WHERE ts >= ?1
             GROUP BY caller ORDER BY COALESCE(SUM(total_tokens),0) DESC LIMIT 8"
        )?;
        let by_caller = by_caller_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(CallerUsage {
                    caller: r.get::<_, String>(0)?,
                    total: r.get::<_, i64>(1)?,
                    calls: r.get::<_, i64>(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut trend_stmt = conn.prepare(
            "SELECT (ts / ?1) * ?1 as bucket, COALESCE(SUM(total_tokens),0), COUNT(*)
             FROM llm_usage_logs WHERE ts >= ?2
             GROUP BY bucket ORDER BY bucket"
        )?;
        let trend = trend_stmt
            .query_map(rusqlite::params![token_bucket_ms, from_ms], |r| {
                let bucket_start: i64 = r.get(0)?;
                Ok(DayTrend {
                    ts: bucket_start + token_bucket_ms / 2,
                    date: bucket_label(&params.range, bucket_start),
                    tokens: r.get::<_, i64>(1)?,
                    calls: r.get::<_, i64>(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let today_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE ts >= ?1",
            rusqlite::params![today_start],
            |r| r.get(0),
        ).unwrap_or(0);
        let period_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE ts >= ?1",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);
        let eligible_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE ts >= ?1 AND (is_noise IS NULL OR is_noise = 0)",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);
        let vectorized_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE ts >= ?1 AND vector_status = 'done'",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);
        let knowledge_generated_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE ts >= ?1 AND knowledge_id IS NOT NULL",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);
        let knowledge_linked_count = knowledge_generated_count;
        let vectorization_rate = if eligible_count > 0 {
            vectorized_count as f64 / eligible_count as f64
        } else { 0.0 };
        let knowledge_generation_rate = if eligible_count > 0 {
            knowledge_generated_count as f64 / eligible_count as f64
        } else { 0.0 };
        let knowledge_rate = knowledge_generation_rate;

        let mut by_hour_stmt = conn.prepare(
            "SELECT CAST(strftime('%H', datetime(ts/1000, 'unixepoch', 'localtime')) AS INTEGER), COUNT(*)
             FROM captures WHERE ts >= ?1
             GROUP BY 1 ORDER BY 1"
        )?;
        let by_hour = by_hour_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(HourCount { hour: r.get(0)?, count: r.get(1)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut by_app_stmt = conn.prepare(
            "SELECT COALESCE(app_name, '未知'), COUNT(*)
             FROM captures WHERE ts >= ?1
             GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 8"
        )?;
        let by_app = by_app_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(AppCount { app: r.get(0)?, count: r.get(1)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut recent_capture_stmt = conn.prepare(
            "SELECT id, ts, COALESCE(app_name, ''), COALESCE(win_title, '')
             FROM captures WHERE ts >= ?1 ORDER BY ts DESC LIMIT 10"
        )?;
        let recent = recent_capture_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(CaptureItem {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    app_name: r.get(2)?,
                    win_title: r.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let app_not_like = build_not_like_clause("c.app_name", &SELF_GENERATED_APP_KEYWORDS);
        let win_not_like = build_not_like_clause("c.win_title", &SELF_GENERATED_WINDOW_KEYWORDS);

        let knowledge_today_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM knowledge_entries WHERE created_at >= datetime(?1/1000, 'unixepoch') AND summary NOT LIKE ?2",
            rusqlite::params![today_start, fallback_noise_pattern.as_str()],
            |r| r.get(0),
        ).unwrap_or(0);
        let knowledge_period_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM knowledge_entries WHERE created_at >= datetime(?1/1000, 'unixepoch') AND summary NOT LIKE ?2",
            rusqlite::params![from_ms, fallback_noise_pattern.as_str()],
            |r| r.get(0),
        ).unwrap_or(0);
        let pending_extraction_count_sql = format!(
            "SELECT COUNT(*) FROM captures c
             WHERE ((c.ocr_text IS NOT NULL AND c.ocr_text != '')
                OR (c.ax_text IS NOT NULL AND c.ax_text != ''))
               AND c.knowledge_id IS NULL
               AND c.is_sensitive = 0
               AND ({app_not_like})
               AND ({win_not_like})"
        );
        let pending_extraction_count: i64 = conn.query_row(
            &pending_extraction_count_sql,
            [],
            |r| r.get(0),
        ).unwrap_or(0);

        let mut knowledge_by_time_stmt = conn.prepare(
            "SELECT (CAST(strftime('%s', created_at) AS INTEGER) * 1000 / ?1) * ?1 + ?1/2 as bucket, COUNT(*)
             FROM knowledge_entries
             WHERE created_at >= datetime(?2/1000, 'unixepoch')
               AND summary NOT LIKE ?3
             GROUP BY bucket ORDER BY bucket"
        )?;
        let knowledge_by_time = knowledge_by_time_stmt
            .query_map(rusqlite::params![knowledge_bucket_ms, from_ms, fallback_noise_pattern.as_str()], |r| {
                Ok(KnowledgeTimePoint { ts: r.get(0)?, count: r.get(1)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut recent_knowledge_stmt = conn.prepare(
            "SELECT id,
                    CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                    COALESCE(summary, ''),
                    COALESCE(category, ''),
                    COALESCE(importance, 0),
                    COALESCE(frag_app_name, ''),
                    COALESCE(frag_win_title, '')
             FROM knowledge_entries
             WHERE created_at >= datetime(?1/1000, 'unixepoch')
               AND summary NOT LIKE ?2
             ORDER BY created_at DESC LIMIT 10"
        )?;
        let knowledge_recent = recent_knowledge_stmt
            .query_map(rusqlite::params![from_ms, fallback_noise_pattern.as_str()], |r| {
                Ok(KnowledgeItem {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    summary: r.get(2)?,
                    category: r.get(3)?,
                    importance: r.get(4)?,
                    app_name: r.get(5)?,
                    win_title: r.get(6)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let rag_today_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM rag_sessions WHERE ts >= ?1",
            rusqlite::params![today_start],
            |r| r.get(0),
        ).unwrap_or(0);
        let rag_period_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM rag_sessions WHERE ts >= ?1",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);
        let avg_latency_ms: i64 = conn.query_row(
            "SELECT COALESCE(AVG(latency_ms), 0) FROM rag_sessions WHERE ts >= ?1 AND latency_ms IS NOT NULL",
            rusqlite::params![from_ms],
            |r| r.get::<_, f64>(0).map(|v| v.round() as i64),
        ).unwrap_or(0);

        let mut rag_recent_stmt = conn.prepare(
            "SELECT id, ts, COALESCE(user_query, ''), latency_ms,
                    COALESCE(json_array_length(retrieved_ids), 0)
             FROM rag_sessions WHERE ts >= ?1 ORDER BY ts DESC LIMIT 10"
        )?;
        let rag_recent = rag_recent_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(RagSessionItem {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    query: r.get(2)?,
                    latency_ms: r.get(3)?,
                    context_count: r.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let total_exec: i64 = conn.query_row(
            "SELECT COUNT(*) FROM task_executions WHERE started_at >= ?1",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);
        let success_exec: i64 = conn.query_row(
            "SELECT COUNT(*) FROM task_executions WHERE started_at >= ?1 AND status = 'success'",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);
        let failed_exec = total_exec.saturating_sub(success_exec);
        let success_rate = if total_exec > 0 {
            success_exec as f64 * 100.0 / total_exec as f64
        } else { 0.0 };

        let mut exec_recent_stmt = conn.prepare(
            "SELECT te.id, COALESCE(st.name, ''), COALESCE(te.status, ''), te.started_at, te.latency_ms, te.knowledge_count
             FROM task_executions te
             LEFT JOIN scheduled_tasks st ON st.id = te.task_id
             WHERE te.started_at >= ?1
             ORDER BY te.started_at DESC LIMIT 10"
        )?;
        let recent_exec = exec_recent_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(TaskExecutionItem {
                    id: r.get(0)?,
                    task_name: r.get(1)?,
                    status: r.get(2)?,
                    started_at: r.get(3)?,
                    latency_ms: r.get(4)?,
                    knowledge_count: r.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(MonitorOverview {
            db_size_bytes,
            capture_total_count,
            token_usage: TokenUsage {
                total_period,
                total_today,
                by_model,
                by_caller,
                trend,
            },
            capture_flow: CaptureFlow {
                today_count,
                period_count,
                eligible_count,
                vectorized_count,
                vectorization_rate,
                knowledge_generated_count,
                knowledge_generation_rate,
                knowledge_linked_count,
                knowledge_rate,
                by_hour,
                by_app,
                recent,
            },
            knowledge_flow: KnowledgeFlow {
                today_count: knowledge_today_count,
                period_count: knowledge_period_count,
                pending_extraction_count,
                by_time: knowledge_by_time,
                recent: knowledge_recent,
            },
            rag_sessions: RagSessionStats {
                today_count: rag_today_count,
                period_count: rag_period_count,
                avg_latency_ms,
                recent: rag_recent,
            },
            task_executions: TaskExecutionStats {
                total: total_exec,
                success: success_exec,
                failed: failed_exec,
                success_rate,
                recent: recent_exec,
            },
        })
    }).await?;

    Ok(Json(overview))
}

// ── 系统资源响应结构 ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SystemResourcesResponse {
    pub db_size_bytes: i64,
    pub trends: ResourceTrends,
    pub gpu_trend: Vec<MetricPoint>,
    pub model_gpu_trend: Vec<MetricPoint>,
    pub disk_trend: Vec<DiskPoint>,
    pub knowledge_events: Vec<KnowledgeTimePoint>,
    pub model_events: Vec<ModelEventItem>,
    pub model_runtime_breakdown: Vec<ModelRuntimeBreakdownItem>,
    pub latest: ResourceLatestBundle,
}

#[derive(Debug, Serialize)]
pub struct ResourceTrends {
    pub system_cpu: Vec<MetricPoint>,
    pub system_mem: Vec<MetricPoint>,
    pub suite_cpu: Vec<MetricPoint>,
    pub suite_mem: Vec<MetricPoint>,
    pub model_cpu: Vec<MetricPoint>,
    pub model_mem: Vec<MetricPoint>,
    pub model_cpu_series: Vec<NamedMetricSeries>,
    pub model_mem_series: Vec<NamedMetricSeries>,
    pub model_estimated_mem_series: Vec<NamedMetricSeries>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MetricPoint {
    pub ts: i64,
    pub value: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct NamedMetricSeries {
    pub key: String,
    pub label: String,
    pub points: Vec<MetricPoint>,
    pub process_names: Vec<String>,
    pub coverage_status: Option<String>,
    pub coverage_note: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiskPoint {
    pub ts: i64,
    pub read_mb: f64,
    pub write_mb: f64,
}

#[derive(Debug, Serialize)]
pub struct ModelEventItem {
    pub ts: i64,
    pub event_type: String,
    pub model_type: String,
    pub model_name: String,
    pub duration_ms: Option<i64>,
    pub memory_mb: Option<i64>,
    pub mem_before_mb: Option<i64>,
    pub mem_after_mb: Option<i64>,
    pub error_msg: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ModelRuntimeBreakdownItem {
    pub key: String,
    pub label: String,
    pub cpu_percent: f64,
    pub mem_process_mb: i64,
    pub process_count: usize,
    pub coverage_status: Option<String>,
    pub coverage_note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ResourceLatestBundle {
    pub system: Option<SystemLatestMetrics>,
    pub suite: Option<ScopedLatestMetrics>,
    pub model: Option<ScopedLatestMetrics>,
}

#[derive(Debug, Serialize)]
pub struct SystemLatestMetrics {
    pub cpu_total: f64,
    pub mem_total_mb: i64,
    pub mem_used_mb: i64,
    pub mem_percent: f64,
    pub gpu_percent: Option<f64>,
    pub gpu_name: Option<String>,
    pub gpu_total_label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ScopedLatestMetrics {
    pub cpu_percent: f64,
    pub mem_process_mb: i64,
    pub process_count: usize,
    pub process_names: Vec<String>,
    pub coverage_status: Option<String>,
    pub coverage_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SystemQuery {
    #[serde(default = "default_sys_range")]
    pub range: String,
}

fn default_sys_range() -> String { "6h".to_string() }

fn has_column(columns: &HashSet<String>, name: &str) -> bool {
    columns.contains(name)
}

fn runtime_label(key: &str) -> String {
    match key {
        "sidecar_local_runtime" => "AI Sidecar 本地运行时".to_string(),
        "model_api_runtime" => "Model API / RAG 运行时".to_string(),
        "ollama_runtime" => "Ollama".to_string(),
        _ => key.to_string(),
    }
}

fn sidecar_model_type_label(model_type: &str, model_name: &str) -> String {
    if model_name.contains('·') {
        return model_name.to_string();
    }
    match model_type {
        "ocr" => format!("OCR · {model_name}"),
        "embedding" => format!("Embedding · {model_name}"),
        "asr" => format!("ASR · {model_name}"),
        "vlm" => format!("VLM · {model_name}"),
        "llm" => format!("LLM · {model_name}"),
        _ => model_name.to_string(),
    }
}

fn has_scope_columns(columns: &HashSet<String>) -> bool {
    ["scope", "source", "target_pids_json", "coverage_status", "coverage_note"]
        .iter()
        .all(|column| has_column(columns, column))
}

fn downsample_metric_points(points: Vec<MetricPoint>, max_points: usize) -> Vec<MetricPoint> {
    if points.len() <= max_points || max_points == 0 {
        return points;
    }

    let last_index = points.len() - 1;
    let mut sampled = Vec::with_capacity(max_points + 1);
    for i in 0..max_points {
        let index = i * last_index / (max_points - 1).max(1);
        let point = points[index].clone();
        if sampled.last().map(|item: &MetricPoint| item.ts) != Some(point.ts) {
            sampled.push(point);
        }
    }
    if sampled.last().map(|item| item.ts) != Some(points[last_index].ts) {
        sampled.push(points[last_index].clone());
    }
    sampled
}

fn downsample_named_metric_series(series: Vec<NamedMetricSeries>, max_points: usize) -> Vec<NamedMetricSeries> {
    series
        .into_iter()
        .map(|mut item| {
            item.points = downsample_metric_points(item.points, max_points);
            item
        })
        .collect()
}

fn downsample_disk_points(points: Vec<DiskPoint>, max_points: usize) -> Vec<DiskPoint> {
    if points.len() <= max_points || max_points == 0 {
        return points;
    }

    let last_index = points.len() - 1;
    let mut sampled = Vec::with_capacity(max_points + 1);
    for i in 0..max_points {
        let index = i * last_index / (max_points - 1).max(1);
        let point = points[index].clone();
        if sampled.last().map(|item: &DiskPoint| item.ts) != Some(point.ts) {
            sampled.push(point);
        }
    }
    if sampled.last().map(|item| item.ts) != Some(points[last_index].ts) {
        sampled.push(points[last_index].clone());
    }
    sampled
}

fn downsample_knowledge_points(points: Vec<KnowledgeTimePoint>, max_points: usize) -> Vec<KnowledgeTimePoint> {
    if points.len() <= max_points || max_points == 0 {
        return points;
    }

    let last_index = points.len() - 1;
    let mut sampled = Vec::with_capacity(max_points + 1);
    for i in 0..max_points {
        let index = i * last_index / (max_points - 1).max(1);
        let point = points[index].clone();
        if sampled.last().map(|item: &KnowledgeTimePoint| item.ts) != Some(point.ts) {
            sampled.push(point);
        }
    }
    if sampled.last().map(|item| item.ts) != Some(points[last_index].ts) {
        sampled.push(points[last_index].clone());
    }
    sampled
}

fn scoped_metric_trend(
    conn: &rusqlite::Connection,
    scope: &str,
    metric_expr: &str,
    bucket_ms: i64,
    from_ms: i64,
) -> Result<Vec<MetricPoint>, rusqlite::Error> {
    let sql = format!(
        "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, AVG({metric_expr})
         FROM system_metrics
         WHERE ts >= ?2 AND scope = ?3
         GROUP BY bucket ORDER BY bucket"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms, scope], |r| {
        Ok(MetricPoint { ts: r.get(0)?, value: r.get(1)? })
    })?;
    let points = rows.filter_map(|r| r.ok()).collect();
    Ok(points)
}

fn scoped_metric_series(
    conn: &rusqlite::Connection,
    scope: &str,
    metric_expr: &str,
    bucket_ms: i64,
    from_ms: i64,
) -> Result<Vec<NamedMetricSeries>, rusqlite::Error> {
    let mut target_stmt = conn.prepare(
        "SELECT target_name, COALESCE(MAX(target_name), ''),
                COALESCE(MAX(coverage_status), ''), COALESCE(MAX(coverage_note), '')
         FROM system_metrics
         WHERE ts >= ?1 AND scope = ?2 AND target_name IS NOT NULL AND target_name != ''
         GROUP BY target_name
         ORDER BY MAX(mem_process_mb) DESC, target_name ASC"
    )?;
    let targets = target_stmt
        .query_map(rusqlite::params![from_ms, scope], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();

    let sql = format!(
        "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, AVG({metric_expr})
         FROM system_metrics
         WHERE ts >= ?2 AND scope = ?3 AND target_name = ?4
         GROUP BY bucket ORDER BY bucket"
    );

    let mut series = Vec::new();
    for (key, _label, coverage_status, coverage_note) in targets {
        let mut stmt = conn.prepare(&sql)?;
        let points = stmt
            .query_map(rusqlite::params![bucket_ms, from_ms, scope, key.as_str()], |r| {
                Ok(MetricPoint { ts: r.get(0)?, value: r.get(1)? })
            })?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        if points.is_empty() {
            continue;
        }
        series.push(NamedMetricSeries {
            key: key.clone(),
            label: runtime_label(&key),
            points,
            process_names: vec![runtime_label(&key)],
            coverage_status: if coverage_status.is_empty() { None } else { Some(coverage_status) },
            coverage_note: if coverage_note.is_empty() { None } else { Some(coverage_note) },
        });
    }
    Ok(series)
}

fn estimated_sidecar_model_mem_series(
    conn: &rusqlite::Connection,
    bucket_ms: i64,
    from_ms: i64,
) -> Result<Vec<NamedMetricSeries>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT model_type, model_name,
                (ts / ?1) * ?1 + ?1/2 as bucket,
                MAX(COALESCE(memory_mb, 0))
         FROM model_events
         WHERE ts >= ?2
           AND model_type IN ('ocr', 'embedding', 'llm')
           AND event_type IN ('load_start', 'load_done', 'unload')
         GROUP BY model_type, model_name, bucket
         ORDER BY bucket"
    )?;
    let mut grouped: std::collections::BTreeMap<String, (String, Vec<MetricPoint>)> = std::collections::BTreeMap::new();
    let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows.filter_map(|r| r.ok()) {
        let key = format!("sidecar_{}", row.0);
        let label = sidecar_model_type_label(&row.0, &row.1);
        grouped
            .entry(key)
            .and_modify(|(_, points)| points.push(MetricPoint { ts: row.2, value: row.3 as f64 }))
            .or_insert_with(|| (label, vec![MetricPoint { ts: row.2, value: row.3 as f64 }]));
    }

    Ok(grouped
        .into_iter()
        .map(|(key, (label, points))| NamedMetricSeries {
            key,
            label,
            points,
            process_names: Vec::new(),
            coverage_status: Some("estimated".to_string()),
            coverage_note: Some("基于 sidecar 模型事件估算的逻辑内存时间线，非进程级精确 RSS".to_string()),
        })
        .collect())
}

fn latest_system_metrics(
    conn: &rusqlite::Connection,
    has_gpu_percent: bool,
    has_gpu_name: bool,
    scoped: bool,
) -> Option<SystemLatestMetrics> {
    let sql = if scoped {
        "SELECT cpu_total, mem_total_mb, mem_used_mb, mem_percent, gpu_percent, gpu_name
         FROM system_metrics
         WHERE scope = ?1
         ORDER BY ts DESC LIMIT 1"
    } else {
        "SELECT cpu_total, mem_total_mb, mem_used_mb, mem_percent, gpu_percent, gpu_name
         FROM system_metrics
         ORDER BY ts DESC LIMIT 1"
    };

    let result = if scoped {
        conn.query_row(sql, rusqlite::params![SYSTEM_SCOPE], |r| {
            Ok((
                r.get::<_, f64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, f64>(3)?,
                if has_gpu_percent { r.get::<_, Option<f64>>(4)? } else { None },
                if has_gpu_name { r.get::<_, Option<String>>(5)? } else { None },
            ))
        })
    } else {
        conn.query_row(sql, [], |r| {
            Ok((
                r.get::<_, f64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, f64>(3)?,
                if has_gpu_percent { r.get::<_, Option<f64>>(4)? } else { None },
                if has_gpu_name { r.get::<_, Option<String>>(5)? } else { None },
            ))
        })
    };

    result.ok().map(|row| SystemLatestMetrics {
        cpu_total: row.0,
        mem_total_mb: row.1,
        mem_used_mb: row.2,
        mem_percent: row.3,
        gpu_percent: row.4,
        gpu_total_label: row.5.clone(),
        gpu_name: row.5,
    })
}

fn latest_scoped_metrics(
    conn: &rusqlite::Connection,
    scope: &str,
) -> Option<ScopedLatestMetrics> {
    conn.query_row(
        "SELECT cpu_process, mem_process_mb,
                COALESCE(target_pids_json, '[]'),
                coverage_status,
                coverage_note
         FROM system_metrics
         WHERE scope = ?1
         ORDER BY ts DESC LIMIT 1",
        rusqlite::params![scope],
        |r| {
            let pids_json: String = r.get(2)?;
            let process_count = serde_json::from_str::<Vec<i64>>(&pids_json)
                .map(|pids| pids.len())
                .unwrap_or(0);
            Ok(ScopedLatestMetrics {
                cpu_percent: r.get(0)?,
                mem_process_mb: r.get(1)?,
                process_count,
                process_names: if scope == MODEL_SCOPE {
                    let mut names = Vec::new();
                    let mut seen = std::collections::HashSet::new();
                    let mut stmt = conn.prepare(
                        "SELECT target_name FROM system_metrics
                         WHERE scope = ?1 AND ts >= ?2 AND target_name IS NOT NULL AND target_name != ''
                         ORDER BY ts DESC"
                    )?;
                    let rows = stmt.query_map(
                        rusqlite::params![MODEL_SERIES_SCOPE, Utc::now().timestamp_millis() - 24 * 3600 * 1000],
                        |row| row.get::<_, String>(0),
                    )?;
                    for row in rows.filter_map(|row| row.ok()) {
                        let label = runtime_label(&row);
                        if seen.insert(label.clone()) {
                            names.push(label);
                        }
                    }
                    names
                } else {
                    Vec::new()
                },
                coverage_status: r.get(3)?,
                coverage_note: r.get(4)?,
            })
        },
    ).ok()
}

fn latest_model_runtime_breakdown(
    conn: &rusqlite::Connection,
) -> Result<Vec<ModelRuntimeBreakdownItem>, rusqlite::Error> {
    let mut items = Vec::new();

    let mut runtime_stmt = conn.prepare(
        "WITH latest_ts AS (
            SELECT MAX(ts) AS ts
            FROM system_metrics
            WHERE scope = ?1
         )
         SELECT target_name,
                COALESCE(MAX(coverage_status), ''),
                COALESCE(MAX(coverage_note), ''),
                AVG(cpu_process),
                AVG(mem_process_mb),
                COALESCE(target_pids_json, '[]')
         FROM system_metrics, latest_ts
         WHERE scope = ?1 AND system_metrics.ts = latest_ts.ts
         GROUP BY target_name, target_pids_json
         ORDER BY AVG(mem_process_mb) DESC, target_name ASC"
    )?;
    let runtime_rows = runtime_stmt.query_map(rusqlite::params![MODEL_SERIES_SCOPE], |r| {
        let key: String = r.get(0)?;
        let pids_json: String = r.get(5)?;
        let process_count = serde_json::from_str::<Vec<i64>>(&pids_json)
            .map(|pids| pids.len())
            .unwrap_or(0);
        Ok(ModelRuntimeBreakdownItem {
            key: key.clone(),
            label: runtime_label(&key),
            coverage_status: match r.get::<_, String>(1)? {
                value if value.is_empty() => None,
                value => Some(value),
            },
            coverage_note: match r.get::<_, String>(2)? {
                value if value.is_empty() => None,
                value => Some(value),
            },
            cpu_percent: r.get::<_, f64>(3)?,
            mem_process_mb: r.get::<_, f64>(4)?.round() as i64,
            process_count,
        })
    })?;
    items.extend(runtime_rows.filter_map(|r| r.ok()));

    let mut sidecar_stmt = conn.prepare(
        "SELECT model_type, model_name, ts, memory_mb
         FROM model_events
         WHERE ts >= ?1
           AND model_type IN ('ocr', 'embedding', 'llm')
           AND event_type IN ('load_start', 'load_done', 'unload')
         ORDER BY ts DESC"
    )?;
    let cutoff = Utc::now().timestamp_millis() - 24 * 3600 * 1000;
    let mut seen = std::collections::HashSet::new();
    let sidecar_rows = sidecar_stmt.query_map(rusqlite::params![cutoff], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, Option<i64>>(3)?.unwrap_or(0),
        ))
    })?;
    for row in sidecar_rows.filter_map(|r| r.ok()) {
        let model_type = row.0;
        let model_name = row.1;
        if !seen.insert(model_type.clone()) {
            continue;
        }
        let key = format!("sidecar_{}", model_type);
        items.push(ModelRuntimeBreakdownItem {
            key,
            label: sidecar_model_type_label(&model_type, &model_name),
            cpu_percent: 0.0,
            mem_process_mb: row.3,
            process_count: 1,
            coverage_status: Some("estimated".to_string()),
            coverage_note: Some("基于 sidecar 模型事件的逻辑拆分，内存为近似值，非进程级精确 RSS".to_string()),
        });
    }

    items.sort_by(|a, b| b.mem_process_mb.cmp(&a.mem_process_mb));
    Ok(items)
}

/// GET /api/monitor/system?range=1h|6h|24h|1d
pub async fn monitor_system(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SystemQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let now_ms = Utc::now().timestamp_millis();
    let range_ms: i64 = match params.range.as_str() {
        "1h"  => 3600 * 1000,
        "6h"  => 6 * 3600 * 1000,
        "24h" | "1d" => 24 * 3600 * 1000,
        _     => 24 * 3600 * 1000,
    };
    let from_ms = now_ms - range_ms;
    let fallback_noise_pattern = format!("{}%", FALLBACK_NOISE_OVERVIEW_PREFIX);
    let bucket_ms = system_bucket_ms(&params.range);
    let max_trend_points = match params.range.as_str() {
        "1h" => 120,
        "6h" => 160,
        "24h" | "1d" => 240,
        _ => 160,
    };

    let result = state.storage.with_conn_async(move |conn| {
        let db_size_bytes = conn.query_row("PRAGMA page_count", [], |r| r.get::<_, i64>(0)).unwrap_or(0)
            * conn.query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        let metric_columns: HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(system_metrics)")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let has_gpu_percent = has_column(&metric_columns, "gpu_percent");
        let has_gpu_name = has_column(&metric_columns, "gpu_name");
        let scoped = has_scope_columns(&metric_columns);

        let system_cpu = if scoped {
            scoped_metric_trend(conn, SYSTEM_SCOPE, "cpu_total", bucket_ms, from_ms)?
        } else {
            let mut stmt = conn.prepare(
                "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, AVG(cpu_total)
                 FROM system_metrics WHERE ts >= ?2
                 GROUP BY bucket ORDER BY bucket"
            )?;
            let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms], |r| {
                Ok(MetricPoint { ts: r.get(0)?, value: r.get(1)? })
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let system_mem = if scoped {
            scoped_metric_trend(conn, SYSTEM_SCOPE, "mem_percent", bucket_ms, from_ms)?
        } else {
            let mut stmt = conn.prepare(
                "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, AVG(mem_percent)
                 FROM system_metrics WHERE ts >= ?2
                 GROUP BY bucket ORDER BY bucket"
            )?;
            let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms], |r| {
                Ok(MetricPoint { ts: r.get(0)?, value: r.get(1)? })
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let suite_cpu = if scoped {
            scoped_metric_trend(conn, SUITE_SCOPE, "cpu_process", bucket_ms, from_ms)?
        } else {
            Vec::new()
        };
        let suite_mem = if scoped {
            scoped_metric_trend(conn, SUITE_SCOPE, "mem_process_mb", bucket_ms, from_ms)?
        } else {
            Vec::new()
        };
        let model_cpu = if scoped {
            scoped_metric_trend(conn, MODEL_SCOPE, "cpu_process", bucket_ms, from_ms)?
        } else {
            Vec::new()
        };
        let model_mem = if scoped {
            scoped_metric_trend(conn, MODEL_SCOPE, "mem_process_mb", bucket_ms, from_ms)?
        } else {
            Vec::new()
        };
        let model_cpu_series = if scoped {
            scoped_metric_series(conn, MODEL_SERIES_SCOPE, "cpu_process", bucket_ms, from_ms)?
        } else {
            Vec::new()
        };
        let model_mem_series = if scoped {
            scoped_metric_series(conn, MODEL_SERIES_SCOPE, "mem_process_mb", bucket_ms, from_ms)?
        } else {
            Vec::new()
        };
        let model_estimated_mem_series = if scoped {
            estimated_sidecar_model_mem_series(conn, bucket_ms, from_ms)?
        } else {
            Vec::new()
        };

        let gpu_trend: Vec<MetricPoint> = if has_gpu_percent {
            if scoped {
                let mut stmt = conn.prepare(
                    "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, AVG(gpu_percent)
                     FROM system_metrics
                     WHERE ts >= ?2 AND scope = ?3 AND gpu_percent IS NOT NULL
                     GROUP BY bucket ORDER BY bucket"
                )?;
                let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms, SYSTEM_SCOPE], |r| {
                    Ok(MetricPoint { ts: r.get(0)?, value: r.get(1)? })
                })?;
                rows.filter_map(|r| r.ok()).collect()
            } else {
                let mut stmt = conn.prepare(
                    "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, AVG(gpu_percent)
                     FROM system_metrics
                     WHERE ts >= ?2 AND gpu_percent IS NOT NULL
                     GROUP BY bucket ORDER BY bucket"
                )?;
                let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms], |r| {
                    Ok(MetricPoint { ts: r.get(0)?, value: r.get(1)? })
                })?;
                rows.filter_map(|r| r.ok()).collect()
            }
        } else {
            Vec::new()
        };
        let model_gpu_trend: Vec<MetricPoint> = if has_gpu_percent && scoped {
            let mut stmt = conn.prepare(
                "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, AVG(gpu_percent)
                 FROM system_metrics
                 WHERE ts >= ?2 AND scope = ?3 AND gpu_percent IS NOT NULL
                 GROUP BY bucket ORDER BY bucket"
            )?;
            let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms, MODEL_SCOPE], |r| {
                Ok(MetricPoint { ts: r.get(0)?, value: r.get(1)? })
            })?;
            rows.filter_map(|r| r.ok()).collect()
        } else {
            Vec::new()
        };

        let disk_trend: Vec<DiskPoint> = if scoped {
            let mut stmt = conn.prepare(
                "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, SUM(disk_read_mb), SUM(disk_write_mb)
                 FROM system_metrics
                 WHERE ts >= ?2 AND scope = ?3
                 GROUP BY bucket ORDER BY bucket"
            )?;
            let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms, SYSTEM_SCOPE], |r| {
                Ok(DiskPoint { ts: r.get(0)?, read_mb: r.get(1)?, write_mb: r.get(2)? })
            })?;
            rows.filter_map(|r| r.ok()).collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, SUM(disk_read_mb), SUM(disk_write_mb)
                 FROM system_metrics
                 WHERE ts >= ?2
                 GROUP BY bucket ORDER BY bucket"
            )?;
            let rows = stmt.query_map(rusqlite::params![bucket_ms, from_ms], |r| {
                Ok(DiskPoint { ts: r.get(0)?, read_mb: r.get(1)?, write_mb: r.get(2)? })
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let latest = ResourceLatestBundle {
            system: latest_system_metrics(conn, has_gpu_percent, has_gpu_name, scoped),
            suite: if scoped { latest_scoped_metrics(conn, SUITE_SCOPE) } else { None },
            model: if scoped { latest_scoped_metrics(conn, MODEL_SCOPE) } else { None },
        };
        let model_runtime_breakdown = if scoped {
            latest_model_runtime_breakdown(conn)?
        } else {
            Vec::new()
        };

        let mut knowledge_events_stmt = conn.prepare(
            "SELECT (ts / ?1) * ?1 + ?1/2 as bucket, COUNT(*)
             FROM (
                SELECT CAST(strftime('%s', created_at) AS INTEGER) * 1000 as ts
                FROM knowledge_entries
                WHERE created_at >= datetime(?2/1000, 'unixepoch')
                  AND summary NOT LIKE ?3
             )
             GROUP BY bucket ORDER BY bucket"
        )?;
        let knowledge_events: Vec<KnowledgeTimePoint> = knowledge_events_stmt
            .query_map(rusqlite::params![bucket_ms, from_ms, fallback_noise_pattern.as_str()], |r| {
                Ok(KnowledgeTimePoint { ts: r.get(0)?, count: r.get(1)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut ev_stmt = conn.prepare(
            "SELECT ts, event_type, model_type, model_name,
                    duration_ms, memory_mb, mem_before_mb, mem_after_mb, error_msg
             FROM model_events WHERE ts >= ?1
             ORDER BY ts DESC LIMIT 50"
        )?;
        let model_events: Vec<ModelEventItem> = ev_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(ModelEventItem {
                    ts:            r.get(0)?,
                    event_type:    r.get(1)?,
                    model_type:    r.get(2)?,
                    model_name:    r.get(3)?,
                    duration_ms:   r.get(4)?,
                    memory_mb:     r.get(5)?,
                    mem_before_mb: r.get(6)?,
                    mem_after_mb:  r.get(7)?,
                    error_msg:     r.get(8)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let system_cpu = downsample_metric_points(system_cpu, max_trend_points);
        let system_mem = downsample_metric_points(system_mem, max_trend_points);
        let suite_cpu = downsample_metric_points(suite_cpu, max_trend_points);
        let suite_mem = downsample_metric_points(suite_mem, max_trend_points);
        let model_cpu = downsample_metric_points(model_cpu, max_trend_points);
        let model_mem = downsample_metric_points(model_mem, max_trend_points);
        let model_cpu_series = downsample_named_metric_series(model_cpu_series, max_trend_points);
        let model_mem_series = downsample_named_metric_series(model_mem_series, max_trend_points);
        let model_estimated_mem_series = downsample_named_metric_series(model_estimated_mem_series, max_trend_points);
        let gpu_trend = downsample_metric_points(gpu_trend, max_trend_points);
        let model_gpu_trend = downsample_metric_points(model_gpu_trend, max_trend_points);
        let disk_trend = downsample_disk_points(disk_trend, max_trend_points);
        let knowledge_events = downsample_knowledge_points(knowledge_events, max_trend_points);

        Ok(SystemResourcesResponse {
            db_size_bytes,
            trends: ResourceTrends {
                system_cpu,
                system_mem,
                suite_cpu,
                suite_mem,
                model_cpu,
                model_mem,
                model_cpu_series,
                model_mem_series,
                model_estimated_mem_series,
            },
            gpu_trend,
            model_gpu_trend,
            disk_trend,
            knowledge_events,
            model_events,
            model_runtime_breakdown,
            latest,
        })
    }).await?;

    Ok(Json(result))
}
