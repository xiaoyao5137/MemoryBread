#!/usr/bin/env python3
"""测试创作服务生成长度"""
import requests
import json

url = "http://localhost:8001/creation/generate"
payload = {
    "user_prompt": "帮我写一篇对vllm实现时分PD分离的技术方案",
    "design_templates": [],
    "timeline_context": None,
    "capture_context": None
}

print("🚀 开始测试创作服务...")
print(f"📝 提示词: {payload['user_prompt']}\n")

response = requests.post(url, json=payload, stream=True, timeout=120)

if response.status_code != 200:
    print(f"❌ 错误: {response.status_code}")
    print(response.text)
    exit(1)

full_text = ""
chunk_count = 0

print("📄 生成中...\n")
for line in response.iter_lines():
    if line:
        line_str = line.decode('utf-8')
        if line_str.startswith('data: '):
            content = line_str[6:]
            if content and content != '""':
                try:
                    # 去掉引号
                    content = json.loads(content)
                    full_text += content
                    chunk_count += 1
                    if chunk_count % 50 == 0:
                        print(f"已生成 {len(full_text)} 字符...")
                except:
                    pass

print(f"\n✅ 生成完成!")
print(f"📊 统计信息:")
print(f"  - 总字符数: {len(full_text)}")
print(f"  - 总块数: {chunk_count}")
print(f"  - 中文字符数: {sum(1 for c in full_text if '一' <= c <= '鿿')}")
print(f"\n📝 前 500 字符预览:")
print(full_text[:500])
print(f"\n📝 后 500 字符预览:")
print(full_text[-500:])
