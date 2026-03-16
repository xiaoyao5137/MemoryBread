//! 监控 API 处理器
//!
//! GET /api/monitor/overview?range=7d
//! 聚合返回：token 用量、采集流水、问答记录、定时任务执行

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::api::{error::ApiError, state::AppState};

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

// ── 响应结构 ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MonitorOverview {
    pub token_usage:     TokenUsage,
    pub capture_flow:    CaptureFlow,
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
    pub date:   String,   // "MM-DD"
    pub tokens: i64,
    pub calls:  i64,
}

#[derive(Debug, Serialize)]
pub struct CaptureFlow {
    pub today_count:    i64,
    pub period_count:   i64,
    pub knowledge_rate: f64,   // 已提炼比例
    pub by_hour:        Vec<HourCount>,
    pub by_app:         Vec<AppCount>,
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

// ── Handler ──────────────────────────────────────────────────────────────────

/// GET /api/monitor/overview
pub async fn monitor_overview(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MonitorQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let now_ms   = Utc::now().timestamp_millis();
    let range_ms = range_to_ms(&params.range);
    let from_ms  = now_ms - range_ms;
    let today_start = now_ms - (now_ms % (24 * 3600 * 1000)); // 今天 00:00 UTC

    let overview = state.storage.with_conn(|conn| {
        // ── 1. Token 用量 ────────────────────────────────────────────────────
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

        // 按模型分组
        let mut by_model_stmt = conn.prepare(
            "SELECT model_name, COALESCE(SUM(total_tokens),0), COUNT(*)
             FROM llm_usage_logs WHERE ts >= ?1
             GROUP BY model_name ORDER BY 2 DESC LIMIT 10"
        )?;
        let by_model: Vec<ModelUsage> = by_model_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(ModelUsage { model: r.get(0)?, total: r.get(1)?, calls: r.get(2)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // 按来源分组
        let mut by_caller_stmt = conn.prepare(
            "SELECT caller, COALESCE(SUM(total_tokens),0), COUNT(*)
             FROM llm_usage_logs WHERE ts >= ?1
             GROUP BY caller ORDER BY 2 DESC"
        )?;
        let by_caller: Vec<CallerUsage> = by_caller_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(CallerUsage { caller: r.get(0)?, total: r.get(1)?, calls: r.get(2)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // 每日趋势（按天聚合）
        let mut trend_stmt = conn.prepare(
            "SELECT strftime('%m-%d', datetime(ts/1000, 'unixepoch', 'localtime')) as day,
                    COALESCE(SUM(total_tokens),0), COUNT(*)
             FROM llm_usage_logs WHERE ts >= ?1
             GROUP BY day ORDER BY day"
        )?;
        let trend: Vec<DayTrend> = trend_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(DayTrend { date: r.get(0)?, tokens: r.get(1)?, calls: r.get(2)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // ── 2. 采集流水 ──────────────────────────────────────────────────────
        let today_captures: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE ts >= ?1",
            rusqlite::params![today_start],
            |r| r.get(0),
        ).unwrap_or(0);

        let period_captures: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE ts >= ?1",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);

        let knowledge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE ts >= ?1 AND knowledge_id IS NOT NULL",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);

        let knowledge_rate = if period_captures > 0 {
            knowledge_count as f64 / period_captures as f64
        } else { 0.0 };

        // 今日按小时分布
        let mut hour_stmt = conn.prepare(
            "SELECT CAST(strftime('%H', datetime(ts/1000, 'unixepoch', 'localtime')) AS INTEGER),
                    COUNT(*)
             FROM captures WHERE ts >= ?1
             GROUP BY 1 ORDER BY 1"
        )?;
        let by_hour: Vec<HourCount> = hour_stmt
            .query_map(rusqlite::params![today_start], |r| {
                Ok(HourCount { hour: r.get(0)?, count: r.get(1)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // 按应用分布（Top 8）
        let mut app_stmt = conn.prepare(
            "SELECT COALESCE(app_name, '未知'), COUNT(*)
             FROM captures WHERE ts >= ?1 AND app_name IS NOT NULL
             GROUP BY app_name ORDER BY 2 DESC LIMIT 8"
        )?;
        let by_app: Vec<AppCount> = app_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(AppCount { app: r.get(0)?, count: r.get(1)? })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // ── 3. RAG 问答 ──────────────────────────────────────────────────────
        let today_rag: i64 = conn.query_row(
            "SELECT COUNT(*) FROM rag_sessions WHERE ts >= ?1",
            rusqlite::params![today_start],
            |r| r.get(0),
        ).unwrap_or(0);

        let period_rag: i64 = conn.query_row(
            "SELECT COUNT(*) FROM rag_sessions WHERE ts >= ?1",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);

        let avg_latency: i64 = conn.query_row(
            "SELECT COALESCE(AVG(latency_ms), 0) FROM rag_sessions WHERE ts >= ?1 AND latency_ms IS NOT NULL",
            rusqlite::params![from_ms],
            |r| r.get(0),
        ).unwrap_or(0);

        let mut rag_stmt = conn.prepare(
            "SELECT id, ts, user_query, latency_ms,
                    (SELECT COUNT(*) FROM json_each(COALESCE(retrieved_ids, '[]'))) as ctx_count
             FROM rag_sessions WHERE ts >= ?1
             ORDER BY ts DESC LIMIT 10"
        )?;
        let recent_rag: Vec<RagSessionItem> = rag_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(RagSessionItem {
                    id:            r.get(0)?,
                    ts:            r.get(1)?,
                    query:         r.get::<_, String>(2).map(|q| {
                        if q.len() > 60 { format!("{}...", &q[..60]) } else { q }
                    })?,
                    latency_ms:    r.get(3)?,
                    context_count: r.get(4).unwrap_or(0),
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // ── 4. 定时任务执行 ──────────────────────────────────────────────────
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

        let failed_exec = total_exec - success_exec;
        let success_rate = if total_exec > 0 { success_exec as f64 / total_exec as f64 } else { 0.0 };

        let mut exec_stmt = conn.prepare(
            "SELECT e.id, COALESCE(t.name, '已删除'), e.status, e.started_at, e.latency_ms, e.knowledge_count
             FROM task_executions e
             LEFT JOIN scheduled_tasks t ON e.task_id = t.id
             WHERE e.started_at >= ?1
             ORDER BY e.started_at DESC LIMIT 10"
        )?;
        let recent_exec: Vec<TaskExecutionItem> = exec_stmt
            .query_map(rusqlite::params![from_ms], |r| {
                Ok(TaskExecutionItem {
                    id:              r.get(0)?,
                    task_name:       r.get(1)?,
                    status:          r.get(2)?,
                    started_at:      r.get(3)?,
                    latency_ms:      r.get(4)?,
                    knowledge_count: r.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(MonitorOverview {
            token_usage: TokenUsage {
                total_period,
                total_today,
                by_model,
                by_caller,
                trend,
            },
            capture_flow: CaptureFlow {
                today_count: today_captures,
                period_count: period_captures,
                knowledge_rate,
                by_hour,
                by_app,
            },
            rag_sessions: RagSessionStats {
                today_count: today_rag,
                period_count: period_rag,
                avg_latency_ms: avg_latency,
                recent: recent_rag,
            },
            task_executions: TaskExecutionStats {
                total: total_exec,
                success: success_exec,
                failed: failed_exec,
                success_rate,
                recent: recent_exec,
            },
        })
    })?;

    Ok(Json(overview))
}
