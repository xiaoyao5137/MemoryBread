"""
启动调试界面

运行此脚本启动 Web 调试界面：
    python start_debug_ui.py

然后在浏览器访问：
    http://localhost:8080
"""

from __future__ import annotations

import logging
import sys

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
    ]
)

if __name__ == "__main__":
    import uvicorn
    from debug_ui import app

    print("=" * 60)
    print("记忆面包闲时计算调试界面")
    print("=" * 60)
    print("启动中...")
    print()
    print("访问地址: http://localhost:8080")
    print("按 Ctrl+C 停止")
    print("=" * 60)

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8080,
        log_level="info",
    )
