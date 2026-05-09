"""创作服务 FastAPI 应用"""
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
import logging

from .service import CreationService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Creation Service")
creation_service = CreationService()


class GenerateRequest(BaseModel):
    user_prompt: str
    design_templates: list[dict]
    timeline_context: Optional[str] = None
    capture_context: Optional[str] = None


@app.post("/creation/generate")
async def generate_document(request: GenerateRequest):
    """流式生成文档"""
    try:
        async def event_stream():
            async for chunk in creation_service.generate_document(
                user_prompt=request.user_prompt,
                design_templates=request.design_templates,
                timeline_context=request.timeline_context,
                capture_context=request.capture_context,
            ):
                import json
                yield f"data: {json.dumps(chunk)}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")
    except Exception as e:
        logger.error(f"Generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    return {"status": "ok"}
