"""
全局模型注册中心（单例）

解决的问题：
1. EmbeddingModel 在 RAG pipeline 和 BackgroundProcessor 中各创建一份（重复占用）
2. Ollama LLM 模型名不统一，导致 Ollama 反复加载/卸载不同模型
3. 模型生命周期不受 idle_compute.ModelManager 管理

使用方式：
    from model_registry_global import get_shared_embedding, get_active_ollama_model

所有模块通过本模块获取模型实例，确保进程内只有一份 EmbeddingModel，
且所有 Ollama 调用使用同一个 active_llm 模型名。

注：Embedding 已从本地 BGE-M3-INT8 (PyTorch, ~650MB) 迁移到 Ollama API
的 bge-small-zh-v1.5 (Q4量化, ~41MB GPU)，消除 PyTorch 本地加载开销。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

import psutil

logger = logging.getLogger(__name__)

# ── 全局单例状态 ──────────────────────────────────────────────────────────────

_embedding_instance = None
_embedding_lock = threading.Lock()
_active_ollama_model: Optional[str] = None
_ollama_model_lock = threading.Lock()


# ── EmbeddingModel 单例 ──────────────────────────────────────────────────────

def get_shared_embedding():
    """
    获取全局共享的 EmbeddingModel 单例。

    首次调用时创建，后续调用直接返回同一实例。
    线程安全。
    """
    global _embedding_instance
    if _embedding_instance is not None:
        return _embedding_instance

    with _embedding_lock:
        if _embedding_instance is not None:
            return _embedding_instance

        from embedding.model import EmbeddingModel
        from idle_compute.model_manager import _log_model_event
        import time

        logger.info("创建全局共享 EmbeddingModel...")
        start_ms = int(time.time() * 1000)
        mem_before = int(psutil.virtual_memory().available / 1024 / 1024)

        _log_model_event("load_start", "embedding", "Shared Embedding · bge-small-zh-v1.5 (Ollama)", memory_mb=41)
        _embedding_instance = EmbeddingModel.create_default()

        duration_ms = int(time.time() * 1000) - start_ms
        mem_after = int(psutil.virtual_memory().available / 1024 / 1024)
        _log_model_event(
            "load_done", "embedding", "Shared Embedding · bge-small-zh-v1.5 (Ollama)",
            duration_ms=duration_ms, memory_mb=41,
            mem_before_mb=mem_before, mem_after_mb=mem_after,
        )
        logger.info("全局共享 EmbeddingModel 创建完成 (耗时 %.1fs)", duration_ms / 1000)
        return _embedding_instance


def reset_shared_embedding():
    """
    重置 EmbeddingModel 单例（用于模型切换或测试）。

    释放旧实例并强制 GC，下次 get_shared_embedding() 会重新创建。
    """
    global _embedding_instance
    with _embedding_lock:
        if _embedding_instance is not None:
            logger.info("释放全局共享 EmbeddingModel")
            from idle_compute.model_manager import _log_model_event
            mem_before = int(psutil.virtual_memory().available / 1024 / 1024)

            _log_model_event("unload", "embedding", "Shared Embedding · bge-small-zh-v1.5 (Ollama)", memory_mb=41)
            del _embedding_instance
            _embedding_instance = None

            import gc
            gc.collect()

            mem_after = int(psutil.virtual_memory().available / 1024 / 1024)
            _log_model_event(
                "unload", "embedding", "Shared Embedding · bge-small-zh-v1.5 (Ollama)",
                memory_mb=41, mem_before_mb=mem_before, mem_after_mb=mem_after,
            )


# ── Ollama 模型名统一 ──────────────────────────────────────────────────────

def get_active_ollama_model() -> str:
    """
    获取当前激活的 Ollama LLM 模型名（如 "qwen3.5:4b"）。

    从 model_config.json 读取用户配置的 active_llm，
    映射到 Ollama 实际的模型标识（model_id）。
    所有需要调用 Ollama LLM 的模块都应通过此函数获取模型名，
    避免硬编码不同模型名导致 Ollama 频繁 swap。
    """
    global _active_ollama_model
    with _ollama_model_lock:
        if _active_ollama_model is not None:
            return _active_ollama_model

        # 从 model_manager 的配置读取
        try:
            from model_manager import AVAILABLE_MODELS as MANAGER_MODELS
            config_path = Path.home() / ".memory-bread" / "model_config.json"
            import json
            if config_path.exists():
                with open(config_path, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                active_llm_id = config.get('active_llm', 'qwen3.5-4b')
                model_info = MANAGER_MODELS.get(active_llm_id)
                if model_info and model_info.provider == 'ollama':
                    _active_ollama_model = model_info.model_id
                    logger.info("激活 Ollama LLM 模型: %s → %s", active_llm_id, _active_ollama_model)
                    return _active_ollama_model
        except Exception as e:
            logger.warning("读取激活模型配置失败: %s, 使用默认值", e)

        # 默认值
        _active_ollama_model = "qwen3.5:4b"
        logger.info("使用默认 Ollama LLM 模型: %s", _active_ollama_model)
        return _active_ollama_model


def set_active_ollama_model(model_name: str):
    """
    更新当前激活的 Ollama 模型名。

    在用户切换模型时调用，确保后续所有 Ollama LLM 调用使用新模型。
    """
    global _active_ollama_model
    with _ollama_model_lock:
        old = _active_ollama_model
        _active_ollama_model = model_name
        logger.info("Ollama LLM 模型切换: %s → %s", old, model_name)


# ── 内存压力保护 ──────────────────────────────────────────────────────────────

def check_memory_pressure() -> str:
    """
    检查当前内存压力等级。

    Returns:
        "normal" | "high" | "critical"
    """
    try:
        mem = psutil.virtual_memory()
        if mem.percent >= 90:
            return "critical"
        elif mem.percent >= 80:
            return "high"
        return "normal"
    except Exception:
        return "normal"


def should_proceed_with_model_load(estimated_mb: int) -> bool:
    """
    判断是否应继续加载模型。

    Args:
        estimated_mb: 预计需要加载的模型内存占用（MB）

    Returns:
        True 可以加载，False 应跳过（内存不足）
    """
    try:
        available_mb = int(psutil.virtual_memory().available / 1024 / 1024)
        # 保留 1GB 给系统和 core-engine
        min_reserved_mb = 1024
        if available_mb - estimated_mb < min_reserved_mb:
            logger.warning(
                "内存不足以加载模型: 可用 %dMB, 需要 %dMB, 保留 %dMB → 跳过",
                available_mb, estimated_mb, min_reserved_mb,
            )
            return False
        return True
    except Exception:
        return True  # 拿不到信息时 fail-open
