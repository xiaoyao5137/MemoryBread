#!/usr/bin/env python3
"""调试 Ollama 响应格式"""
import httpx
import json
import asyncio

async def debug_ollama():
    url = "http://localhost:11434/api/chat"
    payload = {
        "model": "qwen3.5:4b",
        "messages": [
            {"role": "system", "content": "你是技术文档助手。直接输出内容，不要思考过程。"},
            {"role": "user", "content": "写一篇50字的技术文档"}
        ],
        "stream": True
    }

    print("🔍 调试 Ollama 响应格式\n")

    async with httpx.AsyncClient(timeout=30.0) as client:
        async with client.stream("POST", url, json=payload) as response:
            line_count = 0
            async for line in response.aiter_lines():
                line_count += 1
                if line:
                    print(f"[{line_count}] 原始行: {repr(line[:200])}")
                    try:
                        data = json.loads(line)
                        print(f"     解析后: {json.dumps(data, ensure_ascii=False)[:200]}")
                        if "message" in data:
                            print(f"     message: {data['message']}")
                    except:
                        print(f"     ❌ 无法解析为 JSON")
                    print()

                    if line_count >= 10:
                        break

if __name__ == "__main__":
    asyncio.run(debug_ollama())
