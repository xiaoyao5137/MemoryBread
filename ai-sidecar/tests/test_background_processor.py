import asyncio
import json
import sqlite3

from background_processor import BackgroundProcessor, _is_self_generated_capture
from knowledge.fragment_grouper import FragmentGrouper


class _StubVectorStorage:
    def __init__(self) -> None:
        self.calls = []

    def store_vector(self, capture_id, text, vector, metadata=None):
        self.calls.append({
            "capture_id": capture_id,
            "text": text,
            "vector": vector,
            "metadata": metadata or {},
        })
        return True


def _init_db(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE captures (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            app_name TEXT,
            win_title TEXT,
            ocr_text TEXT,
            ax_text TEXT,
            knowledge_id INTEGER,
            is_sensitive INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE knowledge_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            capture_id INTEGER NOT NULL,
            summary TEXT,
            overview TEXT,
            details TEXT,
            entities TEXT,
            category TEXT,
            importance INTEGER,
            occurrence_count INTEGER,
            capture_ids TEXT,
            start_time INTEGER,
            end_time INTEGER,
            duration_minutes INTEGER,
            frag_app_name TEXT,
            frag_win_title TEXT,
            observed_at INTEGER,
            event_time_start INTEGER,
            event_time_end INTEGER,
            history_view INTEGER NOT NULL DEFAULT 0,
            content_origin TEXT,
            activity_type TEXT,
            is_self_generated INTEGER NOT NULL DEFAULT 0,
            evidence_strength TEXT
        )
        """
    )
    conn.commit()
    conn.close()


def test_is_self_generated_capture_matches_memory_bread() -> None:
    assert _is_self_generated_capture("memory-bread-desktop", "问答页") is True
    assert _is_self_generated_capture("其他应用", "记忆面包 RagPanel") is True
    assert _is_self_generated_capture("Google Chrome", "Claude") is False


def test_fragment_grouper_splits_history_review_from_live_chat() -> None:
    grouper = FragmentGrouper()
    captures = [
        {
            "id": 1,
            "ts": 1000,
            "app_name": "WeChat",
            "window_title": "聊天窗口",
            "ax_text": "今天和产品同步需求，正在回复最新消息",
            "ocr_text": None,
        },
        {
            "id": 2,
            "ts": 2000,
            "app_name": "WeChat",
            "window_title": "聊天记录",
            "ax_text": "回看昨天的聊天记录，查看前天的历史消息",
            "ocr_text": None,
        },
    ]

    assert grouper._history_mode_changed([captures[0]], captures[1]) is True
    assert grouper._check_context_continuity([captures[0]], captures[1]) is False


def test_save_knowledge_persists_semantic_fields(tmp_path) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)
    conn = sqlite3.connect(db_path)

    knowledge = {
        "capture_ids": "[1,2]",
        "overview": "今天回看了昨天的飞书消息",
        "details": "确认了昨天讨论的发布安排",
        "entities": "[\"飞书\", \"发布\"]",
        "category": "聊天",
        "importance": 4,
        "occurrence_count": 1,
        "start_time": 1000,
        "end_time": 2000,
        "duration_minutes": 1,
        "frag_app_name": "Feishu",
        "frag_win_title": "项目群",
        "observed_at": 2000,
        "event_time_start": 500,
        "event_time_end": 800,
        "history_view": True,
        "content_origin": "historical_content",
        "activity_type": "reviewing_history",
        "is_self_generated": False,
        "evidence_strength": "high",
    }

    knowledge_id = processor._save_knowledge(conn, knowledge)
    row = conn.execute(
        "SELECT observed_at, event_time_start, event_time_end, history_view, content_origin, activity_type, is_self_generated, evidence_strength FROM knowledge_entries WHERE id = ?",
        (knowledge_id,),
    ).fetchone()
    conn.close()

    assert row == (2000, 500, 800, 1, "historical_content", "reviewing_history", 0, "high")


def test_process_knowledge_vectorization_passes_semantic_metadata(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)

    class _StubWorker:
        async def handle(self, req):
            class _Result:
                vectors = [[0.1, 0.2, 0.3]]

            class _Response:
                status = "ok"
                result = _Result()
                error = None

            return _Response()

    storage = _StubVectorStorage()
    monkeypatch.setattr(processor, "_get_embed_worker", lambda: _StubWorker())

    import background_processor as bp_module
    monkeypatch.setattr(bp_module, "time", type("_T", (), {"time": staticmethod(lambda: 1.0)}))
    monkeypatch.setattr("embedding.vector_storage.get_vector_storage", lambda: storage)

    group = [{"id": 10, "app_name": "Gemini", "window_title": "Gemini"}]
    knowledge = {
        "overview": "今天问了 Gemini 发布计划",
        "details": "确认了发布时间窗口",
        "entities": "[\"Gemini\", \"发布计划\"]",
        "start_time": 1000,
        "end_time": 2000,
        "observed_at": 2000,
        "event_time_start": 1500,
        "event_time_end": 1800,
        "history_view": False,
        "content_origin": "live_interaction",
        "activity_type": "ask_ai",
        "is_self_generated": False,
        "evidence_strength": "medium",
        "frag_app_name": "Gemini",
        "frag_win_title": "Gemini",
        "category": "聊天",
    }

    ok = asyncio.run(processor._process_knowledge_vectorization(group, 77, knowledge))

    assert ok is True
    assert len(storage.calls) == 1
    metadata = storage.calls[0]["metadata"]
    assert metadata["source_type"] == "knowledge"
    assert metadata["knowledge_id"] == 77
    assert metadata["observed_at"] == 2000
    assert metadata["event_time_start"] == 1500
    assert metadata["event_time_end"] == 1800
    assert metadata["history_view"] is False
    assert metadata["content_origin"] == "live_interaction"
    assert metadata["activity_type"] == "ask_ai"
    assert metadata["evidence_strength"] == "medium"


def test_trigger_unified_bake_pipeline_skips_when_no_new_knowledge(tmp_path) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)

    result = asyncio.run(processor._trigger_unified_bake_pipeline(0))

    assert result == {
        "triggered": False,
        "reason": "no_new_knowledge",
    }


def test_trigger_unified_bake_pipeline_posts_to_core(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)

    captured = {}

    class _StubResponse:
        def read(self):
            return b'{"id":"42","status":"completed","auto_created_count":3,"candidate_count":1,"discarded_count":0}'

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        captured["method"] = request.get_method()
        captured["headers"] = {k.lower(): v for k, v in request.header_items()}
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["timeout"] = timeout
        return _StubResponse()

    monkeypatch.setenv("CORE_ENGINE_URL", "http://127.0.0.1:7070")
    monkeypatch.setattr("background_processor.urllib_request.urlopen", _fake_urlopen)

    result = asyncio.run(processor._trigger_unified_bake_pipeline(2))

    assert captured["url"] == "http://127.0.0.1:7070/api/bake/run"
    assert captured["method"] == "POST"
    assert captured["headers"]["content-type"] == "application/json"
    assert captured["body"] == {
        "trigger_reason": "knowledge_background",
        "limit": 2,
    }
    assert captured["timeout"] == 15
    assert result == {
        "triggered": True,
        "status": "completed",
        "run_id": "42",
        "auto_created_count": 3,
        "candidate_count": 1,
        "discarded_count": 0,
    }
