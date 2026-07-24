from __future__ import annotations

import asyncio
import sqlite3

from background_processor import BackgroundProcessor
from embedding.base import EmbeddingVector
from embedding.document_chunks import (
    build_document_snapshot,
    canonicalize_document_url,
    chunk_document,
    estimate_tokens,
)
from embedding.vector_storage import VectorStorage


def _create_vector_schema(path: str) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE captures (id INTEGER PRIMARY KEY)")
        conn.execute(
            """
            CREATE TABLE vector_index (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                capture_id INTEGER NOT NULL,
                qdrant_point_id TEXT NOT NULL UNIQUE,
                chunk_index INTEGER NOT NULL DEFAULT 0,
                chunk_text TEXT NOT NULL,
                model_name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                doc_key TEXT,
                source_type TEXT NOT NULL DEFAULT 'capture',
                knowledge_id INTEGER,
                time INTEGER,
                start_time INTEGER,
                end_time INTEGER,
                observed_at INTEGER,
                event_time_start INTEGER,
                event_time_end INTEGER,
                history_view INTEGER NOT NULL DEFAULT 0,
                content_origin TEXT,
                activity_type TEXT,
                is_self_generated INTEGER NOT NULL DEFAULT 0,
                evidence_strength TEXT,
                app_name TEXT,
                win_title TEXT,
                category TEXT,
                user_verified INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute("INSERT INTO captures (id) VALUES (7)")


class _FakeQdrant:
    def __init__(self) -> None:
        self.upserts = []
        self.deletes = []

    def upsert(self, **kwargs):
        self.upserts.append(kwargs)

    def delete(self, **kwargs):
        self.deletes.append(kwargs)


def test_document_chunking_keeps_content_after_old_500_character_cutoff() -> None:
    body = (
        "第一章：背景\n\n"
        + "这是背景说明。" * 45
        + "\n\n第二章：潮汐\n\n"
        + "潮汐特性用于控制后台任务的启动和并发水位。" * 40
    )
    chunks = chunk_document(body, title="系统调度方案")

    assert len(chunks) >= 2
    assert any("潮汐特性" in chunk for chunk in chunks[1:])
    assert all(estimate_tokens(chunk) <= 500 for chunk in chunks)


def test_document_snapshot_uses_canonical_url_and_full_ax_text() -> None:
    capture = {
        "id": 9,
        "url": "https://docs.corp.kuaishou.com/k/home/ABC_123?from=recent#section",
        "window_title": "调度文档",
        "ax_text": "前言。" * 120 + "潮汐特性在正文后部。",
        "ocr_text": "短 OCR",
    }
    snapshot = build_document_snapshot(capture)

    assert snapshot is not None
    assert snapshot.canonical_url == "https://docs.corp.kuaishou.com/k/home/ABC_123"
    assert snapshot.doc_key == f"document_url:{snapshot.canonical_url}"
    assert "潮汐特性" in snapshot.body
    assert canonicalize_document_url(capture["url"]) == snapshot.canonical_url


def test_document_vector_storage_is_idempotent_and_replaces_old_version(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "vectors.db")
    _create_vector_schema(db_path)
    storage = VectorStorage(db_path=db_path)
    qdrant = _FakeQdrant()
    monkeypatch.setattr(storage, "_get_qdrant_client", lambda: qdrant)
    metadata = {
        "doc_key": "document_url:https://docs.corp.kuaishou.com/k/home/ABC_123",
        "content_hash": "version-one",
        "url": "https://docs.corp.kuaishou.com/k/home/ABC_123",
        "title": "调度文档",
        "ts": 1234,
    }

    assert storage.store_document_vectors(
        7,
        ["第一块", "第二块包含潮汐特性"],
        [[0.1, 0.2], [0.2, 0.3]],
        metadata,
    )
    assert storage.store_document_vectors(
        7,
        ["第一块", "第二块包含潮汐特性"],
        [[0.1, 0.2], [0.2, 0.3]],
        metadata,
    )
    assert len(qdrant.upserts) == 1

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT chunk_index, chunk_text, source_type, doc_key FROM vector_index ORDER BY chunk_index"
        ).fetchall()
    assert rows == [
        (0, "第一块", "document", metadata["doc_key"]),
        (1, "第二块包含潮汐特性", "document", metadata["doc_key"]),
    ]

    changed = {**metadata, "content_hash": "version-two"}
    assert storage.store_document_vectors(
        7,
        ["新版本包含潮汐特性"],
        [[0.3, 0.4]],
        changed,
    )
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT chunk_index, chunk_text FROM vector_index ORDER BY chunk_index"
        ).fetchall()
    assert rows == [(0, "新版本包含潮汐特性")]
    assert len(qdrant.upserts) == 2
    assert len(qdrant.deletes) == 1


def test_background_vectorization_routes_document_chunks_to_document_domain(
    tmp_path,
    monkeypatch,
) -> None:
    class _Storage:
        def __init__(self) -> None:
            self.document_calls = []
            self.capture_calls = []

        def document_version_exists(self, *_args) -> bool:
            return False

        def store_document_vectors(self, capture_id, chunks, vectors, metadata):
            self.document_calls.append((capture_id, chunks, vectors, metadata))
            return True

        def store_vector(self, *args, **kwargs):
            self.capture_calls.append((args, kwargs))
            return True

    class _Model:
        model_name = "test-embedding"

        def encode(self, texts):
            return [
                EmbeddingVector(text=text, vector=[float(index), 0.5])
                for index, text in enumerate(texts)
            ]

    storage = _Storage()
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr("embedding.vector_storage.get_vector_storage", lambda: storage)
    monkeypatch.setattr("model_registry_global.get_shared_embedding", lambda: _Model())
    processor = BackgroundProcessor(db_path=str(tmp_path / "missing.db"))
    capture = {
        "id": 88,
        "ts": 1234,
        "app_name": "Google Chrome",
        "window_title": "潮汐调度说明",
        "url": "https://docs.corp.kuaishou.com/k/home/ABC_123",
        "ax_text": "背景信息。" * 100 + "潮汐特性用于调节后台任务。" * 60,
        "ocr_text": "",
    }

    asyncio.run(processor._process_vectorization_batch([capture]))

    assert storage.capture_calls == []
    assert len(storage.document_calls) == 1
    capture_id, chunks, vectors, metadata = storage.document_calls[0]
    assert capture_id == 88
    assert len(chunks) == len(vectors)
    assert len(chunks) >= 2
    assert any("潮汐特性" in chunk for chunk in chunks)
    assert metadata["source_type"] == "document"
    assert metadata["doc_key"].startswith("document_url:")
