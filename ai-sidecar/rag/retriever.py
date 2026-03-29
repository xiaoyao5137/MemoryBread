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

    def _get_client(self):
        """懒加载 Qdrant 客户端"""
        if self._client is None:
            try:
                from qdrant_client import QdrantClient

                if self.qdrant_path:
                    self._client = QdrantClient(path=self.qdrant_path)
                    logger.info(f"Qdrant 本地模式已连接: {self.qdrant_path}")
                else:
                    self._client = QdrantClient(host=self.host or "localhost", port=self.port or 6333)
                    logger.info(f"Qdrant 客户端已连接: {self.host}:{self.port}")
            except Exception as e:
                logger.error(f"连接 Qdrant 失败: {e}")
                self._client = None
        return self._client

    def is_available(self) -> bool:
        """检查 Qdrant 是否可用"""
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

        client = self._get_client()
        if not client:
            logger.warning("Qdrant 不可用，跳过向量检索")
            return []

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
            return []

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
            if chunks:
                conn.close()
                logger.debug(f"FTS5 检索返回 {len(chunks)} 条结果")
                return chunks

            chunks = self._search_by_app_fields(
                cursor,
                query=query,
                top_k=top_k,
                start_ts=start_ts,
                end_ts=end_ts,
                entity_terms=entity_terms,
            )
            conn.close()
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
                c.ocr_text,
                c.ax_text,
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
                "LOWER(COALESCE(c.app_name, '') || ' ' || COALESCE(c.win_title, '') || ' ' || COALESCE(c.ocr_text, '') || ' ' || COALESCE(c.ax_text, ''))",
                entity_terms,
            )
            sql += f" AND {clause}"
            params.extend(clause_params)

        sql += " ORDER BY rank LIMIT ?"
        params.append(top_k)
        cursor.execute(sql, params)
        return [self._row_to_chunk(row, abs(row["score"])) for row in cursor.fetchall()]

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
                c.ocr_text,
                c.ax_text
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
            "LOWER(COALESCE(c.app_name, '') || ' ' || COALESCE(c.win_title, '') || ' ' || COALESCE(c.ocr_text, '') || ' ' || COALESCE(c.ax_text, ''))",
            terms,
        )
        sql += f" AND {clause}"
        params.extend(clause_params)
        sql += " ORDER BY c.ts DESC LIMIT ?"
        params.append(top_k)
        cursor.execute(sql, params)

        rows = cursor.fetchall()
        return [self._row_to_chunk(row, float(len(terms)), source="fts5") for row in rows]

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
        if row["ocr_text"]:
            parts.append(f"OCR：{row['ocr_text']}")
        if row["ax_text"]:
            parts.append(f"AX：{row['ax_text']}")
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
            )
            if chunks:
                conn.close()
                logger.debug(f"知识库检索返回 {len(chunks)} 条结果")
                return chunks

            chunks = self._search_by_app_fields(
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
            )
            conn.close()
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
                fts.rank as score
            FROM knowledge_fts fts
            JOIN knowledge_entries k ON fts.rowid = k.id
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
        sql, params = _apply_noise_filters(sql, params)
        if entity_terms:
            clause, clause_params = _build_like_clauses(
                "LOWER(COALESCE(k.summary, '') || ' ' || COALESCE(k.overview, '') || ' ' || COALESCE(k.details, '') || ' ' || COALESCE(k.frag_app_name, '') || ' ' || COALESCE(k.frag_win_title, ''))",
                entity_terms,
            )
            sql += f" AND {clause}"
            params.extend(clause_params)

        sql += " ORDER BY rank LIMIT ?"
        params.append(top_k)
        cursor.execute(sql, params)
        return [self._row_to_chunk(row, abs(row["score"])) for row in cursor.fetchall()]

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
    ) -> list[RetrievedChunk]:
        terms = entity_terms or _extract_query_terms(query)
        if query_mode == "summary":
            terms = [term for term in terms if not _is_app_like_term(term)] or terms
        terms = list(dict.fromkeys(terms))
        # 任务型宽松检索：terms 为空时允许继续，纯按时间段和 activity_types 扫描
        # 非任务型检索：terms 为空则无意义，直接返回
        is_time_scan = not terms and (observed_start_ts is not None or start_ts is not None)
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
                k.evidence_strength
            FROM knowledge_entries k
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

        sql, params = _apply_noise_filters(sql, params)
        if terms:
            clause, clause_params = _build_like_clauses(
                "LOWER(COALESCE(k.summary, '') || ' ' || COALESCE(k.overview, '') || ' ' || COALESCE(k.details, '') || ' ' || COALESCE(k.frag_app_name, '') || ' ' || COALESCE(k.frag_win_title, ''))",
                terms,
            )
            sql += f" AND {clause}"
            params.extend(clause_params)
        sql += " ORDER BY COALESCE(k.observed_at, k.end_time, k.start_time, 0) DESC LIMIT ?"
        params.append(top_k)
        cursor.execute(sql, params)

        rows = cursor.fetchall()
        return [self._row_to_chunk(row, float(len(terms)) if terms else 1.0) for row in rows]

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
                "time": time_value,
                "app_name": row["frag_app_name"],
                "win_title": row["frag_win_title"],
                "category": row["category"],
                "user_verified": row["user_verified"],
            },
        )

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
        if "activity_type" in row.keys() and row["activity_type"]:
            parts.append(f"活动类型：{row['activity_type']}")
        if "content_origin" in row.keys() and row["content_origin"]:
            parts.append(f"内容来源：{row['content_origin']}")
        if "history_view" in row.keys() and row["history_view"]:
            parts.append("历史回看：是")
        if row["overview"] or row["summary"]:
            parts.append(f"概述：{row['overview'] or row['summary']}")
        if row["details"]:
            parts.append(f"详情：{row['details']}")
        return "\n".join(parts)



def _format_ts(ts: int | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts)
