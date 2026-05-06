//! POST /action/execute — 键鼠接管执行（stub，由 executor 模块实现后替换）

use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ActionRequest {
    /// 动作类型：click / type_text / hotkey / scroll
    pub action_type: String,
    /// 目标 Accessibility 节点 ID（可选）
    pub target_id: Option<String>,
    /// 目标坐标 [x, y]（可选）
    pub coords: Option<[f64; 2]>,
    /// 输入文本（type_text 时使用）
    pub text: Option<String>,
    /// 快捷键列表（hotkey 时使用）
    pub keys: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct ActionResponse {
    pub success: bool,
    pub message: String,
    pub action_id: String,
}

/// 占位实现：executor 模块完成后替换为真实的键鼠模拟逻辑。
pub async fn execute_action(Json(body): Json<ActionRequest>) -> Json<ActionResponse> {
    Json(ActionResponse {
        success: false,
        message: format!(
            "action '{}' 执行器正在开发中，请等待 executor 模块完成。",
            body.action_type
        ),
        action_id: uuid_stub(),
    })
}

fn uuid_stub() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("action-{ts}")
}
