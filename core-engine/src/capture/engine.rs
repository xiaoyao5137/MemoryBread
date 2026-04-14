//! CaptureEngine — 核心采集引擎
//!
//! 协调截图、AX 信息抓取、隐私过滤和 SQLite 存储。
//!
//! 设计模式：
//! - 事件通过 `tokio::sync::mpsc::Receiver<CaptureEvent>` 注入
//! - 引擎本身不包含事件监听逻辑（由 `listener` 模块或外部注入）
//! - 这使得引擎在测试中可以完全脱离系统 API 运行

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::ipc::IpcClient;
use crate::storage::{
    models::{EventType, NewCapture, NewVectorIndex},
    StorageManager,
};

use super::{
    ax::{get_frontmost_info_async, AXInfo},
    filter::PrivacyFilter,
    screenshot::{capture_and_save, hamming_distance},
    CaptureError,
};

// ─────────────────────────────────────────────────────────────────────────────
// CaptureConfig
// ─────────────────────────────────────────────────────────────────────────────

/// 采集引擎配置参数
#[derive(Debug, Clone)]
pub struct CaptureConfig {
    /// 截图根目录（绝对路径）
    pub captures_dir: PathBuf,
    /// JPEG 压缩质量 0–100（推荐 80）
    pub screenshot_quality: u8,
    /// 是否启用截图（可在低电量模式下关闭）
    pub enable_screenshot: bool,
    /// 是否启用 Accessibility 信息抓取
    pub enable_ax: bool,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        Self {
            captures_dir:       PathBuf::from(home).join(".memory-bread").join("captures"),
            screenshot_quality: 80,
            enable_screenshot:  true,
            enable_ax:          true,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CaptureEvent
// ─────────────────────────────────────────────────────────────────────────────

/// 触发一次采集的事件类型
#[derive(Debug, Clone)]
pub enum CaptureEvent {
    /// 前台应用发生切换（最高优先级）
    AppSwitch {
        app_name:  String,
        bundle_id: Option<String>,
        win_title: String,
    },
    /// 鼠标点击（在新位置落点）
    MouseClick { x: f64, y: f64 },
    /// 键盘停顿（2 秒无按键）
    KeyPause {
        /// 停顿前的键盘输入片段（已去除密码框内容）
        input_buffer: String,
    },
    /// 页面/内容滚动
    Scroll,
    /// 定时兜底采集（每 N 分钟触发）
    Periodic,
    /// 用户手动唤醒
    Manual,
}

impl CaptureEvent {
    /// 映射到数据库 event_type 字段。
    pub fn to_event_type(&self) -> EventType {
        match self {
            CaptureEvent::AppSwitch { .. }  => EventType::AppSwitch,
            CaptureEvent::MouseClick { .. } => EventType::MouseClick,
            CaptureEvent::KeyPause { .. }   => EventType::KeyPause,
            CaptureEvent::Scroll            => EventType::Scroll,
            CaptureEvent::Periodic          => EventType::Auto,
            CaptureEvent::Manual            => EventType::Manual,
        }
    }

    /// 提取键盘输入文本（仅 KeyPause 有值）。
    pub fn input_text(&self) -> Option<&str> {
        match self {
            CaptureEvent::KeyPause { input_buffer } => Some(input_buffer),
            _ => None,
        }
    }

    /// 提取事件携带的应用名（AppSwitch 专用）。
    pub fn app_name(&self) -> Option<&str> {
        match self {
            CaptureEvent::AppSwitch { app_name, .. } => Some(app_name),
            _ => None,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CaptureEngine
// ─────────────────────────────────────────────────────────────────────────────

/// 核心采集引擎，协调所有采集步骤。
#[derive(Debug, Clone, Default)]
struct CachedContext {
    app_name: Option<String>,
    app_bundle_id: Option<String>,
    win_title: Option<String>,
    focused_role: Option<String>,
    focused_id: Option<String>,
}

impl CachedContext {
    fn has_context(&self) -> bool {
        self.app_name.is_some() || self.win_title.is_some() || self.app_bundle_id.is_some()
    }

    fn from_ax_info(info: &AXInfo) -> Self {
        Self {
            app_name: info.app_name.clone(),
            app_bundle_id: info.app_bundle_id.clone(),
            win_title: info.win_title.clone(),
            focused_role: info.focused_role.clone(),
            focused_id: info.focused_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct PeriodicSceneKey {
    app_identity: String,
    win_title: String,
}

impl PeriodicSceneKey {
    fn from_ax_info(info: &AXInfo) -> Option<Self> {
        let app_identity = info
            .app_bundle_id
            .as_deref()
            .or(info.app_name.as_deref())?
            .trim();
        if app_identity.is_empty() {
            return None;
        }

        let win_title = info.win_title.as_deref().unwrap_or("").trim();
        Some(Self {
            app_identity: app_identity.to_string(),
            win_title: win_title.to_string(),
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct RecentFrameFingerprint {
    ts_ms: i64,
    dhash: u64,
}

const PERIODIC_DEDUP_WINDOW_MS: i64 = 5 * 60 * 1000;
const PERIODIC_DHASH_SKIP_DISTANCE: u32 = 1;
const PERIODIC_MAX_RECENT_PER_SCENE: usize = 8;

pub struct CaptureEngine {
    storage: StorageManager,
    config:  CaptureConfig,
    filter:  PrivacyFilter,
    ipc_client: Option<IpcClient>,
    last_context: Mutex<Option<CachedContext>>,
    recent_periodic_frames: Mutex<HashMap<PeriodicSceneKey, VecDeque<RecentFrameFingerprint>>>,
}

impl CaptureEngine {
    /// 使用默认隐私过滤器创建引擎。
    pub fn new(storage: StorageManager, config: CaptureConfig) -> Self {
        let ipc_client = IpcClient::new();
        if ipc_client.is_available() {
            info!("检测到 AI Sidecar socket，OCR 将在运行时按需连接");
        } else {
            warn!("启动时未检测到 AI Sidecar socket，稍后可自动恢复 OCR 连接");
        }

        Self {
            storage,
            config,
            filter: PrivacyFilter::new(),
            ipc_client: Some(ipc_client),
            last_context: Mutex::new(None),
            recent_periodic_frames: Mutex::new(HashMap::new()),
        }
    }

    /// 使用自定义隐私过滤器创建引擎（从数据库 app_filters 加载后使用）。
    pub fn with_filter(
        storage: StorageManager,
        config:  CaptureConfig,
        filter:  PrivacyFilter,
    ) -> Self {
        let ipc_client = IpcClient::new();
        if ipc_client.is_available() {
            info!("检测到 AI Sidecar socket，OCR 将在运行时按需连接");
        } else {
            warn!("启动时未检测到 AI Sidecar socket，稍后可自动恢复 OCR 连接");
        }

        Self {
            storage,
            config,
            filter,
            ipc_client: Some(ipc_client),
            last_context: Mutex::new(None),
            recent_periodic_frames: Mutex::new(HashMap::new()),
        }
    }

    // ── 主处理流程 ─────────────────────────────────────────────────────────

    /// 处理一个采集事件：截图 + AX 抓取 + 隐私过滤 + DB 写入。
    ///
    /// 返回 `Ok(Some(id))`：已写入数据库的 capture id（含被过滤的记录）。
    pub async fn process_event(
        &self,
        event: CaptureEvent,
    ) -> Result<Option<i64>, CaptureError> {
        let ts = current_ts_ms();

        // 1. 抓取 Accessibility 信息（异步 + 超时保护）
        let ax_info = if self.config.enable_ax {
            get_frontmost_info_async().await
        } else {
            None
        };

        let ax_missing = ax_info.is_none();

        // 2. 合并事件携带的信息、AX 抓取结果和最近一次成功上下文
        let merged = self.merge_ax_and_event(&event, ax_info);
        let cache_hit = ax_missing
            && (merged.app_name.is_some() || merged.win_title.is_some() || merged.app_bundle_id.is_some());
        let is_periodic_event = matches!(event, CaptureEvent::Periodic);
        let has_ax_text = has_meaningful_ax_text(&merged);
        let has_input_text = has_meaningful_input_text(&event);

        debug!(
            event = ?event.to_event_type(),
            ax_missing,
            cache_hit,
            app = ?merged.app_name,
            win_title = ?merged.win_title,
            ax_text_len = merged.extracted_text.as_ref().map(|t| t.len()),
            "AX 与上下文合并完成"
        );

        // 3. 隐私过滤
        let is_sensitive = self.filter.is_sensitive(
            merged.app_name.as_deref(),
            merged.app_bundle_id.as_deref(),
            merged.focused_role.as_deref(),
            merged.win_title.as_deref(),
        );

        if is_sensitive {
            debug!(
                app = ?merged.app_name,
                bundle_id = ?merged.app_bundle_id,
                focused_role = ?merged.focused_role,
                win_title = ?merged.win_title,
                "隐私窗口已过滤，记录占位行"
            );
            let id = self.save_capture(
                ts,
                &merged,
                &event,
                None,   // 不截图
                true,   // is_sensitive
            )?;
            return Ok(Some(id));
        }

        // 4. 截图 / periodic 去重策略
        let mut screenshot_path = None;
        let mut periodic_screenshot_dhash = None;
        if is_periodic_event {
            if has_ax_text {
                debug!(event = ?event.to_event_type(), "跳过截图：periodic_ax_present_lightweight_mode");
            } else if !self.config.enable_screenshot {
                debug!(event = ?event.to_event_type(), "跳过入库：periodic_ax_missing_without_screenshot");
                return Ok(None);
            } else if let Some(result) = capture_and_save(&self.config.captures_dir, self.config.screenshot_quality)? {
                let duplicate = self.should_skip_periodic_capture(&merged, ts, result.dhash);
                if duplicate {
                    delete_screenshot_file(&result.full_path);
                    debug!(
                        event = ?event.to_event_type(),
                        path = %result.relative_path,
                        "跳过入库：periodic_visual_duplicate"
                    );
                    return Ok(None);
                }

                debug!(path = %result.relative_path, dhash = result.dhash, "periodic 截图已保存，等待 OCR 兜底");
                periodic_screenshot_dhash = Some(result.dhash);
                screenshot_path = Some(result.relative_path);
            } else {
                debug!(event = ?event.to_event_type(), "跳过入库：periodic_ax_missing_without_screenshot_result");
                return Ok(None);
            }
        } else if self.config.enable_screenshot {
            match capture_and_save(&self.config.captures_dir, self.config.screenshot_quality)? {
                Some(result) => {
                    debug!(path = %result.relative_path, "截图已保存");
                    screenshot_path = Some(result.relative_path);
                }
                None => {}
            }
        }

        if !has_ax_text && screenshot_path.is_none() && !has_input_text {
            debug!(
                event = ?event.to_event_type(),
                app = ?merged.app_name,
                win_title = ?merged.win_title,
                "跳过入库：empty_capture_payload"
            );
            return Ok(None);
        }

        // 5. 写入数据库
        let id = self.save_capture(ts, &merged, &event, screenshot_path.clone(), false)?;
        self.update_cached_context(&merged);
        if is_periodic_event {
            if let (Some(scene_key), Some(dhash)) = (
                PeriodicSceneKey::from_ax_info(&merged),
                periodic_screenshot_dhash,
            ) {
                self.record_periodic_frame(scene_key, ts, dhash);
            }
        }
        debug!(
            id,
            event = ?event.to_event_type(),
            app = ?merged.app_name,
            win_title = ?merged.win_title,
            ax_text_len = merged.extracted_text.as_ref().map(|t| t.len()),
            screenshot = screenshot_path.is_some(),
            "采集完成"
        );

        // 6. 异步调用 OCR（只要 AX 正文缺失且有截图就允许）
        if !has_ax_text {
            if screenshot_path.is_none() {
                debug!(id, "跳过 OCR：no_screenshot");
            } else if let Some(ref ipc_client) = self.ipc_client {
                let screenshot_path = screenshot_path.unwrap();
                let full_path = self.config.captures_dir.join(&screenshot_path);

                // 先检查 Sidecar 是否在线
                if !ipc_client.ping().await {
                    debug!(id, app = ?merged.app_name, "跳过 OCR：sidecar_offline");
                } else {
                    debug!(id, path = %screenshot_path, "触发 OCR：ax_missing");
                    // 异步调用 OCR（带超时保护）
                    let ipc_client = ipc_client.clone();
                    let storage = self.storage.clone();
                    tokio::spawn(async move {
                        match tokio::time::timeout(
                            Duration::from_secs(15),
                            tokio::task::spawn_blocking({
                                let client = ipc_client.clone();
                                let path = full_path.to_str().unwrap().to_string();
                                move || client.call_ocr(id, &path)
                            }),
                        )
                        .await
                        {
                            Ok(Ok(Ok(ocr_result))) => {
                                debug!(
                                    id,
                                    confidence = ocr_result.confidence,
                                    text_len = ocr_result.text.len(),
                                    "OCR 识别成功"
                                );
                                if let Err(e) = storage.update_ocr_text(
                                    id,
                                    &ocr_result.text,
                                    ocr_result.confidence as f32,
                                ) {
                                    warn!(id, "更新 OCR 文本失败: {}", e);
                                    return;
                                }

                                debug!(id, "OCR 文本已回写，等待后台批处理统一向量化");
                            }
                            Ok(Ok(Err(e))) => {
                                warn!(id, "OCR 调用失败: {}", e);
                            }
                            Ok(Err(e)) => {
                                warn!(id, "OCR 任务崩溃: {:?}", e);
                            }
                            Err(_) => {
                                warn!(id, "OCR 超时（15 秒）");
                            }
                        }
                    });
                }
            } else {
                debug!(id, app = ?merged.app_name, "跳过 OCR：sidecar_unavailable");
            }
        } else {
            debug!(id, ax_text_len = merged.extracted_text.as_ref().map(|t| t.len()), "跳过 OCR：ax_present，等待后台批处理统一向量化");
        }

        Ok(Some(id))
    }

    /// 启动事件处理循环（生产环境入口）。
    ///
    /// 从 channel 持续接收事件直到发送端关闭。
    pub async fn run(
        self,
        mut rx: mpsc::Receiver<CaptureEvent>,
    ) -> Result<(), CaptureError> {
        info!("CaptureEngine 已启动");

        while let Some(event) = rx.recv().await {
            match self.process_event(event).await {
                Ok(Some(id)) => debug!(id, "事件处理完成"),
                Ok(None)     => {}
                Err(e)       => warn!("事件处理失败: {}", e),
            }
        }

        info!("CaptureEngine 退出（channel 已关闭）");
        Ok(())
    }

    // ── 辅助方法 ──────────────────────────────────────────────────────────

    /// 合并事件内置信息、AX 抓取结果与最近一次成功上下文。
    ///
    /// 优先级：事件显式字段 > 当前 AX 成功值 > 最近缓存值。
    fn merge_ax_and_event(&self, event: &CaptureEvent, ax: Option<AXInfo>) -> AXInfo {
        let cached = self.last_context
            .lock()
            .ok()
            .and_then(|guard| guard.clone());

        let mut info = ax.unwrap_or_default();

        if let Some(cached) = cached {
            if info.app_name.is_none() {
                info.app_name = cached.app_name;
            }
            if info.app_bundle_id.is_none() {
                info.app_bundle_id = cached.app_bundle_id;
            }
            if info.win_title.is_none() {
                info.win_title = cached.win_title;
            }
            if info.focused_role.is_none() {
                info.focused_role = cached.focused_role;
            }
            if info.focused_id.is_none() {
                info.focused_id = cached.focused_id;
            }
        }

        if let CaptureEvent::AppSwitch { app_name, bundle_id, win_title } = event {
            info.app_name  = Some(app_name.clone());
            info.win_title = Some(win_title.clone());
            if let Some(bid) = bundle_id {
                info.app_bundle_id = Some(bid.clone());
            }
        }

        info
    }

    fn update_cached_context(&self, info: &AXInfo) {
        let context = CachedContext::from_ax_info(info);
        if !context.has_context() {
            return;
        }

        if let Ok(mut guard) = self.last_context.lock() {
            *guard = Some(context);
        }
    }

    fn should_skip_periodic_capture(&self, info: &AXInfo, ts: i64, dhash: u64) -> bool {
        let Some(scene_key) = PeriodicSceneKey::from_ax_info(info) else {
            return false;
        };

        let Ok(mut guard) = self.recent_periodic_frames.lock() else {
            return false;
        };

        let entry = guard.entry(scene_key).or_default();
        prune_recent_frames(entry, ts);
        entry.iter().any(|frame| hamming_distance(frame.dhash, dhash) <= PERIODIC_DHASH_SKIP_DISTANCE)
    }

    fn record_periodic_frame(&self, scene_key: PeriodicSceneKey, ts: i64, dhash: u64) {
        let Ok(mut guard) = self.recent_periodic_frames.lock() else {
            return;
        };

        let entry = guard.entry(scene_key).or_default();
        prune_recent_frames(entry, ts);
        entry.push_back(RecentFrameFingerprint { ts_ms: ts, dhash });
        while entry.len() > PERIODIC_MAX_RECENT_PER_SCENE {
            entry.pop_front();
        }
    }

    /// 构造并写入 captures 记录。
    fn save_capture(
        &self,
        ts:              i64,
        ax:              &AXInfo,
        event:           &CaptureEvent,
        screenshot_path: Option<String>,
        is_sensitive:    bool,
    ) -> Result<i64, CaptureError> {
        let new_capture = NewCapture {
            ts,
            app_name:        ax.app_name.clone(),
            app_bundle_id:   ax.app_bundle_id.clone(),
            // 敏感记录不保存窗口标题
            win_title:       if is_sensitive { None } else { ax.win_title.clone() },
            event_type:      event.to_event_type(),
            // 敏感记录不保存文本
            ax_text:         if is_sensitive { None } else { ax.extracted_text.clone() },
            ax_focused_role: if is_sensitive { None } else { ax.focused_role.clone() },
            ax_focused_id:   if is_sensitive { None } else { ax.focused_id.clone() },
            screenshot_path,
            input_text:      if is_sensitive { None } else { event.input_text().map(str::to_string) },
            is_sensitive,
        };
        Ok(self.storage.insert_capture(&new_capture)?)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

fn current_ts_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_millis() as i64
}

fn has_meaningful_ax_text(info: &AXInfo) -> bool {
    info.extracted_text
        .as_deref()
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false)
}

fn has_meaningful_input_text(event: &CaptureEvent) -> bool {
    event.input_text()
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false)
}

fn prune_recent_frames(frames: &mut VecDeque<RecentFrameFingerprint>, now_ts: i64) {
    while let Some(front) = frames.front() {
        if now_ts - front.ts_ms > PERIODIC_DEDUP_WINDOW_MS {
            frames.pop_front();
        } else {
            break;
        }
    }
}

fn delete_screenshot_file(path: &std::path::Path) {
    if let Err(err) = std::fs::remove_file(path) {
        warn!(path = ?path, "删除去重截图失败: {}", err);
    }
}

impl CaptureEngine {
    /// 触发文本向量化并写入向量库
    ///
    /// 流程：
    /// 1. 调用 AI Sidecar 的 Embedding API
    /// 2. 将向量元数据写入 SQLite vector_index 表
    /// 3. 实际向量数据由 Sidecar 写入 Qdrant
    async fn trigger_embedding(
        ipc_client: IpcClient,
        storage: StorageManager,
        capture_id: i64,
        text: String,
    ) {
        // 文本太短不值得向量化
        if text.trim().len() < 10 {
            debug!(capture_id, "文本过短，跳过向量化");
            return;
        }

        // 调用 Embedding API
        match ipc_client.call_embed(capture_id, vec![text.clone()]) {
            Ok(embed_result) => {
                debug!(
                    capture_id,
                    vector_count = embed_result.vectors.len(),
                    "Embedding 成功"
                );

                // 为每个向量生成唯一的 point_id（Qdrant 使用 UUID）
                let point_id = uuid::Uuid::new_v4().to_string();

                // 写入 vector_index 元数据
                let created_at = current_ts_ms();
                let index = NewVectorIndex {
                    capture_id,
                    qdrant_point_id: point_id,
                    chunk_index: 0, // 单文本不分块
                    chunk_text: text,
                    model_name: "bge-m3".to_string(), // 与 AI Sidecar 保持一致
                    created_at,
                    doc_key: format!("capture:{}", capture_id),
                    source_type: "capture".to_string(),
                    knowledge_id: None,
                    time: Some(created_at),
                    start_time: None,
                    end_time: None,
                    observed_at: None,
                    event_time_start: None,
                    event_time_end: None,
                    history_view: false,
                    content_origin: None,
                    activity_type: None,
                    is_self_generated: false,
                    evidence_strength: None,
                    app_name: None,
                    win_title: None,
                    category: None,
                    user_verified: false,
                };

                if let Err(e) = storage.insert_vector_index(&index) {
                    warn!(capture_id, "写入向量索引元数据失败: {}", e);
                } else {
                    debug!(capture_id, "向量索引元数据已写入");
                }
            }
            Err(e) => {
                warn!(capture_id, "Embedding 调用失败: {}", e);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::screenshot::{clear_test_screenshots, push_test_screenshot_from_image};
    use crate::storage::repo::capture::CaptureFilter;
    use crate::storage::StorageManager;
    use image::{DynamicImage, GrayImage, Luma};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn make_test_captures_dir() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let suffix = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("memory-bread-test-captures-{}-{}", current_ts_ms(), suffix));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 创建测试用引擎（关闭截图和 AX，全部走 mock）
    fn make_engine() -> CaptureEngine {
        let storage = StorageManager::open_in_memory().unwrap();
        let config = CaptureConfig {
            captures_dir:       make_test_captures_dir(),
            enable_screenshot:  false,
            enable_ax:         false,
            ..Default::default()
        };
        CaptureEngine::new(storage, config)
    }

    fn make_engine_with_screenshot() -> CaptureEngine {
        let storage = StorageManager::open_in_memory().unwrap();
        let config = CaptureConfig {
            captures_dir:       make_test_captures_dir(),
            enable_screenshot:  true,
            enable_ax:         false,
            ..Default::default()
        };
        CaptureEngine::new(storage, config)
    }

    fn gradient_image(offset: u8) -> DynamicImage {
        let mut image = GrayImage::new(64, 64);
        for y in 0..64 {
            for x in 0..64 {
                let value = x as u8 ^ offset ^ ((y as u8) >> 2);
                image.put_pixel(x, y, Luma([value]));
            }
        }
        DynamicImage::ImageLuma8(image)
    }

    // ── 单事件处理 ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_mouse_click_without_payload_skips_insert() {
        let engine = make_engine();
        let result = engine
            .process_event(CaptureEvent::MouseClick { x: 100.0, y: 200.0 })
            .await
            .unwrap();

        assert!(result.is_none());
        let list = engine.storage.list_captures(&CaptureFilter::new()).unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn test_key_pause_stores_input_text() {
        let engine = make_engine();
        let id = engine
            .process_event(CaptureEvent::KeyPause {
                input_buffer: "你好世界".into(),
            })
            .await
            .unwrap()
            .unwrap();

        let rec = engine.storage.get_capture(id).unwrap().unwrap();
        assert_eq!(rec.event_type, "key_pause");
        assert_eq!(rec.input_text.as_deref(), Some("你好世界"));
    }

    #[tokio::test]
    async fn test_key_pause_with_blank_input_skips_insert() {
        let engine = make_engine();
        let result = engine
            .process_event(CaptureEvent::KeyPause {
                input_buffer: "   ".into(),
            })
            .await
            .unwrap();

        assert!(result.is_none());
        let list = engine.storage.list_captures(&CaptureFilter::new()).unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn test_app_switch_without_payload_skips_insert() {
        let engine = make_engine();
        let result = engine
            .process_event(CaptureEvent::AppSwitch {
                app_name:  "Feishu".into(),
                bundle_id: Some("com.feishu.feishu".into()),
                win_title: "工作群".into(),
            })
            .await
            .unwrap();

        assert!(result.is_none());
        let list = engine.storage.list_captures(&CaptureFilter::new()).unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn test_app_switch_with_ax_text_stores_app_info() {
        let engine = make_engine();
        let ts = current_ts_ms();
        let ax = AXInfo {
            app_name: Some("Feishu".into()),
            app_bundle_id: Some("com.feishu.feishu".into()),
            win_title: Some("工作群".into()),
            extracted_text: Some("项目同步中".into()),
            ..Default::default()
        };

        let id = engine
            .save_capture(ts, &ax, &CaptureEvent::AppSwitch {
                app_name:  "Feishu".into(),
                bundle_id: Some("com.feishu.feishu".into()),
                win_title: "工作群".into(),
            }, None, false)
            .unwrap();

        let rec = engine.storage.get_capture(id).unwrap().unwrap();
        assert_eq!(rec.event_type, "app_switch");
        assert_eq!(rec.app_name.as_deref(), Some("Feishu"));
        assert_eq!(rec.app_bundle_id.as_deref(), Some("com.feishu.feishu"));
        assert_eq!(rec.win_title.as_deref(), Some("工作群"));
        assert_eq!(rec.ax_text.as_deref(), Some("项目同步中"));
    }

    #[tokio::test]
    async fn test_scroll_without_payload_skips_insert() {
        let engine = make_engine();
        let result = engine.process_event(CaptureEvent::Scroll).await.unwrap();

        assert!(result.is_none());
        let list = engine.storage.list_captures(&CaptureFilter::new()).unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn test_periodic_event() {
        let engine = make_engine();
        let result = engine
            .process_event(CaptureEvent::Periodic)
            .await
            .unwrap();

        assert!(result.is_none());
        let list = engine.storage.list_captures(&CaptureFilter::new()).unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn test_periodic_with_ax_text_stays_lightweight() {
        let engine = make_engine_with_screenshot();
        let ts = current_ts_ms();
        let ax = AXInfo {
            app_name: Some("Chrome".into()),
            app_bundle_id: Some("com.google.Chrome".into()),
            win_title: Some("Doc".into()),
            extracted_text: Some("这是一段 AX 正文".into()),
            ..Default::default()
        };

        let id = engine
            .save_capture(ts, &ax, &CaptureEvent::Periodic, None, false)
            .unwrap();
        let rec = engine.storage.get_capture(id).unwrap().unwrap();
        assert_eq!(rec.event_type, "auto");
        assert!(rec.screenshot_path.is_none());
        assert_eq!(rec.ax_text.as_deref(), Some("这是一段 AX 正文"));
    }

    #[tokio::test]
    async fn test_periodic_ax_missing_without_screenshot_skips_insert() {
        let engine = make_engine();
        engine.update_cached_context(&AXInfo {
            app_name: Some("Chrome".into()),
            app_bundle_id: Some("com.google.Chrome".into()),
            win_title: Some("Doc".into()),
            ..Default::default()
        });

        let result = engine.process_event(CaptureEvent::Periodic).await.unwrap();
        assert!(result.is_none());

        let list = engine.storage.list_captures(&CaptureFilter::new()).unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn test_periodic_ax_missing_with_new_frame_inserts_capture_and_keeps_screenshot() {
        clear_test_screenshots();
        let engine = make_engine_with_screenshot();
        engine.update_cached_context(&AXInfo {
            app_name: Some("Chrome".into()),
            app_bundle_id: Some("com.google.Chrome".into()),
            win_title: Some("Doc".into()),
            ..Default::default()
        });
        push_test_screenshot_from_image(&gradient_image(0));

        let id = engine
            .process_event(CaptureEvent::Periodic)
            .await
            .unwrap()
            .unwrap();

        let rec = engine.storage.get_capture(id).unwrap().unwrap();
        assert_eq!(rec.event_type, "auto");
        assert!(rec.screenshot_path.is_some());
        assert!(rec.ax_text.is_none());
    }

    #[tokio::test]
    async fn test_periodic_ax_missing_duplicate_frame_skips_insert_and_deletes_file() {
        clear_test_screenshots();
        let engine = make_engine_with_screenshot();
        engine.update_cached_context(&AXInfo {
            app_name: Some("Chrome".into()),
            app_bundle_id: Some("com.google.Chrome".into()),
            win_title: Some("Doc".into()),
            ..Default::default()
        });
        let screenshot_dir = engine.config.captures_dir.join("screenshots");
        let baseline_files = std::fs::read_dir(&screenshot_dir)
            .ok()
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or(0);
        push_test_screenshot_from_image(&gradient_image(0));
        let first_id = engine
            .process_event(CaptureEvent::Periodic)
            .await
            .unwrap()
            .unwrap();
        let first = engine.storage.get_capture(first_id).unwrap().unwrap();
        let first_path = engine
            .config
            .captures_dir
            .join(first.screenshot_path.as_deref().unwrap());
        assert!(first_path.exists());

        push_test_screenshot_from_image(&gradient_image(0));
        let result = engine.process_event(CaptureEvent::Periodic).await.unwrap();
        assert!(result.is_none());

        let list = engine.storage.list_captures(&CaptureFilter::new()).unwrap();
        assert_eq!(list.len(), 1);

        let screenshot_files = std::fs::read_dir(&screenshot_dir)
            .ok()
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or(0);
        assert_eq!(screenshot_files, baseline_files + 1, "重复截图文件应被清理");
    }

    #[test]
    fn test_periodic_dedup_distance_threshold() {
        let engine = make_engine_with_screenshot();
        let info = AXInfo {
            app_name: Some("Chrome".into()),
            app_bundle_id: Some("com.google.Chrome".into()),
            win_title: Some("Doc".into()),
            ..Default::default()
        };
        let scene_key = PeriodicSceneKey::from_ax_info(&info).unwrap();
        let now = current_ts_ms();

        engine.record_periodic_frame(scene_key.clone(), now, 0);
        assert!(engine.should_skip_periodic_capture(&info, now, 1));
        assert!(!engine.should_skip_periodic_capture(&info, now, 3));

        engine.record_periodic_frame(scene_key, now - PERIODIC_DEDUP_WINDOW_MS - 1, 0);
        assert!(!engine.should_skip_periodic_capture(&info, now, 3));
    }

    #[test]
    fn test_periodic_dedup_expired_frame_no_longer_skips() {
        let engine = make_engine_with_screenshot();
        let info = AXInfo {
            app_name: Some("Chrome".into()),
            app_bundle_id: Some("com.google.Chrome".into()),
            win_title: Some("Doc".into()),
            ..Default::default()
        };
        let scene_key = PeriodicSceneKey::from_ax_info(&info).unwrap();
        let now = current_ts_ms();

        engine.record_periodic_frame(scene_key, now - PERIODIC_DEDUP_WINDOW_MS - 10, 0);
        assert!(!engine.should_skip_periodic_capture(&info, now, 0));
    }

    #[test]
    fn test_periodic_dedup_different_scene_key_does_not_collide() {
        let engine = make_engine_with_screenshot();
        let chrome = AXInfo {
            app_name: Some("Chrome".into()),
            app_bundle_id: Some("com.google.Chrome".into()),
            win_title: Some("Doc".into()),
            ..Default::default()
        };
        let safari = AXInfo {
            app_name: Some("Safari".into()),
            app_bundle_id: Some("com.apple.Safari".into()),
            win_title: Some("Doc".into()),
            ..Default::default()
        };
        let now = current_ts_ms();

        engine.record_periodic_frame(PeriodicSceneKey::from_ax_info(&chrome).unwrap(), now, 0);
        assert!(!engine.should_skip_periodic_capture(&safari, now, 0));
    }

    // ── 隐私过滤 ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_blocked_app_records_sensitive_row() {
        let storage = StorageManager::open_in_memory().unwrap();
        let config = CaptureConfig {
            enable_screenshot: false,
            enable_ax:         false,
            ..Default::default()
        };
        let filter = PrivacyFilter::new()
            .with_extra_blocked_apps(&["SecretApp".into()]);
        let engine = CaptureEngine::with_filter(storage, config, filter);

        let id = engine
            .process_event(CaptureEvent::AppSwitch {
                app_name:  "SecretApp".into(),
                bundle_id: None,
                win_title: "Secret Window".into(),
            })
            .await
            .unwrap()
            .unwrap();

        let rec = engine.storage.get_capture(id).unwrap().unwrap();
        assert!(rec.is_sensitive,         "应标记为敏感");
        assert!(rec.ax_text.is_none(),    "敏感记录不含文本");
        assert!(rec.win_title.is_none(),  "敏感记录不含标题");
        assert!(rec.input_text.is_none(), "敏感记录不含输入");
        // app_name 保留（用于统计）
        assert_eq!(rec.app_name.as_deref(), Some("SecretApp"));
    }

    #[tokio::test]
    async fn test_wechat_blocked_app_records_sensitive_row() {
        let storage = StorageManager::open_in_memory().unwrap();
        let config = CaptureConfig {
            enable_screenshot: false,
            enable_ax:         false,
            ..Default::default()
        };
        let filter = PrivacyFilter::new().with_extra_blocked_apps(&["WeChat".into()]);
        let engine = CaptureEngine::with_filter(storage, config, filter);

        let id = engine
            .process_event(CaptureEvent::AppSwitch {
                app_name: "WeChat".into(),
                bundle_id: Some("com.tencent.xinWeChat".into()),
                win_title: "微信聊天".into(),
            })
            .await
            .unwrap()
            .unwrap();

        let rec = engine.storage.get_capture(id).unwrap().unwrap();
        assert!(rec.is_sensitive, "WeChat 黑名单命中后应标记为敏感");
        assert!(rec.screenshot_path.is_none(), "敏感记录不应截图");
        assert!(rec.ax_text.is_none(), "敏感记录不应保留 AX 文本");
    }

    #[tokio::test]
    async fn test_default_blocked_app_1password() {
        let storage = StorageManager::open_in_memory().unwrap();
        let config = CaptureConfig {
            enable_screenshot: false,
            enable_ax:         false,
            ..Default::default()
        };
        let engine = CaptureEngine::new(storage, config);

        let id = engine
            .process_event(CaptureEvent::AppSwitch {
                app_name:  "1Password".into(),
                bundle_id: None,
                win_title: "Unlock 1Password".into(),
            })
            .await
            .unwrap()
            .unwrap();

        let rec = engine.storage.get_capture(id).unwrap().unwrap();
        assert!(rec.is_sensitive);
    }

    // ── channel 事件循环 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn test_run_loop_processes_multiple_events() {
        let storage = StorageManager::open_in_memory().unwrap();
        let storage_clone = storage.clone();

        let config = CaptureConfig {
            enable_screenshot: false,
            enable_ax:         false,
            ..Default::default()
        };
        let engine = CaptureEngine::new(storage, config);
        let (tx, rx) = mpsc::channel::<CaptureEvent>(16);

        // 发送 4 个事件后关闭 channel，仅保留带输入文本的 key pause
        tx.send(CaptureEvent::Manual).await.unwrap();
        tx.send(CaptureEvent::Periodic).await.unwrap();
        tx.send(CaptureEvent::Scroll).await.unwrap();
        tx.send(CaptureEvent::KeyPause { input_buffer: "hello".into() }).await.unwrap();
        drop(tx); // channel 关闭后 run() 返回

        engine.run(rx).await.unwrap();

        let list = storage_clone.list_captures(&CaptureFilter::new()).unwrap();
        assert_eq!(list.len(), 1, "空壳事件应被统一跳过，仅保留带输入文本的 key_pause");
        assert_eq!(list[0].event_type, "key_pause");
        assert_eq!(list[0].input_text.as_deref(), Some("hello"));
    }

    // ── CaptureEvent 方法 ─────────────────────────────────────────────────

    #[test]
    fn test_event_to_event_type_mapping() {
        use crate::storage::models::EventType;
        assert_eq!(CaptureEvent::Periodic.to_event_type(),                 EventType::Auto);
        assert_eq!(CaptureEvent::Manual.to_event_type(),                   EventType::Manual);
        assert_eq!(CaptureEvent::Scroll.to_event_type(),                   EventType::Scroll);
        assert_eq!(CaptureEvent::MouseClick { x: 0.0, y: 0.0 }.to_event_type(), EventType::MouseClick);
        assert_eq!(
            CaptureEvent::KeyPause { input_buffer: "".into() }.to_event_type(),
            EventType::KeyPause
        );
        assert_eq!(
            CaptureEvent::AppSwitch {
                app_name: "".into(), bundle_id: None, win_title: "".into()
            }.to_event_type(),
            EventType::AppSwitch
        );
    }

    #[test]
    fn test_event_input_text() {
        let e1 = CaptureEvent::KeyPause { input_buffer: "hello".into() };
        assert_eq!(e1.input_text(), Some("hello"));
        assert!(has_meaningful_input_text(&e1));

        let e2 = CaptureEvent::Manual;
        assert!(e2.input_text().is_none());
        assert!(!has_meaningful_input_text(&e2));

        let e3 = CaptureEvent::MouseClick { x: 1.0, y: 2.0 };
        assert!(e3.input_text().is_none());
        assert!(!has_meaningful_input_text(&e3));

        let e4 = CaptureEvent::KeyPause { input_buffer: "   ".into() };
        assert_eq!(e4.input_text(), Some("   "));
        assert!(!has_meaningful_input_text(&e4));
    }

    #[test]
    fn test_event_app_name() {
        let e = CaptureEvent::AppSwitch {
            app_name: "Chrome".into(),
            bundle_id: None,
            win_title: "Google".into(),
        };
        assert_eq!(e.app_name(), Some("Chrome"));
        assert!(CaptureEvent::Manual.app_name().is_none());
    }

    // ── merge_ax_and_event ────────────────────────────────────────────────

    #[test]
    fn test_merge_uses_ax_for_non_app_switch() {
        let engine = make_engine();
        let ax_info = AXInfo {
            app_name:  Some("Chrome".into()),
            win_title: Some("Google Search".into()),
            ..Default::default()
        };
        let merged = engine.merge_ax_and_event(&CaptureEvent::Manual, Some(ax_info));
        assert_eq!(merged.app_name.as_deref(), Some("Chrome"));
        assert_eq!(merged.win_title.as_deref(), Some("Google Search"));
    }

    #[test]
    fn test_merge_falls_back_to_cached_context() {
        let engine = make_engine();
        engine.update_cached_context(&AXInfo {
            app_name: Some("Chrome".into()),
            app_bundle_id: Some("com.google.Chrome".into()),
            win_title: Some("Docs".into()),
            ..Default::default()
        });

        let merged = engine.merge_ax_and_event(&CaptureEvent::Periodic, None);
        assert_eq!(merged.app_name.as_deref(), Some("Chrome"));
        assert_eq!(merged.app_bundle_id.as_deref(), Some("com.google.Chrome"));
        assert_eq!(merged.win_title.as_deref(), Some("Docs"));
    }

    #[test]
    fn test_merge_prefers_current_ax_over_cached_context() {
        let engine = make_engine();
        engine.update_cached_context(&AXInfo {
            app_name: Some("OldApp".into()),
            win_title: Some("Old Window".into()),
            ..Default::default()
        });

        let merged = engine.merge_ax_and_event(&CaptureEvent::Periodic, Some(AXInfo {
            app_name: Some("NewApp".into()),
            win_title: Some("New Window".into()),
            ..Default::default()
        }));
        assert_eq!(merged.app_name.as_deref(), Some("NewApp"));
        assert_eq!(merged.win_title.as_deref(), Some("New Window"));
    }

}
