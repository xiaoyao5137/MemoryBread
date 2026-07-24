"""PyInstaller 入口：在一个受签名的 helper 中承载三个本地 AI 服务。"""

from __future__ import annotations

import argparse
import asyncio
import logging
import multiprocessing
import os
import threading


def run_sidecar() -> None:
    import main as sidecar_main

    asyncio.run(sidecar_main._main())


def run_model_api() -> None:
    import model_api_server as server

    logging.basicConfig(level=logging.INFO)

    def warmup_rag_pipeline() -> None:
        try:
            server.get_rag_pipeline()
            server.logger.info("RAG pipeline 预热完成")
        except Exception as exc:
            server.logger.error("RAG pipeline 预热失败: %s", exc, exc_info=True)

    threading.Thread(
        target=warmup_rag_pipeline,
        daemon=True,
        name="rag-warmup",
    ).start()
    server.logger.info("RAG pipeline 异步预热已启动")
    server._idle_diary_backfill_worker.start()
    server.app.run(
        host="127.0.0.1",
        port=7071,
        debug=False,
        threaded=True,
        use_reloader=False,
    )


def run_creation_service() -> None:
    import uvicorn
    from creation.app import app

    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="记忆面包本地 AI 服务")
    parser.add_argument(
        "service",
        choices=("sidecar", "model-api", "creation"),
        help="要启动的内置服务",
    )
    return parser.parse_args()


def main() -> None:
    multiprocessing.freeze_support()
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    service = parse_args().service
    if service == "sidecar":
        run_sidecar()
    elif service == "model-api":
        run_model_api()
    else:
        run_creation_service()


if __name__ == "__main__":
    main()
