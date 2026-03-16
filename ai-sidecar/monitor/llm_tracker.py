"""
LLM 用量埋点工具

所有调用 LLM 的模块（TaskExecutor、RAG、KnowledgeExtractor）
在调用后通过此模块记录 token 用量到 llm_usage_logs 表。
"""

import sqlite3
import time
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DB_PATH = str(Path.home() / ".workbuddy" / "workbuddy.db")


def log_llm_usage(
    caller: str,
    model_name: str,
    prompt_tokens: int,
    completion_tokens: int,
    latency_ms: int,
    caller_id: Optional[str] = None,
    status: str = "success",
    error_msg: Optional[str] = None,
    db_path: str = DB_PATH,
):
    """
    记录一次 LLM 调用的 token 用量。

    Args:
        caller: 调用来源，'rag' | 'task' | 'knowledge'
        model_name: 模型名称，如 'qwen2.5:3b'
        prompt_tokens: 输入 token 数
        completion_tokens: 输出 token 数
        latency_ms: 调用耗时（毫秒）
        caller_id: 关联 ID（task_id / rag_session_id 等）
        status: 'success' | 'failed'
        error_msg: 失败原因
    """
    try:
        conn = sqlite3.connect(db_path)
        conn.execute(
            """INSERT INTO llm_usage_logs
               (ts, caller, caller_id, model_name, prompt_tokens, completion_tokens,
                total_tokens, latency_ms, status, error_msg)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                int(time.time() * 1000),
                caller,
                caller_id,
                model_name,
                prompt_tokens,
                completion_tokens,
                prompt_tokens + completion_tokens,
                latency_ms,
                status,
                error_msg,
            ),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        # 埋点失败不影响主流程
        logger.warning(f"LLM 用量埋点失败: {e}")


def estimate_tokens(text: str) -> int:
    """粗略估算 token 数（中文约1.5字/token，英文约4字/token）"""
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars
    return int(chinese_chars / 1.5 + other_chars / 4)


class LLMCallTracker:
    """
    上下文管理器，自动记录 LLM 调用的耗时和 token 用量。

    用法：
        with LLMCallTracker(caller='rag', model='qwen2.5:3b') as tracker:
            response = client.chat(...)
            tracker.set_response(response)
    """

    def __init__(self, caller: str, model_name: str, caller_id: Optional[str] = None, db_path: str = DB_PATH):
        self.caller = caller
        self.model_name = model_name
        self.caller_id = caller_id
        self.db_path = db_path
        self._start_ms = 0
        self._prompt_tokens = 0
        self._completion_tokens = 0
        self._status = "success"
        self._error_msg = None

    def __enter__(self):
        self._start_ms = int(time.time() * 1000)
        return self

    def set_response(self, response: dict):
        """从 Ollama 响应中提取 token 用量"""
        usage = response.get("usage") or {}
        # Ollama 响应格式
        self._prompt_tokens = (
            usage.get("prompt_tokens")
            or response.get("prompt_eval_count")
            or 0
        )
        self._completion_tokens = (
            usage.get("completion_tokens")
            or response.get("eval_count")
            or 0
        )
        # 如果没有 token 信息，用文本估算
        if self._prompt_tokens == 0:
            content = response.get("message", {}).get("content", "")
            self._completion_tokens = estimate_tokens(content)

    def set_error(self, error_msg: str):
        self._status = "failed"
        self._error_msg = error_msg

    def set_tokens(self, prompt: int, completion: int):
        self._prompt_tokens = prompt
        self._completion_tokens = completion

    def __exit__(self, exc_type, exc_val, exc_tb):
        latency_ms = int(time.time() * 1000) - self._start_ms
        if exc_type is not None:
            self._status = "failed"
            self._error_msg = str(exc_val)
        log_llm_usage(
            caller=self.caller,
            model_name=self.model_name,
            prompt_tokens=self._prompt_tokens,
            completion_tokens=self._completion_tokens,
            latency_ms=latency_ms,
            caller_id=self.caller_id,
            status=self._status,
            error_msg=self._error_msg,
            db_path=self.db_path,
        )
        return False  # 不吞异常
