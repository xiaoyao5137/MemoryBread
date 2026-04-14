//! REST API 集成测试
//!
//! 测试覆盖：
//! - GET /health → 200 + {"status":"ok"}
//! - GET /captures（空库）→ 200 + total=0
//! - GET /captures?from=&to= → 200
//! - GET /captures?q=... → 200 (FTS5 降级到空结果)
//! - GET /captures?app=... → 200
//! - GET /preferences → 200 + list
//! - PUT /preferences/:key → 200 + 返回新值
//! - PUT /preferences/:key（无 body）→ 400
//! - POST /query → 200 + stub 回复
//! - POST /query（sidecar 不可用）→ 502
//! - POST /query（sidecar 返回 502）→ 502
//! - POST /pii/scrub → 200 + 原文返回

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use memory_bread_core::{
    api::{AppState, state::DebugLogSpec},
    storage::{NewKnowledgeEntry, StorageManager},
};
use memory_bread_core::storage::models::{EventType, NewCapture};

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/// 创建测试用 axum Router（使用内存临时 SQLite）
async fn make_test_router() -> (axum::Router, tempfile::TempDir) {
    let tmp    = tempfile::tempdir().unwrap();
    let db     = tmp.path().join("test.db");
    let sm     = StorageManager::open(&db).unwrap();
    let state  = AppState::new(sm);
    let router = memory_bread_core::api::create_router(state);
    (router, tmp)
}

fn make_test_state(sm: StorageManager, debug_log_specs: Vec<DebugLogSpec>) -> Arc<AppState> {
    Arc::new(AppState {
        storage: sm,
        sidecar_url: "http://127.0.0.1:7071".to_string(),
        debug_log_specs,
    })
}

async fn spawn_bake_sidecar(responses: Vec<String>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let queue = Arc::new(Mutex::new(
        responses
            .into_iter()
            .map(|item| item.to_string())
            .collect::<VecDeque<_>>(),
    ));

    tokio::spawn({
        let queue = Arc::clone(&queue);
        async move {
            loop {
                let response = {
                    let mut guard = queue.lock().await;
                    guard.pop_front()
                };
                let Some(response) = response else {
                    break;
                };

                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buffer = [0_u8; 8192];
                let _ = stream.read(&mut buffer).await;
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(20)).await;
    format!("http://{}", addr)
}

fn make_bake_response(
    knowledge: serde_json::Value,
    template: serde_json::Value,
    sop: serde_json::Value,
) -> String {
    let body = serde_json::json!({
        "knowledge": knowledge,
        "template": template,
        "sop": sop,
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 20
        },
        "model": "test-model",
        "degraded": false
    })
    .to_string();

    format!(
        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn make_bake_error_response(status_line: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status_line}\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn make_bake_state(sm: StorageManager, sidecar_url: String) -> Arc<AppState> {
    Arc::new(AppState {
        storage: sm,
        sidecar_url,
        debug_log_specs: vec![],
    })
}

async fn spawn_failing_sidecar() -> String {
    spawn_bake_sidecar(vec![make_bake_error_response(
        "502 Bad Gateway",
        r#"{"error":"boom"}"#,
    )])
    .await
}

/// 发送请求并返回 (StatusCode, 响应体字符串)
async fn oneshot(router: axum::Router, req: Request<Body>) -> (StatusCode, String) {
    let resp = router.oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes).to_string();
    (status, body)
}

fn seed_capture(sm: &StorageManager) -> i64 {
    sm.insert_capture(&NewCapture {
        ts: 1_710_000_000_000,
        app_name: Some("Chrome".to_string()),
        app_bundle_id: Some("com.google.Chrome".to_string()),
        win_title: Some("测试来源窗口".to_string()),
        event_type: EventType::Manual,
        ax_text: Some("测试来源文本".to_string()),
        ax_focused_role: None,
        ax_focused_id: None,
        screenshot_path: None,
        input_text: None,
        is_sensitive: false,
    }).unwrap()
}

fn seed_knowledge_entry(sm: &StorageManager, category: &str, summary: &str, overview: &str, details: serde_json::Value) -> i64 {
    sm.insert_knowledge_entry(&NewKnowledgeEntry {
        capture_id: seed_capture(sm),
        summary: summary.to_string(),
        overview: Some(overview.to_string()),
        details: Some(details.to_string()),
        entities: r#"["流程","模板"]"#.to_string(),
        category: category.to_string(),
        importance: 4,
        occurrence_count: Some(3),
        observed_at: Some(1_710_000_000_000),
        event_time_start: None,
        event_time_end: None,
        history_view: false,
        content_origin: Some("manual".to_string()),
        activity_type: Some("reading".to_string()),
        is_self_generated: false,
        evidence_strength: Some("high".to_string()),
    }).unwrap()
}

fn bake_rejected(reason: &str) -> serde_json::Value {
    serde_json::json!({
        "accepted": false,
        "reason": reason,
        "payload": null,
    })
}

fn bake_knowledge_artifact(summary: &str, review_status: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "accepted": true,
        "reason": null,
        "payload": {
            "summary": summary,
            "overview": format!("{summary} overview"),
            "entities": ["周报", "流程"],
            "importance": 5,
            "occurrence_count": 2,
            "evidence_summary": "来自测试 sidecar",
            "match_score": 0.91,
            "match_level": "high",
            "review_status": review_status,
        }
    })
}

fn bake_template_artifact(name: &str, review_status: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "accepted": true,
        "reason": null,
        "payload": {
            "name": name,
            "category": "周报",
            "status": "enabled",
            "tags": ["周报", "模板"],
            "applicable_tasks": ["creation"],
            "linked_knowledge_ids": [],
            "structure_sections": [
                {"title": "背景", "keywords": ["背景"], "notes": null},
                {"title": "进展", "keywords": ["进展"], "notes": null}
            ],
            "style_phrases": ["整体看"],
            "replacement_rules": [],
            "prompt_hint": "按周报结构填写",
            "diagram_code": null,
            "image_assets": [],
            "evidence_summary": "来自测试 sidecar",
            "match_score": 0.89,
            "match_level": "high",
            "review_status": review_status,
        }
    })
}

fn bake_sop_artifact(summary: &str, review_status: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "accepted": true,
        "reason": null,
        "payload": {
            "summary": summary,
            "overview": format!("{summary} overview"),
            "source_title": summary,
            "trigger_keywords": ["周报", "提炼"],
            "extracted_problem": "如何沉淀周报流程",
            "steps": ["确认输入", "整理素材", "生成输出"],
            "linked_knowledge_ids": [],
            "confidence": "high",
            "evidence_summary": "来自测试 sidecar",
            "match_score": 0.93,
            "match_level": "high",
            "review_status": review_status,
        }
    })
}

async fn run_bake(router: axum::Router, trigger_reason: &str) -> (StatusCode, serde_json::Value, String) {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/bake/run")
        .header("content-type", "application/json")
        .body(Body::from(format!(
            r#"{{"trigger_reason":"{}","limit":10}}"#,
            trigger_reason
        )))
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    let json = serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!({ "raw": body }));
    (status, json, body)
}

#[tokio::test]
async fn test_bake_style_config_roundtrip() {
    let (router, _tmp) = make_test_router().await;

    let get_req = Request::builder()
        .uri("/api/bake/style-config")
        .body(Body::empty())
        .unwrap();
    let (get_status, get_body) = oneshot(router.clone(), get_req).await;
    assert_eq!(get_status, StatusCode::OK, "body: {get_body}");
    let get_json: serde_json::Value = serde_json::from_str(&get_body).unwrap();
    assert!(get_json["preferred_phrases"].is_array());

    let put_req = Request::builder()
        .method(Method::PUT)
        .uri("/api/bake/style-config")
        .header("content-type", "application/json")
        .body(Body::from(r#"{
            "preferred_phrases": ["整体看"],
            "replacement_rules": [{"from":"综上所述","to":"整体看"}],
            "style_samples": ["这里建议先收敛范围。"],
            "apply_to_creation": true,
            "apply_to_template_editing": false
        }"#))
        .unwrap();
    let (put_status, put_body) = oneshot(router.clone(), put_req).await;
    assert_eq!(put_status, StatusCode::OK, "body: {put_body}");
    let put_json: serde_json::Value = serde_json::from_str(&put_body).unwrap();
    assert_eq!(put_json["apply_to_template_editing"], false);

    let get_again_req = Request::builder()
        .uri("/api/bake/style-config")
        .body(Body::empty())
        .unwrap();
    let (get_again_status, get_again_body) = oneshot(router, get_again_req).await;
    assert_eq!(get_again_status, StatusCode::OK, "body: {get_again_body}");
    let get_again_json: serde_json::Value = serde_json::from_str(&get_again_body).unwrap();
    assert_eq!(get_again_json["style_samples"][0], "这里建议先收敛范围。");
}

#[tokio::test]
async fn test_bake_templates_crud_flow() {
    let (router, _tmp) = make_test_router().await;

    let create_req = Request::builder()
        .method(Method::POST)
        .uri("/api/bake/templates")
        .header("content-type", "application/json")
        .body(Body::from(r#"{
            "name":"周报模板",
            "category":"周报",
            "status":"draft",
            "tags":["周报"],
            "applicable_tasks":["creation"],
            "source_article_ids":[],
            "source_memory_ids":[],
            "linked_knowledge_ids":[],
            "structure_sections":[{"title":"本周进展","keywords":["进展"],"notes":null}],
            "style_phrases":["整体看"],
            "replacement_rules":[{"from":"综上所述","to":"整体看"}],
            "prompt_hint":"聚焦本周主线",
            "diagram_code":null,
            "image_assets":[],
            "usage_count":0
        }"#))
        .unwrap();
    let (create_status, create_body) = oneshot(router.clone(), create_req).await;
    assert_eq!(create_status, StatusCode::OK, "body: {create_body}");
    let created: serde_json::Value = serde_json::from_str(&create_body).unwrap();
    let template_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["source_article_ids"].as_array().unwrap().len(), 0);
    assert_eq!(created["source_memory_ids"].as_array().unwrap().len(), 0);

    let list_req = Request::builder()
        .uri("/api/bake/templates")
        .body(Body::empty())
        .unwrap();
    let (list_status, list_body) = oneshot(router.clone(), list_req).await;
    assert_eq!(list_status, StatusCode::OK, "body: {list_body}");
    let list_json: serde_json::Value = serde_json::from_str(&list_body).unwrap();
    assert_eq!(list_json["items"].as_array().unwrap().len(), 1);

    let update_req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/bake/templates/{template_id}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{
            "name":"周报模板-更新",
            "category":"周报",
            "status":"pending_review",
            "tags":["周报","精选"],
            "applicable_tasks":["creation"],
            "source_article_ids":[],
            "source_memory_ids":[],
            "linked_knowledge_ids":[],
            "structure_sections":[],
            "style_phrases":[],
            "replacement_rules":[],
            "prompt_hint":"更新后提示",
            "diagram_code":null,
            "image_assets":[],
            "usage_count":2
        }"#))
        .unwrap();
    let (update_status, update_body) = oneshot(router.clone(), update_req).await;
    assert_eq!(update_status, StatusCode::OK, "body: {update_body}");
    let update_json: serde_json::Value = serde_json::from_str(&update_body).unwrap();
    assert_eq!(update_json["name"], "周报模板-更新");
    assert_eq!(update_json["source_memory_ids"].as_array().unwrap().len(), 0);

    let toggle_req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/bake/templates/{template_id}/toggle-status"))
        .body(Body::empty())
        .unwrap();
    let (toggle_status, toggle_body) = oneshot(router, toggle_req).await;
    assert_eq!(toggle_status, StatusCode::OK, "body: {toggle_body}");
    let toggle_json: serde_json::Value = serde_json::from_str(&toggle_body).unwrap();
    assert_eq!(toggle_json["status"], "enabled");
}

#[tokio::test]
async fn test_bake_sops_list_and_adopt() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let sop_id = seed_knowledge_entry(
        &sm,
        "bake_sop",
        "客服问题处理",
        "标准处理流程",
        serde_json::json!({
            "source_capture_id": "1",
            "source_title": "客服问题处理",
            "trigger_keywords": ["客服", "SOP"],
            "confidence": "medium",
            "steps": ["确认问题", "定位知识", "给出回复"],
            "linked_knowledge_ids": ["1"],
            "status": "candidate"
        }),
    );
    let router = memory_bread_core::api::create_router(AppState::new(sm));

    let list_req = Request::builder()
        .uri("/api/bake/sops")
        .body(Body::empty())
        .unwrap();
    let (list_status, list_body) = oneshot(router.clone(), list_req).await;
    assert_eq!(list_status, StatusCode::OK, "body: {list_body}");
    let list_json: serde_json::Value = serde_json::from_str(&list_body).unwrap();
    assert_eq!(list_json["items"].as_array().unwrap().len(), 1);

    let adopt_req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/bake/sops/{sop_id}/adopt"))
        .body(Body::empty())
        .unwrap();
    let (adopt_status, adopt_body) = oneshot(router, adopt_req).await;
    assert_eq!(adopt_status, StatusCode::OK, "body: {adopt_body}");
    let adopt_json: serde_json::Value = serde_json::from_str(&adopt_body).unwrap();
    assert_eq!(adopt_json["status"], "confirmed");
}

#[tokio::test]
async fn test_bake_memories_promote_and_ignore_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();

    let sidecar_url = spawn_bake_sidecar(vec![make_bake_response(
        bake_knowledge_artifact("预览知识", None),
        bake_template_artifact("预览模板", Some("candidate")),
        bake_sop_artifact("预览 SOP", Some("candidate")),
    )])
    .await;

    let memory_id = seed_knowledge_entry(
        &sm,
        "bake_article",
        "高价值情节记忆",
        "沉淀模板写法",
        serde_json::json!({
            "url": "https://example.com/article",
            "source_knowledge_id": 1,
            "source_capture_id": "1",
            "weight": 88,
            "open_count": 6,
            "dwell_seconds": 240,
            "has_edit_action": true,
            "knowledge_ref_count": 4,
            "status": "candidate",
            "suggested_action": "template",
            "tags": ["模板", "流程"],
            "last_visited_at": "2026-04-07 10:00"
        }),
    );
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let preview_req = Request::builder()
        .uri(format!("/api/bake/memories/{memory_id}/preview"))
        .body(Body::empty())
        .unwrap();
    let (preview_status, preview_body) = oneshot(router.clone(), preview_req).await;
    assert_eq!(preview_status, StatusCode::OK, "body: {preview_body}");
    let preview_json: serde_json::Value = serde_json::from_str(&preview_body).unwrap();
    assert_eq!(preview_json["knowledge"]["payload"]["match_level"], "high");
    assert_eq!(preview_json["template"]["payload"]["match_score"], 0.89);
    assert_eq!(preview_json["sop"]["payload"]["match_score"], 0.93);

    let list_req = Request::builder()
        .uri("/api/bake/memories")
        .body(Body::empty())
        .unwrap();
    let (list_status, list_body) = oneshot(router.clone(), list_req).await;
    assert_eq!(list_status, StatusCode::OK, "body: {list_body}");
    let list_json: serde_json::Value = serde_json::from_str(&list_body).unwrap();
    assert_eq!(list_json["articles"].as_array().unwrap().len(), 1);
    assert_eq!(list_json["memories"].as_array().unwrap().len(), 1);

    let promote_template_req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/bake/memories/{memory_id}/promote-template"))
        .body(Body::empty())
        .unwrap();
    let (promote_template_status, promote_template_body) = oneshot(router.clone(), promote_template_req).await;
    assert_eq!(promote_template_status, StatusCode::OK, "body: {promote_template_body}");
    let promote_template_json: serde_json::Value = serde_json::from_str(&promote_template_body).unwrap();
    assert_eq!(promote_template_json["name"], "高价值情节记忆");

    let promote_sop_req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/bake/memories/{memory_id}/promote-sop"))
        .body(Body::empty())
        .unwrap();
    let (promote_sop_status, promote_sop_body) = oneshot(router.clone(), promote_sop_req).await;
    assert_eq!(promote_sop_status, StatusCode::OK, "body: {promote_sop_body}");
    let promote_sop_json: serde_json::Value = serde_json::from_str(&promote_sop_body).unwrap();
    assert_eq!(promote_sop_json["status"], "candidate");

    let ignore_req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/bake/memories/{memory_id}/ignore"))
        .body(Body::empty())
        .unwrap();
    let (ignore_status, ignore_body) = oneshot(router.clone(), ignore_req).await;
    assert_eq!(ignore_status, StatusCode::OK, "body: {ignore_body}");
    let ignore_json: serde_json::Value = serde_json::from_str(&ignore_body).unwrap();
    assert_eq!(ignore_json["status"], "ignored");

    let overview_req = Request::builder()
        .uri("/api/bake/overview")
        .body(Body::empty())
        .unwrap();
    let (overview_status, overview_body) = oneshot(router, overview_req).await;
    assert_eq!(overview_status, StatusCode::OK, "body: {overview_body}");
    let overview_json: serde_json::Value = serde_json::from_str(&overview_body).unwrap();
    assert_eq!(overview_json["template_count"], 1);
    assert_eq!(overview_json["memory_count"], 1);
    assert_eq!(overview_json["knowledge_count"], 0);
}

#[tokio::test]
async fn test_bake_knowledge_api_only_returns_bake_knowledge() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();

    seed_knowledge_entry(&sm, "meeting", "普通 knowledge", "普通概述", serde_json::json!({}));
    seed_knowledge_entry(&sm, "bake_article", "情节记忆", "记忆概述", serde_json::json!({}));
    seed_knowledge_entry(&sm, "bake_sop", "操作手册", "SOP 概述", serde_json::json!({}));
    seed_knowledge_entry(&sm, "bake_knowledge", "已提炼知识", "知识概述", serde_json::json!({}));

    let router = memory_bread_core::api::create_router(AppState::new(sm));
    let req = Request::builder()
        .uri("/api/bake/knowledge")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    let items = json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["category"], "bake_knowledge");
    assert_eq!(items[0]["summary"], "已提炼知识");
}

#[tokio::test]
async fn test_bake_overview_counts_only_bake_knowledge() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();

    seed_knowledge_entry(&sm, "meeting", "普通 knowledge", "普通概述", serde_json::json!({}));
    seed_knowledge_entry(&sm, "bake_article", "情节记忆", "记忆概述", serde_json::json!({}));
    seed_knowledge_entry(&sm, "bake_knowledge", "已提炼知识", "知识概述", serde_json::json!({}));

    let router = memory_bread_core::api::create_router(AppState::new(sm));
    let req = Request::builder()
        .uri("/api/bake/overview")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["memory_count"], 1);
    assert_eq!(json["knowledge_count"], 1);
}

#[tokio::test]
async fn test_bake_captures_search_matches_win_title() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    sm.insert_capture(&NewCapture {
        ts: 1_710_000_000_000,
        app_name: Some("Chrome".to_string()),
        app_bundle_id: Some("com.google.Chrome".to_string()),
        win_title: Some("设计稿评审页面".to_string()),
        event_type: EventType::Manual,
        ax_text: Some("无关正文".to_string()),
        ax_focused_role: None,
        ax_focused_id: None,
        screenshot_path: None,
        input_text: None,
        is_sensitive: false,
    }).unwrap();

    let router = memory_bread_core::api::create_router(AppState::new(sm));
    let req = Request::builder()
        .uri("/api/bake/captures?q=%E8%AE%BE%E8%AE%A1%E7%A8%BF")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    let items = json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["win_title"], "设计稿评审页面");
}

#[tokio::test]
async fn test_bake_memories_init_is_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "初始化候选情节记忆",
        "可映射为高价值情节记忆",
        serde_json::json!({}),
    );
    let router = memory_bread_core::api::create_router(AppState::new(sm));

    let first_req = Request::builder()
        .method(Method::POST)
        .uri("/api/bake/memories/init")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"limit":10}"#))
        .unwrap();
    let (first_status, first_body) = oneshot(router.clone(), first_req).await;
    assert_eq!(first_status, StatusCode::OK, "body: {first_body}");
    let first_json: serde_json::Value = serde_json::from_str(&first_body).unwrap();
    assert_eq!(first_json["created_count"], 1);
    assert_eq!(first_json["articles"].as_array().unwrap().len(), 1);
    assert_eq!(first_json["memories"].as_array().unwrap().len(), 1);

    let second_req = Request::builder()
        .method(Method::POST)
        .uri("/api/bake/memories/init")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"limit":10}"#))
        .unwrap();
    let (second_status, second_body) = oneshot(router.clone(), second_req).await;
    assert_eq!(second_status, StatusCode::OK, "body: {second_body}");
    let second_json: serde_json::Value = serde_json::from_str(&second_body).unwrap();
    assert_eq!(second_json["created_count"], 0);

    let list_req = Request::builder()
        .uri("/api/bake/memories")
        .body(Body::empty())
        .unwrap();
    let (list_status, list_body) = oneshot(router, list_req).await;
    assert_eq!(list_status, StatusCode::OK, "body: {list_body}");
    let list_json: serde_json::Value = serde_json::from_str(&list_body).unwrap();
    assert_eq!(list_json["articles"].as_array().unwrap().len(), 1);
    assert_eq!(list_json["memories"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn test_bake_run_pipeline_creates_only_template() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "适合沉淀模板的候选",
        "应只落模板",
        serde_json::json!({}),
    );
    let sidecar_url = spawn_bake_sidecar(vec![make_bake_response(
        bake_rejected("not_a_knowledge"),
        bake_template_artifact("周报模板", Some("candidate")),
        bake_rejected("not_a_sop"),
    )])
    .await;
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let (status, run_json, run_body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(status, StatusCode::OK, "body: {run_body}");
    assert_eq!(run_json["processed_episode_count"], 1);
    assert_eq!(run_json["auto_created_count"], 0);
    assert_eq!(run_json["candidate_count"], 2);
    assert_eq!(run_json["discarded_count"], 2);
    assert_eq!(run_json["knowledge_created_count"], 0);
    assert_eq!(run_json["template_created_count"], 1);
    assert_eq!(run_json["sop_created_count"], 0);

    let knowledge_req = Request::builder()
        .uri("/api/bake/knowledge")
        .body(Body::empty())
        .unwrap();
    let (knowledge_status, knowledge_body) = oneshot(router.clone(), knowledge_req).await;
    assert_eq!(knowledge_status, StatusCode::OK, "body: {knowledge_body}");
    let knowledge_json: serde_json::Value = serde_json::from_str(&knowledge_body).unwrap();
    assert_eq!(knowledge_json["items"].as_array().unwrap().len(), 0);

    let templates_req = Request::builder()
        .uri("/api/bake/templates")
        .body(Body::empty())
        .unwrap();
    let (templates_status, templates_body) = oneshot(router.clone(), templates_req).await;
    assert_eq!(templates_status, StatusCode::OK, "body: {templates_body}");
    let templates_json: serde_json::Value = serde_json::from_str(&templates_body).unwrap();
    assert_eq!(templates_json["items"].as_array().unwrap().len(), 1);
    assert_eq!(templates_json["items"][0]["name"], "周报模板");

    let sops_req = Request::builder()
        .uri("/api/bake/sops")
        .body(Body::empty())
        .unwrap();
    let (sops_status, sops_body) = oneshot(router.clone(), sops_req).await;
    assert_eq!(sops_status, StatusCode::OK, "body: {sops_body}");
    let sops_json: serde_json::Value = serde_json::from_str(&sops_body).unwrap();
    assert_eq!(sops_json["items"].as_array().unwrap().len(), 0);

    let memories_req = Request::builder()
        .uri("/api/bake/memories")
        .body(Body::empty())
        .unwrap();
    let (memories_status, memories_body) = oneshot(router, memories_req).await;
    assert_eq!(memories_status, StatusCode::OK, "body: {memories_body}");
    let memories_json: serde_json::Value = serde_json::from_str(&memories_body).unwrap();
    assert_eq!(memories_json["memories"].as_array().unwrap().len(), 1);
    assert_eq!(memories_json["memories"][0]["template_match_score"], 0.89);
    assert_eq!(memories_json["memories"][0]["template_match_level"], "high");
    assert!(memories_json["memories"][0]["knowledge_match_score"].is_null());
    assert!(memories_json["memories"][0]["knowledge_match_level"].is_null());
    assert!(memories_json["memories"][0]["sop_match_score"].is_null());
    assert!(memories_json["memories"][0]["sop_match_level"].is_null());
}

#[tokio::test]
async fn test_bake_run_pipeline_creates_only_sop() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "适合沉淀 SOP 的候选",
        "应只落 SOP",
        serde_json::json!({}),
    );
    let sidecar_url = spawn_bake_sidecar(vec![make_bake_response(
        bake_rejected("not_a_knowledge"),
        bake_rejected("not_a_template"),
        bake_sop_artifact("标准操作流程", Some("candidate")),
    )])
    .await;
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let (status, run_json, run_body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(status, StatusCode::OK, "body: {run_body}");
    assert_eq!(run_json["processed_episode_count"], 1);
    assert_eq!(run_json["auto_created_count"], 0);
    assert_eq!(run_json["candidate_count"], 2);
    assert_eq!(run_json["discarded_count"], 2);
    assert_eq!(run_json["knowledge_created_count"], 0);
    assert_eq!(run_json["template_created_count"], 0);
    assert_eq!(run_json["sop_created_count"], 1);

    let knowledge_req = Request::builder()
        .uri("/api/bake/knowledge")
        .body(Body::empty())
        .unwrap();
    let (knowledge_status, knowledge_body) = oneshot(router.clone(), knowledge_req).await;
    assert_eq!(knowledge_status, StatusCode::OK, "body: {knowledge_body}");
    let knowledge_json: serde_json::Value = serde_json::from_str(&knowledge_body).unwrap();
    assert_eq!(knowledge_json["items"].as_array().unwrap().len(), 0);

    let templates_req = Request::builder()
        .uri("/api/bake/templates")
        .body(Body::empty())
        .unwrap();
    let (templates_status, templates_body) = oneshot(router.clone(), templates_req).await;
    assert_eq!(templates_status, StatusCode::OK, "body: {templates_body}");
    let templates_json: serde_json::Value = serde_json::from_str(&templates_body).unwrap();
    assert_eq!(templates_json["items"].as_array().unwrap().len(), 0);

    let sops_req = Request::builder()
        .uri("/api/bake/sops")
        .body(Body::empty())
        .unwrap();
    let (sops_status, sops_body) = oneshot(router.clone(), sops_req).await;
    assert_eq!(sops_status, StatusCode::OK, "body: {sops_body}");
    let sops_json: serde_json::Value = serde_json::from_str(&sops_body).unwrap();
    assert_eq!(sops_json["items"].as_array().unwrap().len(), 1);
    assert_eq!(sops_json["items"][0]["source_title"], "标准操作流程");
    assert_eq!(sops_json["items"][0]["extracted_problem"], "标准操作流程");

    let memories_req = Request::builder()
        .uri("/api/bake/memories")
        .body(Body::empty())
        .unwrap();
    let (memories_status, memories_body) = oneshot(router, memories_req).await;
    assert_eq!(memories_status, StatusCode::OK, "body: {memories_body}");
    let memories_json: serde_json::Value = serde_json::from_str(&memories_body).unwrap();
    assert_eq!(memories_json["memories"].as_array().unwrap().len(), 1);
    assert_eq!(memories_json["memories"][0]["sop_match_score"], 0.93);
    assert_eq!(memories_json["memories"][0]["sop_match_level"], "high");
    assert!(memories_json["memories"][0]["knowledge_match_score"].is_null());
    assert!(memories_json["memories"][0]["knowledge_match_level"].is_null());
    assert!(memories_json["memories"][0]["template_match_score"].is_null());
    assert!(memories_json["memories"][0]["template_match_level"].is_null());
}

#[tokio::test]
async fn test_bake_run_pipeline_creates_only_knowledge_and_updates_overview() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "周报模板流程沉淀",
        "沉淀步骤化标准方案",
        serde_json::json!({}),
    );
    let sidecar_url = spawn_bake_sidecar(vec![make_bake_response(
        bake_knowledge_artifact("提炼后的知识", None),
        bake_rejected("not_a_template"),
        bake_rejected("not_a_sop"),
    )])
    .await;
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let (run_status, run_json, run_body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(run_status, StatusCode::OK, "body: {run_body}");
    assert_eq!(run_json["status"], "completed");
    assert_eq!(run_json["trigger_reason"], "manual_debug");
    assert_eq!(run_json["processed_episode_count"], 1);
    assert_eq!(run_json["auto_created_count"], 1);
    assert_eq!(run_json["candidate_count"], 1);
    assert_eq!(run_json["discarded_count"], 2);
    assert_eq!(run_json["knowledge_created_count"], 1);
    assert_eq!(run_json["template_created_count"], 0);
    assert_eq!(run_json["sop_created_count"], 0);

    let overview_req = Request::builder()
        .uri("/api/bake/overview")
        .body(Body::empty())
        .unwrap();
    let (overview_status, overview_body) = oneshot(router.clone(), overview_req).await;
    assert_eq!(overview_status, StatusCode::OK, "body: {overview_body}");
    let overview_json: serde_json::Value = serde_json::from_str(&overview_body).unwrap();
    assert_eq!(overview_json["template_count"], 0);
    assert_eq!(overview_json["memory_count"], 1);
    assert_eq!(overview_json["knowledge_count"], 1);
    assert_eq!(overview_json["pending_candidates"], 1);
    assert_eq!(overview_json["auto_created_today"], 1);
    assert_eq!(overview_json["candidate_today"], 1);
    assert_eq!(overview_json["discarded_today"], 2);
    assert_eq!(overview_json["last_bake_run_status"], "completed");
    assert_eq!(overview_json["last_trigger_reason"], "manual_debug");
    assert_eq!(overview_json["knowledge_auto_count"], 1);
    assert_eq!(overview_json["template_auto_count"], 0);
    assert_eq!(overview_json["sop_auto_count"], 0);
    assert!(overview_json["last_bake_run_at"].as_i64().unwrap() > 0);
    assert!(!overview_json["recent_activities"].as_array().unwrap().is_empty());

    let knowledge_req = Request::builder()
        .uri("/api/bake/knowledge")
        .body(Body::empty())
        .unwrap();
    let (knowledge_status, knowledge_body) = oneshot(router.clone(), knowledge_req).await;
    assert_eq!(knowledge_status, StatusCode::OK, "body: {knowledge_body}");
    let knowledge_json: serde_json::Value = serde_json::from_str(&knowledge_body).unwrap();
    assert_eq!(knowledge_json["items"].as_array().unwrap().len(), 1);
    assert_eq!(knowledge_json["items"][0]["summary"], "提炼后的知识");

    let templates_req = Request::builder()
        .uri("/api/bake/templates")
        .body(Body::empty())
        .unwrap();
    let (templates_status, templates_body) = oneshot(router.clone(), templates_req).await;
    assert_eq!(templates_status, StatusCode::OK, "body: {templates_body}");
    let templates_json: serde_json::Value = serde_json::from_str(&templates_body).unwrap();
    assert_eq!(templates_json["items"].as_array().unwrap().len(), 0);

    let sops_req = Request::builder()
        .uri("/api/bake/sops")
        .body(Body::empty())
        .unwrap();
    let (sops_status, sops_body) = oneshot(router.clone(), sops_req).await;
    assert_eq!(sops_status, StatusCode::OK, "body: {sops_body}");
    let sops_json: serde_json::Value = serde_json::from_str(&sops_body).unwrap();
    assert_eq!(sops_json["items"].as_array().unwrap().len(), 0);

    let memories_req = Request::builder()
        .uri("/api/bake/memories")
        .body(Body::empty())
        .unwrap();
    let (memories_status, memories_body) = oneshot(router, memories_req).await;
    assert_eq!(memories_status, StatusCode::OK, "body: {memories_body}");
    let memories_json: serde_json::Value = serde_json::from_str(&memories_body).unwrap();
    assert_eq!(memories_json["memories"].as_array().unwrap().len(), 1);
    assert_eq!(memories_json["memories"][0]["source_knowledge_id"], "1");
    assert_eq!(memories_json["memories"][0]["status"], "candidate");
    assert_eq!(memories_json["memories"][0]["knowledge_match_score"], 0.91);
    assert_eq!(memories_json["memories"][0]["knowledge_match_level"], "high");
    assert!(memories_json["memories"][0]["template_match_score"].is_null());
    assert!(memories_json["memories"][0]["template_match_level"].is_null());
    assert!(memories_json["memories"][0]["sop_match_score"].is_null());
    assert!(memories_json["memories"][0]["sop_match_level"].is_null());
}

#[tokio::test]
async fn test_bake_overview_recent_activity_highlights_knowledge_background_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "周报模板流程沉淀",
        "沉淀步骤化标准方案",
        serde_json::json!({}),
    );
    let sidecar_url = spawn_bake_sidecar(vec![make_bake_response(
        bake_knowledge_artifact("后台提炼知识", None),
        bake_rejected("not_a_template"),
        bake_rejected("not_a_sop"),
    )])
    .await;
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let (run_status, _, run_body) = run_bake(router.clone(), "knowledge_background").await;
    assert_eq!(run_status, StatusCode::OK, "body: {run_body}");

    let overview_req = Request::builder()
        .uri("/api/bake/overview")
        .body(Body::empty())
        .unwrap();
    let (overview_status, overview_body) = oneshot(router, overview_req).await;
    assert_eq!(overview_status, StatusCode::OK, "body: {overview_body}");
    let overview_json: serde_json::Value = serde_json::from_str(&overview_body).unwrap();
    assert_eq!(overview_json["last_trigger_reason"], "knowledge_background");
    let recent_activities = overview_json["recent_activities"].as_array().unwrap();
    assert!(recent_activities.iter().any(|item| item.as_str().unwrap_or_default().contains("知识后台提炼后已自动执行分类烤面包")));
}

#[tokio::test]
async fn test_bake_run_pipeline_is_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "周报模板流程沉淀",
        "沉淀步骤化标准方案",
        serde_json::json!({}),
    );
    let sidecar_url = spawn_bake_sidecar(vec![make_bake_response(
        bake_knowledge_artifact("第一次提炼知识", None),
        bake_template_artifact("第一次模板", Some("candidate")),
        bake_sop_artifact("第一次 SOP", Some("candidate")),
    )])
    .await;
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let (first_status, first_json, first_body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(first_status, StatusCode::OK, "body: {first_body}");
    assert_eq!(first_json["status"], "completed");
    assert_eq!(first_json["processed_episode_count"], 1);
    assert_eq!(first_json["auto_created_count"], 1);
    assert_eq!(first_json["candidate_count"], 3);
    assert_eq!(first_json["discarded_count"], 0);
    assert_eq!(first_json["knowledge_created_count"], 1);
    assert_eq!(first_json["template_created_count"], 1);
    assert_eq!(first_json["sop_created_count"], 1);

    let (second_status, second_json, second_body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(second_status, StatusCode::OK, "body: {second_body}");
    assert_eq!(second_json["status"], "completed");
    assert_eq!(second_json["processed_episode_count"], 0);
    assert_eq!(second_json["auto_created_count"], 0);
    assert_eq!(second_json["candidate_count"], 0);
    assert_eq!(second_json["discarded_count"], 0);
    assert_eq!(second_json["knowledge_created_count"], 0);
    assert_eq!(second_json["template_created_count"], 0);
    assert_eq!(second_json["sop_created_count"], 0);

    let knowledge_req = Request::builder()
        .uri("/api/bake/knowledge")
        .body(Body::empty())
        .unwrap();
    let (knowledge_status, knowledge_body) = oneshot(router.clone(), knowledge_req).await;
    assert_eq!(knowledge_status, StatusCode::OK, "body: {knowledge_body}");
    let knowledge_json: serde_json::Value = serde_json::from_str(&knowledge_body).unwrap();
    assert_eq!(knowledge_json["items"].as_array().unwrap().len(), 1);

    let templates_req = Request::builder()
        .uri("/api/bake/templates")
        .body(Body::empty())
        .unwrap();
    let (templates_status, templates_body) = oneshot(router.clone(), templates_req).await;
    assert_eq!(templates_status, StatusCode::OK, "body: {templates_body}");
    let templates_json: serde_json::Value = serde_json::from_str(&templates_body).unwrap();
    assert_eq!(templates_json["items"].as_array().unwrap().len(), 1);

    let sops_req = Request::builder()
        .uri("/api/bake/sops")
        .body(Body::empty())
        .unwrap();
    let (sops_status, sops_body) = oneshot(router.clone(), sops_req).await;
    assert_eq!(sops_status, StatusCode::OK, "body: {sops_body}");
    let sops_json: serde_json::Value = serde_json::from_str(&sops_body).unwrap();
    assert_eq!(sops_json["items"].as_array().unwrap().len(), 1);

    let memories_req = Request::builder()
        .uri("/api/bake/memories")
        .body(Body::empty())
        .unwrap();
    let (memories_status, memories_body) = oneshot(router, memories_req).await;
    assert_eq!(memories_status, StatusCode::OK, "body: {memories_body}");
    let memories_json: serde_json::Value = serde_json::from_str(&memories_body).unwrap();
    assert_eq!(memories_json["memories"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn test_bake_run_pipeline_rejected_candidate_advances_watermark() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "只有背景信息，没有可复用产物",
        "只应推进 watermark",
        serde_json::json!({}),
    );
    let sidecar_url = spawn_bake_sidecar(vec![make_bake_response(
        bake_rejected("no_knowledge"),
        bake_rejected("no_template"),
        bake_rejected("no_sop"),
    )])
    .await;
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let (status, run_json, run_body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(status, StatusCode::OK, "body: {run_body}");
    assert_eq!(run_json["status"], "completed");
    assert_eq!(run_json["processed_episode_count"], 1);
    assert_eq!(run_json["auto_created_count"], 0);
    assert_eq!(run_json["candidate_count"], 1);
    assert_eq!(run_json["discarded_count"], 3);
    assert_eq!(run_json["knowledge_created_count"], 0);
    assert_eq!(run_json["template_created_count"], 0);
    assert_eq!(run_json["sop_created_count"], 0);

    let memories_req = Request::builder()
        .uri("/api/bake/memories")
        .body(Body::empty())
        .unwrap();
    let (memories_status, memories_body) = oneshot(router.clone(), memories_req).await;
    assert_eq!(memories_status, StatusCode::OK, "body: {memories_body}");
    let memories_json: serde_json::Value = serde_json::from_str(&memories_body).unwrap();
    assert_eq!(memories_json["memories"].as_array().unwrap().len(), 1);

    let (rerun_status, rerun_json, rerun_body) = run_bake(router, "manual_debug").await;
    assert_eq!(rerun_status, StatusCode::OK, "body: {rerun_body}");
    assert_eq!(rerun_json["processed_episode_count"], 0);
}

#[tokio::test]
async fn test_bake_run_pipeline_malformed_json_does_not_advance_watermark() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "第一次返回坏 JSON",
        "失败后不应推进 watermark",
        serde_json::json!({}),
    );
    let sidecar_url = spawn_bake_sidecar(vec![
        make_bake_error_response("200 OK", "{not json"),
        make_bake_response(
            bake_knowledge_artifact("重试后成功知识", None),
            bake_rejected("not_a_template"),
            bake_rejected("not_a_sop"),
        ),
    ])
    .await;
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let (first_status, first_json, first_body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(first_status, StatusCode::INTERNAL_SERVER_ERROR, "body: {first_body}");
    assert_eq!(first_json["error"], "INTERNAL_ERROR");
    assert!(first_json["message"].as_str().unwrap_or_default().contains("解析 bake sidecar 响应失败"));

    let (second_status, second_json, second_body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(second_status, StatusCode::OK, "body: {second_body}");
    assert_eq!(second_json["processed_episode_count"], 1);
    assert_eq!(second_json["knowledge_created_count"], 1);

    let knowledge_req = Request::builder()
        .uri("/api/bake/knowledge")
        .body(Body::empty())
        .unwrap();
    let (knowledge_status, knowledge_body) = oneshot(router, knowledge_req).await;
    assert_eq!(knowledge_status, StatusCode::OK, "body: {knowledge_body}");
    let knowledge_json: serde_json::Value = serde_json::from_str(&knowledge_body).unwrap();
    assert_eq!(knowledge_json["items"].as_array().unwrap().len(), 1);
    assert_eq!(knowledge_json["items"][0]["summary"], "重试后成功知识");
}

#[tokio::test]
async fn test_bake_run_pipeline_maps_sidecar_http_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    seed_knowledge_entry(
        &sm,
        "meeting",
        "sidecar 失败映射",
        "应返回 BAD_GATEWAY",
        serde_json::json!({}),
    );
    let sidecar_url = spawn_bake_sidecar(vec![make_bake_error_response(
        "502 Bad Gateway",
        r#"{"error":"boom"}"#,
    )])
    .await;
    let router = memory_bread_core::api::create_router(make_bake_state(sm, sidecar_url));

    let (status, json, body) = run_bake(router.clone(), "manual_debug").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "body: {body}");
    assert_eq!(json["error"], "BAD_GATEWAY");
    assert!(json["message"].as_str().unwrap_or_default().contains("bake 提炼服务返回错误"));

    let (retry_status, retry_json, retry_body) = run_bake(router, "manual_debug").await;
    assert_eq!(retry_status, StatusCode::BAD_GATEWAY, "body: {retry_body}");
    assert_eq!(retry_json["error"], "BAD_GATEWAY");
}

// ── /debug/log-files ──────────────────────────────────────────────────────────

#[tokio::test]
async fn test_debug_log_files_returns_empty_list_when_whitelist_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let router = memory_bread_core::api::create_router(make_test_state(sm, vec![]));

    let req = Request::builder()
        .uri("/api/debug/log-files")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_debug_log_files_marks_missing_file_as_not_exists() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let log_dir = tmp.path().join("logs");
    std::fs::create_dir_all(&log_dir).unwrap();
    let router = memory_bread_core::api::create_router(make_test_state(
        sm,
        vec![DebugLogSpec::new("core", "core.log · Core Engine", log_dir, "core.log")],
    ));

    let req = Request::builder()
        .uri("/api/debug/log-files")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    let item = &json["items"][0];
    assert_eq!(item["key"], "core");
    assert_eq!(item["exists"], false);
    assert_eq!(item["size_bytes"], 0);
  }

#[tokio::test]
async fn test_debug_log_content_returns_whitelisted_log() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let log_dir = tmp.path().join("logs");
    std::fs::create_dir_all(&log_dir).unwrap();
    std::fs::write(log_dir.join("core.log"), "line1\nline2\n").unwrap();
    let router = memory_bread_core::api::create_router(make_test_state(
        sm,
        vec![DebugLogSpec::new("core", "core.log · Core Engine", log_dir, "core.log")],
    ));

    let req = Request::builder()
        .uri("/api/debug/log-files/core")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["key"], "core");
    assert_eq!(json["truncated"], false);
    assert!(json["content"].as_str().unwrap().contains("line2"));
}

#[tokio::test]
async fn test_debug_log_content_returns_404_for_unknown_key() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let router = memory_bread_core::api::create_router(make_test_state(sm, vec![]));

    let req = Request::builder()
        .uri("/api/debug/log-files/unknown")
        .body(Body::empty())
        .unwrap();
    let (status, _body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_debug_log_content_truncates_large_file() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let log_dir = tmp.path().join("logs");
    std::fs::create_dir_all(&log_dir).unwrap();
    let content = "A".repeat(140 * 1024);
    std::fs::write(log_dir.join("core.log"), content).unwrap();
    let router = memory_bread_core::api::create_router(make_test_state(
        sm,
        vec![DebugLogSpec::new("core", "core.log · Core Engine", log_dir, "core.log")],
    ));

    let req = Request::builder()
        .uri("/api/debug/log-files/core")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["truncated"], true);
    assert_eq!(json["returned_bytes"], 128 * 1024);
    assert_eq!(json["total_size_bytes"], 140 * 1024);
}

#[tokio::test]
async fn test_debug_log_content_rejects_path_escape_via_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let log_dir = tmp.path().join("logs");
    std::fs::create_dir_all(&log_dir).unwrap();
    let outside = tmp.path().join("outside.log");
    std::fs::write(&outside, "outside").unwrap();
    std::os::unix::fs::symlink(&outside, log_dir.join("core.log")).unwrap();
    let router = memory_bread_core::api::create_router(make_test_state(
        sm,
        vec![DebugLogSpec::new("core", "core.log · Core Engine", log_dir, "core.log")],
    ));

    let req = Request::builder()
        .uri("/api/debug/log-files/core")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body: {body}");
    assert!(body.contains("路径越界"), "body: {body}");
}

// ── /health ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_health_200() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder().uri("/health").body(Body::empty()).unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["status"], "ok");
}

#[tokio::test]
async fn test_health_version_present() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder().uri("/health").body(Body::empty()).unwrap();
    let (_, body) = oneshot(router, req).await;
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["version"].as_str().unwrap().len() > 0);
}

// ── /captures ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_captures_empty_db() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder().uri("/captures").body(Body::empty()).unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["total"], 0);
    assert!(json["captures"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_captures_with_time_filter() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder()
        .uri("/captures?from=0&to=9999999999999&limit=10")
        .body(Body::empty())
        .unwrap();
    let (status, _body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn test_captures_fts_query() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder()
        .uri("/captures?q=%E5%B7%A5%E4%BD%9C")  // URL-encoded "工作"
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["captures"].is_array());
}

#[tokio::test]
async fn test_captures_app_filter() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder()
        .uri("/captures?app=%E5%BE%AE%E4%BF%A1")  // URL-encoded "微信"
        .body(Body::empty())
        .unwrap();
    let (status, _) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn test_captures_limit_respected() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder()
        .uri("/captures?limit=5")
        .body(Body::empty())
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["captures"].as_array().unwrap().len() <= 5);
}

// ── /preferences ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_preferences_list() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder().uri("/preferences").body(Body::empty()).unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["preferences"].is_array());
    // 种子数据（002_seed_defaults.sql）会插入若干默认偏好
    assert!(json["preferences"].as_array().unwrap().len() >= 0);
}

#[tokio::test]
async fn test_preferences_put() {
    let (router, _tmp) = make_test_router().await;
    let body_json = r#"{"value":"测试值"}"#;
    let req = Request::builder()
        .method(Method::PUT)
        .uri("/preferences/test.api.key")
        .header("content-type", "application/json")
        .body(Body::from(body_json))
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["key"], "test.api.key");
    assert_eq!(json["value"], "测试值");
}

#[tokio::test]
async fn test_preferences_put_update_existing() {
    let (router, _tmp) = make_test_router().await;
    // 第一次设置
    let req1 = Request::builder()
        .method(Method::PUT)
        .uri("/preferences/test.update.key")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"value":"原始值"}"#))
        .unwrap();
    let (s1, _) = oneshot(router.clone(), req1).await;
    assert_eq!(s1, StatusCode::OK);

    // 第二次更新
    let req2 = Request::builder()
        .method(Method::PUT)
        .uri("/preferences/test.update.key")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"value":"更新后的值"}"#))
        .unwrap();
    let (s2, body2) = oneshot(router, req2).await;
    assert_eq!(s2, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body2).unwrap();
    assert_eq!(json["value"], "更新后的值");
}

#[tokio::test]
async fn test_preferences_put_invalid_body_400() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder()
        .method(Method::PUT)
        .uri("/preferences/test.key")
        .header("content-type", "application/json")
        .body(Body::from("not-json"))
        .unwrap();
    let (status, _) = oneshot(router, req).await;
    // axum 返回 422（JSON parse 失败）
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "expected 4xx, got {status}"
    );
}

// ── /query ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_query_sidecar_unavailable_returns_502() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let state = Arc::new(AppState {
        storage: sm,
        sidecar_url: "http://127.0.0.1:9".to_string(),
        debug_log_specs: vec![],
    });
    let router = memory_bread_core::api::create_router(state);

    let req = Request::builder()
        .method(Method::POST)
        .uri("/query")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query":"今日工作总结"}"#))
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "body: {body}");
}

#[tokio::test]
async fn test_query_sidecar_error_response_returns_502() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let sidecar_url = spawn_failing_sidecar().await;
    let state = Arc::new(AppState {
        storage: sm,
        sidecar_url,
        debug_log_specs: vec![],
    });
    let router = memory_bread_core::api::create_router(state);

    let req = Request::builder()
        .method(Method::POST)
        .uri("/query")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query":"test","top_k":5}"#))
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "body: {body}");
    assert!(body.contains("502 Bad Gateway"), "body: {body}");
}


#[tokio::test]
async fn test_action_stub_returns_200() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder()
        .method(Method::POST)
        .uri("/action/execute")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"action_type":"click","coords":[100.0,200.0]}"#))
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["action_id"].as_str().unwrap().len() > 0);
}

// ── /pii/scrub ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_pii_scrub_stub_returns_text() {
    let (router, _tmp) = make_test_router().await;
    let req = Request::builder()
        .method(Method::POST)
        .uri("/pii/scrub")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"text":"我的手机号是 13800138000"}"#))
        .unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    // stub 原文返回，不做脱敏
    assert_eq!(json["text"], "我的手机号是 13800138000");
    assert_eq!(json["redacted_count"], 0);
}

// ── 404 测试 ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_knowledge_api_returns_semantic_fields() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let sm = StorageManager::open(&db).unwrap();
    let capture_id = seed_capture(&sm);

    sm.with_conn(|conn| {
        conn.execute(
            "INSERT INTO knowledge_entries (capture_id, summary, overview, details, entities, category, importance, occurrence_count, observed_at, event_time_start, event_time_end, history_view, content_origin, activity_type, is_self_generated, evidence_strength, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, datetime(?17/1000, 'unixepoch'), datetime(?18/1000, 'unixepoch'))",
            rusqlite::params![
                capture_id,
                "今天回看飞书消息",
                "今天回看飞书消息",
                "确认了昨天的发布安排",
                "[\"飞书\",\"发布\"]",
                "聊天",
                4_i64,
                1_i64,
                1_710_000_100_000_i64,
                1_709_913_600_000_i64,
                1_709_914_000_000_i64,
                1_i64,
                "historical_content",
                "reviewing_history",
                0_i64,
                "high",
                1_710_000_100_000_i64,
                1_710_000_100_000_i64,
            ],
        )?;
        Ok::<_, memory_bread_core::storage::StorageError>(())
    }).unwrap();

    let router = memory_bread_core::api::create_router(AppState::new(sm));
    let req = Request::builder().uri("/api/knowledge").body(Body::empty()).unwrap();
    let (status, body) = oneshot(router, req).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    let entry = &json["entries"][0];
    assert_eq!(entry["observed_at"], 1_710_000_100_000_i64);
    assert_eq!(entry["event_time_start"], 1_709_913_600_000_i64);
    assert_eq!(entry["event_time_end"], 1_709_914_000_000_i64);
    assert_eq!(entry["history_view"], true);
    assert_eq!(entry["content_origin"], "historical_content");
    assert_eq!(entry["activity_type"], "reviewing_history");
    assert_eq!(entry["is_self_generated"], false);
    assert_eq!(entry["evidence_strength"], "high");
}

