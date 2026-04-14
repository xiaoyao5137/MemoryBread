"""
记忆面包 AI Sidecar 入口点

启动方式：
    python main.py                    # 生产模式（加载所有 AI 模型）
    python main.py --dry-run          # 干运行（仅测试 IPC 通信，不加载模型）
    python main.py --log-level DEBUG  # 调试日志

环境变量：
    SIDECAR_LOG_LEVEL: 日志级别（DEBUG/INFO/WARNING/ERROR），默认 INFO
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import threading
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
IPC_PYTHON_DIR = PROJECT_ROOT.parent / "shared" / "ipc-protocol" / "python"
if str(IPC_PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(IPC_PYTHON_DIR))

from memory_bread_ipc import IpcServer

# ─────────────────────────────────────────────────────────────────────────────
# 日志配置
# ─────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)-20s %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("sidecar.main")


# ─────────────────────────────────────────────────────────────────────────────
# CLI 参数
# ─────────────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="记忆面包 AI Sidecar",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="不加载 AI 模型，仅测试 IPC 服务是否正常启动",
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("SIDECAR_LOG_LEVEL", "INFO"),
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="日志级别（默认 INFO）",
    )
    return parser.parse_args()


# ─────────────────────────────────────────────────────────────────────────────
# 内部向量搜索 HTTP 服务（端口 7072）
# 在 sidecar 进程内运行，复用 VectorStorage 单例的 Qdrant 客户端，
# 避免 model_api_server 另开 Qdrant 连接导致文件锁冲突。
# ─────────────────────────────────────────────────────────────────────────────

def _start_vector_search_server() -> None:
    """在 daemon 线程中启动内部向量搜索 HTTP 服务（端口 7072）。"""
    try:
        from flask import Flask, jsonify, request as flask_request

        _vs_app = Flask("vector_search_internal")
        logging.getLogger("werkzeug").setLevel(logging.WARNING)

        @_vs_app.route('/vector_search', methods=['POST'])
        def vector_search():
            data = flask_request.get_json()
            if not data or 'query_vector' not in data:
                return jsonify({'error': 'missing query_vector'}), 400
            query_vector = data['query_vector']
            top_k = int(data.get('top_k', 10))
            score_threshold = float(data.get('score_threshold', 0.3))
            try:
                from embedding.vector_storage import get_vector_storage
                vs = get_vector_storage()
                client = vs._get_qdrant_client()
                if client is None:
                    return jsonify({'error': 'Qdrant client not available'}), 503
                results = client.query_points(
                    collection_name=vs._collection_name,
                    query=query_vector,
                    limit=top_k,
                    score_threshold=score_threshold,
                ).points
                hits = []
                for hit in results:
                    payload = dict(hit.payload or {})
                    capture_id = int(payload.get('capture_id') or 0)
                    doc_key = payload.get('doc_key') or f"capture:{capture_id}"
                    hits.append({
                        'capture_id': capture_id,
                        'doc_key': doc_key,
                        'text': payload.get('text', ''),
                        'score': float(hit.score),
                        'source': 'vector',
                        'metadata': payload,
                    })
                return jsonify({'results': hits})
            except Exception as e:
                logging.getLogger(__name__).error("vector_search 失败: %s", e)
                return jsonify({'error': str(e)}), 500

        @_vs_app.route('/health', methods=['GET'])
        def health():
            return jsonify({'status': 'ok', 'service': 'vector_search'})

        logging.getLogger(__name__).info("内部向量搜索服务已启动 (port 7072)")
        _vs_app.run(host='127.0.0.1', port=7072, debug=False, threaded=True, use_reloader=False)
    except Exception as e:
        logging.getLogger(__name__).warning("内部向量搜索服务启动失败（不影响主服务）: %s", e)


# ─────────────────────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────────────────────

async def _main() -> None:
    args = _parse_args()
    logging.getLogger().setLevel(args.log_level)
    limited_mode = os.environ.get("SIDECAR_LIMITED_MODE") == "1"

    # 启动内部向量搜索 HTTP 服务（daemon 线程）
    threading.Thread(target=_start_vector_search_server, daemon=True, name="vector-search-server").start()

    if args.dry_run:
        # 干运行：只处理 ping，其余任务返回 NOT_IMPLEMENTED
        from memory_bread_ipc.transport import default_dispatch
        dispatch_fn = default_dispatch
        logger.info("dry-run 模式：使用内置 ping-only 分发器")
        bg_processor = None
    else:
        # 基础 OCR 模式：跳过大模型/向量模型启动检查，只保留 ping + OCR
        if limited_mode:
            logger.warning("SIDECAR_LIMITED_MODE=1，启用基础 IPC 模式，仅保留 ping/OCR 能力")
            from memory_bread_ipc import IpcResponse, PingResult
            from ocr.worker import OcrWorker
            from ocr.engine import OcrEngine

            ocr_worker = OcrWorker(engine=OcrEngine.create_default())

            async def limited_dispatch(req):
                if req.task.type == "ping":
                    return IpcResponse.make_ok(req.id, PingResult(), 0)
                if req.task.type == "ocr":
                    return await ocr_worker.handle(req)
                return IpcResponse.make_error(req.id, "NOT_IMPLEMENTED", f"任务类型 '{req.task.type}' 在基础 IPC 模式下不可用", 0)

            dispatch_fn = limited_dispatch
            bg_processor = None
        else:
            # 生产模式：运行启动检查
            from startup_checks import run_startup_checks
            if not run_startup_checks():
                logger.warning("启动检查未通过，退回基础 IPC 模式，仅保留 ping/OCR 能力")
                from memory_bread_ipc import IpcResponse, PingResult
                from ocr.worker import OcrWorker
                from ocr.engine import OcrEngine

                ocr_worker = OcrWorker(engine=OcrEngine.create_default())

                async def limited_dispatch(req):
                    if req.task.type == "ping":
                        return IpcResponse.make_ok(req.id, PingResult(), 0)
                    if req.task.type == "ocr":
                        return await ocr_worker.handle(req)
                    return IpcResponse.make_error(req.id, "NOT_IMPLEMENTED", f"任务类型 '{req.task.type}' 在基础 IPC 模式下不可用", 0)

                dispatch_fn = limited_dispatch
                bg_processor = None
            else:
                from dispatcher_v2 import Dispatcher
                d = Dispatcher()
                await d.initialize()
                dispatch_fn = d.dispatch
                logger.info("生产模式：使用完整任务分发器")

                # 启动后台处理器（向量化 + 知识提炼）
                from background_processor import BackgroundProcessor
                from pathlib import Path
                db_path = str(Path.home() / ".memory-bread" / "memory-bread.db")
                bg_processor = BackgroundProcessor(db_path=db_path, interval=90, batch_size=8)
                asyncio.create_task(bg_processor.run())
                logger.info("后台处理器已启动（向量化 + 知识提炼）")

    server = IpcServer(dispatch_fn=dispatch_fn)

    # 注册优雅关闭信号
    loop = asyncio.get_running_loop()
    def shutdown():
        server.stop()
        if bg_processor:
            bg_processor.stop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown)

    logger.info("记忆面包 AI Sidecar 启动完成，等待 Rust Core Engine 连接...")
    await server.serve()
    logger.info("Sidecar 已正常退出")


if __name__ == "__main__":
    asyncio.run(_main())
