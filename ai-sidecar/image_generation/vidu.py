"""
Vidu 文生图 / 参考图生图 客户端

Docs:
- 创建任务: https://platform.vidu.cn/docs/reference-to-image
  POST https://api.vidu.cn/ent/v2/reference2image
- 查询任务: https://platform.vidu.cn/docs/search-task-api
  GET  https://api.vidu.cn/ent/v2/tasks/{id}/creations

鉴权: Authorization: Token {api_key}  （仅使用 API Key；Key ID 仅用于
账号识别，不参与请求签名）
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import List, Optional


VIDU_BASE_URL = "https://api.vidu.cn/ent/v2"

DEFAULT_MODEL = "viduq2"
ALLOWED_MODELS = {"viduq1", "viduq2"}

TERMINAL_STATES = {"success", "failed"}


class ViduError(Exception):
    """Vidu API 调用失败的基础异常。"""


class ViduTaskFailed(ViduError):
    """任务最终状态为 failed。"""

    def __init__(self, task_id: str, err_code: str):
        super().__init__(f"Vidu 任务 {task_id} 失败 (err_code={err_code})")
        self.task_id = task_id
        self.err_code = err_code


class ViduTaskTimeout(ViduError):
    """轮询超时仍未结束。"""

    def __init__(self, task_id: str, last_state: str):
        super().__init__(f"Vidu 任务 {task_id} 轮询超时 (state={last_state})")
        self.task_id = task_id
        self.last_state = last_state


@dataclass
class ViduCreation:
    id: str
    url: str
    cover_url: str = ""
    watermarked_url: str = ""


@dataclass
class ViduResult:
    task_id: str
    state: str
    credits: int
    creations: List[ViduCreation]


class ViduClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = VIDU_BASE_URL,
        timeout: float = 30.0,
    ):
        if not api_key:
            raise ViduError("Vidu API Key 未配置")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ── 内部 HTTP ──────────────────────────────────────────────────────────

    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Token {self.api_key}",
        }

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            raise ViduError(f"Vidu HTTP {e.code}: {err_body or e.reason}") from e
        except urllib.error.URLError as e:
            raise ViduError(f"Vidu 网络错误: {e.reason}") from e

        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError as e:
            raise ViduError(f"Vidu 返回非 JSON: {raw[:200]}") from e

    # ── 公共方法 ───────────────────────────────────────────────────────────

    def create_reference_to_image(
        self,
        prompt: str,
        images: Optional[List[str]] = None,
        model: str = DEFAULT_MODEL,
        seed: int = 0,
        aspect_ratio: str = "16:9",
        resolution: str = "1080p",
        payload: str = "",
        callback_url: str = "",
    ) -> dict:
        if not prompt:
            raise ViduError("prompt 不能为空")
        if len(prompt) > 2000:
            raise ViduError("prompt 长度超过 2000 字符")
        if model not in ALLOWED_MODELS:
            raise ViduError(f"不支持的 Vidu 模型: {model}")

        body = {
            "model": model,
            "prompt": prompt,
            "seed": seed,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
        }
        if images:
            body["images"] = images
        if payload:
            body["payload"] = payload
        if callback_url:
            body["callback_url"] = callback_url

        return self._request("POST", "/reference2image", body)

    def get_task(self, task_id: str) -> dict:
        if not task_id:
            raise ViduError("task_id 不能为空")
        return self._request("GET", f"/tasks/{task_id}/creations")

    def wait_for_task(
        self,
        task_id: str,
        poll_interval: float = 3.0,
        max_wait: float = 180.0,
    ) -> ViduResult:
        deadline = time.monotonic() + max_wait
        last_state = "created"
        while True:
            data = self.get_task(task_id)
            last_state = data.get("state", "")
            if last_state == "success":
                creations = [
                    ViduCreation(
                        id=c.get("id", ""),
                        url=c.get("url", ""),
                        cover_url=c.get("cover_url", ""),
                        watermarked_url=c.get("watermarked_url", ""),
                    )
                    for c in data.get("creations", [])
                ]
                return ViduResult(
                    task_id=task_id,
                    state=last_state,
                    credits=int(data.get("credits", 0) or 0),
                    creations=creations,
                )
            if last_state == "failed":
                raise ViduTaskFailed(task_id, data.get("err_code", ""))
            if time.monotonic() >= deadline:
                raise ViduTaskTimeout(task_id, last_state)
            time.sleep(poll_interval)

    def generate(
        self,
        prompt: str,
        images: Optional[List[str]] = None,
        model: str = DEFAULT_MODEL,
        aspect_ratio: str = "16:9",
        resolution: str = "1080p",
        seed: int = 0,
        poll_interval: float = 3.0,
        max_wait: float = 180.0,
    ) -> ViduResult:
        """一次性创建任务并轮询到终态，返回最终图片 URL 列表。"""
        created = self.create_reference_to_image(
            prompt=prompt,
            images=images,
            model=model,
            seed=seed,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
        )
        task_id = created.get("task_id")
        if not task_id:
            raise ViduError(f"Vidu 创建任务返回缺少 task_id: {created}")
        return self.wait_for_task(task_id, poll_interval=poll_interval, max_wait=max_wait)
