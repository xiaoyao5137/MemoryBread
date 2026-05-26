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


# ── 模型目录 ──────────────────────────────────────────────────────────────────

AVAILABLE_MODELS: List[ModelMeta] = [

    # ── 本地 LLM（Ollama）────────────────────────────────────────────────────
    ModelMeta(
        id="qwen3.5-4b", name="Qwen3.5 4B", category="llm", provider="ollama",
        size_gb=3.4, min_memory_gb=6.0, is_default=True,
        description="阿里通义千问 3.5，4B 参数，原生多模态，推理更强，适合 8GB+ 内存",
        tags=["推荐", "中文优化", "多模态"],
    ),
    ModelMeta(
        id="gemma4-e4b", name="Gemma 4 E4B", category="llm", provider="ollama",
        size_gb=9.6, min_memory_gb=16.0,
        description="Google Gemma 4，4B 有效参数，原生多模态，Apache 2.0 开源",
        tags=["多模态", "Google"],
    ),
    ModelMeta(
        id="qwen2.5-3b", name="Qwen2.5 3B", category="llm", provider="ollama",
        size_gb=2.0, min_memory_gb=4.0, is_default=False,
        description="阿里通义千问 2.5，3B 参数，适合 8GB 以下内存机器",
        tags=["轻量", "中文优化"],
    ),
    ModelMeta(
        id="qwen2.5-7b", name="Qwen2.5 7B", category="llm", provider="ollama",
        size_gb=4.1, min_memory_gb=8.0,
        description="阿里通义千问 2.5，7B 参数，效果更好，需要 8GB+ 内存",
        tags=["中文优化", "均衡"],
    ),
    ModelMeta(
        id="deepseek-r1-7b", name="DeepSeek-R1 7B", category="llm", provider="ollama",
        size_gb=4.7, min_memory_gb=8.0,
        description="DeepSeek R1 推理模型，7B 参数，推理能力强",
        tags=["推理", "均衡"],
    ),

    # ── 本地 Embedding（Ollama）──────────────────────────────────────────────
    ModelMeta(
        id="bge-small-zh", name="BGE-Small-ZH-Q4", category="embedding", provider="ollama",
        size_gb=0.05, min_memory_gb=1.0, is_default=True,
        description="BAAI BGE-Small 中文版，512 维，量化版本，内存占用低",
        tags=["推荐", "超轻量", "中文"],
    ),
    ModelMeta(
        id="bge-m3", name="BGE-M3", category="embedding", provider="ollama",
        size_gb=0.6, min_memory_gb=2.0, is_default=False,
        description="BAAI BGE-M3，多语言向量模型，中英文效果优秀",
        tags=["多语言"],
    ),
    ModelMeta(
        id="nomic-embed-text", name="Nomic Embed Text", category="embedding", provider="ollama",
        size_gb=0.3, min_memory_gb=1.0,
        description="Nomic 文本向量模型，英文效果好",
        tags=["英文"],
    ),

    # ── 商业 LLM：OpenAI ─────────────────────────────────────────────────────
    ModelMeta(
        id="gpt-5.5", name="GPT-5.5", category="llm", provider="openai",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="OpenAI GPT-5.5，最新旗舰模型，推理和创作能力大幅提升",
        tags=["最新", "高质量", "多模态"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
            ApiKeyField("base_url", "Base URL（可选）", "https://api.openai.com/v1", required=False, secret=False),
        ],
    ),
    ModelMeta(
        id="gpt-4o", name="GPT-4o", category="llm", provider="openai",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="OpenAI GPT-4o，强大多模态模型，按 token 计费",
        tags=["高质量", "多模态"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
            ApiKeyField("base_url", "Base URL（可选）", "https://api.openai.com/v1", required=False, secret=False),
        ],
    ),
    ModelMeta(
        id="gpt-4o-mini", name="GPT-4o Mini", category="llm", provider="openai",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="OpenAI GPT-4o Mini，性价比高，速度快",
        tags=["快速", "低成本"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
            ApiKeyField("base_url", "Base URL（可选）", "https://api.openai.com/v1", required=False, secret=False),
        ],
    ),

    # ── 商业 LLM：Anthropic ──────────────────────────────────────────────────
    ModelMeta(
        id="claude-4.7-opus", name="Claude 4.7 Opus", category="llm", provider="anthropic",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="Anthropic Claude 4.7 Opus，最强推理与创作能力，旗舰模型",
        tags=["最新", "高质量", "代码", "推理"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-ant-...", required=True, secret=True),
        ],
    ),

    # ── 商业 LLM：通义千问 ───────────────────────────────────────────────────
    ModelMeta(
        id="qwen-plus", name="通义千问 Plus", category="llm", provider="tongyi",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="阿里云通义千问 Plus，中文能力强，国内访问稳定",
        tags=["中文优化", "国内"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
        ],
    ),
    ModelMeta(
        id="qwen-max", name="通义千问 Max", category="llm", provider="tongyi",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="阿里云通义千问 Max，最强版本",
        tags=["高质量", "中文优化", "国内"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
        ],
    ),

    # ── 商业 LLM：豆包 ───────────────────────────────────────────────────────
    ModelMeta(
        id="doubao-pro-32k", name="豆包 Pro 32K", category="llm", provider="doubao",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="字节跳动豆包 Pro，32K 上下文，国内访问稳定",
        tags=["长上下文", "国内"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "...", required=True, secret=True),
            ApiKeyField("endpoint_id", "Endpoint ID", "ep-...", required=True, secret=False),
        ],
    ),

    # ── 商业 LLM：DeepSeek ───────────────────────────────────────────────────
    ModelMeta(
        id="deepseek-chat", name="DeepSeek Chat", category="llm", provider="deepseek",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="DeepSeek Chat，性价比极高，推理能力强",
        tags=["高性价比", "推理", "国内"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
        ],
    ),
    ModelMeta(
        id="deepseek-reasoner", name="DeepSeek Reasoner", category="llm", provider="deepseek",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="DeepSeek R1 推理模型，复杂推理任务首选",
        tags=["推理", "国内"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
        ],
    ),

    # ── 商业 LLM：Kimi ───────────────────────────────────────────────────────
    ModelMeta(
        id="kimi-2.5", name="Kimi 2.5", category="llm", provider="kimi",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="月之暗面 Kimi 2.5，最新版本，长文本理解能力更强，国内访问稳定",
        tags=["最新", "长上下文", "国内"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
        ],
    ),

    # ── 商业 Embedding：OpenAI ───────────────────────────────────────────────
    ModelMeta(
        id="text-embedding-3-small", name="text-embedding-3-small", category="embedding",
        provider="openai", size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="OpenAI 文本向量模型，效果好，按 token 计费",
        tags=["高质量"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
            ApiKeyField("base_url", "Base URL（可选）", "https://api.openai.com/v1", required=False, secret=False),
        ],
    ),

    # ── 生图模型 ─────────────────────────────────────────────────────────────
    ModelMeta(
        id="dall-e-3", name="DALL·E 3", category="image", provider="openai",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="OpenAI DALL·E 3，高质量文生图模型，支持详细提示词",
        tags=["文生图", "高质量"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
            ApiKeyField("base_url", "Base URL（可选）", "https://api.openai.com/v1", required=False, secret=False),
        ],
    ),
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
    ModelMeta(
        id="qwen-image-edit", name="Qwen Image Edit", category="image", provider="tongyi",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="阿里通义千问图像编辑模型，支持图像编辑和修复",
        tags=["图像编辑", "中文优化", "国内"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "sk-...", required=True, secret=True),
        ],
    ),
    ModelMeta(
        id="kling-v1", name="可灵 v1", category="image", provider="kling",
        size_gb=0.0, min_memory_gb=0.0, requires_api_key=True,
        description="快手可灵 AI，文生图/视频模型，中文理解能力强，国内访问稳定",
        tags=["文生图", "视频生成", "中文优化", "国内"],
        api_key_fields=[
            ApiKeyField("api_key", "API Key", "...", required=True, secret=True),
        ],
    ),
]

# 快速查找
_MODEL_MAP: Dict[str, ModelMeta] = {m.id: m for m in AVAILABLE_MODELS}


def get_model(model_id: str) -> Optional[ModelMeta]:
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
        recommended_ids += ["deepseek-chat", "qwen-plus", "gpt-4o-mini"]
    elif memory_gb < 16:
        tier = "mid"
        reason = f"内存 {memory_gb:.0f}GB，可运行 3B-7B 本地模型"
        for m in AVAILABLE_MODELS:
            if m.category == "llm" and m.provider == "ollama" and m.min_memory_gb <= memory_gb:
                recommended_ids.append(m.id)
        recommended_ids += ["deepseek-chat", "qwen-plus"]
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
            recommended_ids = ["deepseek-chat", "qwen-plus", "gpt-4o-mini"]

    # Embedding 推荐
    if memory_gb >= 2:
        recommended_ids.append("bge-m3")
    else:
        recommended_ids.append("bge-small-zh")

    return {
        "recommended_ids": list(dict.fromkeys(recommended_ids)),  # 去重保序
        "tier": tier,
        "reason": reason,
        "suggest_api": suggest_api,
    }
