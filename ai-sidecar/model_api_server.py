"""
模型管理 API - 提供模型列表、下载、配置等接口
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import BadGateway, ServiceUnavailable
from model_manager import ModelManager, ModelType, AVAILABLE_MODELS as MANAGER_MODELS, MODEL_ID_ALIASES
from model_registry import AVAILABLE_MODELS, get_recommendations, get_model, list_models as registry_list
import psutil
import logging
import dataclasses
import json
import sqlite3
import time
import fcntl
import asyncio
import concurrent.futures
import sys
import threading
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
IPC_PYTHON_DIR = PROJECT_ROOT.parent / "shared" / "ipc-protocol" / "python"
if str(IPC_PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(IPC_PYTHON_DIR))

from background_processor import BackgroundProcessor
from inference_queue import (
    LANE_P0_QUERY,
    LANE_P1_PREEXTRACT,
    LANE_P2_BAKE,
    Priority,
    QueueEvictedError,
    configure_global_queue,
    get_global_queue,
)
from monitor.llm_tracker import estimate_tokens, log_llm_usage
from idle_compute.model_manager import _log_model_event

logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# RAG 查询期间持有此文件锁，阻止时间线提炼同时占用 Ollama
_RAG_LOCK_FILE = "/tmp/memory-bread-rag.lock"
_RAG_LOCK_OWNER_FILE = "/tmp/memory-bread-rag-owner.txt"
_PREEMPT_SIGNAL_FILE = "/tmp/memory-bread-preempt.signal"


def _write_lock_owner(owner: str):
    """记录当前锁持有者（query/extract）"""
    try:
        with open(_RAG_LOCK_OWNER_FILE, "w") as f:
            f.write(owner)
    except Exception:
        pass


def _read_lock_owner() -> str:
    """读取当前锁持有者"""
    try:
        with open(_RAG_LOCK_OWNER_FILE, "r") as f:
            return f.read().strip()
    except Exception:
        return ""


def _send_preempt_signal():
    """发送抢占信号，通知提炼任务释放锁"""
    try:
        with open(_PREEMPT_SIGNAL_FILE, "w") as f:
            f.write(str(time.time()))
    except Exception:
        pass


def _clear_preempt_signal():
    """清除抢占信号"""
    try:
        import os
        if os.path.exists(_PREEMPT_SIGNAL_FILE):
            os.remove(_PREEMPT_SIGNAL_FILE)
    except Exception:
        pass


def _check_preempt_signal() -> bool:
    """检查是否收到抢占信号"""
    import os
    return os.path.exists(_PREEMPT_SIGNAL_FILE)


def _rag_acquire_lock(timeout_sec=3.0, owner="query", can_preempt=True):
    """返回一个已持有独占锁的文件对象，调用方负责 unlock + close。

    Args:
        timeout_sec: 获取锁的超时时间（秒），超时抛出 TimeoutError
        owner: 锁持有者标识（query/extract）
        can_preempt: 是否可以抢占提炼任务

    Raises:
        TimeoutError: 在指定时间内未能获取锁
    """
    import time
    fd = open(_RAG_LOCK_FILE, "w")
    deadline = time.time() + timeout_sec
    preempt_sent = False

    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            _write_lock_owner(owner)
            _clear_preempt_signal()
            return fd
        except (IOError, OSError) as e:
            # 查询任务可以抢占提炼任务
            if can_preempt and not preempt_sent:
                current_owner = _read_lock_owner()
                if current_owner == "extract":
                    logger.info(f"{owner} 检测到提炼任务占用锁，发送抢占信号")
                    _send_preempt_signal()
                    preempt_sent = True

            if time.time() >= deadline:
                fd.close()
                raise TimeoutError(f"获取 RAG 锁超时（{timeout_sec}s）") from e
            time.sleep(0.05)


def _rag_release_lock(fd):
    """释放并关闭 _rag_acquire_lock 返回的文件对象。"""
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        fd.close()

# 初始化模型管理器
model_manager = ModelManager()
_rag_pipeline = None
_rag_pipeline_lock = __import__('threading').Lock()
_bake_extractor = None
_bake_extractor_lock = __import__('threading').Lock()
DB_PATH = str(Path.home() / ".memory-bread" / "memory-bread.db")


def _read_user_identity() -> str:
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT value FROM user_preferences WHERE key = 'user.identity_keywords' LIMIT 1"
        )
        row = cursor.fetchone()
        conn.close()
        return (row[0] or "").strip() if row else ""
    except Exception as exc:
        logger.warning("读取用户身份偏好失败: %s", exc)
        return ""


def get_bake_extractor():
    global _bake_extractor
    identity = _read_user_identity()
    # 使用全局统一的 Ollama 模型名，避免与 RAG 查询使用不同模型导致 Ollama swap
    from model_registry_global import get_active_ollama_model
    ollama_model = get_active_ollama_model()
    cached_identity = getattr(get_bake_extractor, '_cached_identity', None)
    cached_model = getattr(get_bake_extractor, '_cached_model', None)

    if _bake_extractor is None or cached_identity != identity or cached_model != ollama_model:
        with _bake_extractor_lock:
            cached_identity = getattr(get_bake_extractor, '_cached_identity', None)
            cached_model = getattr(get_bake_extractor, '_cached_model', None)
            if _bake_extractor is None or cached_identity != identity or cached_model != ollama_model:
                from knowledge.extractor_v2 import KnowledgeExtractorV2
                logger.info("初始化 Bake Extractor，model=%s identity=%r", ollama_model, identity)
                _bake_extractor = KnowledgeExtractorV2(
                    model=ollama_model,
                    user_identity=identity,
                )
                get_bake_extractor._cached_identity = identity
                get_bake_extractor._cached_model = ollama_model
    return _bake_extractor


def _save_rag_session(query: str, prompt_used: str, answer: str, contexts: list[dict], latency_ms: int) -> int | None:
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO rag_sessions
               (ts, scene_type, user_query, retrieved_ids, prompt_used, llm_response, latency_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                int(time.time() * 1000),
                'monitor',
                query,
                json.dumps(contexts, ensure_ascii=False),
                prompt_used,
                answer,
                latency_ms,
            ),
        )
        session_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return session_id
    except Exception as exc:
        logger.warning("RAG 会话落库失败: %s", exc)
        return None


@app.route('/api/rag/history', methods=['GET'])
def rag_history():
    """读取最近的咨询记录，供咨询页回看历史问答。"""
    try:
        try:
            limit = int(request.args.get('limit', 20))
        except (TypeError, ValueError):
            limit = 20
        limit = max(1, min(limit, 100))

        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """SELECT id, ts, user_query, retrieved_ids, llm_response, latency_ms
               FROM rag_sessions
               ORDER BY ts DESC
               LIMIT ?""",
            (limit,),
        )
        rows = cursor.fetchall()
        conn.close()

        items = []
        for row in rows:
            raw_contexts = []
            try:
                raw_contexts = json.loads(row['retrieved_ids'] or '[]')
            except Exception:
                raw_contexts = []
            contexts = []
            for item in raw_contexts:
                if isinstance(item, dict):
                    contexts.append(item)
                elif item is not None:
                    contexts.append({
                        'capture_id': item,
                        'text': f'历史咨询关联的采集记录 #{item}',
                        'score': 0,
                        'source': 'capture',
                        'source_type': 'capture',
                    })
            items.append({
                'id': row['id'],
                'ts': row['ts'],
                'query': row['user_query'] or '',
                'answer': row['llm_response'] or '',
                'contexts': contexts,
                'context_count': len(contexts),
                'latency_ms': row['latency_ms'],
            })

        return jsonify({'items': items})
    except Exception as e:
        logger.error(f"读取 RAG 咨询记录失败: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


def get_rag_pipeline():
    """懒加载 RAG pipeline，共用 7071 服务暴露 /query。线程安全。"""
    global _rag_pipeline
    if _rag_pipeline is None:
        with _rag_pipeline_lock:
            if _rag_pipeline is None:
                logger.info("初始化 RAG pipeline...")
                try:
                    from embedding.model import EmbeddingModel
                    from rag.retriever import VectorRetriever, KnowledgeFts5Retriever, Fts5Retriever
                    from rag.llm.ollama import OllamaBackend
                    from rag.pipeline import RagPipeline
                    from model_registry_global import (
                        get_shared_embedding, get_active_ollama_model,
                        should_proceed_with_model_load, set_active_ollama_model,
                    )

                    db_path = str(Path.home() / ".memory-bread" / "memory-bread.db")
                    qdrant_path = str(Path.home() / ".qdrant")

                    # 通过全局单例获取 Ollama 模型名，确保与时间线提炼使用同一模型
                    ollama_model = get_active_ollama_model()

                    # 内存门禁：LLM 预计占用 ~2.5GB，检查是否足够
                    if not should_proceed_with_model_load(estimated_mb=2500):
                        raise ServiceUnavailable(
                            "内存不足，无法启动 RAG 服务。请关闭其他应用后重试。"
                        )

                    _log_model_event("load_start", "embedding", "RAG Embedding · Shared", memory_mb=650)
                    embed_start_ms = int(time.time() * 1000)
                    # 使用全局共享 EmbeddingModel，避免与 BackgroundProcessor 重复加载
                    embedding_model = get_shared_embedding()

                    # 验证向量模型是否可用
                    if not embedding_model or not hasattr(embedding_model, 'encode'):
                        raise RuntimeError("向量模型初始化失败，无法启动 RAG 服务")

                    _log_model_event(
                        "load_done",
                        "embedding",
                        "RAG Embedding · Shared",
                        duration_ms=int(time.time() * 1000) - embed_start_ms,
                        memory_mb=650,
                    )
                    _log_model_event("load_start", "llm", f"RAG LLM · {ollama_model}", memory_mb=2500)
                    pipeline = RagPipeline(
                        embedding_model=embedding_model,
                        vector_retriever=VectorRetriever(
                            collection="memory_bread_captures",
                            qdrant_path=qdrant_path,
                        ),
                        fts5_retriever=Fts5Retriever(db_path=db_path),
                        knowledge_retriever=KnowledgeFts5Retriever(db_path=db_path),
                        llm=OllamaBackend(model=ollama_model, timeout=360, num_predict=1536),
                        top_k=5,
                        db_path=db_path,
                    )
                    _log_model_event("load_done", "llm", f"RAG LLM · {ollama_model}", memory_mb=2500)
                    # 强制预热 embedding，避免首次查询时再加载 BGE 导致超时
                    try:
                        test_result = pipeline._embed.encode(["预热"])
                        if not test_result or len(test_result) == 0:
                            raise RuntimeError("向量模型预热失败，返回空结果")
                        logger.info("✅ 向量模型预热成功")
                    except Exception as e:
                        logger.error(f"❌ 向量模型预热失败: {e}")
                        raise RuntimeError(f"向量模型不可用: {e}") from e
                    # 预热完成后才设置全局变量，确保查询不会在模型加载期间进入
                    _rag_pipeline = pipeline
                    logger.info(f"RAG pipeline 初始化完成，模型: {ollama_model}")
                except Exception as exc:
                    logger.error("RAG pipeline 初始化失败: %s", exc, exc_info=True)
                    _rag_pipeline = None
                    raise ServiceUnavailable(f"RAG pipeline 初始化失败: {exc}") from exc
    return _rag_pipeline


def _build_rag_llm_override(data: dict):
    """根据创作模型配置构造 RAG 本次查询使用的 LLM。"""
    model = (data.get('creation_model') or '').strip()
    api_key = (data.get('creation_api_key') or '').strip()
    base_url = (data.get('creation_base_url') or '').strip()
    if not model:
        return None

    # 有 API Key 的模型按创作页云端模型处理；没有 API Key 的 qwen3.5:4b 等本地模型走 Ollama。
    if api_key:
        from rag.llm.cloud import CloudChatBackend
        return CloudChatBackend(model=model, api_key=api_key, base_url=base_url, timeout=360)

    from rag.llm.ollama import OllamaBackend
    return OllamaBackend(model=model, timeout=360, num_predict=1536)


def _model_to_dict(meta, status_info: dict) -> dict:
    """将 ModelMeta + 状态信息合并为前端所需的 dict"""
    d = dataclasses.asdict(meta)
    status = status_info.get('status', 'not_installed')

    # 特殊处理：本地模型需要检查 RAG pipeline 是否就绪
    # 仅当模型已安装（active/installed）但 RAG pipeline 未就绪时，才显示 loading
    # not_installed 时保留原状态，以便前端显示"下载"按钮
    if status_info.get('is_active') and meta.provider == 'ollama':
        if meta.category in ('llm', 'embedding') and _rag_pipeline is None:
            if status in ('active', 'installed'):
                status = 'loading'

    d['status']            = status
    d['download_progress'] = status_info.get('download_progress', 0)
    d['is_active']         = status_info.get('is_active', False)
    d['recommended']       = status_info.get('recommended', False)
    d['recommend_reason']  = status_info.get('recommend_reason', '')
    if 'error' in status_info:
        d['error'] = status_info['error']
    return d


@app.route('/health', methods=['GET'])
def health():
    """7071 统一健康检查：模型管理 API 与 RAG /query 共用此服务。"""
    try:
        pipeline_ready = _rag_pipeline is not None
        return jsonify({
            'status': 'ok',
            'service': 'model_api_rag',
            'pipeline_ready': pipeline_ready,
            'active_llm': model_manager.config.get('active_llm'),
            'active_embedding': model_manager.config.get('active_embedding'),
            'active_image': model_manager.config.get('active_image'),
        })
    except Exception as e:
        logger.error(f"健康检查失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models', methods=['GET'])
def list_models():
    """
    获取所有可用模型列表（整合 registry + 运行时状态）

    Query Parameters:
        category: 筛选类型（llm/embedding/ocr/asr/vlm）
    """
    try:
        category = request.args.get('category')
        metas = registry_list(category)

        # 获取运行时状态
        runtime = model_manager.get_all_status()
        active_llm = MODEL_ID_ALIASES.get(model_manager.config.get('active_llm'), model_manager.config.get('active_llm'))
        if active_llm != model_manager.config.get('active_llm'):
            model_manager.config['active_llm'] = active_llm
            model_manager._save_config()
            runtime = model_manager.get_all_status()
        # 获取推荐列表
        hw = _get_hardware()
        rec = get_recommendations(
            memory_gb=hw['memory_gb'],
            cpu_cores=hw['cpu_cores'],
            disk_free_gb=hw['disk_free_gb'],
            has_gpu=hw['has_gpu'],
        )
        recommended_ids = set(rec['recommended_ids'])

        result = []
        for meta in metas:
            status_info = runtime.get(meta.id, {})
            status_info['recommended'] = meta.id in recommended_ids
            status_info['recommend_reason'] = rec['reason'] if meta.id in recommended_ids else ''
            result.append(_model_to_dict(meta, status_info))

        # 添加 Ollama 推理引擎状态
        ollama_status = model_manager.get_ollama_setup_status()
        result.append({
            'id': 'ollama',
            'name': 'Ollama',
            'category': 'inference_engine',
            'provider': 'ollama',
            'status': 'active' if ollama_status['ollama_running'] else 'not_installed' if not ollama_status['ollama_installed'] else 'installed',
            'is_active': ollama_status['ollama_running'],
            'download_progress': 100 if ollama_status['ollama_installed'] else 0,
            'recommended': True,
            'recommend_reason': 'Ollama 是本地推理引擎，必须运行才能使用 LLM 模型',
            'version': ollama_status.get('ollama_version'),
            'can_upgrade': ollama_status['ollama_installed'] and ollama_status['brew_available'],
        })

        return jsonify({'status': 'ok', 'models': result})
    except Exception as e:
        logger.error(f"获取模型列表失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/hardware', methods=['GET'])
def get_hardware():
    """检测本机硬件配置并返回选型建议"""
    try:
        hw = _get_hardware()
        rec = get_recommendations(
            memory_gb=hw['memory_gb'],
            cpu_cores=hw['cpu_cores'],
            disk_free_gb=hw['disk_free_gb'],
            has_gpu=hw['has_gpu'],
            gpu_memory_gb=hw.get('gpu_memory_gb', 0.0),
        )
        return jsonify({'status': 'ok', 'hardware': hw, 'recommendation': rec})
    except Exception as e:
        logger.error(f"硬件检测失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/active', methods=['GET'])
def get_active_models():
    """返回当前激活的 LLM、Embedding 和 Image 模型"""
    try:
        active_llm_id  = MODEL_ID_ALIASES.get(model_manager.config.get('active_llm'), model_manager.config.get('active_llm'))
        active_emb_id  = model_manager.config.get('active_embedding')
        active_image_id = model_manager.config.get('active_image')
        runtime        = model_manager.get_all_status()
        def _build(model_id):
            if not model_id:
                return None
            meta = get_model(model_id)
            if not meta:
                return None
            return _model_to_dict(meta, runtime.get(model_id, {'status': 'installed', 'is_active': True}))

        return jsonify({
            'status': 'ok',
            'llm':       _build(active_llm_id),
            'embedding': _build(active_emb_id),
            'image':     _build(active_image_id),
        })
    except Exception as e:
        logger.error(f"获取激活模型失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/<model_id>/status', methods=['GET'])
def model_status(model_id: str):
    """查询单个模型的下载状态（用于前端轮询进度）"""
    try:
        model_id = MODEL_ID_ALIASES.get(model_id, model_id)
        runtime = model_manager.get_all_status()
        info = runtime.get(model_id, {'status': 'not_installed', 'download_progress': 0})
        return jsonify({'status': 'ok', 'model_id': model_id, **info})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/<model_id>/configure', methods=['POST'])
def configure_model(model_id: str):
    """
    保存模型的 API Key 及其他配置字段

    Body: { "fields": { "api_key": "sk-...", "base_url": "..." } }
    """
    try:
        model_id = MODEL_ID_ALIASES.get(model_id, model_id)
        data   = request.json or {}
        fields = data.get('fields', {})
        meta   = get_model(model_id)
        if not meta:
            return jsonify({'status': 'error', 'message': f'未知模型 {model_id}'}), 404

        # 保存各字段
        for field_def in (meta.api_key_fields or []):
            if field_def.key in fields:
                model_manager.set_config_field(model_id, field_def.key, fields[field_def.key])

        return jsonify({'status': 'ok', 'message': f'{model_id} 配置已保存'})
    except Exception as e:
        logger.error(f"配置模型失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/<model_id>/validate', methods=['POST'])
def validate_model(model_id: str):
    """验证 API Key 是否有效（发送测试请求）"""
    try:
        model_id = MODEL_ID_ALIASES.get(model_id, model_id)
        ok, msg = model_manager.validate_api_key(model_id)
        return jsonify({'status': 'ok' if ok else 'error', 'valid': ok, 'message': msg})
    except Exception as e:
        return jsonify({'status': 'error', 'valid': False, 'message': str(e)}), 500


@app.route('/api/models/<model_id>/download', methods=['POST'])
def download_model(model_id: str):
    try:
        model_id = MODEL_ID_ALIASES.get(model_id, model_id)
        result = model_manager.download_model(model_id)
        status = result.get('status', 'error') if isinstance(result, dict) else ('ok' if result else 'error')
        if status in ('ok', 'downloading', 'pending'):
            return jsonify({'status': 'ok', 'message': result.get('message', f'模型 {model_id} 下载已启动') if isinstance(result, dict) else f'模型 {model_id} 下载已启动'})
        return jsonify({'status': 'error', 'message': result.get('message', f'模型 {model_id} 下载失败') if isinstance(result, dict) else f'模型 {model_id} 下载失败'}), 500
    except Exception as e:
        logger.error(f"下载模型失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/<model_id>/activate', methods=['POST'])
def activate_model(model_id: str):
    global _rag_pipeline
    try:
        model_id = MODEL_ID_ALIASES.get(model_id, model_id)
        success = model_manager.activate_model(model_id)
        if success:
            # 同步更新全局 Ollama 模型名，确保后续所有调用使用新模型
            active_llm = MANAGER_MODELS.get(model_id)
            if active_llm and active_llm.provider == 'ollama':
                from model_registry_global import set_active_ollama_model, reset_shared_embedding
                set_active_ollama_model(active_llm.model_id)
                # 切换模型时重置共享 Embedding（embedding 模型切换时才需要）
                if active_llm.type.value == 'embedding':
                    reset_shared_embedding()

            with _rag_pipeline_lock:
                _rag_pipeline = None
            # 后台初始化 RAG pipeline
            def init_pipeline():
                try:
                    get_rag_pipeline()
                except Exception as e:
                    logger.warning(f"RAG pipeline 初始化失败: {e}")
            threading.Thread(target=init_pipeline, daemon=True).start()
            return jsonify({'status': 'ok', 'message': f'模型 {model_id} 已激活'})
        return jsonify({'status': 'error', 'message': f'模型 {model_id} 激活失败'}), 500
    except Exception as e:
        logger.error(f"激活模型失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/<model_id>/delete', methods=['DELETE'])
def delete_model(model_id: str):
    try:
        model_id = MODEL_ID_ALIASES.get(model_id, model_id)
        success = model_manager.delete_model(model_id)
        if success:
            return jsonify({'status': 'ok', 'message': f'模型 {model_id} 已删除'})
        return jsonify({'status': 'error', 'message': f'模型 {model_id} 删除失败'}), 500
    except Exception as e:
        logger.error(f"删除模型失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/config', methods=['GET'])
def get_config():
    try:
        return jsonify({'status': 'ok', 'config': model_manager.config})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/llm-concurrency', methods=['GET'])
def get_llm_concurrency():
    try:
        configured = int(model_manager.config.get('llm_max_concurrency', 1) or 1)
        configured = max(1, min(3, configured))
        stats = get_global_queue().stats()
        return jsonify({
            'status': 'ok',
            'max_concurrency': configured,
            'max_allowed': 3,
            'stats': stats,
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/llm-concurrency', methods=['POST'])
def update_llm_concurrency():
    try:
        data = request.get_json(silent=True) or {}
        raw_value = data.get('max_concurrency')
        try:
            max_concurrency = int(raw_value)
        except (TypeError, ValueError):
            return jsonify({'status': 'error', 'message': 'max_concurrency 必须是 1 到 3 的整数'}), 400
        if max_concurrency < 1 or max_concurrency > 3:
            return jsonify({'status': 'error', 'message': 'max_concurrency 必须在 1 到 3 之间'}), 400

        model_manager.config['llm_max_concurrency'] = max_concurrency
        model_manager._save_config()
        stats = configure_global_queue(max_concurrency)
        return jsonify({
            'status': 'ok',
            'max_concurrency': max_concurrency,
            'max_allowed': 3,
            'stats': stats,
        })
    except Exception as e:
        logger.error("更新 LLM 并发配置失败: %s", e, exc_info=True)
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/config/api-key', methods=['POST'])
def set_api_key():
    try:
        data     = request.json or {}
        provider = data.get('provider')
        api_key  = data.get('api_key')
        if not provider or not api_key:
            return jsonify({'status': 'error', 'message': '缺少 provider 或 api_key'}), 400
        model_manager.set_api_key(provider, api_key)
        return jsonify({'status': 'ok', 'message': f'{provider} API Key 已设置'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/ollama/setup-status', methods=['GET'])
def ollama_setup_status():
    try:
        detail = model_manager.get_ollama_setup_status()
        return jsonify({'status': 'ok', 'stage': 'detect', 'detail': detail, 'message': detail.get('message', '')})
    except Exception as e:
        logger.error(f"获取 Ollama 安装状态失败: {e}")
        return jsonify({'status': 'error', 'stage': 'detect', 'message': str(e)}), 500


@app.route('/api/ollama/install', methods=['POST'])
def ollama_install():
    try:
        result = model_manager.install_ollama_auto()
        code = 200 if result.get('status') == 'ok' else 400
        return jsonify(result), code
    except Exception as e:
        logger.error(f"自动安装 Ollama 失败: {e}", exc_info=True)
        return jsonify({'status': 'error', 'stage': 'install', 'message': str(e)}), 500


@app.route('/api/ollama/start', methods=['POST'])
def ollama_start():
    try:
        result = model_manager.start_ollama_service()
        code = 200 if result.get('status') == 'ok' else 400
        return jsonify(result), code
    except Exception as e:
        logger.error(f"启动 Ollama 服务失败: {e}", exc_info=True)
        return jsonify({'status': 'error', 'stage': 'start', 'message': str(e)}), 500


@app.route('/api/ollama/upgrade', methods=['POST'])
def ollama_upgrade():
    """启动 Ollama 升级任务"""
    try:
        result = model_manager.upgrade_ollama()
        return jsonify(result), 200
    except Exception as e:
        logger.error(f"升级 Ollama 失败: {e}", exc_info=True)
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/ollama/upgrade/status', methods=['GET'])
def ollama_upgrade_status():
    """获取 Ollama 升级状态"""
    try:
        status = model_manager.get_upgrade_status()
        return jsonify(status), 200
    except Exception as e:
        logger.error(f"获取升级状态失败: {e}", exc_info=True)
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/<model_id>/chat', methods=['POST'])
def model_chat(model_id: str):
    """模型体验对话接口 - 流式返回模型回复。
    
    支持 Ollama 本地模型和商业 API 模型。
    Body: { "messages": [{"role": "user", "content": "..."}] }
    """
    try:
        model_id = MODEL_ID_ALIASES.get(model_id, model_id)
        data = request.get_json(silent=True) or {}
        messages = data.get('messages', [])
        if not messages:
            return jsonify({'status': 'error', 'message': '缺少 messages 参数'}), 400

        meta = get_model(model_id)
        if not meta:
            return jsonify({'status': 'error', 'message': f'未知模型 {model_id}'}), 404

        if meta.category != 'llm':
            return jsonify({'status': 'error', 'message': f'模型 {model_id} 不是对话模型'}), 400

        provider = meta.provider
        cfg = model_manager.config.get('model_configs', {}).get(model_id, {})

        # ── Ollama 本地模型 ──────────────────────────────────────────────────
        if provider == 'ollama':
            ollama_model_id = None
            # 从 MANAGER_MODELS 获取 Ollama model_id
            if model_id in MANAGER_MODELS:
                ollama_model_id = MANAGER_MODELS[model_id].model_id
            else:
                # 回退：直接使用 model_id 转换
                names = model_manager._ollama_names_for_model(model_id)
                ollama_model_id = names[0] if names else model_id

            payload = {
                'model': ollama_model_id,
                'messages': messages,
                'stream': True,
                'options': {'temperature': 0.7, 'num_predict': 2048},
            }

            def generate_ollama():
                import http.client
                conn = http.client.HTTPConnection('localhost', 11434, timeout=120)
                conn.request('POST', '/api/chat', body=json.dumps(payload), headers={'Content-Type': 'application/json'})
                resp = conn.getresponse()
                if resp.status != 200:
                    yield f"data: {json.dumps({'error': f'Ollama 返回 {resp.status}'})}\n\n"
                    conn.close()
                    return
                while True:
                    line = resp.readline()
                    if not line:
                        break
                    line_str = line.decode('utf-8').strip()
                    if not line_str:
                        continue
                    try:
                        chunk = json.loads(line_str)
                        content = chunk.get('message', {}).get('content', '')
                        done = chunk.get('done', False)
                        if content:
                            yield f"data: {json.dumps({'content': content})}\n\n"
                        if done:
                            yield f"data: {json.dumps({'done': True})}\n\n"
                            break
                    except json.JSONDecodeError:
                        continue
                conn.close()

            return app.response_class(generate_ollama(), mimetype='text/event-stream')

        # ── OpenAI 系列（含兼容接口的提供商）──────────────────────────────────
        openai_compatible_providers = {
            'openai':       {'default_base': 'https://api.openai.com/v1', 'model_key': None},
            'deepseek':     {'default_base': 'https://api.deepseek.com/v1', 'model_key': None},
            'tongyi':       {'default_base': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'model_key': None},
            'doubao':       {'default_base': 'https://ark.cn-beijing.volces.com/api/v3', 'model_key': 'endpoint_id'},
            'kimi':         {'default_base': 'https://api.moonshot.cn/v1', 'model_key': None},
        }

        if provider in openai_compatible_providers:
            provider_info = openai_compatible_providers[provider]
            api_key = cfg.get('api_key') or model_manager.config.get('api_keys', {}).get(provider, '')
            if not api_key:
                return jsonify({'status': 'error', 'message': f'{provider} API Key 未配置'}), 400

            base_url = cfg.get('base_url', provider_info['default_base'])

            # 确定 model_name
            model_name = meta.id
            # OpenAI 特殊模型名映射
            if provider == 'openai':
                model_name_map = {'gpt-5.5': 'gpt-4.5-preview', 'gpt-4o': 'gpt-4o', 'gpt-4o-mini': 'gpt-4o-mini'}
                model_name = model_name_map.get(meta.id, meta.id)
            elif provider == 'deepseek':
                model_name_map = {'deepseek-chat': 'deepseek-chat', 'deepseek-reasoner': 'deepseek-reasoner'}
                model_name = model_name_map.get(meta.id, meta.id)
            elif provider == 'tongyi':
                model_name_map = {'qwen-plus': 'qwen-plus', 'qwen-max': 'qwen-max'}
                model_name = model_name_map.get(meta.id, meta.id)
            elif provider == 'doubao':
                endpoint_id = cfg.get('endpoint_id') or model_manager.config.get('model_configs', {}).get(model_id, {}).get('endpoint_id', '')
                model_name = endpoint_id
            elif provider == 'kimi':
                model_name_map = {'kimi-2.5': 'moonshot-v1-auto'}
                model_name = model_name_map.get(meta.id, meta.id)

            def generate_openai():
                req_payload = {
                    'model': model_name,
                    'messages': messages,
                    'stream': True,
                    'max_tokens': 2048,
                }
                req_data = json.dumps(req_payload).encode('utf-8')
                req = urllib.request.Request(
                    f"{base_url}/chat/completions",
                    data=req_data,
                    headers={
                        'Authorization': f'Bearer {api_key}',
                        'Content-Type': 'application/json',
                    },
                    method='POST',
                )
                try:
                    resp = urllib.request.urlopen(req, timeout=120)
                except Exception as e:
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"
                    return

                for line in resp:
                    line_str = line.decode('utf-8').strip()
                    if not line_str:
                        continue
                    if line_str.startswith('data: '):
                        data_str = line_str[6:]
                        if data_str == '[DONE]':
                            yield f"data: {json.dumps({'done': True})}\n\n"
                            break
                        try:
                            chunk = json.loads(data_str)
                            choices = chunk.get('choices', [])
                            if choices:
                                delta = choices[0].get('delta', {}) or choices[0].get('text', '')
                                content = delta.get('content', '') if isinstance(delta, dict) else delta
                                if content:
                                    yield f"data: {json.dumps({'content': content})}\n\n"
                        except json.JSONDecodeError:
                            continue

            return app.response_class(generate_openai(), mimetype='text/event-stream')

        # ── Anthropic ──────────────────────────────────────────────────
        if provider == 'anthropic':
            api_key = cfg.get('api_key') or model_manager.config.get('api_keys', {}).get('anthropic', '')
            if not api_key:
                return jsonify({'status': 'error', 'message': 'Anthropic API Key 未配置'}), 400

            # Claude 模型名映射
            model_name_map = {'claude-4.7-opus': 'claude-opus-4-20250514'}
            model_name = model_name_map.get(meta.id, meta.id)

            def generate_anthropic():
                # Anthropic 不支持流式，直接返回完整响应
                req_payload = {
                    'model': model_name,
                    'max_tokens': 2048,
                    'messages': messages,
                }
                req_data = json.dumps(req_payload).encode('utf-8')
                req = urllib.request.Request(
                    'https://api.anthropic.com/v1/messages',
                    data=req_data,
                    headers={
                        'x-api-key': api_key,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json',
                    },
                    method='POST',
                )
                try:
                    resp = urllib.request.urlopen(req, timeout=120)
                    resp_data = json.loads(resp.read().decode('utf-8'))
                except Exception as e:
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"
                    return

                # 提取回复内容
                content_blocks = resp_data.get('content', [])
                full_text = ''
                for block in content_blocks:
                    if block.get('type') == 'text':
                        full_text += block.get('text', '')

                # 分块流式发送
                chunk_size = 20
                for i in range(0, len(full_text), chunk_size):
                    yield f"data: {json.dumps({'content': full_text[i:i+chunk_size]})}\n\n"
                yield f"data: {json.dumps({'done': True})}\n\n"

            return app.response_class(generate_anthropic(), mimetype='text/event-stream')

        # ── Google Gemini ──────────────────────────────────────────────────
        if provider == 'google':
            api_key = cfg.get('api_key') or model_manager.config.get('api_keys', {}).get('google', '')
            if not api_key:
                return jsonify({'status': 'error', 'message': 'Google API Key 未配置'}), 400

            return jsonify({'status': 'error', 'message': 'Google 模型对话暂未实现'}), 501

        return jsonify({'status': 'error', 'message': f'提供商 {provider} 的对话接口暂未实现'}), 501

    except Exception as e:
        logger.error(f"模型对话失败: {e}", exc_info=True)
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/query', methods=['POST'])
def rag_query():
    """RAG 查询接口，与模型管理 API 共用 7071 端口。"""
    start_ms = int(time.time() * 1000)
    query = None
    top_k = 5
    try:
        data = request.get_json()
        if not data or 'query' not in data:
            return jsonify({'error': '缺少 query 参数'}), 400

        query = data['query']
        top_k = data.get('top_k', 5)
        logger.info(f"收到 RAG 查询: {query}")

        # 内存压力检查
        from model_registry_global import check_memory_pressure
        pressure = check_memory_pressure()
        if pressure == "critical":
            logger.warning("内存压力 Critical，RAG 查询降级处理")
            return jsonify({
                'error': 'MEMORY_PRESSURE',
                'message': '系统内存不足，RAG 查询暂时不可用，请稍后再试'
            }), 503

        # 检查模型是否就绪
        if _rag_pipeline is None:
            return jsonify({
                'error': 'MODEL_NOT_READY',
                'message': '向量模型或推理模型未就绪，请前往「烤箱型号」界面检查模型状态'
            }), 503

        pipeline = _rag_pipeline
        llm_override = _build_rag_llm_override(data)

        # 通过 InferenceQueue 统一调度所有 LLM 推理，P0 = 在线 RAG 查询
        try:
            result = get_global_queue().submit_sync(
                Priority.P0,
                lambda: pipeline.query(query, top_k=top_k, llm=llm_override),
                timeout=420.0,
                lane=LANE_P0_QUERY,
            )
        except QueueEvictedError as ee:
            logger.warning(f"RAG 查询被队列淘汰: {ee}")
            return jsonify({'error': '系统繁忙，请稍候再试'}), 503
        except concurrent.futures.TimeoutError:
            logger.warning("RAG 查询执行超时")
            return jsonify({
                'error': '查询超时',
                'message': '本次咨询生成时间过长，请稍后重试或缩小查询范围'
            }), 504

        contexts = [
            {
                'capture_id': chunk.capture_id,
                'doc_key': chunk.doc_key,
                'text': chunk.text,
                'score': chunk.score,
                'source': chunk.metadata.get('source_type') or chunk.source,
                'source_type': chunk.metadata.get('source_type') or chunk.source,
                'knowledge_id': chunk.metadata.get('knowledge_id'),
                'artifact_id': chunk.metadata.get('artifact_id'),
                'document_id': chunk.metadata.get('document_id'),
                'app_name': chunk.metadata.get('app_name'),
                'win_title': chunk.metadata.get('win_title'),
                'url': chunk.metadata.get('url') or chunk.metadata.get('source_url'),
                'source_url': chunk.metadata.get('source_url') or chunk.metadata.get('url'),
                'title': chunk.metadata.get('title'),
                'doc_type': chunk.metadata.get('doc_type'),
                'time': chunk.metadata.get('time') or chunk.metadata.get('ts') or chunk.metadata.get('end_time') or chunk.metadata.get('start_time'),
                'observed_at': chunk.metadata.get('observed_at'),
                'event_time_start': chunk.metadata.get('event_time_start'),
                'event_time_end': chunk.metadata.get('event_time_end'),
                'start_time': chunk.metadata.get('start_time'),
                'end_time': chunk.metadata.get('end_time'),
                'summary': chunk.metadata.get('summary'),
                'overview': chunk.metadata.get('overview'),
                'category': chunk.metadata.get('category'),
                'activity_type': chunk.metadata.get('activity_type'),
                'content_origin': chunk.metadata.get('content_origin'),
                'history_view': chunk.metadata.get('history_view'),
                'evidence_strength': chunk.metadata.get('evidence_strength'),
                'importance': chunk.metadata.get('importance'),
                'source_timeline_ids': chunk.metadata.get('source_timeline_ids'),
                'linked_knowledge_ids': chunk.metadata.get('linked_knowledge_ids'),
            }
            for chunk in result.contexts
        ]

        prompt_used = pipeline._build_context(result.contexts)
        latency_ms = int(time.time() * 1000) - start_ms
        session_id = _save_rag_session(query, prompt_used, result.answer, contexts, latency_ms)

        completion_tokens = result.tokens or estimate_tokens(result.answer)
        prompt_tokens = estimate_tokens(f"工作记录上下文：\n{prompt_used}\n\n用户问题：{query}")
        log_llm_usage(
            caller='rag',
            model_name=result.model or 'unknown',
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=latency_ms,
            caller_id=str(session_id) if session_id is not None else None,
        )

        return jsonify({
            'answer': result.answer,
            'contexts': contexts,
            'model': result.model,
        })
    except Exception as e:
        latency_ms = int(time.time() * 1000) - start_ms
        error_text = str(e)
        if query:
            from model_registry_global import get_active_ollama_model
            log_llm_usage(
                caller='rag',
                model_name=get_active_ollama_model(),
                prompt_tokens=estimate_tokens(query),
                completion_tokens=0,
                latency_ms=latency_ms,
                status='failed',
                error_msg=error_text,
            )
        logger.error(f"RAG 查询失败: {e}", exc_info=True)

        lowered = error_text.lower()
        if 'ollama' in lowered or 'bad gateway' in lowered:
            return jsonify({'error': error_text}), 502
        if 'service unavailable' in lowered or '初始化失败' in error_text or 'busy' in lowered:
            return jsonify({'error': error_text}), 503
        return jsonify({'error': error_text}), 500


@app.route('/knowledge/extract', methods=['POST'])
def extract_knowledge():
    """触发一次真实时间线提炼。"""
    try:
        data = request.get_json(silent=True) or {}
        limit = data.get('limit')
        force_finalize_tail = bool(data.get('force_finalize_tail', False))

        if limit is not None:
            try:
                limit = int(limit)
            except (TypeError, ValueError):
                return jsonify({'error': 'limit 必须是正整数'}), 400
            if limit <= 0:
                return jsonify({'error': 'limit 必须是正整数'}), 400

        processor = BackgroundProcessor(db_path=DB_PATH, interval=90, batch_size=8)
        # 通过 InferenceQueue 统一调度，P1 = 时间线提炼
        try:
            result = get_global_queue().submit_sync(
                Priority.P1,
                lambda: asyncio.run(
                    processor.run_once(
                        limit_override=limit,
                        force_finalize_tail=force_finalize_tail,
                    )
                ),
                timeout=600.0,
                lane=LANE_P1_PREEXTRACT,
            )
        except QueueEvictedError as ee:
            logger.warning(f"时间线提炼被队列淘汰: {ee}")
            return jsonify({'error': '系统繁忙，请稍候再试'}), 503
        except concurrent.futures.TimeoutError:
            logger.warning("时间线提炼执行超时")
            return jsonify({'error': '提炼超时'}), 504

        processed_count = int(result.get('processed_count', 0))
        fetched_count = int(result.get('fetched_count', 0))
        remaining_estimate = int(result.get('remaining_estimate', 0))
        reason = result.get('reason')

        if processed_count > 0:
            message = f'时间线提炼完成，本轮处理 {processed_count} 个片段'
        elif fetched_count == 0:
            message = '当前没有待提炼的采集记录'
        elif reason == 'force_finalize_tail':
            message = '已强制收尾最后一组，但本轮未生成新知识'
        else:
            message = '已触发时间线提炼，本轮暂无可完成的片段'

        return jsonify({
            'status': 'ok',
            'message': message,
            'fetched_count': fetched_count,
            'processed_count': processed_count,
            'remaining_estimate': remaining_estimate,
            'force_finalize_tail': force_finalize_tail,
            'reason': reason,
        })
    except Exception as e:
        logger.error(f"时间线提炼触发失败: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


@app.route('/bake/extract', methods=['POST'])
def extract_bake():
    """对单条 bake candidate 做分类特异提炼，不直接写业务表。"""
    start_ms = int(time.time() * 1000)
    lock_wait_start_ms = start_ms
    try:
        data = request.get_json(silent=True) or {}
        candidate = data.get('candidate')
        trigger_reason = data.get('trigger_reason') or 'manual_debug'
        if not isinstance(candidate, dict):
            return jsonify({'error': '缺少 candidate 对象'}), 400
        if not candidate.get('source_timeline_id') and candidate.get('source_knowledge_id'):
            candidate['source_timeline_id'] = candidate.get('source_knowledge_id')
        if not candidate.get('source_timeline_id'):
            return jsonify({'error': 'candidate.source_timeline_id 缺失'}), 400

        source_timeline_id = candidate.get('source_timeline_id')
        logger.info(
            "bake extract request start source_timeline_id=%s trigger_reason=%s",
            source_timeline_id,
            trigger_reason,
        )
        extractor = get_bake_extractor()
        # 通过 InferenceQueue 统一调度，P2 = bake 大批量提炼
        try:
            result = get_global_queue().submit_sync(
                Priority.P2,
                lambda: extractor.extract_bake_bundle(candidate, preempt_check=lambda: False),
                timeout=900.0,
                lane=LANE_P2_BAKE,
            )
        except QueueEvictedError as ee:
            logger.warning(f"bake extract 被队列淘汰: {ee}")
            return jsonify({'error': 'AI 正在处理其他任务，请稍候再试'}), 503
        except concurrent.futures.TimeoutError:
            logger.warning("bake extract 执行超时")
            return jsonify({'error': 'bake 提炼超时'}), 504
        lock_wait_ms = int(time.time() * 1000) - lock_wait_start_ms
        logger.info(
            "bake extract done source_timeline_id=%s queue_wait_ms=%s",
            source_timeline_id,
            lock_wait_ms,
        )

        result['trigger_reason'] = trigger_reason
        result['latency_ms'] = int(time.time() * 1000) - start_ms
        result['lock_wait_ms'] = lock_wait_ms
        logger.info(
            "bake extract request done source_timeline_id=%s latency_ms=%s total_elapsed_ms=%s stage_elapsed_ms=%s degraded=%s",
            source_timeline_id,
            result['latency_ms'],
            result.get('total_elapsed_ms'),
            result.get('stage_elapsed_ms'),
            result.get('degraded'),
        )
        return jsonify(result)
    except Exception as e:
        logger.error("bake 提炼失败: %s", e, exc_info=True)
        lowered = str(e).lower()
        if 'ollama' in lowered or 'bad gateway' in lowered:
            return jsonify({'error': str(e)}), 502
        if 'service unavailable' in lowered or 'busy' in lowered:
            return jsonify({'error': str(e)}), 503
        return jsonify({'error': str(e)}), 500


@app.route('/bake/merge_document', methods=['POST'])
def merge_bake_document():
    """将新 capture 合并进已有文档，返回更新后的字段。"""
    try:
        data = request.get_json(silent=True) or {}
        existing_document = data.get('existing_document')
        candidate = data.get('candidate')
        if not isinstance(existing_document, dict) or not isinstance(candidate, dict):
            return jsonify({'error': '缺少 existing_document 或 candidate'}), 400
        if not candidate.get('source_timeline_id'):
            return jsonify({'error': 'candidate.source_timeline_id 缺失'}), 400
        extractor = get_bake_extractor()
        result = get_global_queue().submit_sync(
            Priority.P2,
            lambda: extractor.merge_bake_document(existing_document, candidate),
            timeout=600.0,
            lane=LANE_P2_BAKE,
        )
        return jsonify(result)
    except Exception as e:
        logger.error("bake merge_document 失败: %s", e, exc_info=True)
        return jsonify({'error': str(e)}), 500


# ── 内部工具 ──────────────────────────────────────────────────────────────────

def _get_hardware() -> dict:
    mem   = psutil.virtual_memory()
    disk  = psutil.disk_usage('/')
    cpu   = psutil.cpu_count(logical=False) or psutil.cpu_count()
    hw = {
        'memory_gb':    round(mem.total / (1024 ** 3), 1),
        'cpu_cores':    cpu,
        'disk_free_gb': round(disk.free / (1024 ** 3), 1),
        'has_gpu':      False,
        'gpu_memory_gb': 0.0,
    }
    # 尝试检测 GPU（macOS Metal / NVIDIA）
    try:
        import subprocess
        result = subprocess.run(
            ['system_profiler', 'SPDisplaysDataType'],
            capture_output=True, text=True, timeout=3
        )
        if 'VRAM' in result.stdout or 'Metal' in result.stdout:
            hw['has_gpu'] = True
    except Exception:
        pass
    return hw


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)

    # 异步预热 RAG pipeline，避免阻塞启动
    def _warmup_rag_pipeline_async():
        try:
            get_rag_pipeline()
            logger.info('RAG pipeline 预热完成')
        except Exception as e:
            logger.error(f'RAG pipeline 预热失败: {e}', exc_info=True)

    import threading
    threading.Thread(target=_warmup_rag_pipeline_async, daemon=True, name='rag-warmup').start()
    logger.info('RAG pipeline 异步预热已启动')

    app.run(host='0.0.0.0', port=7071, debug=False, threaded=True)
