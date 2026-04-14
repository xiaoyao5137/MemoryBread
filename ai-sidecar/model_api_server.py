"""
模型管理 API - 提供模型列表、下载、配置等接口
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import BadGateway, ServiceUnavailable
from model_manager import ModelManager, ModelType, AVAILABLE_MODELS as MANAGER_MODELS
from model_registry import AVAILABLE_MODELS, get_recommendations, get_model, list_models as registry_list
import psutil
import logging
import dataclasses
import json
import sqlite3
import time
import fcntl
import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
IPC_PYTHON_DIR = PROJECT_ROOT.parent / "shared" / "ipc-protocol" / "python"
if str(IPC_PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(IPC_PYTHON_DIR))

from background_processor import BackgroundProcessor
from monitor.llm_tracker import estimate_tokens, log_llm_usage
from idle_compute.model_manager import _log_model_event

logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# RAG 查询期间持有此文件锁，阻止知识提炼同时占用 Ollama
_RAG_LOCK_FILE = "/tmp/memory-bread-rag.lock"
_rag_lock_fd = open(_RAG_LOCK_FILE, "w")

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
    active_llm_id = model_manager.config.get('active_llm', 'qwen3.5-4b')
    active_llm = MANAGER_MODELS.get(active_llm_id)
    ollama_model = active_llm.model_id if active_llm else 'qwen3.5:4b'
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
    retrieved_ids = [ctx.get('capture_id') for ctx in contexts if ctx.get('capture_id') is not None]
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
                json.dumps(retrieved_ids, ensure_ascii=False),
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

                    db_path = str(Path.home() / ".memory-bread" / "memory-bread.db")
                    qdrant_path = str(Path.home() / ".qdrant")
                    active_llm_id = model_manager.config.get('active_llm', 'qwen3.5-4b')
                    active_llm = MANAGER_MODELS.get(active_llm_id)
                    ollama_model = active_llm.model_id if active_llm else 'qwen3.5:4b'

                    _log_model_event("load_start", "embedding", "RAG Embedding · BGE-M3-INT8", memory_mb=650)
                    embed_start_ms = int(time.time() * 1000)
                    embedding_model = EmbeddingModel.create_default()
                    _log_model_event(
                        "load_done",
                        "embedding",
                        "RAG Embedding · BGE-M3-INT8",
                        duration_ms=int(time.time() * 1000) - embed_start_ms,
                        memory_mb=650,
                    )
                    _log_model_event("load_start", "llm", f"RAG LLM · {ollama_model}", memory_mb=2500)
                    _rag_pipeline = RagPipeline(
                        embedding_model=embedding_model,
                        vector_retriever=VectorRetriever(
                            collection="memory_bread_captures",
                            qdrant_path=qdrant_path,
                        ),
                        fts5_retriever=Fts5Retriever(db_path=db_path),
                        knowledge_retriever=KnowledgeFts5Retriever(db_path=db_path),
                        llm=OllamaBackend(model=ollama_model, timeout=180, num_predict=1536),
                        top_k=5,
                        db_path=db_path,
                    )
                    _log_model_event("load_done", "llm", f"RAG LLM · {ollama_model}", memory_mb=2500)
                    # 强制预热 embedding，避免首次查询时再加载 BGE 导致超时
                    try:
                        _rag_pipeline._embed.encode(["预热"])
                    except Exception as e:
                        logger.warning(f"Embedding 预热失败: {e}")
                    logger.info(f"RAG pipeline 初始化完成，模型: {ollama_model}")
                except Exception as exc:
                    logger.error("RAG pipeline 初始化失败: %s", exc, exc_info=True)
                    _rag_pipeline = None
                    raise ServiceUnavailable(f"RAG pipeline 初始化失败: {exc}") from exc
    return _rag_pipeline


def _model_to_dict(meta, status_info: dict) -> dict:
    """将 ModelMeta + 状态信息合并为前端所需的 dict"""
    d = dataclasses.asdict(meta)
    d['status']            = status_info.get('status', 'not_installed')
    d['download_progress'] = status_info.get('download_progress', 0)
    d['is_active']         = status_info.get('is_active', False)
    d['recommended']       = status_info.get('recommended', False)
    d['recommend_reason']  = status_info.get('recommend_reason', '')
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
        if runtime.get('qwen2.5-3b', {}).get('status') in ('installed', 'active') and model_manager.config.get('active_llm') not in runtime:
            model_manager.config['active_llm'] = 'qwen2.5-3b'
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
    """返回当前激活的 LLM 和 Embedding 模型"""
    try:
        active_llm_id  = model_manager.config.get('active_llm')
        active_emb_id  = model_manager.config.get('active_embedding')
        runtime        = model_manager.get_all_status()
        if runtime.get('qwen2.5-3b', {}).get('status') in ('installed', 'active') and not active_llm_id:
            active_llm_id = 'qwen2.5-3b'
            model_manager.config['active_llm'] = active_llm_id
            model_manager._save_config()

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
        })
    except Exception as e:
        logger.error(f"获取激活模型失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/<model_id>/status', methods=['GET'])
def model_status(model_id: str):
    """查询单个模型的下载状态（用于前端轮询进度）"""
    try:
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
        ok, msg = model_manager.validate_api_key(model_id)
        return jsonify({'status': 'ok' if ok else 'error', 'valid': ok, 'message': msg})
    except Exception as e:
        return jsonify({'status': 'error', 'valid': False, 'message': str(e)}), 500


@app.route('/api/models/<model_id>/download', methods=['POST'])
def download_model(model_id: str):
    try:
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
        success = model_manager.activate_model(model_id)
        if success:
            with _rag_pipeline_lock:
                _rag_pipeline = None
            return jsonify({'status': 'ok', 'message': f'模型 {model_id} 已激活'})
        return jsonify({'status': 'error', 'message': f'模型 {model_id} 激活失败'}), 500
    except Exception as e:
        logger.error(f"激活模型失败: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/models/<model_id>/delete', methods=['DELETE'])
def delete_model(model_id: str):
    try:
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

        pipeline = get_rag_pipeline()
        # 持有 RAG 锁，阻止知识提炼同时占用 Ollama
        fcntl.flock(_rag_lock_fd, fcntl.LOCK_EX)
        try:
            result = pipeline.query(query, top_k=top_k)
        finally:
            fcntl.flock(_rag_lock_fd, fcntl.LOCK_UN)

        contexts = [
            {
                'capture_id': chunk.capture_id,
                'doc_key': chunk.doc_key,
                'text': chunk.text,
                'score': chunk.score,
                'source': chunk.metadata.get('source_type') or chunk.source,
                'source_type': chunk.metadata.get('source_type') or chunk.source,
                'knowledge_id': chunk.metadata.get('knowledge_id'),
                'app_name': chunk.metadata.get('app_name'),
                'win_title': chunk.metadata.get('win_title'),
                'time': chunk.metadata.get('time') or chunk.metadata.get('ts') or chunk.metadata.get('end_time') or chunk.metadata.get('start_time'),
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
            log_llm_usage(
                caller='rag',
                model_name='qwen2.5:3b',
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
    """触发一次真实 knowledge 提炼。"""
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
        result = asyncio.run(
            processor.run_once(
                limit_override=limit,
                force_finalize_tail=force_finalize_tail,
            )
        )

        processed_count = int(result.get('processed_count', 0))
        fetched_count = int(result.get('fetched_count', 0))
        remaining_estimate = int(result.get('remaining_estimate', 0))
        reason = result.get('reason')

        if processed_count > 0:
            message = f'知识提炼完成，本轮处理 {processed_count} 个片段'
        elif fetched_count == 0:
            message = '当前没有待提炼的采集记录'
        elif reason == 'force_finalize_tail':
            message = '已强制收尾最后一组，但本轮未生成新知识'
        else:
            message = '已触发知识提炼，本轮暂无可完成的片段'

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
        logger.error(f"知识提炼触发失败: {e}", exc_info=True)
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
        if not candidate.get('source_knowledge_id'):
            return jsonify({'error': 'candidate.source_knowledge_id 缺失'}), 400

        source_knowledge_id = candidate.get('source_knowledge_id')
        logger.info(
            "bake extract request start source_knowledge_id=%s trigger_reason=%s",
            source_knowledge_id,
            trigger_reason,
        )
        extractor = get_bake_extractor()
        fcntl.flock(_rag_lock_fd, fcntl.LOCK_EX)
        lock_wait_ms = int(time.time() * 1000) - lock_wait_start_ms
        logger.info(
            "bake extract lock acquired source_knowledge_id=%s lock_wait_ms=%s",
            source_knowledge_id,
            lock_wait_ms,
        )
        try:
            result = extractor.extract_bake_bundle(candidate)
        finally:
            fcntl.flock(_rag_lock_fd, fcntl.LOCK_UN)
            logger.info("bake extract lock released source_knowledge_id=%s", source_knowledge_id)

        result['trigger_reason'] = trigger_reason
        result['latency_ms'] = int(time.time() * 1000) - start_ms
        result['lock_wait_ms'] = lock_wait_ms
        logger.info(
            "bake extract request done source_knowledge_id=%s latency_ms=%s total_elapsed_ms=%s stage_elapsed_ms=%s degraded=%s",
            source_knowledge_id,
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
    # 启动时同步预热 RAG pipeline，避免首个查询遭遇 embedding 冷启动超时
    try:
        get_rag_pipeline()
        logger.info('RAG pipeline 预热完成')
    except Exception as e:
        logger.warning(f'RAG pipeline 预热失败: {e}')
    app.run(host='0.0.0.0', port=7071, debug=False, threaded=True)

