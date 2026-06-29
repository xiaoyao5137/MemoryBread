"""
模型注册表

定义所有可用模型的元数据，并提供基于硬件的选型建议。
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any


@dataclass
class ApiKeyField:
    key:         str
    label:       str
    placeholder: str
    required:    bool = True
    secret:      bool = True


@dataclass
class ModelMeta:
    id:               str
    name:             str
    category:         str          # llm | embedding | ocr | asr | vlm | image
    provider:         str          # ollama | huggingface | openai | anthropic | tongyi | doubao | deepseek | kimi | kling
    size_gb:          float
    description:      str
    is_default:       bool = False
    requires_api_key: bool = False
    api_key_fields:   List[ApiKeyField] = field(default_factory=list)
    tags:             List[str] = field(default_factory=list)
    min_memory_gb:    float = 0.0  # 运行所需最低内存


# 前端只暴露 MemoryBread 品牌模型 ID；真实模型名集中在后端映射，便于后续替换底层模型。
MODEL_ID_ALIASES: Dict[str, str] = {
    "qwen3.5-4b": "mbem-v1-local",
    "qwen2.5-3b": "mbem-v1-local",
    "qwen2.5-7b": "mbem-v1-local",
    "deepseek-r1-7b": "mbem-v1-local",
    "gemma4-e4b": "mbem-v1-local",
    "bge-m3": "bge-small-zh",
    "nomic-embed-text": "bge-small-zh",
    "text-embedding-3-small": "bge-small-zh",
}


# ── 模型目录 ──────────────────────────────────────────────────────────────────

AVAILABLE_MODELS: List[ModelMeta] = [

    # ── 采集分析模型（本地 Ollama）───────────────────────────────────────────
    ModelMeta(
        id="mbem-v1-local", name="MBEM v1.0", category="llm", provider="ollama",
        size_gb=3.4, min_memory_gb=6.0, is_default=True,
        description="MemoryBread Extract Model Local 1.0，本地提炼模型 v1，用于采集内容理解、知识提炼和本地咨询分析",
        tags=["推荐", "本地", "采集分析"],
    ),

    # ── 本地 Embedding（Ollama）──────────────────────────────────────────────
    ModelMeta(
        id="bge-small-zh", name="BGE-Small-ZH-Q4", category="embedding", provider="ollama",
        size_gb=0.05, min_memory_gb=1.0, is_default=True,
        description="BAAI BGE-Small 中文版，512 维，量化版本，内存占用低",
        tags=["推荐", "超轻量", "中文"],
    ),

    # ── 生图模型 ─────────────────────────────────────────────────────────────
    ModelMeta(
        id="gpt-image-2", name="GPT Image 2", category="image", provider="openai",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="OpenAI GPT Image 2，最新图像生成模型，理解能力更强",
        tags=["最新", "文生图", "高质量"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
            ApiKeyField("base_url", "Base URL（可选）", "https://api.openai.com/v1", required=False, secret=False),
        ],
    ),
    ModelMeta(
        id="gemini-nano-banana", name="Gemini Nano Banana", category="image", provider="google",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="Google Gemini Nano Banana，轻量级图像生成模型，速度快",
        tags=["文生图", "快速"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "...", required=True, secret=True),
        ],
    ),
]

# 快速查找
_MODEL_MAP: Dict[str, ModelMeta] = {m.id: m for m in AVAILABLE_MODELS}


def get_model(model_id: str) -> Optional[ModelMeta]:
    model_id = MODEL_ID_ALIASES.get(model_id, model_id)
    return _MODEL_MAP.get(model_id)


def list_models(category: Optional[str] = None) -> List[ModelMeta]:
    if category:
        return [m for m in AVAILABLE_MODELS if m.category == category]
    return AVAILABLE_MODELS


# ── 硬件选型建议 ──────────────────────────────────────────────────────────────

def get_recommendations(
    memory_gb: float,
    cpu_cores: int,
    disk_free_gb: float,
    has_gpu: bool = False,
    gpu_memory_gb: float = 0.0,
) -> Dict[str, Any]:
    """
    基于硬件配置返回推荐模型 id 列表和建议说明。

    Returns:
        {
            "recommended_ids": [...],
            "tier": "low" | "mid" | "high",
            "reason": "...",
            "suggest_api": bool,
        }
    """
    recommended_ids = []
    suggest_api = False

    # 判断硬件档次
    if memory_gb < 8:
        tier = "low"
        reason = f"内存 {memory_gb:.0f}GB 较小，推荐轻量本地模型或商业 API"
        suggest_api = True
        # LLM：只推荐 ≤3B
        for m in AVAILABLE_MODELS:
            if m.category == "llm" and m.provider == "ollama" and m.min_memory_gb <= memory_gb:
                recommended_ids.append(m.id)
        # 商业 API 也推荐
    elif memory_gb < 16:
        tier = "mid"
        reason = f"内存 {memory_gb:.0f}GB，可运行 3B-7B 本地模型"
        for m in AVAILABLE_MODELS:
            if m.category == "llm" and m.provider == "ollama" and m.min_memory_gb <= memory_gb:
                recommended_ids.append(m.id)
    else:
        tier = "high"
        reason = f"内存 {memory_gb:.0f}GB，可运行大型本地模型"
        for m in AVAILABLE_MODELS:
            if m.category == "llm" and m.provider == "ollama" and m.min_memory_gb <= memory_gb:
                recommended_ids.append(m.id)

    # 磁盘不足时不推荐大模型
    if disk_free_gb < 5:
        reason += f"，磁盘剩余 {disk_free_gb:.0f}GB 不足，建议使用商业 API"
        suggest_api = True
        recommended_ids = [i for i in recommended_ids
                           if not _MODEL_MAP.get(i) or _MODEL_MAP[i].size_gb < disk_free_gb]
        if not any(i for i in recommended_ids if _MODEL_MAP.get(i) and _MODEL_MAP[i].provider == "ollama"):
            recommended_ids = []

    # Embedding 推荐
    recommended_ids.append("bge-small-zh")

    return {
        "recommended_ids": list(dict.fromkeys(recommended_ids)),  # 去重保序
        "tier": tier,
        "reason": reason,
        "suggest_api": suggest_api,
    }
