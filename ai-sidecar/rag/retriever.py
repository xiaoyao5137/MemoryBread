"""
检索器模块

提供多种检索策略：
- VectorRetriever: Qdrant 向量检索
- Fts5Retriever: SQLite FTS5 全文检索
- KnowledgeFts5Retriever: 知识库 FTS5 检索
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

logger = logging.getLogger(__name__)

_NOISE_OVERVIEW_PREFIX = "低价值工作片段（"


@dataclass
class VectorSearchFilter:
    start_ts: int | None = None
    end_ts: int | None = None
    source_types: list[str] | None = None
    app_names: list[str] | None = None
    category: str | None = None
    observed_start_ts: int | None = None
    observed_end_ts: int | None = None
    event_start_ts: int | None = None
    event_end_ts: int | None = None
    activity_types: list[str] | None = None
    content_origins: list[str] | None = None
    history_view: bool | None = None
    is_self_generated: bool | None = None
    evidence_strengths: list[str] | None = None



def _escape_fts5_term(term: str) -> str:
    escaped = term.replace('"', '""').strip()
    return f'"{escaped}"' if escaped else '""'



def _extract_query_terms(query: str) -> list[str]:
    tokens = re.findall(r"[A-Za-z0-9.]+|[\u4e00-\u9fff]+", query.lower())
    terms: list[str] = []
    seen: set[str] = set()
    stop_terms = {
        "什么", "怎么", "如何", "为什么", "昨天", "今天", "最近", "本周", "那段",
        "提到", "知识", "总结", "里", "了吗", "是否", "有关", "关于",
    }

    def _add(term: str) -> None:
        term = term.strip()
        if len(term) < 2 or term in stop_terms or term in seen:
            return
        seen.add(term)
        terms.append(term)

    for token in tokens:
        if len(token) < 2:
            continue
        if re.fullmatch(r"[\u4e00-\u9fff]+", token) and len(token) > 4:
            for size in (4, 3, 2):
                for i in range(0, len(token) - size + 1):
                    _add(token[i:i + size])
        else:
            _add(token)

    return terms



def _build_like_clauses(expression: str, terms: list[str]) -> tuple[str, list[str]]:
    if not terms:
        return "", []
    clause = "(" + " OR ".join(f"{expression} LIKE ?" for _ in terms) + ")"
    params = [f"%{term.lower()}%" for term in terms]
    return clause, params



def _is_app_like_term(term: str) -> bool:
    lowered = term.lower()
    return any(ch.isascii() for ch in term) or lowered in {"飞书", "微信", "chrome", "safari", "gemini", "claude", "chatgpt"}



def _build_fts_or_query(terms: list[str]) -> str:
    normalized = [term.strip() for term in dict.fromkeys(terms) if term and term.strip()]
    if not normalized:
        return ""
    return " OR ".join(_escape_fts5_term(term) for term in normalized)



def _apply_noise_filters(sql: str, params: list[object], alias: str = "k") -> tuple[str, list[object]]:
    sql += f" AND COALESCE({alias}.overview, '') NOT LIKE ?"
    params.append(f"{_NOISE_OVERVIEW_PREFIX}%")
    sql += (
        f" AND NOT (COALESCE({alias}.evidence_strength, '') = ?"
        f" AND COALESCE({alias}.activity_type, '') IN (?, '')"
        f" AND COALESCE({alias}.content_origin, '') IN (?, ''))"
    )
    params.extend(["low", "other", "other"])
    return sql, params



def _build_in_clause(values: list[object]) -> tuple[str, list[object]]:
    normalized = [value for value in dict.fromkeys(values) if value is not None]
    if not normalized:
        return "", []
    placeholders = ", ".join("?" for _ in normalized)
    return f"({placeholders})", normalized



def _capture_doc_key(capture_id: int) -> str:
    return f"capture:{capture_id}"



def _knowledge_doc_key(knowledge_id: int) -> str:
    return f"knowledge:{knowledge_id}"


def _artifact_doc_key(source_type: str, artifact_id: int) -> str:
    return f"{source_type}:{artifact_id}"


def _is_link_lookup_query(query: str) -> bool:
    lowered = query.lower()
    return any(term in lowered for term in ("url", "链接", "地址", "网址", "文档地址", "页面"))


def _merge_chunks(chunks: list["RetrievedChunk"], limit: int, prefer_url: bool = False) -> list["RetrievedChunk"]:
    unique: list[RetrievedChunk] = []
    seen: set[str] = set()
    for chunk in chunks:
        key = chunk.doc_key or f"{chunk.source}:{chunk.capture_id}:{len(unique)}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(chunk)

    if prefer_url:
        unique.sort(
            key=lambda chunk: (
                bool((chunk.metadata or {}).get("url") or "URL：" in chunk.text),
                1 if (chunk.metadata or {}).get("source_type") == "document" else 0,
                chunk.score,
            ),
            reverse=True,
        )

    return unique[:limit]


def _rank_keyword_chunks(chunks: list["RetrievedChunk"], terms: list[str], prefer_url: bool) -> list["RetrievedChunk"]:
    lowered_terms = [term.lower() for term in terms if term]

    def _score(chunk: RetrievedChunk) -> tuple[float, float, int]:
        text = chunk.text.lower()
        metadata = chunk.metadata or {}
        title = str(metadata.get("title") or "").lower()
        summary = str(metadata.get("summary") or metadata.get("overview") or "").lower()
        url = str(metadata.get("url") or "")
        text_hits = sum(1 for term in lowered_terms if term in text)
        title_hits = sum(1 for term in lowered_terms if term in title)
        summary_hits = sum(1 for term in lowered_terms if term in summary)
        score = float(text_hits) + title_hits * 4.0 + summary_hits * 1.5

        meaningful_terms = [term for term in lowered_terms if len(term) >= 2]
        title_coverage = title_hits / max(1, min(len(meaningful_terms), 12))
        long_title_hits = sum(1 for term in meaningful_terms if len(term) >= 3 and term in title)
        if title_hits:
            score += 12.0 + title_coverage * 32.0 + long_title_hits * 3.0

        if prefer_url and url:
            score += 5
        if prefer_url and metadata.get("source_type") == "document":
            score += 4
        if metadata.get("source_type") in {"document", "operation", "bake_knowledge"}:
            score += 2
        if "docs.corp.kuaishou.com" in url:
            score += 3
        score += min(float(chunk.score or 0) / 6.0, 30.0)
        time_value = int(metadata.get("time") or metadata.get("ts") or 0)
        return score, chunk.score, time_value

    return sorted(chunks, key=_score, reverse=True)


@dataclass
class RetrievedChunk:
    """检索到的文本片段"""

    capture_id: int
    text: str
    score: float = 0.0
    source: str = "unknown"  # vector / fts5 / knowledge / merged
    metadata: dict[str, Any] | None = None
    doc_key: str | None = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}
        if not self.doc_key:
            self.doc_key = self.metadata.get("doc_key") or _capture_doc_key(self.capture_id)
        self.metadata.setdefault("doc_key", self.doc_key)


class VectorRetriever:
    """Qdrant 向量检索器"""

    # sidecar 内部向量搜索服务地址（main_v2.py 启动，避免 Qdrant 文件锁冲突）
    _INTERNAL_SEARCH_URL = "http://127.0.0.1:7072/vector_search"

    def __init__(
        self,
        collection: str = "memory_bread_captures",
        host: Optional[str] = None,
        port: Optional[int] = None,
        qdrant_path: Optional[str] = None,
    ):
        self.collection = collection
        self.host = host
        self.port = port
        self.qdrant_path = qdrant_path
        self._client = None
        self._use_internal_http: Optional[bool] = None  # None=未探测

    @staticmethod
    def _filters_to_payload(filters: VectorSearchFilter | None) -> dict[str, Any] | None:
        if filters is None:
            return None
        return {
            key: value
            for key, value in {
                "start_ts": filters.start_ts,
                "end_ts": filters.end_ts,
                "observed_start_ts": filters.observed_start_ts,
                "observed_end_ts": filters.observed_end_ts,
                "event_start_ts": filters.event_start_ts,
                "event_end_ts": filters.event_end_ts,
                "source_types": filters.source_types,
                "app_names": filters.app_names,
                "category": filters.category,
                "activity_types": filters.activity_types,
                "content_origins": filters.content_origins,
                "history_view": filters.history_view,
                "is_self_generated": filters.is_self_generated,
                "evidence_strengths": filters.evidence_strengths,
            }.items()
            if value is not None
        }

    def _try_internal_http(
        self,
        query_vector: list[float],
        top_k: int,
        score_threshold: float,
        filters: VectorSearchFilter | None,
    ) -> Optional[list]:
        """尝试通过 sidecar 内部 HTTP 服务做向量搜索，避免 Qdrant 文件锁冲突。"""
        try:
            import urllib.request, json as _json
            payload = _json.dumps({
                'query_vector': query_vector,
                'top_k': top_k,
                'score_threshold': score_threshold,
                'filters': self._filters_to_payload(filters),
            }).encode()
            req = urllib.request.Request(
                self._INTERNAL_SEARCH_URL,
                data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = _json.loads(resp.read())
            return data.get('results', [])
        except Exception:
            return None

    def _get_client(self):
        """创建 Qdrant 直连客户端（仅当内部 HTTP 服务不可用时使用）"""
        try:
            from qdrant_client import QdrantClient
            if self.qdrant_path:
                client = QdrantClient(path=self.qdrant_path)
            else:
                client = QdrantClient(host=self.host or "localhost", port=self.port or 6333)
            return client
        except Exception as e:
            logger.error(f"连接 Qdrant 失败: {e}")
            return None

    def is_available(self) -> bool:
        """检查向量检索是否可用"""
        # 优先检查内部 HTTP 服务
        if self.qdrant_path:
            try:
                import urllib.request
                with urllib.request.urlopen("http://127.0.0.1:7072/health", timeout=2):
                    return True
            except Exception:
                pass
        return self._get_client() is not None

    def search(
        self,
        query_vector: list[float],
        top_k: int = 10,
        score_threshold: float = 0.3,
        filters: VectorSearchFilter | None = None,
    ) -> list[RetrievedChunk]:
        """向量相似度搜索"""
        if not query_vector:
            return []

        # 本地模式：始终优先走 sidecar 内部 HTTP（避免 Qdrant 文件锁冲突）。
        # 注意：即使带 metadata filters 也不能直连本地 Qdrant 文件，否则会与 sidecar 写入进程抢锁。
        if self.qdrant_path:
            raw = self._try_internal_http(query_vector, top_k, score_threshold, filters)
            if raw is not None:
                chunks = []
                for item in raw:
                    metadata = dict(item.get('metadata') or {})
                    metadata['retrieval_method'] = 'vector'
                    chunks.append(RetrievedChunk(
                        capture_id=item.get('capture_id', 0),
                        text=item.get('text', ''),
                        score=float(item.get('score', 0)),
                        source='vector',
                        metadata=metadata,
                        doc_key=item.get('doc_key', ''),
                    ))
                logger.debug(f"内部向量检索返回 {len(chunks)} 条结果")
                return chunks
            raise RuntimeError("内部向量搜索服务不可用，已阻止降级到关键词兜底")

        client = self._get_client()
        if not client:
            raise RuntimeError("Qdrant 不可用，向量检索无法执行")

        try:
            query_kwargs: dict[str, Any] = {
                "collection_name": self.collection,
                "query": query_vector,
                "limit": top_k,
                "score_threshold": score_threshold,
            }
            qdrant_filter = self._build_qdrant_filter(filters)
            if qdrant_filter is not None:
                query_kwargs["query_filter"] = qdrant_filter

            results = client.query_points(**query_kwargs).points

            chunks = []
            for hit in results:
                payload = dict(hit.payload or {})
                source_type = payload.get("source_type") or "capture"
                capture_id = int(payload.get("capture_id") or 0)
                knowledge_id = payload.get("knowledge_id")
                doc_key = payload.get("doc_key")
                if not doc_key:
                    if source_type == "knowledge" and knowledge_id is not None:
                        doc_key = _knowledge_doc_key(int(knowledge_id))
                    else:
                        doc_key = _capture_doc_key(capture_id)
                metadata = {
                    **payload,
                    "doc_key": doc_key,
                    "source_type": source_type,
                    "retrieval_method": "vector",
                }
                chunks.append(RetrievedChunk(
                    capture_id=capture_id,
                    text=payload.get("text", ""),
                    score=float(hit.score),
                    source="vector",
                    metadata=metadata,
                    doc_key=doc_key,
                ))

            logger.debug(f"向量检索返回 {len(chunks)} 条结果")
            return chunks
        except Exception as e:
            logger.error(f"向量检索失败: {e}")
            raise RuntimeError(f"向量检索失败: {e}") from e

    @staticmethod
    def _build_qdrant_filter(filters: VectorSearchFilter | None):
        if filters is None:
            return None

        conditions: list[Any] = []
        try:
            from qdrant_client.models import FieldCondition, Filter, MatchAny, MatchValue, Range

            if filters.start_ts is not None or filters.end_ts is not None:
                conditions.append(
                    FieldCondition(
                        key="time",
                        range=Range(gte=filters.start_ts, lte=filters.end_ts),
                    )
                )
            if filters.observed_start_ts is not None or filters.observed_end_ts is not None:
                conditions.append(
                    FieldCondition(
                        key="observed_at",
                        range=Range(gte=filters.observed_start_ts, lte=filters.observed_end_ts),
                    )
                )
            if filters.event_start_ts is not None or filters.event_end_ts is not None:
                conditions.append(
                    FieldCondition(
                        key="event_time_start",
                        range=Range(gte=filters.event_start_ts, lte=filters.event_end_ts),
                    )
                )
            if filters.source_types:
                normalized = [value for value in filters.source_types if value]
                if normalized:
                    conditions.append(FieldCondition(key="source_type", match=MatchAny(any=normalized)))
            if filters.app_names:
                normalized = [value for value in dict.fromkeys(name.strip() for name in filters.app_names if name and name.strip())]
                if len(normalized) == 1:
                    conditions.append(FieldCondition(key="app_name", match=MatchValue(value=normalized[0])))
                elif len(normalized) > 1:
                    conditions.append(FieldCondition(key="app_name", match=MatchAny(any=normalized)))
            if filters.category:
                conditions.append(FieldCondition(key="category", match=MatchValue(value=filters.category)))
            if filters.activity_types:
                normalized = [value for value in dict.fromkeys(filters.activity_types) if value]
                if len(normalized) == 1:
                    conditions.append(FieldCondition(key="activity_type", match=MatchValue(value=normalized[0])))
                elif len(normalized) > 1:
                    conditions.append(FieldCondition(key="activity_type", match=MatchAny(any=normalized)))
            if filters.content_origins:
                normalized = [value for value in dict.fromkeys(filters.content_origins) if value]
                if len(normalized) == 1:
                    conditions.append(FieldCondition(key="content_origin", match=MatchValue(value=normalized[0])))
                elif len(normalized) > 1:
                    conditions.append(FieldCondition(key="content_origin", match=MatchAny(any=normalized)))
            if filters.history_view is not None:
                conditions.append(FieldCondition(key="history_view", match=MatchValue(value=filters.history_view)))
            if filters.is_self_generated is not None:
                conditions.append(FieldCondition(key="is_self_generated", match=MatchValue(value=filters.is_self_generated)))
            if filters.evidence_strengths:
                normalized = [value for value in dict.fromkeys(filters.evidence_strengths) if value]
                if len(normalized) == 1:
                    conditions.append(FieldCondition(key="evidence_strength", match=MatchValue(value=normalized[0])))
                elif len(normalized) > 1:
                    conditions.append(FieldCondition(key="evidence_strength", match=MatchAny(any=normalized)))
        except Exception as exc:
            logger.warning("构造 Qdrant filter 失败，忽略 metadata filter: %s", exc)
            return None

        if not conditions:
            return None
        return Filter(must=conditions)


class Fts5Retriever:
    """SQLite FTS5 全文检索器"""

    def __init__(self, db_path: str):
        self.db_path = db_path

    def search(
        self,
        query: str,
        top_k: int = 10,
        start_ts: int | None = None,
        end_ts: int | None = None,
        entity_terms: list[str] | None = None,
    ) -> list[RetrievedChunk]:
        """FTS5 全文检索"""
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            chunks = self._search_by_fts(
                cursor,
                query=query,
                top_k=top_k,
                start_ts=start_ts,
                end_ts=end_ts,
                entity_terms=entity_terms,
            )
            fallback_chunks = self._search_by_app_fields(
                cursor,
                query=query,
                top_k=top_k,
                start_ts=start_ts,
                end_ts=end_ts,
                entity_terms=entity_terms,
            )
            conn.close()
            chunks = _merge_chunks([*chunks, *fallback_chunks], top_k, prefer_url=_is_link_lookup_query(query))
            logger.debug(f"Capture 字段回退检索返回 {len(chunks)} 条结果")
            return chunks
        except Exception as e:
            logger.error(f"FTS5 检索失败: {e}")
            return []

    def _search_by_fts(
        self,
        cursor: sqlite3.Cursor,
        query: str,
        top_k: int,
        start_ts: int | None,
        end_ts: int | None,
        entity_terms: list[str] | None,
    ) -> list[RetrievedChunk]:
        sql = """
            SELECT
                c.id as capture_id,
                c.ts,
                c.app_name,
                c.win_title,
                c.url,
                c.webpage_title,
                c.ocr_text,
                c.ax_text,
                c.input_text,
                c.audio_text,
                fts.rank as score
            FROM captures_fts fts
            JOIN captures c ON fts.rowid = c.id
            WHERE captures_fts MATCH ?
        """
        params: list[object] = [_escape_fts5_term(query)]

        if start_ts is not None:
            sql += " AND c.ts >= ?"
            params.append(start_ts)
        if end_ts is not None:
            sql += " AND c.ts <= ?"
            params.append(end_ts)
        if entity_terms:
            clause, clause_params = _build_like_clauses(
                "LOWER(COALESCE(c.app_name, '') || ' ' || COALESCE(c.win_title, '') || ' ' || COALESCE(c.webpage_title, '') || ' ' || COALESCE(c.url, '') || ' ' || COALESCE(c.ocr_text, '') || ' ' || COALESCE(c.ax_text, '') || ' ' || COALESCE(c.input_text, '') || ' ' || COALESCE(c.audio_text, ''))",
                entity_terms,
            )
            sql += f" AND {clause}"
            params.extend(clause_params)

        sql += " ORDER BY rank LIMIT ?"
        params.append(top_k)
        cursor.execute(sql, params)
        rows = cursor.fetchall()
        return [self._row_to_chunk(row, abs(row["score"])) for row in rows]

    def _search_by_app_fields(
        self,
        cursor: sqlite3.Cursor,
        query: str,
        top_k: int,
        start_ts: int | None,
        end_ts: int | None,
        entity_terms: list[str] | None,
    ) -> list[RetrievedChunk]:
        terms = list(dict.fromkeys([*(entity_terms or []), *_extract_query_terms(query)]))
        if not terms:
            return []

        sql = """
            SELECT
                c.id as capture_id,
                c.ts,
                c.app_name,
                c.win_title,
                c.url,
                c.webpage_title,
                c.ocr_text,
                c.ax_text,
                c.input_text,
                c.audio_text
            FROM captures c
            WHERE 1=1
        """
        params: list[object] = []

        if start_ts is not None:
            sql += " AND c.ts >= ?"
            params.append(start_ts)
        if end_ts is not None:
            sql += " AND c.ts <= ?"
            params.append(end_ts)

        clause, clause_params = _build_like_clauses(
            "LOWER(COALESCE(c.app_name, '') || ' ' || COALESCE(c.win_title, '') || ' ' || COALESCE(c.webpage_title, '') || ' ' || COALESCE(c.url, '') || ' ' || COALESCE(c.ocr_text, '') || ' ' || COALESCE(c.ax_text, '') || ' ' || COALESCE(c.input_text, '') || ' ' || COALESCE(c.audio_text, ''))",
            terms,
        )
        sql += f" AND {clause}"
        params.extend(clause_params)
        sql += " ORDER BY c.ts DESC LIMIT ?"
        candidate_limit = max(top_k * 50, 200)
        params.append(candidate_limit)
        cursor.execute(sql, params)

        rows = cursor.fetchall()
        chunks = [self._row_to_chunk(row, float(len(terms)), source="fts5") for row in rows]
        return _rank_keyword_chunks(chunks, terms, prefer_url=_is_link_lookup_query(query))[:top_k]

    def _row_to_chunk(self, row: sqlite3.Row, score: float, source: str = "fts5") -> RetrievedChunk:
        doc_key = _capture_doc_key(row["capture_id"])
        return RetrievedChunk(
            capture_id=row["capture_id"],
            text=self._build_capture_text(row),
            score=score,
            source=source,
            doc_key=doc_key,
            metadata={
                "doc_key": doc_key,
                "source_type": "capture",
                "retrieval_method": source,
                "time": row["ts"],
                "ts": row["ts"],
                "app_name": row["app_name"],
                "win_title": row["win_title"],
                "url": row["url"] if "url" in row.keys() else None,
                "webpage_title": row["webpage_title"] if "webpage_title" in row.keys() else None,
            },
        )

    @staticmethod
    def _build_capture_text(row: sqlite3.Row) -> str:
        parts: list[str] = []
        ts_text = _format_ts(row["ts"])
        if ts_text:
            parts.append(f"时间：{ts_text}")
        if row["app_name"]:
            parts.append(f"应用：{row['app_name']}")
        if row["win_title"]:
            parts.append(f"窗口：{row['win_title']}")
        if "webpage_title" in row.keys() and row["webpage_title"]:
            parts.append(f"页面：{row['webpage_title']}")
        if "url" in row.keys() and row["url"]:
            parts.append(f"URL：{row['url']}")
        if row["ocr_text"]:
            parts.append(f"OCR：{row['ocr_text']}")
        if row["ax_text"]:
            parts.append(f"AX：{row['ax_text']}")
        if "input_text" in row.keys() and row["input_text"]:
            parts.append(f"输入：{row['input_text']}")
        if "audio_text" in row.keys() and row["audio_text"]:
            parts.append(f"音频：{row['audio_text']}")
        return "\n".join(parts)


class KnowledgeFts5Retriever:
    """知识库 FTS5 检索器"""

    def __init__(self, db_path: str):
        self.db_path = db_path

    def search(
        self,
        query: str,
        top_k: int = 10,
        start_ts: int | None = None,
        end_ts: int | None = None,
        entity_terms: list[str] | None = None,
        observed_start_ts: int | None = None,
        observed_end_ts: int | None = None,
        event_start_ts: int | None = None,
        event_end_ts: int | None = None,
        activity_types: list[str] | None = None,
        content_origins: list[str] | None = None,
        history_view: bool | None = None,
        is_self_generated: bool | None = None,
        evidence_strengths: list[str] | None = None,
        query_mode: str = "lookup",
        created_start_ts: int | None = None,
        created_end_ts: int | None = None,
    ) -> list[RetrievedChunk]:
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'"
            )
            if not cursor.fetchone():
                logger.debug("knowledge_fts 表不存在，跳过知识库检索")
                conn.close()
                return []

            prefer_url = _is_link_lookup_query(query)
            artifact_chunks = self._search_artifacts(
                cursor,
                query=query,
                top_k=top_k,
                entity_terms=entity_terms,
            )
            chunks = self._search_by_fts(
                cursor,
                query=query,
                top_k=top_k,
                start_ts=start_ts,
                end_ts=end_ts,
                entity_terms=entity_terms,
                observed_start_ts=observed_start_ts,
                observed_end_ts=observed_end_ts,
                event_start_ts=event_start_ts,
                event_end_ts=event_end_ts,
                activity_types=activity_types,
                content_origins=content_origins,
                history_view=history_view,
                is_self_generated=is_self_generated,
                evidence_strengths=evidence_strengths,
                query_mode=query_mode,
                created_start_ts=created_start_ts,
                created_end_ts=created_end_ts,
            )
            fallback_chunks = [] if prefer_url and artifact_chunks else self._search_by_app_fields(
                    cursor,
                    query=query,
                    top_k=top_k,
                    start_ts=start_ts,
                    end_ts=end_ts,
                    entity_terms=entity_terms,
                    observed_start_ts=observed_start_ts,
                    observed_end_ts=observed_end_ts,
                    event_start_ts=event_start_ts,
                    event_end_ts=event_end_ts,
                    activity_types=activity_types,
                    content_origins=content_origins,
                    history_view=history_view,
                    is_self_generated=is_self_generated,
                    evidence_strengths=evidence_strengths,
                    query_mode=query_mode,
                    created_start_ts=created_start_ts,
                    created_end_ts=created_end_ts,
                )
            conn.close()
            chunks = _merge_chunks([*artifact_chunks, *chunks, *fallback_chunks], top_k, prefer_url=prefer_url)
            logger.debug(f"知识库字段回退检索返回 {len(chunks)} 条结果")
            return chunks
        except Exception as e:
            logger.error(f"知识库检索失败: {e}")
            return []

    def _search_by_fts(
        self,
        cursor: sqlite3.Cursor,
        query: str,
        top_k: int,
        start_ts: int | None,
        end_ts: int | None,
        entity_terms: list[str] | None,
        observed_start_ts: int | None,
        observed_end_ts: int | None,
        event_start_ts: int | None,
        event_end_ts: int | None,
        activity_types: list[str] | None,
        content_origins: list[str] | None,
        history_view: bool | None,
        is_self_generated: bool | None,
        evidence_strengths: list[str] | None,
        query_mode: str,
        created_start_ts: int | None = None,
        created_end_ts: int | None = None,
    ) -> list[RetrievedChunk]:
        fts_terms = list(dict.fromkeys([*(entity_terms or []), query.strip()]))
        fts_query = _build_fts_or_query(fts_terms if query_mode == "summary" else [query.strip(), *(entity_terms or [])])
        if not fts_query:
            return []

        sql = """
            SELECT
                k.id,
                k.capture_id,
                k.summary,
                k.overview,
                k.details,
                k.start_time,
                k.end_time,
                k.duration_minutes,
                k.frag_app_name,
                k.frag_win_title,
                k.category,
                k.user_verified,
                k.observed_at,
                k.event_time_start,
                k.event_time_end,
                k.history_view,
                k.content_origin,
                k.activity_type,
                k.is_self_generated,
                k.evidence_strength,
                k.importance,
                (
                    SELECT c.url
                    FROM captures c
                    WHERE (c.id = k.capture_id OR COALESCE(k.capture_ids, '') LIKE ('%' || c.id || '%'))
                      AND COALESCE(c.url, '') != ''
                    ORDER BY c.ts DESC
                    LIMIT 1
                ) AS linked_url,
                (
                    SELECT c.webpage_title
                    FROM captures c
                    WHERE (c.id = k.capture_id OR COALESCE(k.capture_ids, '') LIKE ('%' || c.id || '%'))
                      AND COALESCE(c.webpage_title, '') != ''
                    ORDER BY c.ts DESC
                    LIMIT 1
                ) AS linked_webpage_title,
                fts.rank as score
            FROM knowledge_fts fts
            JOIN timelines k ON fts.rowid = k.id
            WHERE knowledge_fts MATCH ?
        """
        params: list[object] = [fts_query]

        if start_ts is not None:
            sql += " AND (k.start_time IS NULL OR k.start_time >= ?)"
            params.append(start_ts)
        if end_ts is not None:
            sql += " AND (k.end_time IS NULL OR k.end_time <= ?)"
            params.append(end_ts)
        if observed_start_ts is not None:
            sql += " AND COALESCE(k.observed_at, k.end_time, k.start_time) >= ?"
            params.append(observed_start_ts)
        if observed_end_ts is not None:
            sql += " AND COALESCE(k.observed_at, k.end_time, k.start_time) <= ?"
            params.append(observed_end_ts)
        if event_start_ts is not None:
            sql += " AND k.event_time_start IS NOT NULL AND k.event_time_start >= ?"
            params.append(event_start_ts)
        if event_end_ts is not None:
            sql += " AND k.event_time_start IS NOT NULL AND COALESCE(k.event_time_end, k.event_time_start) <= ?"
            params.append(event_end_ts)
        if activity_types:
            clause, clause_params = _build_in_clause(activity_types)
            if clause:
                sql += f" AND k.activity_type IN {clause}"
                params.extend(clause_params)
        if content_origins:
            clause, clause_params = _build_in_clause(content_origins)
            if clause:
                sql += f" AND k.content_origin IN {clause}"
                params.extend(clause_params)
        if history_view is not None:
            sql += " AND COALESCE(k.history_view, 0) = ?"
            params.append(1 if history_view else 0)
        if is_self_generated is not None:
            sql += " AND COALESCE(k.is_self_generated, 0) = ?"
            params.append(1 if is_self_generated else 0)
        if evidence_strengths:
            clause, clause_params = _build_in_clause(evidence_strengths)
            if clause:
                sql += f" AND k.evidence_strength IN {clause}"
                params.extend(clause_params)
        if created_start_ts is not None:
            sql += " AND k.created_at_ms >= ?"
            params.append(created_start_ts)
        if created_end_ts is not None:
            sql += " AND k.created_at_ms <= ?"
            params.append(created_end_ts)
        sql, params = _apply_noise_filters(sql, params)
        if entity_terms:
            clause, clause_params = _build_like_clauses(
                "LOWER(COALESCE(k.summary, '') || ' ' || COALESCE(k.overview, '') || ' ' || COALESCE(k.details, '') || ' ' || COALESCE(k.frag_app_name, '') || ' ' || COALESCE(k.frag_win_title, '') || ' ' || COALESCE((SELECT group_concat(COALESCE(c.webpage_title, '') || ' ' || COALESCE(c.url, ''), ' ') FROM captures c WHERE c.id = k.capture_id OR COALESCE(k.capture_ids, '') LIKE ('%' || c.id || '%')), ''))",
                entity_terms,
            )
            sql += f" AND {clause}"
            params.extend(clause_params)

        sql += " ORDER BY rank LIMIT ?"
        params.append(top_k)
        cursor.execute(sql, params)
        rows = cursor.fetchall()
        return [self._row_to_chunk(row, abs(row["score"])) for row in rows]

    def _search_by_app_fields(
        self,
        cursor: sqlite3.Cursor,
        query: str,
        top_k: int,
        start_ts: int | None,
        end_ts: int | None,
        entity_terms: list[str] | None,
        observed_start_ts: int | None,
        observed_end_ts: int | None,
        event_start_ts: int | None,
        event_end_ts: int | None,
        activity_types: list[str] | None,
        content_origins: list[str] | None,
        history_view: bool | None,
        is_self_generated: bool | None,
        evidence_strengths: list[str] | None,
        query_mode: str,
        created_start_ts: int | None = None,
        created_end_ts: int | None = None,
    ) -> list[RetrievedChunk]:
        terms = entity_terms or _extract_query_terms(query)
        if query_mode == "summary":
            terms = [term for term in terms if not _is_app_like_term(term)] or terms
        terms = list(dict.fromkeys(terms))
        # 任务型宽松检索：terms 为空时允许继续，纯按时间段和 activity_types 扫描
        # 非任务型检索：terms 为空则无意义，直接返回
        is_time_scan = not terms and (observed_start_ts is not None or start_ts is not None or created_start_ts is not None)
        if not terms and not is_time_scan:
            return []

        sql = """
            SELECT
                k.id,
                k.capture_id,
                k.summary,
                k.overview,
                k.details,
                k.start_time,
                k.end_time,
                k.duration_minutes,
                k.frag_app_name,
                k.frag_win_title,
                k.category,
                k.user_verified,
                k.observed_at,
                k.event_time_start,
                k.event_time_end,
                k.history_view,
                k.content_origin,
                k.activity_type,
                k.is_self_generated,
                k.evidence_strength,
                k.importance,
                (
                    SELECT c.url
                    FROM captures c
                    WHERE (c.id = k.capture_id OR COALESCE(k.capture_ids, '') LIKE ('%' || c.id || '%'))
                      AND COALESCE(c.url, '') != ''
                    ORDER BY c.ts DESC
                    LIMIT 1
                ) AS linked_url,
                (
                    SELECT c.webpage_title
                    FROM captures c
                    WHERE (c.id = k.capture_id OR COALESCE(k.capture_ids, '') LIKE ('%' || c.id || '%'))
                      AND COALESCE(c.webpage_title, '') != ''
                    ORDER BY c.ts DESC
                    LIMIT 1
                ) AS linked_webpage_title
            FROM timelines k
            WHERE 1=1
        """
        params: list[object] = []

        if start_ts is not None:
            sql += " AND (k.start_time IS NULL OR k.start_time >= ?)"
            params.append(start_ts)
        if end_ts is not None:
            sql += " AND (k.end_time IS NULL OR k.end_time <= ?)"
            params.append(end_ts)
        if observed_start_ts is not None:
            sql += " AND COALESCE(k.observed_at, k.end_time, k.start_time) >= ?"
            params.append(observed_start_ts)
        if observed_end_ts is not None:
            sql += " AND COALESCE(k.observed_at, k.end_time, k.start_time) <= ?"
            params.append(observed_end_ts)
        if event_start_ts is not None:
            sql += " AND k.event_time_start IS NOT NULL AND k.event_time_start >= ?"
            params.append(event_start_ts)
        if event_end_ts is not None:
            sql += " AND k.event_time_start IS NOT NULL AND COALESCE(k.event_time_end, k.event_time_start) <= ?"
            params.append(event_end_ts)
        if activity_types:
            clause, clause_params = _build_in_clause(activity_types)
            if clause:
                sql += f" AND k.activity_type IN {clause}"
                params.extend(clause_params)
        if content_origins:
            clause, clause_params = _build_in_clause(content_origins)
            if clause:
                sql += f" AND k.content_origin IN {clause}"
                params.extend(clause_params)
        if history_view is not None:
            sql += " AND COALESCE(k.history_view, 0) = ?"
            params.append(1 if history_view else 0)
        if is_self_generated is not None:
            sql += " AND COALESCE(k.is_self_generated, 0) = ?"
            params.append(1 if is_self_generated else 0)
        if evidence_strengths:
            clause, clause_params = _build_in_clause(evidence_strengths)
            if clause:
                sql += f" AND k.evidence_strength IN {clause}"
                params.extend(clause_params)
        if created_start_ts is not None:
            sql += " AND k.created_at_ms >= ?"
            params.append(created_start_ts)
        if created_end_ts is not None:
            sql += " AND k.created_at_ms <= ?"
            params.append(created_end_ts)

        sql, params = _apply_noise_filters(sql, params)
        if terms:
            clause, clause_params = _build_like_clauses(
                "LOWER(COALESCE(k.summary, '') || ' ' || COALESCE(k.overview, '') || ' ' || COALESCE(k.details, '') || ' ' || COALESCE(k.frag_app_name, '') || ' ' || COALESCE(k.frag_win_title, '') || ' ' || COALESCE((SELECT group_concat(COALESCE(c.webpage_title, '') || ' ' || COALESCE(c.url, ''), ' ') FROM captures c WHERE c.id = k.capture_id OR COALESCE(k.capture_ids, '') LIKE ('%' || c.id || '%')), ''))",
                terms,
            )
            sql += f" AND {clause}"
            params.extend(clause_params)
        # 当使用 created_at 过滤时，按 created_at 排序；否则按 observed_at 排序
        if created_start_ts is not None or created_end_ts is not None:
            sql += " ORDER BY k.created_at_ms DESC LIMIT ?"
        else:
            sql += " ORDER BY COALESCE(k.observed_at, k.end_time, k.start_time, 0) DESC LIMIT ?"
        candidate_limit = max(top_k * 50, 200)
        params.append(candidate_limit)
        cursor.execute(sql, params)

        rows = cursor.fetchall()
        chunks = [self._row_to_chunk(row, float(len(terms)) if terms else 1.0) for row in rows]
        return _rank_keyword_chunks(chunks, terms, prefer_url=_is_link_lookup_query(query))[:top_k]

    def _row_to_chunk(self, row: sqlite3.Row, score: float) -> RetrievedChunk:
        knowledge_id = row["id"]
        doc_key = _knowledge_doc_key(knowledge_id)
        time_value = row["observed_at"] or row["end_time"] or row["start_time"]
        return RetrievedChunk(
            capture_id=row["capture_id"],
            text=self._build_knowledge_text(row),
            score=score,
            source="knowledge",
            doc_key=doc_key,
            metadata={
                "doc_key": doc_key,
                "source_type": "knowledge",
                "retrieval_method": "knowledge",
                "knowledge_id": knowledge_id,
                "overview": row["overview"],
                "summary": row["summary"],
                "start_time": row["start_time"],
                "end_time": row["end_time"],
                "observed_at": row["observed_at"],
                "event_time_start": row["event_time_start"],
                "event_time_end": row["event_time_end"],
                "history_view": bool(row["history_view"]),
                "content_origin": row["content_origin"],
                "activity_type": row["activity_type"],
                "is_self_generated": bool(row["is_self_generated"]),
                "evidence_strength": row["evidence_strength"],
                "importance": row["importance"],
                "time": time_value,
                "app_name": row["frag_app_name"],
                "win_title": row["frag_win_title"],
                "url": row["linked_url"] if "linked_url" in row.keys() else None,
                "webpage_title": row["linked_webpage_title"] if "linked_webpage_title" in row.keys() else None,
                "category": row["category"],
                "user_verified": row["user_verified"],
            },
        )

    def _search_artifacts(
        self,
        cursor: sqlite3.Cursor,
        query: str,
        top_k: int,
        entity_terms: list[str] | None,
    ) -> list[RetrievedChunk]:
        terms = list(dict.fromkeys([*(entity_terms or []), *_extract_query_terms(query)]))
        if not terms:
            return []

        chunks: list[RetrievedChunk] = []
        chunks.extend(self._search_document_artifacts(cursor, terms, top_k))
        chunks.extend(self._search_knowledge_artifacts(cursor, terms, top_k))
        chunks.extend(self._search_operation_artifacts(cursor, terms, top_k))
        return _rank_keyword_chunks(chunks, terms, prefer_url=_is_link_lookup_query(query))[:top_k]

    def _search_document_artifacts(
        self,
        cursor: sqlite3.Cursor,
        terms: list[str],
        top_k: int,
    ) -> list[RetrievedChunk]:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='bake_documents'")
        if not cursor.fetchone():
            return []

        clause, params = _build_like_clauses(
            "LOWER(COALESCE(title, '') || ' ' || COALESCE(doc_type, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(full_content, '') || ' ' || COALESCE(sections_json, '') || ' ' || COALESCE(source_url, ''))",
            terms,
        )
        if not clause:
            return []

        sql = f"""
            SELECT
                id, title, doc_type, summary, full_content, sections_json, source_url,
                source_memory_ids, linked_knowledge_ids, updated_at
            FROM bake_documents
            WHERE deleted_at IS NULL AND {clause}
            ORDER BY updated_at DESC
            LIMIT ?
        """
        cursor.execute(sql, [*params, max(top_k * 40, 300)])
        rows = cursor.fetchall()
        chunks = [self._document_row_to_chunk(row, terms) for row in rows]
        return chunks

    def _search_knowledge_artifacts(
        self,
        cursor: sqlite3.Cursor,
        terms: list[str],
        top_k: int,
    ) -> list[RetrievedChunk]:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='bake_knowledge'")
        if not cursor.fetchone():
            return []

        clause, params = _build_like_clauses(
            "LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(content, '') || ' ' || COALESCE(detailed_content, '') || ' ' || COALESCE(entities, ''))",
            terms,
        )
        if not clause:
            return []

        sql = f"""
            SELECT
                id, title, summary, content, detailed_content, timeline_id,
                source_timeline_ids, source_capture_ids, importance, user_verified, updated_at_ms
            FROM bake_knowledge
            WHERE {clause}
            ORDER BY COALESCE(updated_at_ms, 0) DESC
            LIMIT ?
        """
        cursor.execute(sql, [*params, max(top_k * 40, 300)])
        rows = cursor.fetchall()
        return [self._knowledge_artifact_row_to_chunk(row, terms) for row in rows]

    def _search_operation_artifacts(
        self,
        cursor: sqlite3.Cursor,
        terms: list[str],
        top_k: int,
    ) -> list[RetrievedChunk]:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='bake_sops'")
        if not cursor.fetchone():
            return []

        clause, params = _build_like_clauses(
            "LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(content, '') || ' ' || COALESCE(detailed_content, '') || ' ' || COALESCE(entities, ''))",
            terms,
        )
        if not clause:
            return []

        sql = f"""
            SELECT
                id, title, summary, content, detailed_content, timeline_id,
                source_capture_ids, importance, user_verified, updated_at_ms
            FROM bake_sops
            WHERE {clause}
            ORDER BY COALESCE(updated_at_ms, 0) DESC
            LIMIT ?
        """
        cursor.execute(sql, [*params, max(top_k * 40, 300)])
        rows = cursor.fetchall()
        return [self._operation_artifact_row_to_chunk(row, terms) for row in rows]

    @staticmethod
    def _json_ids(value: str | None) -> list[str]:
        if not value:
            return []
        try:
            import json
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(item) for item in parsed if item is not None]
        except Exception:
            return re.findall(r"\d+", value)
        return []

    @staticmethod
    def _keyword_score(text: str, terms: list[str]) -> float:
        lowered = text.lower()
        return float(sum(1 for term in terms if term.lower() in lowered))

    @staticmethod
    def _document_artifact_score(row: sqlite3.Row, terms: list[str], text: str) -> float:
        base = KnowledgeFts5Retriever._keyword_score(text, terms) + 50.0
        title = str(row["title"] or "").lower()
        summary = str(row["summary"] or "").lower()
        full = f"{title} {summary}"

        title_hits = sum(1 for term in terms if term.lower() in title)
        summary_hits = sum(1 for term in terms if term.lower() in summary)
        score = base + title_hits * 8.0 + summary_hits * 2.0

        meaningful_terms = [term.lower() for term in terms if len(term) >= 2]
        title_coverage = title_hits / max(1, min(len(meaningful_terms), 12))
        long_title_hits = sum(1 for term in meaningful_terms if len(term) >= 3 and term in title)
        full_coverage = sum(1 for term in meaningful_terms if term in full) / max(1, min(len(meaningful_terms), 12))
        if title_hits:
            score += 12.0 + title_coverage * 32.0 + long_title_hits * 3.0
        if full_coverage:
            score += full_coverage * 10.0
        return score

    def _document_row_to_chunk(self, row: sqlite3.Row, terms: list[str]) -> RetrievedChunk:
        artifact_id = int(row["id"])
        doc_key = _artifact_doc_key("document", artifact_id)
        source_timeline_ids = self._json_ids(row["source_memory_ids"])
        linked_knowledge_ids = self._json_ids(row["linked_knowledge_ids"])
        text = self._build_document_text(row)
        return RetrievedChunk(
            capture_id=0,
            text=text,
            score=self._document_artifact_score(row, terms, text),
            source="document",
            doc_key=doc_key,
            metadata={
                "doc_key": doc_key,
                "source_type": "document",
                "retrieval_method": "artifact",
                "artifact_id": artifact_id,
                "document_id": artifact_id,
                "title": row["title"],
                "summary": row["summary"],
                "overview": row["summary"],
                "category": row["doc_type"],
                "doc_type": row["doc_type"],
                "url": row["source_url"],
                "source_url": row["source_url"],
                "time": row["updated_at"],
                "updated_at": row["updated_at"],
                "source_timeline_ids": source_timeline_ids,
                "linked_knowledge_ids": linked_knowledge_ids,
            },
        )

    def _knowledge_artifact_row_to_chunk(self, row: sqlite3.Row, terms: list[str]) -> RetrievedChunk:
        artifact_id = int(row["id"])
        doc_key = _artifact_doc_key("bake_knowledge", artifact_id)
        source_timeline_ids = self._json_ids(row["source_timeline_ids"])
        if row["timeline_id"] and str(row["timeline_id"]) not in source_timeline_ids:
            source_timeline_ids.insert(0, str(row["timeline_id"]))
        text = self._build_bake_artifact_text(row, "知识")
        return RetrievedChunk(
            capture_id=0,
            text=text,
            score=self._keyword_score(text, terms) + 20.0,
            source="bake_knowledge",
            doc_key=doc_key,
            metadata={
                "doc_key": doc_key,
                "source_type": "bake_knowledge",
                "retrieval_method": "artifact",
                "artifact_id": artifact_id,
                "title": row["title"],
                "summary": row["summary"],
                "overview": row["summary"],
                "source_timeline_ids": source_timeline_ids,
                "source_capture_ids": self._json_ids(row["source_capture_ids"]),
                "importance": row["importance"],
                "user_verified": bool(row["user_verified"]),
                "time": row["updated_at_ms"],
                "updated_at": row["updated_at_ms"],
            },
        )

    def _operation_artifact_row_to_chunk(self, row: sqlite3.Row, terms: list[str]) -> RetrievedChunk:
        artifact_id = int(row["id"])
        doc_key = _artifact_doc_key("operation", artifact_id)
        source_timeline_ids = [str(row["timeline_id"])] if row["timeline_id"] else []
        text = self._build_bake_artifact_text(row, "操作")
        return RetrievedChunk(
            capture_id=0,
            text=text,
            score=self._keyword_score(text, terms) + 20.0,
            source="operation",
            doc_key=doc_key,
            metadata={
                "doc_key": doc_key,
                "source_type": "operation",
                "retrieval_method": "artifact",
                "artifact_id": artifact_id,
                "title": row["title"],
                "summary": row["summary"],
                "overview": row["summary"],
                "source_timeline_ids": source_timeline_ids,
                "source_capture_ids": self._json_ids(row["source_capture_ids"]),
                "importance": row["importance"],
                "user_verified": bool(row["user_verified"]),
                "time": row["updated_at_ms"],
                "updated_at": row["updated_at_ms"],
            },
        )

    @staticmethod
    def _build_document_text(row: sqlite3.Row) -> str:
        parts: list[str] = [f"文档：{row['title']}"]
        if row["doc_type"]:
            parts.append(f"类型：{row['doc_type']}")
        if row["summary"]:
            parts.append(f"摘要：{row['summary']}")
        if row["source_url"]:
            parts.append(f"URL：{row['source_url']}")
        if row["full_content"]:
            parts.append(f"正文：{str(row['full_content'])[:1200]}")
        elif row["sections_json"]:
            parts.append(f"结构：{str(row['sections_json'])[:800]}")
        return "\n".join(parts)

    @staticmethod
    def _build_bake_artifact_text(row: sqlite3.Row, label: str) -> str:
        parts: list[str] = [f"{label}：{row['title']}"]
        if row["summary"]:
            parts.append(f"摘要：{row['summary']}")
        if row["detailed_content"]:
            parts.append(f"详情：{str(row['detailed_content'])[:1000]}")
        elif row["content"]:
            parts.append(f"内容：{str(row['content'])[:800]}")
        return "\n".join(parts)

    @staticmethod
    def _build_knowledge_text(row: sqlite3.Row) -> str:
        parts: list[str] = []
        observed_text = _format_ts(row["observed_at"]) if "observed_at" in row.keys() else ""
        event_start_text = _format_ts(row["event_time_start"]) if "event_time_start" in row.keys() else ""
        event_end_text = _format_ts(row["event_time_end"]) if "event_time_end" in row.keys() else ""
        start_text = _format_ts(row["start_time"])
        end_text = _format_ts(row["end_time"])
        if observed_text:
            parts.append(f"看到时间：{observed_text}")
        if event_start_text or event_end_text:
            if event_start_text and event_end_text and event_start_text != event_end_text:
                parts.append(f"事件时间：{event_start_text} ~ {event_end_text}")
            else:
                parts.append(f"事件时间：{event_start_text or event_end_text}")
        elif start_text or end_text:
            if start_text and end_text and start_text != end_text:
                parts.append(f"记录时间：{start_text} ~ {end_text}")
            else:
                parts.append(f"记录时间：{start_text or end_text}")
        if row["duration_minutes"]:
            parts.append(f"时长：{row['duration_minutes']} 分钟")
        if row["frag_app_name"]:
            parts.append(f"应用：{row['frag_app_name']}")
        if row["frag_win_title"]:
            parts.append(f"窗口：{row['frag_win_title']}")
        if "linked_webpage_title" in row.keys() and row["linked_webpage_title"]:
            parts.append(f"页面：{row['linked_webpage_title']}")
        if "linked_url" in row.keys() and row["linked_url"]:
            parts.append(f"URL：{row['linked_url']}")
        if "activity_type" in row.keys() and row["activity_type"]:
            parts.append(f"活动类型：{row['activity_type']}")
        if "content_origin" in row.keys() and row["content_origin"]:
            parts.append(f"内容来源：{row['content_origin']}")
        if "history_view" in row.keys() and row["history_view"]:
            parts.append("历史回看：是")
        if row["overview"] or row["summary"]:
            parts.append(f"概述：{row['overview'] or row['summary']}")
        # details 不放入检索 text，避免 RAG prompt 超长；details 保留在 metadata 中
        return "\n".join(parts)



def _format_ts(ts: int | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts)
