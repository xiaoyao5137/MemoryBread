"""
闲时计算系统调试界面

提供 Web UI 用于：
1. 测试各模型任务的提交和执行
2. 监控系统状态（CPU/内存/模型加载）
3. 查看任务队列和执行历史
4. 手动触发闲时任务
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from dispatcher_v2 import Dispatcher
from idle_compute import TaskType, TaskPriority, Task

logger = logging.getLogger(__name__)

# 创建 FastAPI 应用
app = FastAPI(title="记忆面包闲时计算调试界面")

# 全局 Dispatcher 实例
dispatcher: Dispatcher = None

# WebSocket 连接管理
active_connections: list[WebSocket] = []

# 任务日志存储（每个任务类型独立）
task_logs = {
    "ocr": [],
    "embedding": [],
    "llm": [],
    "vlm": [],
    "asr": [],
    "system": [],
}

def add_task_log(task_type: str, message: str, level: str = "info"):
    """添加任务日志"""
    log_entry = {
        "timestamp": datetime.now().isoformat(),
        "message": message,
        "level": level,
    }

    if task_type in task_logs:
        task_logs[task_type].append(log_entry)
        # 保留最近 100 条
        if len(task_logs[task_type]) > 100:
            task_logs[task_type] = task_logs[task_type][-100:]

    # 同时添加到系统日志
    task_logs["system"].append({
        "timestamp": log_entry["timestamp"],
        "message": f"[{task_type.upper()}] {message}",
        "level": level,
    })
    if len(task_logs["system"]) > 200:
        task_logs["system"] = task_logs["system"][-200:]


# ── API 端点 ──────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    """启动时初始化 Dispatcher"""
    global dispatcher
    dispatcher = Dispatcher()
    await dispatcher.initialize()
    logger.info("Dispatcher 已初始化")


@app.get("/", response_class=HTMLResponse)
async def get_dashboard():
    """返回调试界面 HTML"""
    return HTML_TEMPLATE


@app.get("/api/status")
async def get_status():
    """获取系统状态"""
    if not dispatcher:
        return {"error": "Dispatcher 未初始化"}

    # 闲时检测器状态
    idle_status = dispatcher._idle_detector.get_status()

    # 任务调度器状态
    task_stats = dispatcher._task_scheduler.get_stats()

    # 模型管理器状态
    model_status = dispatcher._model_manager.get_status()

    return {
        "timestamp": datetime.now().isoformat(),
        "idle_detector": {
            "cpu_usage": round(idle_status["cpu_usage"], 1),
            "cpu_ok": idle_status["cpu_ok"],
            "memory_usage": round(idle_status["memory_usage"], 1),
            "memory_ok": idle_status["memory_ok"],
            "on_power": idle_status["on_power"],
            "stable_elapsed": int(idle_status["stable_elapsed"]),
            "stable_required": idle_status["stable_required"],
            "time_until_next": idle_status["time_until_next"],
            "can_execute": idle_status["can_execute"],
        },
        "task_scheduler": {
            "total_submitted": task_stats["total_submitted"],
            "completed": task_stats["completed"],
            "failed": task_stats["failed"],
            "pending_realtime": task_stats["pending_realtime"],
            "pending_on_demand": task_stats["pending_on_demand"],
            "pending_idle": task_stats["pending_idle"],
            "total_pending": task_stats["total_pending"],
        },
        "model_manager": {
            "loaded_count": model_status["loaded_count"],
            "total_memory_mb": model_status["total_memory_mb"],
            "models": model_status["models"],
        },
    }


@app.post("/api/task/ocr")
async def submit_ocr_task():
    """提交 OCR 任务"""
    task = Task(
        task_id=f"ocr-test-{datetime.now().timestamp()}",
        task_type=TaskType.OCR,
        priority=TaskPriority.REALTIME,
        payload={"screenshot_path": "/tmp/test.jpg"},
    )

    add_task_log("ocr", f"提交任务: {task.task_id}", "info")

    success = dispatcher._task_scheduler.submit_task(task)

    if success:
        add_task_log("ocr", "任务已提交（实时处理）", "success")
    else:
        add_task_log("ocr", "任务提交失败：队列已满", "error")

    return {
        "success": success,
        "task_id": task.task_id,
        "message": "OCR 任务已提交（实时处理）" if success else "任务队列已满",
    }


@app.post("/api/task/embedding")
async def submit_embedding_task():
    """提交 Embedding 任务"""
    task = Task(
        task_id=f"embed-test-{datetime.now().timestamp()}",
        task_type=TaskType.EMBEDDING,
        priority=TaskPriority.IDLE_HIGH,
        payload={"capture_id": 1, "text": "测试文本"},
    )

    add_task_log("embedding", f"提交任务: {task.task_id}", "info")

    success = dispatcher._task_scheduler.submit_task(task)

    if success:
        add_task_log("embedding", "任务已加入闲时队列", "success")
    else:
        add_task_log("embedding", "任务提交失败：队列已满", "error")

    return {
        "success": success,
        "task_id": task.task_id,
        "message": "Embedding 任务已加入闲时队列" if success else "任务队列已满",
    }


@app.post("/api/task/vlm")
async def submit_vlm_task():
    """提交 VLM 任务"""
    task = Task(
        task_id=f"vlm-test-{datetime.now().timestamp()}",
        task_type=TaskType.VLM,
        priority=TaskPriority.IDLE_LOW,
        payload={"image_path": "/tmp/test.jpg", "question": "这是什么？"},
    )

    add_task_log("vlm", f"提交任务: {task.task_id}", "info")

    success = dispatcher._task_scheduler.submit_task(task)

    if success:
        add_task_log("vlm", "任务已加入闲时队列", "success")
    else:
        add_task_log("vlm", "任务提交失败：队列已满", "error")

    return {
        "success": success,
        "task_id": task.task_id,
        "message": "VLM 任务已加入闲时队列" if success else "任务队列已满",
    }


@app.post("/api/task/asr")
async def submit_asr_task():
    """提交 ASR 任务"""
    task = Task(
        task_id=f"asr-test-{datetime.now().timestamp()}",
        task_type=TaskType.ASR,
        priority=TaskPriority.IDLE_LOW,
        payload={"audio_path": "/tmp/test.wav"},
    )

    add_task_log("asr", f"提交任务: {task.task_id}", "info")

    success = dispatcher._task_scheduler.submit_task(task)

    if success:
        add_task_log("asr", "任务已加入闲时队列", "success")
    else:
        add_task_log("asr", "任务提交失败：队列已满", "error")

    return {
        "success": success,
        "task_id": task.task_id,
        "message": "ASR 任务已加入闲时队列" if success else "任务队列已满",
    }


@app.post("/api/task/llm")
async def submit_llm_task():
    """提交 LLM 任务"""
    task = Task(
        task_id=f"llm-test-{datetime.now().timestamp()}",
        task_type=TaskType.LLM,
        priority=TaskPriority.ON_DEMAND,
        payload={"query": "测试问题"},
    )

    add_task_log("llm", f"提交任务: {task.task_id}", "info")

    success = dispatcher._task_scheduler.submit_task(task)

    if success:
        add_task_log("llm", "任务已提交（按需处理）", "success")
    else:
        add_task_log("llm", "任务提交失败：队列已满", "error")

    return {
        "success": success,
        "task_id": task.task_id,
        "message": "LLM 任务已提交（按需处理）" if success else "任务队列已满",
    }


@app.post("/api/trigger_idle")
async def trigger_idle_tasks():
    """手动触发闲时任务处理"""
    if not dispatcher._idle_engine:
        add_task_log("system", "闲时引擎未启动", "error")
        return {"success": False, "message": "闲时引擎未启动"}

    # 临时标记为可执行（绕过时间限制）
    dispatcher._idle_detector._last_execution_time = None

    add_task_log("system", "手动触发闲时任务处理", "info")

    return {
        "success": True,
        "message": "已触发闲时任务处理（将在下次检查时执行）",
    }


@app.post("/api/model/unload_all")
async def unload_all_models():
    """卸载所有模型"""
    dispatcher._model_manager.unload_all(force=True)
    add_task_log("system", "已卸载所有模型", "info")
    return {"success": True, "message": "已卸载所有模型"}


@app.get("/api/logs/{task_type}")
async def get_task_logs(task_type: str):
    """获取指定任务类型的日志"""
    if task_type not in task_logs:
        return {"error": "无效的任务类型"}

    return {
        "task_type": task_type,
        "logs": task_logs[task_type],
    }


@app.post("/api/logs/{task_type}/clear")
async def clear_task_logs(task_type: str):
    """清空指定任务类型的日志"""
    if task_type not in task_logs:
        return {"error": "无效的任务类型"}

    task_logs[task_type].clear()
    return {"success": True, "message": f"{task_type} 日志已清空"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket 连接，用于实时推送状态更新"""
    await websocket.accept()
    active_connections.append(websocket)

    try:
        while True:
            # 每秒推送一次状态
            await asyncio.sleep(1)

            status = await get_status()
            await websocket.send_json(status)

    except WebSocketDisconnect:
        active_connections.remove(websocket)
        logger.info("WebSocket 连接断开")


# ── HTML 模板 ─────────────────────────────────────────────────────────

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>记忆面包闲时计算调试界面</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        h1 {
            color: #333;
            margin-bottom: 20px;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }

        .card {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .card h2 {
            font-size: 18px;
            color: #333;
            margin-bottom: 15px;
            border-bottom: 2px solid #4CAF50;
            padding-bottom: 10px;
        }

        .stat {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #eee;
        }

        .stat:last-child {
            border-bottom: none;
        }

        .stat-label {
            color: #666;
        }

        .stat-value {
            font-weight: bold;
            color: #333;
        }

        .stat-value.ok {
            color: #4CAF50;
        }

        .stat-value.warning {
            color: #FF9800;
        }

        .stat-value.error {
            color: #F44336;
        }

        .button-group {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        button {
            padding: 12px 20px;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s;
            font-weight: 500;
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        }

        button:active {
            transform: translateY(0);
        }

        .btn-primary {
            background: #4CAF50;
            color: white;
        }

        .btn-primary:hover {
            background: #45a049;
        }

        .btn-secondary {
            background: #2196F3;
            color: white;
        }

        .btn-secondary:hover {
            background: #0b7dda;
        }

        .btn-warning {
            background: #FF9800;
            color: white;
        }

        .btn-warning:hover {
            background: #e68900;
        }

        .btn-danger {
            background: #F44336;
            color: white;
        }

        .btn-danger:hover {
            background: #da190b;
        }

        .model-item {
            padding: 10px;
            margin: 5px 0;
            background: #f9f9f9;
            border-radius: 4px;
        }

        .log-box {
            background: #1e1e1e;
            color: #d4d4d4;
            padding: 10px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            max-height: 200px;
            overflow-y: auto;
            line-height: 1.6;
        }

        .log-entry {
            margin: 4px 0;
            padding: 4px 8px;
            border-left: 3px solid #4CAF50;
            background: rgba(76, 175, 80, 0.1);
        }

        .log-entry.info {
            border-left-color: #2196F3;
            background: rgba(33, 150, 243, 0.1);
        }

        .log-entry.success {
            border-left-color: #4CAF50;
            background: rgba(76, 175, 80, 0.1);
        }

        .log-entry.warning {
            border-left-color: #FF9800;
            background: rgba(255, 152, 0, 0.1);
        }

        .log-entry.error {
            border-left-color: #F44336;
            background: rgba(244, 67, 54, 0.1);
        }

        .log-timestamp {
            color: #888;
            font-size: 11px;
            margin-right: 8px;
        }

        .log-message {
            color: #d4d4d4;
        }
            border-left: 4px solid #ddd;
        }

        .model-item.loaded {
            border-left-color: #4CAF50;
            background: #e8f5e9;
        }

        .model-name {
            font-weight: bold;
            color: #333;
        }

        .model-memory {
            font-size: 12px;
            color: #666;
            margin-top: 4px;
        }

        .toast {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            background: #323232;
            color: white;
            border-radius: 4px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            z-index: 1000;
            animation: slideIn 0.3s;
        }

        @keyframes slideIn {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }

        .progress-bar {
            width: 100%;
            height: 8px;
            background: #eee;
            border-radius: 4px;
            overflow: hidden;
            margin-top: 5px;
        }

        .progress-fill {
            height: 100%;
            background: #4CAF50;
            transition: width 0.3s;
        }

        .timestamp {
            font-size: 12px;
            color: #999;
            text-align: right;
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 记忆面包闲时计算调试界面</h1>

        <div class="grid">
            <!-- 闲时检测器 -->
            <div class="card">
                <h2>⏱️ 闲时检测器</h2>
                <div class="stat">
                    <span class="stat-label">CPU 使用率</span>
                    <span class="stat-value" id="cpu-usage">--</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" id="cpu-progress" style="width: 0%"></div>
                </div>

                <div class="stat">
                    <span class="stat-label">内存使用率</span>
                    <span class="stat-value" id="memory-usage">--</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" id="memory-progress" style="width: 0%"></div>
                </div>

                <div class="stat">
                    <span class="stat-label">充电状态</span>
                    <span class="stat-value" id="power-status">--</span>
                </div>

                <div class="stat">
                    <span class="stat-label">稳定时长</span>
                    <span class="stat-value" id="stable-time">--</span>
                </div>

                <div class="stat">
                    <span class="stat-label">距离下次执行</span>
                    <span class="stat-value" id="next-exec">--</span>
                </div>

                <div class="stat">
                    <span class="stat-label">可执行闲时任务</span>
                    <span class="stat-value" id="can-execute">--</span>
                </div>
            </div>

            <!-- 任务调度器 -->
            <div class="card">
                <h2>📋 任务调度器</h2>
                <div class="stat">
                    <span class="stat-label">总提交</span>
                    <span class="stat-value" id="total-submitted">0</span>
                </div>
                <div class="stat">
                    <span class="stat-label">已完成</span>
                    <span class="stat-value ok" id="completed">0</span>
                </div>
                <div class="stat">
                    <span class="stat-label">失败</span>
                    <span class="stat-value error" id="failed">0</span>
                </div>
                <div class="stat">
                    <span class="stat-label">实时队列</span>
                    <span class="stat-value" id="pending-realtime">0</span>
                </div>
                <div class="stat">
                    <span class="stat-label">按需队列</span>
                    <span class="stat-value" id="pending-on-demand">0</span>
                </div>
                <div class="stat">
                    <span class="stat-label">闲时队列</span>
                    <span class="stat-value warning" id="pending-idle">0</span>
                </div>
                <div class="stat">
                    <span class="stat-label">总待处理</span>
                    <span class="stat-value" id="total-pending">0</span>
                </div>
            </div>

            <!-- 模型管理器 -->
            <div class="card">
                <h2>🧠 模型管理器</h2>
                <div class="stat">
                    <span class="stat-label">已加载模型数</span>
                    <span class="stat-value" id="loaded-count">0</span>
                </div>
                <div class="stat">
                    <span class="stat-label">总内存占用</span>
                    <span class="stat-value" id="total-memory">0 MB</span>
                </div>
                <div id="models-list" style="margin-top: 15px;">
                    <!-- 动态填充 -->
                </div>
            </div>
        </div>

        <!-- 任务提交按钮 -->
        <div class="grid">
            <div class="card">
                <h2>🔧 OCR 任务（实时）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    常驻内存 50MB，立即处理
                </p>
                <button class="btn-primary" onclick="submitTask('ocr')">
                    提交 OCR 任务
                </button>
                <div class="log-container" style="margin-top: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <strong style="font-size: 14px;">任务日志</strong>
                        <button class="btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="clearLogs('ocr')">清空</button>
                    </div>
                    <div id="ocr-logs" class="log-box"></div>
                </div>
            </div>

            <div class="card">
                <h2>🧮 Embedding 任务（闲时）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    闲时加载 650MB，批量处理
                </p>
                <button class="btn-primary" onclick="submitTask('embedding')">
                    提交 Embedding 任务
                </button>
                <div class="log-container" style="margin-top: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <strong style="font-size: 14px;">任务日志</strong>
                        <button class="btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="clearLogs('embedding')">清空</button>
                    </div>
                    <div id="embedding-logs" class="log-box"></div>
                </div>
            </div>

            <div class="card">
                <h2>🤖 LLM 任务（按需）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    按需加载 2.5GB，2分钟后卸载
                </p>
                <button class="btn-primary" onclick="submitTask('llm')">
                    提交 LLM 任务
                </button>
                <div class="log-container" style="margin-top: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <strong style="font-size: 14px;">任务日志</strong>
                        <button class="btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="clearLogs('llm')">清空</button>
                    </div>
                    <div id="llm-logs" class="log-box"></div>
                </div>
            </div>

            <div class="card">
                <h2>👁️ VLM 任务（闲时）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    闲时加载 3GB，图像理解
                </p>
                <button class="btn-primary" onclick="submitTask('vlm')">
                    提交 VLM 任务
                </button>
                <div class="log-container" style="margin-top: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <strong style="font-size: 14px;">任务日志</strong>
                        <button class="btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="clearLogs('vlm')">清空</button>
                    </div>
                    <div id="vlm-logs" class="log-box"></div>
                </div>
            </div>

            <div class="card">
                <h2>🎤 ASR 任务（闲时）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    闲时加载 80MB，语音转文字
                </p>
                <button class="btn-primary" onclick="submitTask('asr')">
                    提交 ASR 任务
                </button>
                <div class="log-container" style="margin-top: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <strong style="font-size: 14px;">任务日志</strong>
                        <button class="btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="clearLogs('asr')">清空</button>
                    </div>
                    <div id="asr-logs" class="log-box"></div>
                </div>
            </div>
        </div>
                </button>
            </div>

            <div class="card">
                <h2>🔧 Embedding 任务（闲时）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    闲时加载 650MB，批量处理
                </p>
                <button class="btn-secondary" onclick="submitTask('embedding')">
                    提交 Embedding 任务
                </button>
            </div>

            <div class="card">
                <h2>🔧 VLM 任务（闲时）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    闲时加载 3GB，批量处理
                </p>
                <button class="btn-secondary" onclick="submitTask('vlm')">
                    提交 VLM 任务
                </button>
            </div>

            <div class="card">
                <h2>🔧 ASR 任务（闲时）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    闲时加载 80MB，批量处理
                </p>
                <button class="btn-secondary" onclick="submitTask('asr')">
                    提交 ASR 任务
                </button>
            </div>

            <div class="card">
                <h2>🔧 LLM 任务（按需）</h2>
                <p style="color: #666; margin-bottom: 15px; font-size: 14px;">
                    按需加载 2.5GB，2 分钟后卸载
                </p>
                <button class="btn-primary" onclick="submitTask('llm')">
                    提交 LLM 任务
                </button>
            </div>

            <div class="card">
                <h2>⚙️ 系统操作</h2>
                <div class="button-group">
                    <button class="btn-warning" onclick="triggerIdle()">
                        手动触发闲时任务
                    </button>
                    <button class="btn-danger" onclick="unloadAll()">
                        卸载所有模型
                    </button>
                </div>
            </div>
        </div>

        <div class="timestamp" id="timestamp">--</div>
    </div>

    <script>
        let ws;

        // 连接 WebSocket
        function connectWebSocket() {
            ws = new WebSocket(`ws://${window.location.host}/ws`);

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                updateUI(data);
            };

            ws.onclose = () => {
                console.log('WebSocket 断开，3 秒后重连...');
                setTimeout(connectWebSocket, 3000);
            };

            ws.onerror = (error) => {
                console.error('WebSocket 错误:', error);
            };
        }

        // 更新 UI
        function updateUI(data) {
            // 时间戳
            document.getElementById('timestamp').textContent =
                `最后更新: ${new Date(data.timestamp).toLocaleString('zh-CN')}`;

            // 闲时检测器
            const idle = data.idle_detector;
            document.getElementById('cpu-usage').textContent =
                `${idle.cpu_usage}%`;
            document.getElementById('cpu-usage').className =
                `stat-value ${idle.cpu_ok ? 'ok' : 'warning'}`;
            document.getElementById('cpu-progress').style.width =
                `${idle.cpu_usage}%`;

            document.getElementById('memory-usage').textContent =
                `${idle.memory_usage}%`;
            document.getElementById('memory-usage').className =
                `stat-value ${idle.memory_ok ? 'ok' : 'warning'}`;
            document.getElementById('memory-progress').style.width =
                `${idle.memory_usage}%`;

            document.getElementById('power-status').textContent =
                idle.on_power ? '✅ 充电中' : '❌ 未充电';
            document.getElementById('power-status').className =
                `stat-value ${idle.on_power ? 'ok' : 'warning'}`;

            document.getElementById('stable-time').textContent =
                `${idle.stable_elapsed}/${idle.stable_required} 秒`;

            document.getElementById('next-exec').textContent =
                formatTime(idle.time_until_next);

            document.getElementById('can-execute').textContent =
                idle.can_execute ? '✅ 是' : '❌ 否';
            document.getElementById('can-execute').className =
                `stat-value ${idle.can_execute ? 'ok' : 'error'}`;

            // 任务调度器
            const task = data.task_scheduler;
            document.getElementById('total-submitted').textContent = task.total_submitted;
            document.getElementById('completed').textContent = task.completed;
            document.getElementById('failed').textContent = task.failed;
            document.getElementById('pending-realtime').textContent = task.pending_realtime;
            document.getElementById('pending-on-demand').textContent = task.pending_on_demand;
            document.getElementById('pending-idle').textContent = task.pending_idle;
            document.getElementById('total-pending').textContent = task.total_pending;

            // 模型管理器
            const model = data.model_manager;
            document.getElementById('loaded-count').textContent = model.loaded_count;
            document.getElementById('total-memory').textContent = `${model.total_memory_mb} MB`;

            // 模型列表
            const modelsList = document.getElementById('models-list');
            modelsList.innerHTML = '';
            for (const [type, info] of Object.entries(model.models)) {
                const div = document.createElement('div');
                div.className = `model-item ${info.loaded ? 'loaded' : ''}`;
                div.innerHTML = `
                    <div class="model-name">
                        ${info.loaded ? '🟢' : '⚪'} ${info.name}
                    </div>
                    <div class="model-memory">
                        ${info.memory_mb} MB ${info.keep_loaded ? '(常驻)' : ''}
                    </div>
                `;
                modelsList.appendChild(div);
            }
        }

        // 格式化时间
        function formatTime(seconds) {
            if (seconds === 0) return '立即可执行';
            if (seconds < 60) return `${seconds} 秒`;
            if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
            return `${Math.floor(seconds / 3600)} 小时`;
        }

        // 显示提示
        function showToast(message) {
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.remove();
            }, 3000);
        }

        // 提交任务
        async function submitTask(type) {
            try {
                const response = await fetch(`/api/task/${type}`, {
                    method: 'POST'
                });
                const data = await response.json();
                showToast(data.message);

                // 刷新该任务的日志
                await loadTaskLogs(type);
            } catch (error) {
                showToast('提交失败: ' + error.message);
            }
        }

        // 加载任务日志
        async function loadTaskLogs(type) {
            try {
                const response = await fetch(`/api/logs/${type}`);
                const data = await response.json();

                const logBox = document.getElementById(`${type}-logs`);
                if (!logBox) return;

                logBox.innerHTML = '';

                if (data.logs && data.logs.length > 0) {
                    data.logs.forEach(log => {
                        const entry = document.createElement('div');
                        entry.className = `log-entry ${log.level}`;

                        const timestamp = new Date(log.timestamp).toLocaleTimeString('zh-CN');
                        entry.innerHTML = `
                            <span class="log-timestamp">${timestamp}</span>
                            <span class="log-message">${log.message}</span>
                        `;

                        logBox.appendChild(entry);
                    });

                    // 滚动到底部
                    logBox.scrollTop = logBox.scrollHeight;
                } else {
                    logBox.innerHTML = '<div style="color: #888; text-align: center; padding: 20px;">暂无日志</div>';
                }
            } catch (error) {
                console.error('加载日志失败:', error);
            }
        }

        // 清空任务日志
        async function clearLogs(type) {
            try {
                const response = await fetch(`/api/logs/${type}/clear`, {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.success) {
                    const logBox = document.getElementById(`${type}-logs`);
                    if (logBox) {
                        logBox.innerHTML = '<div style="color: #888; text-align: center; padding: 20px;">暂无日志</div>';
                    }
                    showToast('日志已清空');
                }
            } catch (error) {
                showToast('清空失败: ' + error.message);
            }
        }

        // 定时刷新所有任务日志
        setInterval(() => {
            ['ocr', 'embedding', 'llm', 'vlm', 'asr'].forEach(type => {
                loadTaskLogs(type);
            });
        }, 2000); // 每2秒刷新一次

        // 触发闲时任务
        async function triggerIdle() {
            try {
                const response = await fetch('/api/trigger_idle', {
                    method: 'POST'
                });
                const data = await response.json();
                showToast(data.message);
            } catch (error) {
                showToast('触发失败: ' + error.message);
            }
        }

        // 卸载所有模型
        async function unloadAll() {
            if (!confirm('确定要卸载所有模型吗？')) return;

            try {
                const response = await fetch('/api/model/unload_all', {
                    method: 'POST'
                });
                const data = await response.json();
                showToast(data.message);
            } catch (error) {
                showToast('卸载失败: ' + error.message);
            }
        }

        // 启动
        connectWebSocket();

        // 初始加载所有日志
        ['ocr', 'embedding', 'llm', 'vlm', 'asr'].forEach(type => {
            loadTaskLogs(type);
        });
    </script>
</body>
</html>
"""


# ── 主程序 ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    print("=" * 60)
    print("记忆面包闲时计算调试界面")
    print("=" * 60)
    print("访问地址: http://localhost:8000")
    print("=" * 60)

    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
