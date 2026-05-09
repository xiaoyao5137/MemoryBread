#!/usr/bin/env python3
"""启动创作服务"""
import sys
import uvicorn

# 添加项目根目录到 Python 路径
sys.path.insert(0, '/Users/xianjiaqi/Documents/mygit/cy/gzdz/ai-sidecar')

from creation.app import app

if __name__ == "__main__":
    print("🚀 启动创作服务...")
    print("📍 监听地址: http://localhost:8001")
    print("📝 端点: POST /creation/generate")
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")
