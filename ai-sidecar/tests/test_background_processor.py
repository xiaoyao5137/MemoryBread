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
            timeline_id INTEGER,
            url TEXT,
            webpage_title TEXT,
            is_sensitive INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE timelines (
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
            time_range_start INTEGER,
            time_range_end INTEGER,
            key_timestamps TEXT,
            observed_at INTEGER,
            event_time_start INTEGER,
            event_time_end INTEGER,
            history_view INTEGER NOT NULL DEFAULT 0,
            content_origin TEXT,
            activity_type TEXT,
            is_self_generated INTEGER NOT NULL DEFAULT 0,
            evidence_strength TEXT,
            created_at_ms INTEGER,
            updated_at_ms INTEGER
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


def test_fragment_grouper_merges_same_document_url() -> None:
    grouper = FragmentGrouper()
    doc_url = "https://docs.corp.kuaishou.com/d/home/fcAAAAAA"
    captures = [
        {
            "id": 1,
            "ts": 1000,
            "app_name": "Google Chrome",
            "window_title": "方案 A - 云文档",
            "ax_text": "方案 A 的完整正文内容，用于验证同一文档连续浏览。",
            "ocr_text": None,
            "url": doc_url,
        },
        {
            "id": 2,
            "ts": 2000,
            "app_name": "Google Chrome",
            "window_title": "方案 A - 云文档",
            "ax_text": "方案 A 的完整正文内容，用于验证同一文档连续浏览。",
            "ocr_text": None,
            "url": f"{doc_url}#section=details",
        },
    ]

    groups = grouper.group_captures(captures)

    assert [[capture["id"] for capture in group] for group in groups] == [[1, 2]]


def test_fragment_grouper_splits_different_or_empty_document_url() -> None:
    grouper = FragmentGrouper()
    captures = [
        {
            "id": 1,
            "ts": 1000,
            "app_name": "Google Chrome",
            "window_title": "方案 A - 云文档",
            "ax_text": "方案正文内容",
            "ocr_text": None,
            "url": "https://docs.corp.kuaishou.com/d/home/fcAAAAAA",
        },
        {
            "id": 2,
            "ts": 2000,
            "app_name": "Google Chrome",
            "window_title": "方案 B - 云文档",
            "ax_text": "方案正文内容",
            "ocr_text": None,
            "url": "https://docs.corp.kuaishou.com/d/home/fcBBBBBB",
        },
        {
            "id": 3,
            "ts": 3000,
            "app_name": "ChatGPT Atlas",
            "window_title": "方案 B - 云文档",
            "ax_text": "方案正文内容",
            "ocr_text": None,
            "url": None,
        },
        {
            "id": 4,
            "ts": 4000,
            "app_name": "ChatGPT Atlas",
            "window_title": "方案 B - 云文档",
            "ax_text": "方案正文内容",
            "ocr_text": None,
            "url": None,
        },
    ]

    groups = grouper.group_captures(captures)

    assert [[capture["id"] for capture in group] for group in groups] == [
        [1],
        [2],
        [3],
        [4],
    ]


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
        "SELECT observed_at, event_time_start, event_time_end, history_view, content_origin, activity_type, is_self_generated, evidence_strength FROM timelines WHERE id = ?",
        (knowledge_id,),
    ).fetchone()
    conn.close()

    assert row == (2000, 500, 800, 1, "historical_content", "reviewing_history", 0, "high")


class _ImmediateQueue:
    def submit_sync(self, _priority, fn, timeout=None, lane=None):
        return fn()


class _SimilarExtractor:
    def __init__(self, similar_id: int) -> None:
        self.similar_id = similar_id

    def extract_merged(self, captures, preempt_check=None):
        capture_ids = [capture["id"] for capture in captures]
        return {
            "capture_ids": json.dumps(capture_ids),
            "summary": "万擎平台稳定性设计",
            "overview": "整理万擎平台稳定性设计与调度策略",
            "details": "补充新的文档内容",
            "entities": json.dumps(["万擎", "SLO"]),
            "category": "文档",
            "importance": 4,
            "occurrence_count": 1,
            "start_time": captures[0]["ts"],
            "end_time": captures[-1]["ts"],
            "duration_minutes": 0,
            "time_range_start": captures[0]["ts"],
            "time_range_end": captures[-1]["ts"],
            "key_timestamps": json.dumps([]),
            "frag_app_name": captures[-1].get("app_name"),
            "frag_win_title": captures[-1].get("window_title"),
            "observed_at": captures[-1]["ts"],
            "content_origin": "document_reference",
            "activity_type": "reading",
            "is_self_generated": False,
            "evidence_strength": "high",
        }

    def _find_similar_knowledge(self, overview, db_conn, **kwargs):
        return self.similar_id


def _seed_timeline(conn: sqlite3.Connection, doc_url: str | None) -> int:
    conn.execute(
        """
        INSERT INTO captures (id, ts, app_name, win_title, ocr_text, ax_text, timeline_id, url, webpage_title)
        VALUES (1, 1000, 'Chrome', 'Doc A', 'doc a', '', 1, ?, 'Doc A')
        """,
        (doc_url,),
    )
    conn.execute(
        """
        INSERT INTO timelines (
            id, capture_id, summary, overview, details, entities, category, importance,
            occurrence_count, capture_ids, start_time, end_time, time_range_start,
            time_range_end, observed_at, content_origin, activity_type, evidence_strength,
            created_at_ms, updated_at_ms
        )
        VALUES (1, 1, 'Doc A', '万擎平台稳定性设计', '已有内容', '[]', '文档', 4,
                1, '[1]', 1000, 1000, 1000, 1000, 1000, 'document_reference',
                'reading', 'high', 1000, 1000)
        """
    )
    conn.commit()
    return 1


async def _skip_vectorization(*_args, **_kwargs):
    return True


def test_similar_merge_rejects_different_document_url(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    doc_a = "https://docs.corp.kuaishou.com/k/home/docA/fcAAAAAA"
    doc_b = "https://docs.corp.kuaishou.com/k/home/docB/fcBBBBBB"
    conn = sqlite3.connect(db_path)
    _seed_timeline(conn, doc_a)
    conn.execute(
        """
        INSERT INTO captures (id, ts, app_name, win_title, ocr_text, ax_text, timeline_id, url, webpage_title)
        VALUES (2, 2000, 'Chrome', 'Doc B', 'doc b', '', NULL, ?, 'Doc B')
        """,
        (doc_b,),
    )
    conn.commit()
    conn.close()

    processor = BackgroundProcessor(db_path=db_path)
    monkeypatch.setattr(processor, "_get_knowledge_extractor", lambda: _SimilarExtractor(1))
    monkeypatch.setattr(processor, "_process_knowledge_vectorization", _skip_vectorization)
    monkeypatch.setattr("inference_queue.get_global_queue", lambda: _ImmediateQueue())

    ok = asyncio.run(processor._process_capture_group([
        {
            "id": 2,
            "ts": 2000,
            "app_name": "Chrome",
            "window_title": "Doc B",
            "ocr_text": "doc b",
            "ax_text": "",
            "url": doc_b,
        }
    ]))

    conn = sqlite3.connect(db_path)
    linked_timeline = conn.execute("SELECT timeline_id FROM captures WHERE id = 2").fetchone()[0]
    timeline_count = conn.execute("SELECT COUNT(*) FROM timelines").fetchone()[0]
    original_capture_ids = conn.execute("SELECT capture_ids FROM timelines WHERE id = 1").fetchone()[0]
    conn.close()

    assert ok is True
    assert linked_timeline != 1
    assert timeline_count == 2
    assert json.loads(original_capture_ids) == [1]


def test_similar_merge_allows_same_document_and_syncs_capture_ids(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    doc_a = "https://docs.corp.kuaishou.com/k/home/docA/fcAAAAAA"
    conn = sqlite3.connect(db_path)
    _seed_timeline(conn, doc_a)
    conn.execute(
        """
        INSERT INTO captures (id, ts, app_name, win_title, ocr_text, ax_text, timeline_id, url, webpage_title)
        VALUES (2, 2000, 'Chrome', 'Doc A', 'doc a part 2', '', NULL, ?, 'Doc A')
        """,
        (doc_a,),
    )
    conn.commit()
    conn.close()

    processor = BackgroundProcessor(db_path=db_path)
    monkeypatch.setattr(processor, "_get_knowledge_extractor", lambda: _SimilarExtractor(1))
    monkeypatch.setattr(processor, "_process_knowledge_vectorization", _skip_vectorization)
    monkeypatch.setattr("inference_queue.get_global_queue", lambda: _ImmediateQueue())

    ok = asyncio.run(processor._process_capture_group([
        {
            "id": 2,
            "ts": 2000,
            "app_name": "Chrome",
            "window_title": "Doc A",
            "ocr_text": "doc a part 2",
            "ax_text": "",
            "url": doc_a,
        }
    ]))

    conn = sqlite3.connect(db_path)
    linked_timeline = conn.execute("SELECT timeline_id FROM captures WHERE id = 2").fetchone()[0]
    capture_ids, end_time = conn.execute(
        "SELECT capture_ids, end_time FROM timelines WHERE id = 1"
    ).fetchone()
    conn.close()

    assert ok is True
    assert linked_timeline == 1
    assert json.loads(capture_ids) == [1, 2]
    assert end_time == 2000


def test_similar_merge_rejects_empty_document_url(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    doc_a = "https://docs.corp.kuaishou.com/k/home/docA/fcAAAAAA"
    conn = sqlite3.connect(db_path)
    _seed_timeline(conn, doc_a)
    conn.execute(
        """
        INSERT INTO captures (id, ts, app_name, win_title, ocr_text, ax_text, timeline_id, url, webpage_title)
        VALUES (2, 2000, 'ChatGPT Atlas', 'Doc A - 云文档', 'doc a part 2', '', NULL, NULL, 'Doc A')
        """
    )
    conn.commit()
    conn.close()

    processor = BackgroundProcessor(db_path=db_path)
    monkeypatch.setattr(processor, "_get_knowledge_extractor", lambda: _SimilarExtractor(1))
    monkeypatch.setattr(processor, "_process_knowledge_vectorization", _skip_vectorization)
    monkeypatch.setattr("inference_queue.get_global_queue", lambda: _ImmediateQueue())

    ok = asyncio.run(processor._process_capture_group([
        {
            "id": 2,
            "ts": 2000,
            "app_name": "ChatGPT Atlas",
            "window_title": "Doc A - 云文档",
            "ocr_text": "doc a part 2",
            "ax_text": "",
            "url": None,
        }
    ]))

    conn = sqlite3.connect(db_path)
    linked_timeline = conn.execute("SELECT timeline_id FROM captures WHERE id = 2").fetchone()[0]
    timeline_count = conn.execute("SELECT COUNT(*) FROM timelines").fetchone()[0]
    original_capture_ids = conn.execute("SELECT capture_ids FROM timelines WHERE id = 1").fetchone()[0]
    conn.close()

    assert ok is True
    assert linked_timeline != 1
    assert timeline_count == 2
    assert json.loads(original_capture_ids) == [1]


def test_empty_url_document_timeline_rejects_cross_batch_merge(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    conn = sqlite3.connect(db_path)
    _seed_timeline(conn, None)
    conn.execute(
        """
        UPDATE captures SET win_title = '方案 A - 云文档' WHERE id = 1
        """
    )
    conn.execute(
        """
        INSERT INTO captures (id, ts, app_name, win_title, ocr_text, ax_text, timeline_id, url, webpage_title)
        VALUES (2, 2000, 'ChatGPT Atlas', '方案 A - 云文档', 'doc a part 2', '', NULL, NULL, '方案 A - 云文档')
        """
    )
    conn.commit()
    conn.close()

    processor = BackgroundProcessor(db_path=db_path)
    monkeypatch.setattr(processor, "_get_knowledge_extractor", lambda: _SimilarExtractor(1))
    monkeypatch.setattr(processor, "_process_knowledge_vectorization", _skip_vectorization)
    monkeypatch.setattr("inference_queue.get_global_queue", lambda: _ImmediateQueue())

    ok = asyncio.run(processor._process_capture_group([
        {
            "id": 2,
            "ts": 2000,
            "app_name": "ChatGPT Atlas",
            "window_title": "方案 A - 云文档",
            "ocr_text": "doc a part 2",
            "ax_text": "",
            "url": None,
        }
    ]))

    conn = sqlite3.connect(db_path)
    linked_timeline = conn.execute("SELECT timeline_id FROM captures WHERE id = 2").fetchone()[0]
    timeline_count = conn.execute("SELECT COUNT(*) FROM timelines").fetchone()[0]
    conn.close()

    assert ok is True
    assert linked_timeline != 1
    assert timeline_count == 2


def test_process_knowledge_vectorization_passes_semantic_metadata(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)

    class _StubWorker:
        _model = object()

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


def test_extraction_status_heartbeat_refreshes_updated_at(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    monkeypatch.setenv("HOME", str(tmp_path))

    class _FakeClock:
        ticks = iter([1000.0, 1005.0])

        @staticmethod
        def time():
            return next(_FakeClock.ticks)

    monkeypatch.setattr("background_processor.time", _FakeClock)

    processor = BackgroundProcessor(db_path=db_path)
    status_file = tmp_path / ".memory-bread" / "state" / "extraction_status.json"
    initial = json.loads(status_file.read_text())

    processor._touch_status_file()
    refreshed = json.loads(status_file.read_text())

    assert initial["running"] is True
    assert initial["updated_at_ms"] == 1000000
    assert refreshed["running"] is True
    assert refreshed["updated_at_ms"] == 1005000


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
            return b'{"id":"42","status":"accepted","auto_created_count":3,"candidate_count":1,"discarded_count":0}'

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
    monkeypatch.setattr(processor, "_all_inference_queues_idle", lambda: True)
    monkeypatch.setattr("background_processor.urllib_request.urlopen", _fake_urlopen)

    result = asyncio.run(processor._trigger_unified_bake_pipeline(2))

    assert captured["url"] == "http://127.0.0.1:7070/api/bake/run"
    assert captured["method"] == "POST"
    assert captured["headers"]["content-type"] == "application/json"
    assert captured["body"] == {
        "trigger_reason": "knowledge_background",
        "limit": 20,
        "max_concurrency": 3,
    }
    assert captured["timeout"] == 15
    assert result == {
        "triggered": True,
        "status": "accepted",
        "run_id": "42",
        "auto_created_count": 3,
        "candidate_count": 1,
        "discarded_count": 0,
        "reason": None,
    }


def test_trigger_unified_bake_pipeline_accepts_battery_limits(tmp_path, monkeypatch) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)
    captured = {}

    class _StubResponse:
        def read(self):
            return b'{"id":"43","status":"accepted"}'

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_urlopen(request, timeout=0):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        return _StubResponse()

    monkeypatch.setattr("background_processor.urllib_request.urlopen", _fake_urlopen)
    monkeypatch.setattr(processor, "_all_inference_queues_idle", lambda: True)

    result = asyncio.run(
        processor._trigger_unified_bake_pipeline(
            processed_count=1,
            limit_override=1,
            max_concurrency=1,
        )
    )

    assert captured["body"] == {
        "trigger_reason": "knowledge_background",
        "limit": 1,
        "max_concurrency": 1,
    }
    assert result["triggered"] is True


def test_trigger_unified_bake_pipeline_does_not_treat_skipped_200_as_started(
    tmp_path, monkeypatch
) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)

    class _StubResponse:
        def read(self):
            return b'{"id":null,"status":"skipped","reason":"max 1 concurrent bake runs reached"}'

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(
        "background_processor.urllib_request.urlopen",
        lambda request, timeout=0: _StubResponse(),
    )
    monkeypatch.setattr(processor, "_all_inference_queues_idle", lambda: True)

    result = asyncio.run(
        processor._trigger_unified_bake_pipeline(
            processed_count=1,
            limit_override=1,
            max_concurrency=1,
        )
    )

    assert result["triggered"] is False
    assert result["status"] == "skipped"
    assert result["run_id"] is None


def test_trigger_unified_bake_pipeline_defers_while_inference_is_busy(
    tmp_path, monkeypatch
) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)
    monkeypatch.setattr(processor, "_all_inference_queues_idle", lambda: False)

    result = asyncio.run(
        processor._trigger_unified_bake_pipeline(
            processed_count=1,
            limit_override=1,
            max_concurrency=1,
        )
    )

    assert result == {
        "triggered": False,
        "reason": "inference_busy",
    }


def test_charging_backlog_raises_timeline_batch_limit_without_dropping_items(tmp_path) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)
    profile = type(
        "_Profile",
        (),
        {"mode": "charging", "timeline_batch_size": 20},
    )()

    assert processor._timeline_batch_limit(profile, 20) == 20
    assert processor._timeline_batch_limit(profile, 63) == 63
    assert processor._timeline_batch_limit(profile, 500) == 100


def test_battery_backlog_keeps_rate_limited_batch_size(tmp_path) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)
    profile = type(
        "_Profile",
        (),
        {"mode": "battery", "timeline_batch_size": 4},
    )()

    assert processor._timeline_batch_limit(profile, 500) == 4


def test_battery_idle_check_requires_local_and_model_api_queues_idle(
    tmp_path, monkeypatch
) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)

    class _LocalQueue:
        def __init__(self, idle: bool) -> None:
            self.idle = idle

        def is_idle(self) -> bool:
            return self.idle

    class _StubResponse:
        def __init__(self, idle: bool) -> None:
            self.idle = idle

        def read(self):
            return json.dumps({"status": "ok", "idle": self.idle}).encode()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    local = _LocalQueue(idle=True)
    monkeypatch.setattr("inference_queue.get_global_queue", lambda: local)
    monkeypatch.setattr(
        "background_processor.urllib_request.urlopen",
        lambda request, timeout=0: _StubResponse(idle=True),
    )
    assert processor._all_inference_queues_idle() is True

    monkeypatch.setattr(
        "background_processor.urllib_request.urlopen",
        lambda request, timeout=0: _StubResponse(idle=False),
    )
    assert processor._all_inference_queues_idle() is False

    local.idle = False
    assert processor._all_inference_queues_idle() is False


def test_battery_idle_check_fails_closed_when_model_api_unavailable(
    tmp_path, monkeypatch
) -> None:
    db_path = str(tmp_path / "captures.db")
    _init_db(db_path)
    processor = BackgroundProcessor(db_path=db_path)

    class _LocalQueue:
        @staticmethod
        def is_idle() -> bool:
            return True

    monkeypatch.setattr("inference_queue.get_global_queue", lambda: _LocalQueue())
    monkeypatch.setattr(
        "background_processor.urllib_request.urlopen",
        lambda request, timeout=0: (_ for _ in ()).throw(OSError("offline")),
    )

    assert processor._all_inference_queues_idle() is False


def test_document_url_with_substantive_body_gets_deterministic_metadata() -> None:
    knowledge = {
        "category": "其他",
        "importance": 2,
        "activity_type": None,
        "content_origin": None,
        "evidence_strength": None,
    }
    captures = [{
        "url": "https://docs.corp.kuaishou.com/k/home/space/document-id",
        "ax_text": "文档正文" * 80,
        "ocr_text": "",
    }]

    applied = BackgroundProcessor._apply_document_metadata_defaults(knowledge, captures)

    assert applied is True
    assert knowledge == {
        "category": "文档",
        "importance": 2,
        "activity_type": "reading",
        "content_origin": "document_reference",
        "evidence_strength": "medium",
    }


def test_document_metadata_fallback_requires_substantive_body() -> None:
    knowledge = {"category": "其他", "importance": 2}

    applied = BackgroundProcessor._apply_document_metadata_defaults(
        knowledge,
        [{
            "url": "https://docs.corp.kuaishou.com/k/home/space/document-id",
            "ax_text": "仅有标题",
        }],
    )

    assert applied is False
    assert knowledge == {"category": "其他", "importance": 2}
