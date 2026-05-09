#!/usr/bin/env python3
"""直接测试 Ollama API"""
import httpx
import json
import asyncio

async def test_ollama():
    url = "http://localhost:11434/api/chat"
    payload = {
        "model": "qwen3.5:4b",
        "messages": [
            {"role": "user", "content": "你好，请简单回复"}
        ],
        "stream": True
    }

    print("🚀 测试 Ollama 流式生成...")
    print(f"📝 模型: {payload['model']}\n")

    chunk_count = 0
    content_count = 0

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream("POST", url, json=payload) as response:
                print(f"✅ 响应状态: {response.status_code}")
                print(f"📄 开始接收数据...\n")

                async for line in response.aiter_lines():
                    if line:
                        chunk_count += 1
                        try:
                            data = json.loads(line)
                            if "message" in data and "content" in data["message"]:
                                content = data["message"]["content"]
                                if content:
                                    content_count += 1
                                    print(f"[{content_count}] {repr(content)}")
                        except json.JSONDecodeError as e:
                            print(f"❌ JSON 解析错误: {e}")
                            print(f"   原始行: {repr(line[:100])}")

                print(f"\n✅ 完成!")
                print(f"📊 总块数: {chunk_count}")
                print(f"📊 有内容的块数: {content_count}")
    except Exception as e:
        print(f"❌ 错误: {e}")

if __name__ == "__main__":
    asyncio.run(test_ollama())
