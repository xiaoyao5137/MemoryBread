"""创作服务 FastAPI 应用"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
import logging

from .service import CreationOptions, CreationService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Creation Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "tauri://localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
creation_service = CreationService()


class GenerateRequest(BaseModel):
    user_prompt: str
    design_templates: list[dict]
    timeline_context: Optional[str] = None
    capture_context: Optional[str] = None
    doc_type: str = ""
    audience: str = ""
    output_format: str = "markdown"
    inherit_format: bool = True
    enable_rag: bool = True
    enable_web_search: bool = False
    enable_image_generation: bool = False
    content_weight: float = 0.45
    quality_weight: float = 0.15
    completeness_weight: float = 0.15
    usage_weight: float = 0.10
    format_weight: float = 0.10
    freshness_weight: float = 0.05
    max_references: int = 6
    creation_model: Optional[str] = None
    creation_api_key: Optional[str] = None
    creation_base_url: Optional[str] = None


class ReferenceRequest(BaseModel):
    user_prompt: str
    doc_type: str = ""
    audience: str = ""
    inherit_format: bool = True
    enable_rag: bool = True
    content_weight: float = 0.45
    quality_weight: float = 0.15
    completeness_weight: float = 0.15
    usage_weight: float = 0.10
    format_weight: float = 0.10
    freshness_weight: float = 0.05
    max_references: int = 6


@app.post("/creation/generate")
async def generate_document(request: GenerateRequest):
    """流式生成文档"""
    try:
        options = _options_from_request(request)

        async def event_stream():
            async for chunk in creation_service.generate_document(
                user_prompt=request.user_prompt,
                design_templates=request.design_templates,
                timeline_context=request.timeline_context,
                capture_context=request.capture_context,
                options=options,
                creation_model=request.creation_model,
                creation_api_key=request.creation_api_key,
                creation_base_url=request.creation_base_url,
            ):
                import json
                yield f"data: {json.dumps(chunk)}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")
    except Exception as e:
        logger.error(f"Generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/creation/references")
async def preview_references(request: ReferenceRequest):
    """预览本次创作会优先使用的参考资料及权重。"""
    try:
        options = _options_from_request(request)
        parsed = creation_service.analyze_requirement(request.user_prompt, options)
        references = (
            creation_service.retrieve_references(request.user_prompt, parsed, options)
            if options.enable_rag
            else []
        )
        return {
            "requirement": parsed,
            "references": [
                {
                    "id": ref.id,
                    "title": ref.title,
                    "doc_type": ref.doc_type,
                    "final_weight": round(ref.final_weight, 4),
                    "relevance_score": round(ref.relevance_score, 4),
                    "quality_score": round(ref.quality_score, 4),
                    "completeness_score": round(ref.completeness_score, 4),
                    "usage_score": round(ref.usage_score, 4),
                    "format_score": round(ref.format_score, 4),
                    "freshness_score": round(ref.freshness_score, 4),
                    "usage_count": ref.usage_count,
                    "reason": ref.reason,
                    "summary": ref.summary,
                    "source_url": ref.source_url,
                }
                for ref in references
            ],
        }
    except Exception as e:
        logger.error(f"Reference preview error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    return {"status": "ok"}


class TestModelRequest(BaseModel):
    model: str
    api_key: str
    base_url: Optional[str] = None


@app.post("/creation/test_model")
async def test_creation_model(request: TestModelRequest):
    """验证创作模型连通性"""
    try:
        chunks = []
        async for chunk in creation_service._generate_cloud(
            "You are a helpful assistant.", "Reply with just 'OK'.",
            request.model, request.api_key, request.base_url or "",
        ):
            chunks.append(chunk)
            if len("".join(chunks)) >= 20:
                break
        return {"status": "ok", "message": "".join(chunks)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class ChatRequest(BaseModel):
    model: str
    api_key: str
    base_url: Optional[str] = None
    messages: list


@app.post("/creation/chat")
async def chat_with_model(request: ChatRequest):
    """与创作模型流式对话"""
    import json as _json
    async def event_stream():
        try:
            async for chunk in creation_service._chat_cloud(
                request.messages, request.model, request.api_key, request.base_url or ""
            ):
                yield f"data: {_json.dumps({'content': chunk})}\n\n"
            yield f"data: {_json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {_json.dumps({'error': str(e)})}\n\n"
    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _options_from_request(request) -> CreationOptions:
    return CreationOptions(
        doc_type=getattr(request, "doc_type", "") or "",
        audience=getattr(request, "audience", "") or "",
        output_format=getattr(request, "output_format", "markdown") or "markdown",
        inherit_format=bool(getattr(request, "inherit_format", True)),
        enable_rag=bool(getattr(request, "enable_rag", True)),
        enable_web_search=bool(getattr(request, "enable_web_search", False)),
        enable_image_generation=bool(getattr(request, "enable_image_generation", False)),
        content_weight=float(getattr(request, "content_weight", 0.45)),
        quality_weight=float(getattr(request, "quality_weight", 0.15)),
        completeness_weight=float(getattr(request, "completeness_weight", 0.15)),
        usage_weight=float(getattr(request, "usage_weight", 0.10)),
        format_weight=float(getattr(request, "format_weight", 0.10)),
        freshness_weight=float(getattr(request, "freshness_weight", 0.05)),
        max_references=int(getattr(request, "max_references", 6)),
    )
