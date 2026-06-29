"""创作服务 - 基于本地文档资产的加权 RAG 创作流水线。"""

from __future__ import annotations

import json
import logging
import math
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Optional
from urllib.parse import quote_plus, urlparse

import httpx

logger = logging.getLogger(__name__)

ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"


@dataclass
class CreationOptions:
    """本次创作的控制参数。"""

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


@dataclass
class ReferenceDocument:
    id: int
    title: str
    doc_type: str
    summary: str
    full_content: str
    sections_json: str
    style_phrases: str
    prompt_hint: str
    usage_count: int
    review_status: str
    updated_at: int
    source_url: Optional[str]
    relevance_score: float
    quality_score: float
    completeness_score: float
    usage_score: float
    format_score: float
    freshness_score: float
    final_weight: float
    reason: str


@dataclass
class WebSearchResult:
    title: str
    url: str
    snippet: str


class CreationService:
    def __init__(
        self,
        ollama_base_url: str = "http://localhost:11434",
        db_path: str | None = None,
        model: str | None = None,
        enable_vector_recall: bool = True,
    ):
        self.ollama_base_url = ollama_base_url
        if model is None:
            from model_registry_global import get_active_ollama_model
            model = get_active_ollama_model()
        self.model = model
        self.db_path = db_path or str(Path.home() / ".memory-bread" / "memory-bread.db")
        self.enable_vector_recall = enable_vector_recall
        self._embedding_model = None
        if enable_vector_recall:
            try:
                from embedding.model import EmbeddingModel
                self._embedding_model = EmbeddingModel.create_default()
                logger.info("向量召回已启用，embedding模型: %s", self._embedding_model.model_name)
            except Exception as e:
                logger.warning("初始化embedding模型失败，将禁用向量召回: %s", e)
                self.enable_vector_recall = False

    async def generate_document(
        self,
        user_prompt: str,
        design_templates: list[dict],
        timeline_context: Optional[str] = None,
        capture_context: Optional[str] = None,
        options: Optional[CreationOptions] = None,
        creation_model: Optional[str] = None,
        creation_api_key: Optional[str] = None,
        creation_base_url: Optional[str] = None,
    ) -> AsyncIterator[str]:
        """流式生成文档。"""
        options = options or CreationOptions()
        parsed = self.analyze_requirement(user_prompt, options)
        references = self.retrieve_references(user_prompt, parsed, options) if options.enable_rag else []
        web_results = (
            await self.collect_web_context(user_prompt, parsed)
            if options.enable_web_search or parsed.get("needs_latest")
            else []
        )

        system_prompt = self._build_system_prompt(design_templates, options)
        user_message = self._build_user_message(
            user_prompt=user_prompt,
            timeline_context=timeline_context,
            capture_context=capture_context,
            options=options,
            parsed_requirement=parsed,
            references=references,
            web_results=web_results,
        )

        local_model = creation_model or self.model
        logger.info("使用模型: %s", local_model)
        logger.info("创作类型: %s, 参考资料: %s", parsed.get("doc_type") or "未指定", len(references))

        if creation_model and creation_api_key:
            output_parts: list[str] = []
            started_ms = int(time.time() * 1000)
            try:
                async for chunk in self._generate_cloud(system_prompt, user_message, creation_model, creation_api_key, creation_base_url or ""):
                    output_parts.append(chunk)
                    yield chunk
                self._log_creation_usage(
                    model_name=creation_model,
                    prompt_text=system_prompt + "\n\n" + user_message,
                    response_text="".join(output_parts),
                    latency_ms=int(time.time() * 1000) - started_ms,
                    status="success",
                )
            except Exception as exc:
                self._log_creation_usage(
                    model_name=creation_model,
                    prompt_text=system_prompt + "\n\n" + user_message,
                    response_text="".join(output_parts),
                    latency_ms=int(time.time() * 1000) - started_ms,
                    status="failed",
                    error_msg=str(exc),
                )
                raise
            return

        # Qwen3.5 在 Ollama chat 模式下有 thinking 解析 bug，导致长时间不输出内容。
        # 改用 /api/generate raw 模式，绕过有问题的 chat 解析器。
        is_qwen35 = "qwen3.5" in local_model.lower()

        if is_qwen35:
            prompt = self._build_qwen35_prompt(system_prompt, user_message)
            payload = {
                "model": local_model,
                "prompt": prompt,
                "raw": True,
                "stream": True,
                "options": {
                    "temperature": 0.65,
                    "top_p": 0.9,
                    "num_predict": 4096,
                },
            }
            endpoint = "/api/generate"
        else:
            payload = {
                "model": local_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                "stream": True,
                "options": {
                    "temperature": 0.65,
                    "top_p": 0.9,
                    "num_predict": 4096,
                },
            }
            endpoint = "/api/chat"

        chunk_count = 0
        output_parts: list[str] = []
        started_ms = int(time.time() * 1000)
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream(
                    "POST", f"{self.ollama_base_url}{endpoint}", json=payload
                ) as response:
                    response.raise_for_status()
                    if is_qwen35:
                        async for chunk in self._stream_qwen35_raw(response):
                            if chunk:
                                output_parts.append(chunk)
                                chunk_count += 1
                                if chunk_count % 100 == 0:
                                    logger.info("已生成 %s 个块", chunk_count)
                                yield chunk
                    else:
                        async for line in response.aiter_lines():
                            if not line:
                                continue
                            try:
                                data = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            msg = data.get("message", {})
                            content = msg.get("content", "")
                            if content:
                                output_parts.append(content)
                                chunk_count += 1
                                if chunk_count % 100 == 0:
                                    logger.info("已生成 %s 个块", chunk_count)
                                yield content

            logger.info("生成完成，总共 %s 个块", chunk_count)
            self._log_creation_usage(
                model_name=local_model,
                prompt_text=system_prompt + "\n\n" + user_message,
                response_text="".join(output_parts),
                latency_ms=int(time.time() * 1000) - started_ms,
                status="success",
            )
        except Exception as exc:
            self._log_creation_usage(
                model_name=local_model,
                prompt_text=system_prompt + "\n\n" + user_message,
                response_text="".join(output_parts),
                latency_ms=int(time.time() * 1000) - started_ms,
                status="failed",
                error_msg=str(exc),
            )
            raise

    def _log_creation_usage(
        self,
        model_name: str,
        prompt_text: str,
        response_text: str,
        latency_ms: int,
        status: str,
        error_msg: str | None = None,
    ) -> None:
        """记录创作模型 token 用量，失败不影响主生成链路。"""
        try:
            from monitor.llm_tracker import estimate_tokens, log_llm_usage

            log_llm_usage(
                caller="creation",
                model_name=model_name,
                prompt_tokens=estimate_tokens(prompt_text),
                completion_tokens=estimate_tokens(response_text),
                latency_ms=latency_ms,
                status=status,
                error_msg=error_msg,
                raw_preview=prompt_text,
                response_preview=response_text,
                db_path=self.db_path,
            )
        except Exception as exc:
            logger.warning("创作 token 用量埋点失败: %s", exc)

    async def _generate_cloud(
        self,
        system_prompt: str,
        user_message: str,
        model: str,
        api_key: str,
        base_url: str,
    ):
        is_claude = "claude" in model.lower() or "anthropic.com" in base_url
        if is_claude:
            url = self._anthropic_messages_url(base_url)
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
            payload = {"model": model, "max_tokens": 8192, "stream": True, "system": system_prompt,
                       "messages": [{"role": "user", "content": user_message}]}
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    await self._raise_for_cloud_error(resp)
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data_str = line[6:]
                        if data_str.strip() == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            if data.get("type") == "content_block_delta":
                                text = data.get("delta", {}).get("text", "")
                                if text:
                                    yield text
                        except json.JSONDecodeError:
                            continue
        else:
            default_urls = {
                "gpt": "https://api.openai.com/v1",
                "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "glm": "https://open.bigmodel.cn/api/paas/v4",
                "moonshot": "https://api.moonshot.cn/v1",
            }
            if not base_url:
                for key, url in default_urls.items():
                    if key in model.lower():
                        base_url = url
                        break
                else:
                    base_url = "https://api.openai.com/v1"
            url = base_url.rstrip('/') + "/chat/completions"
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            payload = {"model": model, "stream": True,
                       "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]}
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    await self._raise_for_cloud_error(resp)
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data_str = line[6:]
                        if data_str.strip() == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            content = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if content:
                                yield content
                        except json.JSONDecodeError:
                            continue

    async def _chat_cloud(self, messages: list, model: str, api_key: str, base_url: str):
        """多轮对话，供体验功能使用。"""
        is_claude = "claude" in model.lower() or "anthropic.com" in base_url
        if is_claude:
            url = self._anthropic_messages_url(base_url)
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
            system, chat_msgs = self._normalize_anthropic_messages(messages)
            payload = {"model": model, "max_tokens": 2048, "stream": True, "system": system, "messages": chat_msgs}
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    await self._raise_for_cloud_error(resp)
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "): continue
                        data_str = line[6:]
                        if data_str.strip() == "[DONE]": break
                        try:
                            d = json.loads(data_str)
                            if d.get("type") == "content_block_delta":
                                text = d.get("delta", {}).get("text", "")
                                if text: yield text
                        except json.JSONDecodeError: continue
        else:
            default_urls = {"gpt": "https://api.openai.com/v1", "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1", "glm": "https://open.bigmodel.cn/api/paas/v4", "moonshot": "https://api.moonshot.cn/v1"}
            if not base_url:
                for key, url in default_urls.items():
                    if key in model.lower(): base_url = url; break
                else: base_url = "https://api.openai.com/v1"
            url = base_url.rstrip('/') + "/chat/completions"
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            payload = {"model": model, "stream": True, "messages": messages}
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    await self._raise_for_cloud_error(resp)
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "): continue
                        data_str = line[6:]
                        if data_str.strip() == "[DONE]": break
                        try:
                            d = json.loads(data_str)
                            content = d.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if content: yield content
                        except json.JSONDecodeError: continue

    @staticmethod
    def _anthropic_messages_url(base_url: str) -> str:
        """兼容用户填写根地址、/v1 或 /v1/messages 的 Anthropic API URL。"""
        url = (base_url or ANTHROPIC_DEFAULT_BASE_URL).strip().rstrip("/")
        if url.endswith("/v1/messages"):
            return url
        if url.endswith("/v1"):
            return f"{url}/messages"
        return f"{url}/v1/messages"

    @staticmethod
    def _normalize_anthropic_messages(messages: list) -> tuple[str, list[dict]]:
        """把体验对话清洗成 Anthropic Messages API 接受的结构。"""
        system_parts: list[str] = []
        chat_msgs: list[dict] = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            content = str(msg.get("content") or "").strip()
            if not content:
                continue
            if role == "system":
                system_parts.append(content)
                continue
            if role not in {"user", "assistant"}:
                continue
            if chat_msgs and chat_msgs[-1]["role"] == role:
                chat_msgs[-1]["content"] += f"\n\n{content}"
            else:
                chat_msgs.append({"role": role, "content": content})

        if not chat_msgs:
            chat_msgs.append({"role": "user", "content": "Hello"})
        if chat_msgs[0]["role"] != "user":
            chat_msgs.insert(0, {"role": "user", "content": "Continue the conversation."})

        system = "\n\n".join(system_parts) or "You are a helpful assistant."
        return system, chat_msgs

    @staticmethod
    async def _raise_for_cloud_error(resp: httpx.Response) -> None:
        """把云模型服务返回的 JSON 错误转换为前端可读的异常文本。"""
        if resp.status_code < 400:
            return

        body = await resp.aread()
        detail = body.decode("utf-8", errors="replace").strip()
        try:
            parsed = json.loads(detail) if detail else {}
            if isinstance(parsed, dict):
                error = parsed.get("error")
                if isinstance(error, dict):
                    detail = error.get("message") or error.get("type") or detail
                else:
                    detail = parsed.get("detail") or parsed.get("message") or detail
        except json.JSONDecodeError:
            pass

        raise RuntimeError(f"模型请求失败 ({resp.status_code}): {detail or resp.reason_phrase}")

    def analyze_requirement(self, user_prompt: str, options: CreationOptions) -> dict:
        """轻量需求解析，先用规则把创作任务结构化。"""
        text = user_prompt.strip()
        doc_type = options.doc_type.strip() or self._infer_doc_type(text)
        audience = options.audience.strip() or self._infer_audience(text)
        keywords = self._extract_keywords(text)

        return {
            "topic": self._infer_topic(text),
            "doc_type": doc_type,
            "audience": audience,
            "keywords": keywords,
            "style": self._infer_style(text),
            "needs_latest": any(word in text for word in ["最新", "政策", "趋势", "行业", "联网", "互联网"]),
            "needs_images": options.enable_image_generation
            or any(word in text for word in ["图片", "配图", "架构图", "流程图", "插图", "封面图"]),
        }

    def retrieve_references(
        self,
        user_prompt: str,
        parsed_requirement: dict,
        options: CreationOptions,
    ) -> list[ReferenceDocument]:
        """多路召回：关键词召回 + 向量召回，融合排序。"""
        db = Path(self.db_path)
        if not db.exists():
            logger.warning("知识库数据库不存在: %s", db)
            return []

        # 路径1: 关键词召回
        try:
            keyword_rows = self._query_document_rows(user_prompt, parsed_requirement, options)
        except Exception as exc:
            logger.warning("关键词召回失败: %s", exc)
            keyword_rows = []

        # 路径2: 向量召回
        vector_rows = []
        if self.enable_vector_recall and self._embedding_model:
            try:
                vector_rows = self._vector_recall(user_prompt, options.max_references * 2)
            except Exception as exc:
                logger.warning("向量召回失败: %s", exc)

        # 合并去重
        seen_ids = set()
        merged_rows = []
        for row in keyword_rows + vector_rows:
            doc_id = int(row.get("id") or 0)
            if doc_id and doc_id not in seen_ids:
                seen_ids.add(doc_id)
                merged_rows.append(row)

        if not merged_rows:
            return []

        # 统一评分
        max_usage = max(int(row.get("usage_count") or 0) for row in merged_rows) or 1
        now_ms = int(time.time() * 1000)
        refs: list[ReferenceDocument] = []
        for row in merged_rows:
            relevance = self._score_relevance(row, parsed_requirement)
            quality = self._score_quality(row)
            completeness = self._score_completeness(row)
            usage = math.log1p(int(row.get("usage_count") or 0)) / math.log1p(max_usage)
            format_score = self._score_format(row, parsed_requirement)
            freshness = self._score_freshness(int(row.get("updated_at") or 0), now_ms)

            final = (
                relevance * options.content_weight
                + quality * options.quality_weight
                + completeness * options.completeness_weight
                + usage * options.usage_weight
                + format_score * options.format_weight
                + freshness * options.freshness_weight
            )

            # 宁缺毋滥：相关性低于阈值直接丢弃
            if relevance < 0.25 or (relevance < 0.4 and final < 0.6):
                continue

            refs.append(
                ReferenceDocument(
                    id=int(row["id"]),
                    title=row.get("title") or "",
                    doc_type=row.get("doc_type") or "",
                    summary=row.get("summary") or "",
                    full_content=row.get("full_content") or "",
                    sections_json=row.get("sections_json") or "[]",
                    style_phrases=row.get("style_phrases") or "[]",
                    prompt_hint=row.get("prompt_hint") or "",
                    usage_count=int(row.get("usage_count") or 0),
                    review_status=row.get("review_status") or "",
                    updated_at=int(row.get("updated_at") or 0),
                    source_url=row.get("source_url"),
                    relevance_score=relevance,
                    quality_score=quality,
                    completeness_score=completeness,
                    usage_score=usage,
                    format_score=format_score,
                    freshness_score=freshness,
                    final_weight=final,
                    reason=self._build_reason(relevance, quality, completeness, usage, format_score),
                )
            )

        refs.sort(key=lambda item: item.final_weight, reverse=True)
        return refs[: max(1, min(options.max_references, 12))]

    async def collect_web_context(
        self,
        user_prompt: str,
        parsed_requirement: dict,
    ) -> list[WebSearchResult]:
        """执行轻量互联网检索。无专用搜索 API 时使用 DuckDuckGo HTML 降级。"""
        queries = self._build_search_queries(user_prompt, parsed_requirement)
        results: list[WebSearchResult] = []
        for query in queries[:3]:
            try:
                results.extend(await self._search_duckduckgo(query))
            except Exception as exc:
                logger.warning("互联网检索失败 query=%s error=%s", query, exc)

        deduped: list[WebSearchResult] = []
        seen: set[str] = set()
        for item in results:
            key = item.url or item.title
            if not key or key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped[:6]

    def _query_document_rows(
        self,
        user_prompt: str,
        parsed_requirement: dict,
        options: CreationOptions,
    ) -> list[dict]:
        keywords = parsed_requirement.get("keywords") or []
        like_terms = keywords[:8] or [user_prompt[:24]]
        params: list[object] = []
        clauses: list[str] = ["deleted_at IS NULL"]

        if parsed_requirement.get("doc_type"):
            clauses.append("(doc_type = ? OR title LIKE ? OR COALESCE(prompt_hint, '') LIKE ?)")
            doc_type = parsed_requirement["doc_type"]
            params.extend([doc_type, f"%{doc_type}%", f"%{doc_type}%"])

        keyword_clauses = []
        for term in like_terms:
            pattern = f"%{term}%"
            keyword_clauses.append(
                "CASE WHEN (title LIKE ? OR COALESCE(summary, '') LIKE ? OR "
                "COALESCE(full_content, '') LIKE ?) THEN 1 ELSE 0 END"
            )
            params.extend([pattern] * 3)
        if keyword_clauses:
            min_matches = max(1, len(like_terms) // 2)  # 至少匹配一半关键词
            clauses.append(f"({' + '.join(keyword_clauses)}) >= {min_matches}")

        sql = f"""
            SELECT id, title, doc_type, summary, full_content, sections_json, style_phrases,
                   prompt_hint, usage_count, review_status, updated_at, source_url
            FROM bake_documents
            WHERE {' AND '.join(clauses)}
            ORDER BY usage_count DESC, updated_at DESC, id DESC
            LIMIT ?
        """
        params.append(max(options.max_references * 4, 16))

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
            if rows:
                return rows
            return [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT id, title, doc_type, summary, full_content, sections_json, style_phrases,
                           prompt_hint, usage_count, review_status, updated_at, source_url
                    FROM bake_documents
                    WHERE deleted_at IS NULL
                    ORDER BY usage_count DESC, updated_at DESC, id DESC
                    LIMIT ?
                    """,
                    (max(options.max_references * 3, 12),),
                ).fetchall()
            ]
        finally:
            conn.close()

    def _vector_recall(self, query: str, limit: int = 10) -> list[dict]:
        """向量召回：通过embedding相似度召回文档。"""
        if not self._embedding_model:
            return []

        # 生成query向量
        try:
            query_emb = self._embedding_model.encode([query])[0]
            query_vector = query_emb.vector
        except Exception as e:
            logger.error("生成query向量失败: %s", e)
            return []

        # 从数据库加载所有文档及其内容
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT id, title, doc_type, summary, full_content, sections_json, style_phrases,
                       prompt_hint, usage_count, review_status, updated_at, source_url
                FROM bake_documents
                WHERE deleted_at IS NULL AND full_content IS NOT NULL
                ORDER BY updated_at DESC
                LIMIT 100
                """
            ).fetchall()

            if not rows:
                return []

            # 计算相似度
            scored_docs = []
            for row in rows:
                text = (row["summary"] or "") + "\n" + (row["full_content"] or "")[:500]
                if not text.strip():
                    continue
                try:
                    doc_emb = self._embedding_model.encode([text])[0]
                    doc_vector = doc_emb.vector
                    similarity = self._cosine_similarity(query_vector, doc_vector)
                    if similarity > 0.5:  # 相似度阈值
                        scored_docs.append((dict(row), similarity))
                except Exception as e:
                    logger.debug("计算文档 %s 向量失败: %s", row["id"], e)
                    continue

            # 按相似度排序
            scored_docs.sort(key=lambda x: x[1], reverse=True)
            logger.info("向量召回: %d个文档（相似度>0.5）", len(scored_docs))
            return [doc for doc, score in scored_docs[:limit]]

        finally:
            conn.close()

    def _cosine_similarity(self, vec1: list[float], vec2: list[float]) -> float:
        """计算余弦相似度。"""
        dot = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = math.sqrt(sum(a * a for a in vec1))
        norm2 = math.sqrt(sum(b * b for b in vec2))
        if norm1 == 0 or norm2 == 0:
            return 0.0
        return dot / (norm1 * norm2)

    def _build_search_queries(self, user_prompt: str, parsed_requirement: dict) -> list[str]:
        topic = parsed_requirement.get("topic") or user_prompt
        doc_type = parsed_requirement.get("doc_type") or ""
        keywords = " ".join((parsed_requirement.get("keywords") or [])[:4])
        base = " ".join(part for part in [topic, doc_type, keywords] if part)
        return [
            f"{base} 最新政策 标准",
            f"{base} 行业方案 案例",
            f"{base} 技术架构 最佳实践",
        ]

    async def _search_duckduckgo(self, query: str) -> list[WebSearchResult]:
        url = f"https://duckduckgo.com/html/?q={quote_plus(query)}"
        headers = {"User-Agent": "Mozilla/5.0 MemoryBreadCreation/1.0"}
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True, headers=headers) as client:
            response = await client.get(url)
            response.raise_for_status()

        pattern = re.compile(
            r'<a[^>]+class="result__a"[^>]+href="(?P<url>[^"]+)"[^>]*>(?P<title>.*?)</a>.*?'
            r'<a[^>]+class="result__snippet"[^>]*>(?P<snippet>.*?)</a>',
            re.S,
        )
        results = []
        for match in pattern.finditer(response.text):
            title = self._strip_html(match.group("title"))
            snippet = self._strip_html(match.group("snippet"))
            result_url = match.group("url")
            if result_url.startswith("//"):
                result_url = "https:" + result_url
            elif result_url.startswith("/"):
                result_url = "https://duckduckgo.com" + result_url
            if title and self._is_reasonable_web_url(result_url):
                results.append(WebSearchResult(title=title, url=result_url, snippet=snippet))
        return results[:4]

    def _build_system_prompt(self, design_templates: list[dict], options: CreationOptions) -> str:
        template_hint = ""
        if design_templates:
            names = "、".join(
                str(item.get("name") or item.get("title") or "未命名模板")
                for item in design_templates[:5]
            )
            template_hint = f"\n可参考的文档模板：{names}"

        return f"""你是一个专业的企业文档创作助手，擅长基于历史文档、知识库和操作手册生成新文档。

工作原则：
1. 使用 Markdown 输出，内容直接可用，不输出思考过程。
2. 优先使用高权重参考资料中的事实、结构、术语和格式风格。
3. 如果参考资料不足，可以生成合理的增量内容，但需要避免编造具体数据、政策编号、客户名称。
4. 若启用互联网检索，请基于检索摘要补充内容，并对政策、标准、日期、数字保留核验说明。
5. 若启用图片生成，请在合适章节插入图片建议占位符，格式为：[图片建议：用途 | 画面/图示要求]。
6. 技术架构图、流程图、关系图优先给出 Mermaid 图，不用纯文字替代。
7. 章节结构要完整，标题层级清晰，语言正式、克制、专业。
8. 根据用户输入的语言进行回复。如果用户使用中文提问，全文必须使用中文输出；如果用户使用英文提问，全文必须使用英文输出。
9. 【强制要求】在正文中每次引用参考资料内容时，必须在引用处插入 Markdown 内联链接，格式严格为 [引用说明](#ref-数字ID)，数字ID 来自参考资料标注的 ref-id。示例：[参见分销诊断框架](#ref-42)。若未插入此格式的引用链接，视为未完成任务。
10. 禁止输出原生 HTML 标签或空锚点，例如 <a id="..."></a>。标题锚点只使用 Markdown 链接引用已有标题。
{template_hint}

输出格式偏好：{options.output_format}"""

    def _build_user_message(
        self,
        user_prompt: str,
        timeline_context: Optional[str],
        capture_context: Optional[str],
        options: CreationOptions,
        parsed_requirement: dict,
        references: list[ReferenceDocument],
        web_results: list[WebSearchResult],
    ) -> str:
        blocks = [
            "请根据以下创作任务生成完整文档。",
            "",
            "【本次创作需求】",
            user_prompt,
            "",
            "【解析后的任务画像】",
            json.dumps(parsed_requirement, ensure_ascii=False, indent=2),
            "",
            "【生成控制】",
            f"- 继承历史格式：{'是' if options.inherit_format else '否'}",
            f"- 启用 RAG：{'是' if options.enable_rag else '否'}",
            f"- 需要互联网检索补充：{'是' if options.enable_web_search else '否'}",
            f"- 需要图片/图示：{'是' if options.enable_image_generation else '否'}",
        ]

        if timeline_context:
            blocks.extend(["", "【参考时间线】", timeline_context])
        if capture_context:
            blocks.extend(["", "【参考采集记录】", capture_context])

        if references:
            blocks.extend(["", "【高权重参考资料】"])
            for index, ref in enumerate(references, 1):
                content = self._clip(self._best_reference_content(ref), 1200)
                sections = self._clip(self._safe_json_summary(ref.sections_json), 500)
                style = self._clip(self._safe_json_summary(ref.style_phrases), 260)
                blocks.extend(
                    [
                        f"### R{index}. {ref.title} (ref-id: {ref.id})",
                        f"- 文档类型：{ref.doc_type or '未知'}",
                        f"- 综合权重：{ref.final_weight:.2f}",
                        f"- 推荐原因：{ref.reason}",
                        f"- 使用热度：{ref.usage_count}",
                        f"- 结构/格式线索：{sections or '无'}",
                        f"- 风格线索：{style or '无'}",
                        f"- 内容摘录：\n{content}",
                    ]
                )
        else:
            blocks.extend(["", "【高权重参考资料】", "未召回到可用参考资料，请根据需求生成合理增量内容。"])

        if web_results:
            blocks.extend(["", "【互联网检索结果】"])
            for index, item in enumerate(web_results, 1):
                blocks.extend(
                    [
                        f"W{index}. {item.title}",
                        f"- URL：{item.url}",
                        f"- 摘要：{self._clip(item.snippet, 260)}",
                    ]
                )
            blocks.append("- 使用规则：外部资料只作为补充参考；涉及政策、标准、日期、数字的内容需保留核验项。")
        elif options.enable_web_search or parsed_requirement.get("needs_latest"):
            blocks.extend(
                [
                    "",
                    "【互联网检索要求】",
                    "- 请列出建议检索的问题或关键词。",
                    "- 对涉及最新政策、标准、价格、版本、日期的信息，用'待联网核验'标记，不要编造具体来源。",
                ]
            )

        if options.enable_image_generation or parsed_requirement.get("needs_images"):
            blocks.extend(
                [
                    "",
                    "【图片与图示要求】",
                    "- 在需要配图的位置插入图片建议占位符。",
                    "- 对流程、架构、关系类内容，优先输出 Mermaid 图。",
                    "- 对封面、场景、宣传类图片，写出可直接给生图模型使用的中文 prompt。",
                ]
            )

        blocks.extend(
            [
                "",
                "【输出要求】",
                "1. 先输出标题和简短摘要。",
                "2. 再输出目录式章节正文，章节不少于 5 个。",
                "3. 在正文中引用参考资料时，必须在引用位置插入内联链接，格式为 [引用说明](#ref-{id})，其中 {id} 替换为对应参考资料括号内的 ref-id 数字。例如参考资料标注 (ref-id: 42)，则引用写作 [见参考方案](#ref-42)。",
                "4. 需要包含'参考资料使用说明'，列出哪些内容/格式来自高权重参考。",
                "5. 需要包含'后续核验与补充清单'，列出联网检索、图片生成或人工审核事项。",
                "6. 不要输出任何原生 HTML 标签；尤其不要用 <a id=\"...\"></a> 为章节添加锚点。",
                "7. 直接开始输出文档正文。",
            ]
        )

        return "\n".join(blocks)

    def _build_qwen35_prompt(self, system_prompt: str, user_message: str) -> str:
        """构建 Qwen3.5 的 raw 模式 prompt，使用官方 chat template。"""
        return (
            f"<|im_start|>system\n{system_prompt}<|im_end|>\n"
            f"<|im_start|>user\n{user_message}<|im_end|>\n"
            f"<|im_start|>assistant\n"
        )

    async def _stream_qwen35_raw(self, response):
        """解析 Qwen3.5 raw 模式的流式响应，过滤 <think> 标签内的内容。"""
        import re
        in_think = False
        think_buffer = ""
        async for line in response.aiter_lines():
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            text = data.get("response", "")
            if not text:
                continue
            # 逐字符处理，过滤 <think>...</think> 块
            output = ""
            for ch in text:
                if not in_think:
                    if ch == "<":
                        think_buffer = ch
                    elif think_buffer:
                        think_buffer += ch
                        if think_buffer == "<think>":
                            in_think = True
                            think_buffer = ""
                        elif not "<think>".startswith(think_buffer):
                            output += think_buffer
                            think_buffer = ""
                    else:
                        output += ch
                else:
                    if ch == ">":
                        think_buffer += ch
                        if think_buffer.endswith("</think>"):
                            in_think = False
                            think_buffer = ""
                    else:
                        think_buffer += ch
            if output:
                yield output

    def _infer_doc_type(self, text: str) -> str:
        mapping = [
            ("操作手册", ["操作手册", "使用手册", "用户手册", "SOP", "流程"]),
            ("建设方案", ["建设方案", "实施方案", "总体方案", "解决方案", "技术方案"]),
            ("汇报材料", ["汇报", "述职", "总结", "报告"]),
            ("制度文档", ["制度", "规范", "管理办法", "规定"]),
            ("产品方案", ["产品方案", "需求文档", "PRD", "MRD"]),
        ]
        for doc_type, words in mapping:
            if any(word in text for word in words):
                return doc_type
        return "通用文档"

    def _infer_audience(self, text: str) -> str:
        for audience in ["政府", "企业管理人员", "客户", "研发团队", "运维人员", "销售", "领导"]:
            if audience in text:
                return audience
        return "业务与技术相关人员"

    def _infer_topic(self, text: str) -> str:
        match = re.search(r'[《“""]([^》”""]{2,60})[》”""]', text)
        if match:
            return match.group(1)
        compact = re.sub(r"\s+", "", text)
        return compact[:50] or "未命名主题"

    def _infer_style(self, text: str) -> str:
        if any(word in text for word in ["正式", "严谨", "政务", "汇报"]):
            return "正式严谨"
        if any(word in text for word in ["简洁", "短", "提纲"]):
            return "简洁提纲"
        if any(word in text for word in ["手册", "步骤", "操作"]):
            return "步骤化说明"
        return "专业清晰"

    def _extract_keywords(self, text: str) -> list[str]:
        try:
            import jieba
            tokens = list(jieba.cut(text))
        except (ImportError, Exception):
            # 智能切分：优先长词，避免重叠
            tokens = []
            text_clean = text.replace("生成一份", "").replace("帮我", "")
            i = 0
            while i < len(text_clean):
                matched = False
                for length in [6, 5, 4, 3, 2]:
                    if i + length <= len(text_clean):
                        token = text_clean[i:i+length]
                        if all(c not in "的了是在" for c in token):
                            tokens.append(token)
                            matched = True
                            break
                i += 1 if not matched else length

        stop = {"帮我", "生成", "一份", "关于", "根据", "参考", "文档", "内容", "格式", "需要", "本次"}
        seen: set[str] = set()
        result: list[str] = []
        for token in tokens:
            if token in stop or len(token) < 2 or token in seen:
                continue
            seen.add(token)
            result.append(token)
        return result[:12]

    def _score_relevance(self, row: dict, parsed_requirement: dict) -> float:
        haystack = "\n".join(
            str(row.get(key) or "")
            for key in ["title", "doc_type", "summary", "full_content", "sections_json", "prompt_hint"]
        )
        keywords = parsed_requirement.get("keywords") or []
        if not keywords:
            return 0.35
        hits = sum(1 for word in keywords if word and word in haystack)
        title_hits = sum(1 for word in keywords if word and word in str(row.get("title") or ""))
        score = (hits / max(len(keywords), 1)) + min(title_hits, 3) * 0.12
        if score < 0.4:  # 相关度过低直接返回0
            return 0.0
        if parsed_requirement.get("doc_type") and parsed_requirement["doc_type"] == row.get("doc_type"):
            score += 0.15
        return min(score, 1.0)

    def _score_quality(self, row: dict) -> float:
        status = str(row.get("review_status") or "")
        base = 0.55
        if status in {"adopted", "auto_created", "verified", "enabled"}:
            base += 0.25
        if row.get("summary"):
            base += 0.08
        if row.get("prompt_hint"):
            base += 0.06
        if row.get("full_content"):
            base += 0.06
        return min(base, 1.0)

    def _score_completeness(self, row: dict) -> float:
        content_len = len(str(row.get("full_content") or ""))
        sections = self._json_len(row.get("sections_json"))
        section_score = min(sections / 6, 1.0)
        content_score = min(content_len / 3000, 1.0)
        return max(0.25, section_score * 0.55 + content_score * 0.45)

    def _score_format(self, row: dict, parsed_requirement: dict) -> float:
        sections = self._json_len(row.get("sections_json"))
        styles = self._json_len(row.get("style_phrases"))
        score = min(sections / 6, 1.0) * 0.7 + min(styles / 6, 1.0) * 0.3
        if parsed_requirement.get("doc_type") and parsed_requirement["doc_type"] == row.get("doc_type"):
            score += 0.12
        return min(max(score, 0.2), 1.0)

    def _score_freshness(self, updated_at: int, now_ms: int) -> float:
        if updated_at <= 0:
            return 0.35
        age_days = max((now_ms - updated_at) / 86_400_000, 0)
        return max(0.25, 1.0 - min(age_days / 365, 0.75))

    def _build_reason(
        self,
        relevance: float,
        quality: float,
        completeness: float,
        usage: float,
        format_score: float,
    ) -> str:
        reasons = []
        if relevance >= 0.65:
            reasons.append("主题高度相关")
        elif relevance >= 0.35:
            reasons.append("主题部分相关")
        if quality >= 0.8:
            reasons.append("质量较高")
        if completeness >= 0.7:
            reasons.append("结构/内容完整")
        if usage >= 0.6:
            reasons.append("历史使用较多")
        if format_score >= 0.7:
            reasons.append("格式可继承")
        return "，".join(reasons) or "可作为补充参考"

    def _best_reference_content(self, ref: ReferenceDocument) -> str:
        return ref.full_content or ref.summary or ref.prompt_hint

    def _clip(self, text: str, limit: int) -> str:
        text = (text or "").strip()
        if len(text) <= limit:
            return text
        return text[:limit].rstrip() + "..."

    def _json_len(self, raw: object) -> int:
        try:
            value = json.loads(raw or "[]")
        except Exception:
            return 0
        if isinstance(value, list):
            return len(value)
        if isinstance(value, dict):
            return len(value)
        return 0

    def _safe_json_summary(self, raw: str) -> str:
        try:
            value = json.loads(raw or "[]")
        except Exception:
            return str(raw or "")
        if isinstance(value, list):
            return "；".join(str(item) for item in value[:8])
        if isinstance(value, dict):
            return "；".join(f"{key}: {value[key]}" for key in list(value.keys())[:8])
        return str(value)

    def _strip_html(self, value: str) -> str:
        value = re.sub(r"<.*?>", "", value or "")
        value = (
            value.replace("&quot;", '"')
            .replace("&amp;", "&")
            .replace("&#x27;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
        )
        return re.sub(r"\s+", " ", value).strip()

    def _is_reasonable_web_url(self, value: str) -> bool:
        try:
            parsed = urlparse(value)
        except Exception:
            return False
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
