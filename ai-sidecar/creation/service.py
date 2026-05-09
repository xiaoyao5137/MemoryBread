"""创作服务 - 调用 Ollama 生成文档"""
import json
from typing import AsyncIterator, Optional
import httpx


class CreationService:
    def __init__(self, ollama_base_url: str = "http://localhost:11434"):
        self.ollama_base_url = ollama_base_url
        self.model = "qwen2.5:3b"  # 使用 qwen2.5 而不是 qwen3.5

    async def generate_document(
        self,
        user_prompt: str,
        design_templates: list[dict],
        timeline_context: Optional[str] = None,
        capture_context: Optional[str] = None,
    ) -> AsyncIterator[str]:
        """流式生成文档"""
        import logging
        logger = logging.getLogger(__name__)

        system_prompt = self._build_system_prompt(design_templates)
        user_message = self._build_user_message(
            user_prompt, timeline_context, capture_context
        )

        logger.info(f"使用模型: {self.model}")
        logger.info(f"System prompt 长度: {len(system_prompt)}")
        logger.info(f"User message 长度: {len(user_message)}")

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "stream": True,
            "options": {
                "temperature": 0.8,  # 提高创造性
                "top_p": 0.9,
                "num_predict": 4096,  # 增加最大生成长度
            },
        }

        chunk_count = 0
        thinking_mode = True  # 跟踪是否还在思考阶段
        async with httpx.AsyncClient(timeout=300.0) as client:
            async with client.stream(
                "POST", f"{self.ollama_base_url}/api/chat", json=payload
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line:
                        try:
                            data = json.loads(line)
                            if "message" in data:
                                # 优先使用 content，如果为空则跳过（忽略 thinking）
                                content = data["message"].get("content", "")
                                if content:
                                    thinking_mode = False  # 开始输出实际内容
                                    chunk_count += 1
                                    if chunk_count % 100 == 0:
                                        logger.info(f"已生成 {chunk_count} 个块")
                                    yield content
                        except json.JSONDecodeError:
                            continue

        logger.info(f"生成完成，总共 {chunk_count} 个块")

    def _build_system_prompt(self, design_templates: list[dict]) -> str:
        """构建系统提示词"""
        return """你是一个专业的技术文档创作助手。

要求：
1. 使用 Markdown 格式
2. 文档长度 2000-3000 字
3. 包含 5-7 个主要章节
4. 每个章节包含详细说明和示例
5. 直接输出内容，不要思考过程
6. 不要输出 "Thinking..." 等思考内容"""

    def _build_user_message(
        self,
        user_prompt: str,
        timeline_context: Optional[str],
        capture_context: Optional[str],
    ) -> str:
        """构建用户消息"""
        message = f"请根据以下指令生成技术文档：\n\n{user_prompt}\n\n"

        if timeline_context:
            message += f"参考时间线：{timeline_context}\n\n"

        if capture_context:
            message += f"参考采集记录：{capture_context}\n\n"

        message += "现在开始生成文档："
        return message
