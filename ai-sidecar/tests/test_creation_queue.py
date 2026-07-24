from __future__ import annotations

import concurrent.futures
import importlib
import threading

import httpx
import pytest

from inference_queue import LANE_P0_CREATION, Priority

creation_app = importlib.import_module("creation.app")


@pytest.mark.asyncio
async def test_creation_generate_runs_in_interactive_p0_lane(monkeypatch):
    calls: list[tuple[Priority, str | None]] = []

    async def fake_generate_document(**_kwargs):
        yield "创作"
        yield "完成"

    class ThreadQueue:
        def submit(self, priority, fn, lane=None):
            calls.append((priority, lane))
            future: concurrent.futures.Future = concurrent.futures.Future()

            def run():
                try:
                    future.set_result(fn())
                except Exception as exc:
                    future.set_exception(exc)

            threading.Thread(target=run, daemon=True).start()
            return future

    monkeypatch.setattr(
        creation_app.creation_service,
        "generate_document",
        fake_generate_document,
    )
    monkeypatch.setattr(creation_app, "get_global_queue", lambda: ThreadQueue())

    transport = httpx.ASGITransport(app=creation_app.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/creation/generate",
            json={
                "user_prompt": "生成一份方案",
                "design_templates": [],
                "enable_rag": False,
            },
        )

    assert response.status_code == 200
    assert calls == [(Priority.P0, LANE_P0_CREATION)]
    assert '"content": "\\u521b\\u4f5c"' in response.text
    assert '"content": "\\u5b8c\\u6210"' in response.text
    assert '"done": true' in response.text
