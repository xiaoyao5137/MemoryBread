use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, AtomicI64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use image::{codecs::jpeg::JpegEncoder, imageops, DynamicImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

static QUITTING: AtomicBool = AtomicBool::new(false);
static LAST_FLOATING_ASSIST_TEMP_CLEANUP_MS: AtomicI64 = AtomicI64::new(0);
const FLOATING_ASSIST_LABEL: &str = "floating-assist";
const FLOATING_ASSIST_DEFAULT_MARGIN: i32 = 24;
const FLOATING_ASSIST_DEFAULT_TOP: i32 = 140;
const FLOATING_ASSIST_DEFAULT_SIZE: i32 = 82;
const FLOATING_ASSIST_TEMP_KEEP_SECS: u64 = 24 * 60 * 60;
const FLOATING_ASSIST_TEMP_CLEANUP_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
const TRAY_TEMPLATE_ICON_SIZE: u32 = 64;

#[cfg(target_os = "macos")]
fn configure_floating_assist_macos_window(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }

    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
    ns_window.setIgnoresMouseEvents(false);
    ns_window.setAcceptsMouseMovedEvents(true);
    ns_window.setCollectionBehavior(
        ns_window.collectionBehavior()
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
}

#[cfg(not(target_os = "macos"))]
fn configure_floating_assist_macos_window(_window: &tauri::WebviewWindow) {}

struct TrayMenuState {
    capture: CheckMenuItem<tauri::Wry>,
    floating_assist: CheckMenuItem<tauri::Wry>,
    floating_assist_auto_task: CheckMenuItem<tauri::Wry>,
    autostart: CheckMenuItem<tauri::Wry>,
}

#[derive(Debug, Serialize)]
struct FloatingAssistOcrResult {
    text: String,
    confidence: f64,
    screenshot_path: String,
    width: u32,
    height: u32,
    screenshot_source: String,
    app_bundle_id: Option<String>,
    app_name: Option<String>,
    window_title: Option<String>,
}

#[derive(Debug, Serialize)]
struct FloatingAssistDragOrigin {
    offset_x: f64,
    offset_y: f64,
}

#[derive(Debug, Serialize)]
struct FloatingAssistPointerState {
    hovering_ball: bool,
}

#[derive(Debug, Serialize)]
struct IpcRequest {
    id: String,
    ts: i64,
    task: IpcTask,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum IpcTask {
    Ocr {
        capture_id: i64,
        screenshot_path: String,
    },
}

#[derive(Debug, Deserialize)]
struct IpcResponse {
    status: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpcOcrResult {
    text: String,
    confidence: f64,
}

struct FloatingAssistScreenCapture {
    preview_path: PathBuf,
    ocr_paths: Vec<PathBuf>,
    width: u32,
    height: u32,
    source: String,
    app_bundle_id: Option<String>,
    app_name: Option<String>,
    window_title: Option<String>,
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn ensure_floating_assist_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(FLOATING_ASSIST_LABEL) {
        configure_floating_assist_macos_window(&window);
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        FLOATING_ASSIST_LABEL,
        WebviewUrl::App("index.html?view=floating-assist".into()),
    )
    .title("记忆面包悬浮球")
    .inner_size(
        FLOATING_ASSIST_DEFAULT_SIZE as f64,
        FLOATING_ASSIST_DEFAULT_SIZE as f64,
    )
    .min_inner_size(
        FLOATING_ASSIST_DEFAULT_SIZE as f64,
        FLOATING_ASSIST_DEFAULT_SIZE as f64,
    )
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .accept_first_mouse(true)
    .content_protected(false)
    .skip_taskbar(true)
    .visible(false)
    .position(960.0, 140.0)
    .build()
    .map_err(|error| error.to_string())?;
    configure_floating_assist_macos_window(&window);
    Ok(window)
}

fn default_floating_assist_position(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> PhysicalPosition<i32> {
    let window_size = window.outer_size().ok();
    let window_width = window_size
        .map(|size| size.width as i32)
        .unwrap_or(FLOATING_ASSIST_DEFAULT_SIZE);
    let window_height = window_size
        .map(|size| size.height as i32)
        .unwrap_or(FLOATING_ASSIST_DEFAULT_SIZE);
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let min_x = monitor_position.x;
        let min_y = monitor_position.y;
        let max_x = min_x + monitor_size.width as i32 - window_width;
        let max_y = min_y + monitor_size.height as i32 - window_height;
        let x = max_x
            .saturating_sub(FLOATING_ASSIST_DEFAULT_MARGIN)
            .max(min_x);
        let y = (min_y + FLOATING_ASSIST_DEFAULT_TOP).clamp(min_y, max_y.max(min_y));
        return PhysicalPosition::new(x, y);
    }

    PhysicalPosition::new(960, FLOATING_ASSIST_DEFAULT_TOP)
}

fn monitor_contains_point(monitor: &Monitor, x: i32, y: i32) -> bool {
    let position = monitor.position();
    let size = monitor.size();
    x >= position.x
        && x < position.x + size.width as i32
        && y >= position.y
        && y < position.y + size.height as i32
}

fn monitor_for_position(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    position: PhysicalPosition<i32>,
) -> Option<Monitor> {
    app.available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors
                .into_iter()
                .find(|monitor| monitor_contains_point(monitor, position.x, position.y))
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn clamp_position_to_monitor_work_area(
    monitor: &Monitor,
    position: PhysicalPosition<i32>,
    window_width: i32,
    window_height: i32,
) -> PhysicalPosition<i32> {
    let work_area = monitor.work_area();
    let min_x = work_area.position.x;
    let min_y = work_area.position.y;
    let max_x = min_x + work_area.size.width as i32 - window_width.max(1);
    let max_y = min_y + work_area.size.height as i32 - window_height.max(1);

    PhysicalPosition::new(
        position.x.clamp(min_x, max_x.max(min_x)),
        position.y.clamp(min_y, max_y.max(min_y)),
    )
}

fn floating_assist_outer_size(
    window: &tauri::WebviewWindow,
    fallback_logical_size: Option<(f64, f64)>,
) -> (i32, i32) {
    let fallback_size = fallback_logical_size.map(|(width, height)| {
        let scale_factor = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor.scale_factor())
            .unwrap_or(1.0);
        (
            (width * scale_factor).round() as i32,
            (height * scale_factor).round() as i32,
        )
    });

    if let Ok(size) = window.outer_size() {
        let outer_size = (size.width as i32, size.height as i32);
        if let Some(fallback_size) = fallback_size {
            return (
                outer_size.0.max(fallback_size.0),
                outer_size.1.max(fallback_size.1),
            );
        }
        return outer_size;
    }

    fallback_size.unwrap_or((FLOATING_ASSIST_DEFAULT_SIZE, FLOATING_ASSIST_DEFAULT_SIZE))
}

fn set_floating_assist_position_clamped(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    position: PhysicalPosition<i32>,
    fallback_logical_size: Option<(f64, f64)>,
) -> Result<(), String> {
    let (window_width, window_height) = floating_assist_outer_size(window, fallback_logical_size);
    let clamped_position = monitor_for_position(app, window, position)
        .map(|monitor| {
            clamp_position_to_monitor_work_area(&monitor, position, window_width, window_height)
        })
        .unwrap_or(position);

    window
        .set_position(clamped_position)
        .map_err(|error| error.to_string())
}

fn set_floating_assist_visible_inner(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let window = ensure_floating_assist_window(app)?;
    let menu_state = app.state::<TrayMenuState>();
    if enabled {
        let _ = window.set_size(LogicalSize::new(
            FLOATING_ASSIST_DEFAULT_SIZE as f64,
            FLOATING_ASSIST_DEFAULT_SIZE as f64,
        ));
        let _ = set_floating_assist_position_clamped(
            app,
            &window,
            default_floating_assist_position(app, &window),
            Some((
                FLOATING_ASSIST_DEFAULT_SIZE as f64,
                FLOATING_ASSIST_DEFAULT_SIZE as f64,
            )),
        );
        window.show().map_err(|error| error.to_string())?;
        let _ = window.set_content_protected(false);
        let _ = window.set_always_on_top(true);
        let _ = app.emit("floating-assist-reset", ());
        menu_state
            .floating_assist_auto_task
            .set_enabled(true)
            .map_err(|error| error.to_string())?;
    } else {
        window.hide().map_err(|error| error.to_string())?;
        menu_state
            .floating_assist_auto_task
            .set_checked(false)
            .map_err(|error| error.to_string())?;
        menu_state
            .floating_assist_auto_task
            .set_enabled(false)
            .map_err(|error| error.to_string())?;
        let _ = app.emit("floating-assist-auto-task-changed", false);
    }
    menu_state
        .floating_assist
        .set_checked(enabled)
        .map_err(|error| error.to_string())?;
    let _ = app.emit("tray-floating-assist-changed", enabled);
    Ok(())
}

fn floating_assist_temp_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法定位用户目录".to_string())?;
    let dir = PathBuf::from(home)
        .join(".memory-bread")
        .join("floating-screenshots");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn cleanup_floating_assist_temp_files() -> Result<(usize, u64), String> {
    let dir = floating_assist_temp_dir()?;
    let now = SystemTime::now();
    let keep_duration = Duration::from_secs(FLOATING_ASSIST_TEMP_KEEP_SECS);
    let entries = fs::read_dir(&dir).map_err(|error| error.to_string())?;
    let mut deleted_count = 0usize;
    let mut freed_bytes = 0u64;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age < keep_duration {
            continue;
        }

        let path = entry.path();
        let size = metadata.len();
        if fs::remove_file(&path).is_ok() {
            deleted_count += 1;
            freed_bytes += size;
        }
    }

    Ok((deleted_count, freed_bytes))
}

fn schedule_floating_assist_temp_cleanup(force: bool) {
    let now = now_ms();
    if force {
        LAST_FLOATING_ASSIST_TEMP_CLEANUP_MS.store(now, Ordering::Relaxed);
    } else {
        let last = LAST_FLOATING_ASSIST_TEMP_CLEANUP_MS.load(Ordering::Relaxed);
        if now.saturating_sub(last) < FLOATING_ASSIST_TEMP_CLEANUP_INTERVAL_MS {
            return;
        }
        if LAST_FLOATING_ASSIST_TEMP_CLEANUP_MS
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
    }

    let _ = tauri::async_runtime::spawn_blocking(|| match cleanup_floating_assist_temp_files() {
        Ok((deleted_count, freed_bytes)) if deleted_count > 0 => {
            eprintln!("悬浮球临时截图清理完成: deleted={deleted_count}, freed_bytes={freed_bytes}");
        }
        Ok(_) => {}
        Err(error) => {
            eprintln!("悬浮球临时截图清理失败: {error}");
        }
    });
}

fn save_rgba_jpeg(path: PathBuf, image: RgbaImage) -> Result<PathBuf, String> {
    let rgb = DynamicImage::ImageRgba8(image).into_rgb8();
    let file = fs::File::create(&path).map_err(|error| error.to_string())?;
    let mut encoder = JpegEncoder::new_with_quality(file, 82);
    encoder
        .encode_image(&DynamicImage::ImageRgb8(rgb))
        .map_err(|error| error.to_string())?;
    Ok(path)
}

fn capture_all_screens_for_floating_assist() -> Result<FloatingAssistScreenCapture, String> {
    let monitors = xcap::Monitor::all()
        .map_err(|error| format!("无法读取屏幕列表，请确认已授予屏幕录制权限：{error}"))?;
    if monitors.is_empty() {
        return Err("未发现可用显示器".to_string());
    }

    let timestamp = now_ms();
    let temp_dir = floating_assist_temp_dir()?;
    let mut captures = Vec::with_capacity(monitors.len());
    let mut ocr_paths = Vec::with_capacity(monitors.len());
    for (index, monitor) in monitors.into_iter().enumerate() {
        let x = monitor
            .x()
            .map_err(|error| format!("读取显示器位置失败：{error}"))?;
        let y = monitor
            .y()
            .map_err(|error| format!("读取显示器位置失败：{error}"))?;
        let image = monitor
            .capture_image()
            .map_err(|error| format!("截图失败，请确认已授予屏幕录制权限：{error}"))?;
        let ocr_path = temp_dir.join(format!("{timestamp}-monitor-{index}.jpg"));
        ocr_paths.push(save_rgba_jpeg(ocr_path, image.clone())?);
        captures.push((x, y, image));
    }

    let min_x = captures
        .iter()
        .map(|(x, _, _)| *x as i64)
        .min()
        .unwrap_or(0);
    let min_y = captures
        .iter()
        .map(|(_, y, _)| *y as i64)
        .min()
        .unwrap_or(0);
    let max_x = captures
        .iter()
        .map(|(x, _, image)| *x as i64 + image.width() as i64)
        .max()
        .unwrap_or(0);
    let max_y = captures
        .iter()
        .map(|(_, y, image)| *y as i64 + image.height() as i64)
        .max()
        .unwrap_or(0);
    let width = u32::try_from(max_x - min_x).map_err(|_| "多显示器截图宽度过大".to_string())?;
    let height = u32::try_from(max_y - min_y).map_err(|_| "多显示器截图高度过大".to_string())?;
    let mut canvas = RgbaImage::from_pixel(width, height, Rgba([255, 252, 247, 255]));
    for (x, y, image) in captures {
        imageops::overlay(&mut canvas, &image, x as i64 - min_x, y as i64 - min_y);
    }

    let preview_path = save_rgba_jpeg(temp_dir.join(format!("{timestamp}.jpg")), canvas)?;
    Ok(FloatingAssistScreenCapture {
        preview_path,
        ocr_paths,
        width,
        height,
        source: "fullscreen".to_string(),
        app_bundle_id: None,
        app_name: None,
        window_title: None,
    })
}

#[cfg(target_os = "macos")]
fn frontmost_bundle_id_for_floating_assist() -> Option<String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg("tell application \"System Events\" to get bundle identifier of first application process whose frontmost is true")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(not(target_os = "macos"))]
fn frontmost_bundle_id_for_floating_assist() -> Option<String> {
    None
}

fn capture_focused_window_for_floating_assist() -> Result<FloatingAssistScreenCapture, String> {
    use xcap::Window;

    const MIN_WINDOW_WIDTH: u32 = 200;
    const MIN_WINDOW_HEIGHT: u32 = 150;

    let windows = Window::all().map_err(|error| format!("读取窗口列表失败：{error}"))?;
    let mut candidates: Vec<(Window, u32, u32, u64)> = Vec::new();
    for window in windows {
        if !window.is_focused().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
            continue;
        }
        let width = window.width().unwrap_or(0);
        let height = window.height().unwrap_or(0);
        let area = (width as u64) * (height as u64);
        candidates.push((window, width, height, area));
    }

    candidates.sort_by(|left, right| right.3.cmp(&left.3));
    let (window, width, height, _) = candidates
        .into_iter()
        .next()
        .ok_or_else(|| "未找到前台窗口".to_string())?;

    let app_name = window
        .app_name()
        .ok()
        .filter(|value| !value.trim().is_empty());
    let app_bundle_id = frontmost_bundle_id_for_floating_assist();
    let window_title = window.title().ok().filter(|value| !value.trim().is_empty());
    if width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT {
        return Err(format!(
            "前台窗口过小，跳过 app={app_name:?} title={window_title:?} {width}x{height}"
        ));
    }

    let image = window.capture_image().map_err(|error| {
        format!("前台窗口截图失败 app={app_name:?} title={window_title:?}：{error}")
    })?;
    let timestamp = now_ms();
    let temp_dir = floating_assist_temp_dir()?;
    let preview_path = save_rgba_jpeg(
        temp_dir.join(format!("{timestamp}-window.jpg")),
        image.clone(),
    )?;
    let ocr_path = save_rgba_jpeg(temp_dir.join(format!("{timestamp}-window-ocr.jpg")), image)?;

    Ok(FloatingAssistScreenCapture {
        preview_path,
        ocr_paths: vec![ocr_path],
        width,
        height,
        source: "window".to_string(),
        app_bundle_id,
        app_name,
        window_title,
    })
}

fn capture_screen_for_floating_assist() -> Result<FloatingAssistScreenCapture, String> {
    capture_focused_window_for_floating_assist()
        .or_else(|_| capture_all_screens_for_floating_assist())
}

fn run_floating_assist_ocr(paths: &[PathBuf]) -> Result<IpcOcrResult, String> {
    let mut parts = Vec::new();
    let mut confidence_sum = 0.0;
    let mut confidence_count = 0usize;
    let mut last_error = None;

    for (index, path) in paths.iter().enumerate() {
        let path_text = path.to_string_lossy().to_string();
        match send_sidecar_ocr(&path_text) {
            Ok(result) => {
                let text = result.text.trim();
                if !text.is_empty() {
                    parts.push(format!("显示器 {}:\n{}", index + 1, text));
                }
                confidence_sum += result.confidence;
                confidence_count += 1;
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    if parts.is_empty() {
        if let Some(error) = last_error {
            return Err(error);
        }
    }

    Ok(IpcOcrResult {
        text: parts.join("\n\n"),
        confidence: if confidence_count > 0 {
            confidence_sum / confidence_count as f64
        } else {
            0.0
        },
    })
}

#[cfg(unix)]
fn connect_ipc_stream() -> Result<Box<dyn ReadWrite>, String> {
    use std::os::unix::net::UnixStream;

    let stream = UnixStream::connect("/tmp/memory-bread-sidecar.sock")
        .map_err(|error| format!("无法连接 OCR sidecar：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    Ok(Box::new(stream))
}

#[cfg(windows)]
fn connect_ipc_stream() -> Result<Box<dyn ReadWrite>, String> {
    use std::net::TcpStream;

    let stream = TcpStream::connect("127.0.0.1:17071")
        .map_err(|error| format!("无法连接 OCR sidecar：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    Ok(Box::new(stream))
}

#[cfg(not(any(unix, windows)))]
fn connect_ipc_stream() -> Result<Box<dyn ReadWrite>, String> {
    Err("当前平台暂不支持悬浮球 OCR IPC".to_string())
}

fn send_ipc_payload(payload: &[u8]) -> Result<IpcResponse, String> {
    let mut stream = connect_ipc_stream()?;
    let length = (payload.len() as u32).to_be_bytes();
    stream
        .write_all(&length)
        .map_err(|error| error.to_string())?;
    stream
        .write_all(payload)
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;

    let mut length_buf = [0u8; 4];
    stream
        .read_exact(&mut length_buf)
        .map_err(|error| error.to_string())?;
    let response_length = u32::from_be_bytes(length_buf) as usize;
    if response_length > 16 * 1024 * 1024 {
        return Err(format!("OCR sidecar 响应过大：{} 字节", response_length));
    }
    let mut response_buf = vec![0u8; response_length];
    stream
        .read_exact(&mut response_buf)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&response_buf).map_err(|error| error.to_string())
}

fn send_sidecar_ocr(path: &str) -> Result<IpcOcrResult, String> {
    let request = IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        ts: now_ms(),
        task: IpcTask::Ocr {
            capture_id: 0,
            screenshot_path: path.to_string(),
        },
    };
    let payload = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let response = send_ipc_payload(&payload)?;
    if response.status != "ok" {
        return Err(response
            .error
            .unwrap_or_else(|| "OCR sidecar 返回未知错误".to_string()));
    }
    let result = response
        .result
        .ok_or_else(|| "OCR sidecar 响应缺少 result".to_string())?;
    serde_json::from_value(result).map_err(|error| error.to_string())
}

fn start_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("start.sh")
}

/// 退出 App 后再由独立脚本停止启动器和所有后台服务，避免脚本先杀掉当前进程。
fn schedule_full_shutdown() {
    let script = start_script_path();
    if !script.is_file() {
        eprintln!("未找到全组件停止脚本: {}", script.display());
        return;
    }

    let result = Command::new("/bin/bash")
        .arg(script)
        .arg("stop-after-app")
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    if let Err(error) = result {
        eprintln!("启动全组件停止脚本失败: {error}");
    }
}

fn schedule_backend_startup() {
    let script = start_script_path();
    if !script.is_file() {
        eprintln!("未找到全组件启动脚本: {}", script.display());
        return;
    }

    if let Err(error) = Command::new("/bin/bash")
        .arg(script)
        .arg("start-backends")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        eprintln!("启动后台服务失败: {error}");
    }
}

#[tauri::command]
fn set_capture_menu_state(app: AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<TrayMenuState>()
        .capture
        .set_checked(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_floating_assist_menu_state(app: AppHandle, enabled: bool) -> Result<(), String> {
    let menu_state = app.state::<TrayMenuState>();
    menu_state
        .floating_assist
        .set_checked(enabled)
        .map_err(|error| error.to_string())?;
    menu_state
        .floating_assist_auto_task
        .set_enabled(enabled)
        .map_err(|error| error.to_string())?;
    if !enabled {
        menu_state
            .floating_assist_auto_task
            .set_checked(false)
            .map_err(|error| error.to_string())?;
        let _ = app.emit("floating-assist-auto-task-changed", false);
    }
    Ok(())
}

#[tauri::command]
fn set_floating_assist_auto_task_menu_state(
    app: AppHandle,
    checked: bool,
    enabled: bool,
) -> Result<(), String> {
    let menu_state = app.state::<TrayMenuState>();
    menu_state
        .floating_assist_auto_task
        .set_enabled(enabled)
        .map_err(|error| error.to_string())?;
    menu_state
        .floating_assist_auto_task
        .set_checked(checked && enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_floating_assist_visible(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_floating_assist_visible_inner(&app, enabled)
}

#[tauri::command]
fn show_main_panel_from_floating_assist(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
fn set_floating_assist_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let window = ensure_floating_assist_window(&app)?;
    set_floating_assist_position_clamped(
        &app,
        &window,
        PhysicalPosition::new(x.round() as i32, y.round() as i32),
        None,
    )
}

#[tauri::command]
fn begin_floating_assist_drag(app: AppHandle) -> Result<FloatingAssistDragOrigin, String> {
    let window = ensure_floating_assist_window(&app)?;
    let window_position = window.outer_position().map_err(|error| error.to_string())?;
    let cursor_position = app.cursor_position().map_err(|error| error.to_string())?;
    Ok(FloatingAssistDragOrigin {
        offset_x: cursor_position.x - f64::from(window_position.x),
        offset_y: cursor_position.y - f64::from(window_position.y),
    })
}

#[tauri::command]
fn update_floating_assist_drag(app: AppHandle, offset_x: f64, offset_y: f64) -> Result<(), String> {
    let window = ensure_floating_assist_window(&app)?;
    let cursor_position = app.cursor_position().map_err(|error| error.to_string())?;
    set_floating_assist_position_clamped(
        &app,
        &window,
        PhysicalPosition::new(
            (cursor_position.x - offset_x).round() as i32,
            (cursor_position.y - offset_y).round() as i32,
        ),
        None,
    )
}

#[tauri::command]
fn get_floating_assist_pointer_state(app: AppHandle) -> Result<FloatingAssistPointerState, String> {
    let Some(window) = app.get_webview_window(FLOATING_ASSIST_LABEL) else {
        return Ok(FloatingAssistPointerState {
            hovering_ball: false,
        });
    };

    configure_floating_assist_macos_window(&window);

    if !window.is_visible().unwrap_or(false) {
        return Ok(FloatingAssistPointerState {
            hovering_ball: false,
        });
    }

    let window_position = window.outer_position().map_err(|error| error.to_string())?;
    let cursor_position = app.cursor_position().map_err(|error| error.to_string())?;
    let scale_factor = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let ball_margin = 8.0 * scale_factor;
    let ball_size = 72.0 * scale_factor;
    let relative_x = cursor_position.x - f64::from(window_position.x);
    let relative_y = cursor_position.y - f64::from(window_position.y);

    Ok(FloatingAssistPointerState {
        hovering_ball: relative_x >= ball_margin
            && relative_x <= ball_margin + ball_size
            && relative_y >= ball_margin
            && relative_y <= ball_margin + ball_size,
    })
}

#[tauri::command]
fn set_floating_assist_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = ensure_floating_assist_window(&app)?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;

    if let Ok(position) = window.outer_position() {
        set_floating_assist_position_clamped(&app, &window, position, Some((width, height)))?;
    }

    Ok(())
}

#[tauri::command]
fn read_floating_assist_image_data_url(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|error| format!("读取截屏失败：{error}"))?;
    let encoded = general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/jpeg;base64,{encoded}"))
}

#[tauri::command]
fn open_floating_assist_reference(app: AppHandle, detail: serde_json::Value) -> Result<(), String> {
    show_main_window(&app);
    app.emit("floating-assist-open-reference", detail)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn capture_screen_ocr_for_floating_assist(
    app: AppHandle,
) -> Result<FloatingAssistOcrResult, String> {
    schedule_floating_assist_temp_cleanup(false);

    let floating_window = app.get_webview_window(FLOATING_ASSIST_LABEL);
    if let Some(window) = floating_window.as_ref() {
        let _ = window.set_content_protected(true);
        let _ = window.set_always_on_top(true);

        let capture_result = tauri::async_runtime::spawn_blocking(|| {
            let capture = capture_screen_for_floating_assist()?;
            let result = run_floating_assist_ocr(&capture.ocr_paths)?;
            Ok::<_, String>((capture, result))
        })
        .await
        .map_err(|error| format!("悬浮球截图任务失败：{error}"));

        let _ = window.set_content_protected(false);
        let _ = window.show();
        let _ = window.set_always_on_top(true);

        let (capture, result) = capture_result??;
        let screenshot_path = capture.preview_path.to_string_lossy().to_string();
        return Ok(FloatingAssistOcrResult {
            text: result.text,
            confidence: result.confidence,
            screenshot_path,
            width: capture.width,
            height: capture.height,
            screenshot_source: capture.source,
            app_bundle_id: capture.app_bundle_id,
            app_name: capture.app_name,
            window_title: capture.window_title,
        });
    }

    let (capture, result) = tauri::async_runtime::spawn_blocking(|| {
        let capture = capture_screen_for_floating_assist()?;
        let result = run_floating_assist_ocr(&capture.ocr_paths)?;
        Ok::<_, String>((capture, result))
    })
    .await
    .map_err(|error| format!("悬浮球截图任务失败：{error}"))??;
    let screenshot_path = capture.preview_path.to_string_lossy().to_string();
    Ok(FloatingAssistOcrResult {
        text: result.text,
        confidence: result.confidence,
        screenshot_path,
        width: capture.width,
        height: capture.height,
        screenshot_source: capture.source,
        app_bundle_id: capture.app_bundle_id,
        app_name: capture.app_name,
        window_title: capture.window_title,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            set_capture_menu_state,
            set_floating_assist_menu_state,
            set_floating_assist_auto_task_menu_state,
            set_floating_assist_visible,
            show_main_panel_from_floating_assist,
            set_floating_assist_position,
            begin_floating_assist_drag,
            update_floating_assist_drag,
            get_floating_assist_pointer_state,
            set_floating_assist_size,
            read_floating_assist_image_data_url,
            open_floating_assist_reference,
            capture_screen_ocr_for_floating_assist,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let main_panel = MenuItem::with_id(app, "main-panel", "主面板", true, None::<&str>)?;
            let capture =
                CheckMenuItem::with_id(app, "capture", "打开/关闭采集", true, true, None::<&str>)?;
            let floating_assist = CheckMenuItem::with_id(
                app,
                "floating-assist",
                "打开/关闭悬浮球",
                true,
                false,
                None::<&str>,
            )?;
            let floating_assist_auto_task = CheckMenuItem::with_id(
                app,
                "floating-assist-auto-task",
                "自动识别任务",
                false,
                false,
                None::<&str>,
            )?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "开机默认启动",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &main_panel,
                    &capture,
                    &floating_assist,
                    &floating_assist_auto_task,
                    &autostart,
                    &settings,
                    &separator,
                    &quit,
                ],
            )?;

            app.manage(TrayMenuState {
                capture: capture.clone(),
                floating_assist: floating_assist.clone(),
                floating_assist_auto_task: floating_assist_auto_task.clone(),
                autostart: autostart.clone(),
            });

            let _ = ensure_floating_assist_window(app.handle());
            schedule_floating_assist_temp_cleanup(true);

            let mut tray = TrayIconBuilder::with_id("memory-bread")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("记忆面包")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "main-panel" => show_main_window(app),
                    "capture" => {
                        let enabled = app
                            .state::<TrayMenuState>()
                            .capture
                            .is_checked()
                            .unwrap_or(true);
                        let _ = app.emit("tray-capture-changed", enabled);
                    }
                    "floating-assist" => {
                        let enabled = app
                            .state::<TrayMenuState>()
                            .floating_assist
                            .is_checked()
                            .unwrap_or(false);
                        if let Err(error) = set_floating_assist_visible_inner(app, enabled) {
                            eprintln!("更新悬浮球状态失败: {error}");
                            let _ = app
                                .state::<TrayMenuState>()
                                .floating_assist
                                .set_checked(!enabled);
                        }
                    }
                    "floating-assist-auto-task" => {
                        let state = app.state::<TrayMenuState>();
                        let floating_enabled = state.floating_assist.is_checked().unwrap_or(false);
                        let requested = state
                            .floating_assist_auto_task
                            .is_checked()
                            .unwrap_or(false);
                        if !floating_enabled {
                            let _ = state.floating_assist_auto_task.set_checked(false);
                            let _ = state.floating_assist_auto_task.set_enabled(false);
                            let _ = app.emit("floating-assist-auto-task-changed", false);
                        } else {
                            let _ = app.emit("floating-assist-auto-task-changed", requested);
                        }
                    }
                    "autostart" => {
                        let state = app.state::<TrayMenuState>();
                        let requested = state.autostart.is_checked().unwrap_or(false);
                        let result = if requested {
                            app.autolaunch().enable()
                        } else {
                            app.autolaunch().disable()
                        };
                        if let Err(error) = result {
                            eprintln!("更新开机启动状态失败: {error}");
                            let _ = state.autostart.set_checked(!requested);
                        }
                    }
                    "settings" => {
                        show_main_window(app);
                        let _ = app.emit("tray-navigate-settings", ());
                    }
                    "quit" => {
                        QUITTING.store(true, Ordering::SeqCst);
                        schedule_full_shutdown();
                        app.exit(0);
                    }
                    _ => {}
                });

            #[cfg(target_os = "macos")]
            {
                let tray_icon = tauri::image::Image::new(
                    include_bytes!("../icons/tray-template.rgba"),
                    TRAY_TEMPLATE_ICON_SIZE,
                    TRAY_TEMPLATE_ICON_SIZE,
                );
                tray = tray.icon(tray_icon).icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
            }
            tray.build(app)?;

            if std::env::args().any(|argument| argument == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                schedule_backend_startup();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
