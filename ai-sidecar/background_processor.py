"""
后台任务处理器 - 自动处理向量化和知识提炼

定期扫描数据库中未处理的采集记录，执行：
1. 向量化（Embedding）
2. 知识提炼（Knowledge Extraction）
"""

import asyncio
import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Optional

from knowledge.fragment_grouper import FragmentGrouper

logger = logging.getLogger(__name__)

_SELF_GENERATED_APP_KEYWORDS = (
    "memory-bread",
    "记忆面包",
)

_SELF_GENERATED_WINDOW_KEYWORDS = (
    "memory-bread",
    "记忆面包",
    "KnowledgePanel",
    "MonitorPanel",
    "RagPanel",
)


def _is_self_generated_capture(app_name: str | None, window_title: str | None) -> bool:
    app_lower = (app_name or "").lower()
    title_lower = (window_title or "").lower()
    return any(keyword in app_lower for keyword in _SELF_GENERATED_APP_KEYWORDS) or any(
        keyword.lower() in title_lower for keyword in _SELF_GENERATED_WINDOW_KEYWORDS
    )


class BackgroundProcessor:
    """后台任务处理器"""

    def __init__(
        self,
        db_path: str,
        interval: int = 30,  # 扫描间隔（秒）
        batch_size: int = 10,  # 每次处理的记录数
    ):
        self.db_path = db_path
        self.interval = interval
        self.batch_size = batch_size
        self.running = False

        # 懒加载 workers
        self._embed_worker = None
        self._knowledge_extractor = None

    def _get_embed_worker(self):
        """懒加载 EmbedWorker"""
        if self._embed_worker is None:
            from embedding.worker import EmbedWorker
            from embedding.model import EmbeddingModel
            self._embed_worker = EmbedWorker(model=EmbeddingModel.create_default())
            logger.info("EmbedWorker 已初始化（后台任务）")
        return self._embed_worker

    def _read_user_identity(self) -> str:
        """从 user_preferences 表读取用户身份关键词"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT value FROM user_preferences WHERE key = 'user.identity_keywords' LIMIT 1"
            )
            row = cursor.fetchone()
            conn.close()
            return (row[0] or "").strip() if row else ""
        except Exception as e:
            logger.warning("读取用户身份偏好失败: %s", e)
            return ""

    def _get_knowledge_extractor(self):
        """懒加载 KnowledgeExtractor V2，在身份发生变化时自动重建"""
        current_identity = self._read_user_identity()
        if self._knowledge_extractor is None or getattr(self, '_cached_identity', None) != current_identity:
            logger.info("开始初始化 KnowledgeExtractor V2（后台任务，identity=%r）", current_identity)
            from knowledge.extractor_v2 import KnowledgeExtractorV2
            from embedding.model import EmbeddingModel

            embedding_model = EmbeddingModel.create_default()
            self._knowledge_extractor = KnowledgeExtractorV2(
                embedding_model=embedding_model,
                user_identity=current_identity,
            )
            self._cached_identity = current_identity
            logger.info("KnowledgeExtractor V2 已初始化（后台任务，支持去重）")
        return self._knowledge_extractor

    def _get_unprocessed_captures(self, conn: sqlite3.Connection, limit: int):
        """获取未处理的采集记录（按时间升序，用于分组）"""
        cursor = conn.cursor()
        # knowledge_id IS NULL 表示尚未被合并进任何工作片段
        # 自生成 app/窗口在 SQL 层直接过滤，避免 LIMIT 被自生成记录占满导致真实内容取不到
        app_kws = tuple(k.lower() for k in _SELF_GENERATED_APP_KEYWORDS)
        win_kws = tuple(k.lower() for k in _SELF_GENERATED_WINDOW_KEYWORDS)
        app_not_like = " AND ".join(
            f"LOWER(c.app_name) NOT LIKE '%{k}%'" for k in app_kws
        )
        win_not_like = " AND ".join(
            f"LOWER(c.win_title) NOT LIKE '%{k}%'" for k in win_kws
        )
        cursor.execute(f"""
            SELECT c.id, c.ts, c.app_name, c.win_title, c.ocr_text, c.ax_text
            FROM captures c
            WHERE ((c.ocr_text IS NOT NULL AND c.ocr_text != '')
               OR (c.ax_text IS NOT NULL AND c.ax_text != ''))
              AND c.knowledge_id IS NULL
              AND c.is_sensitive = 0
              AND ({app_not_like})
              AND ({win_not_like})
            ORDER BY c.ts ASC
            LIMIT ?
        """, (limit,))
        rows = cursor.fetchall()
        return [
            {
                'id': r[0], 'ts': r[1], 'app_name': r[2],
                'window_title': r[3], 'ocr_text': r[4], 'ax_text': r[5],
            }
            for r in rows
        ]

    def _get_fragment_grouper(self):
        """懒加载 FragmentGrouper"""
        if not hasattr(self, '_fragment_grouper'):
            from knowledge.fragment_grouper import FragmentGrouper
            # 复用已有的 embedding model（如果已初始化）
            embed_model = self._embed_worker.model if self._embed_worker else None
            self._fragment_grouper = FragmentGrouper(embedding_model=embed_model)
            logger.info("FragmentGrouper 已初始化")
        return self._fragment_grouper

    def _save_knowledge(self, conn: sqlite3.Connection, knowledge: dict) -> int:
        """保存 knowledge 条目，返回新插入的 id"""
        capture_ids_raw = knowledge.get('capture_ids', '[]')
        try:
            capture_ids = json.loads(capture_ids_raw) if capture_ids_raw else []
        except json.JSONDecodeError:
            capture_ids = []

        primary_capture_id = capture_ids[0] if capture_ids else knowledge.get('capture_id')
        if primary_capture_id is None:
            raise ValueError('knowledge 缺少 capture_id/capture_ids，无法保存')

        overview = knowledge.get('overview') or knowledge.get('summary', '')
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO knowledge_entries
            (
                capture_id,
                summary,
                overview,
                details,
                entities,
                category,
                importance,
                occurrence_count,
                capture_ids,
                start_time,
                end_time,
                duration_minutes,
                frag_app_name,
                frag_win_title,
                observed_at,
                event_time_start,
                event_time_end,
                history_view,
                content_origin,
                activity_type,
                is_self_generated,
                evidence_strength
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            primary_capture_id,
            overview,
            overview,
            knowledge.get('details', ''),
            knowledge.get('entities', '[]'),
            knowledge.get('category', '其他'),
            knowledge.get('importance', 3),
            knowledge.get('occurrence_count', 1),
            capture_ids_raw,
            knowledge.get('start_time'),
            knowledge.get('end_time'),
            knowledge.get('duration_minutes'),
            knowledge.get('frag_app_name'),
            knowledge.get('frag_win_title'),
            knowledge.get('observed_at') or knowledge.get('end_time') or knowledge.get('start_time'),
            knowledge.get('event_time_start'),
            knowledge.get('event_time_end'),
            int(bool(knowledge.get('history_view', False))),
            knowledge.get('content_origin'),
            knowledge.get('activity_type'),
            int(bool(knowledge.get('is_self_generated', False))),
            knowledge.get('evidence_strength'),
        ))
        conn.commit()
        return cursor.lastrowid

    def _mark_captures_processed(
        self, conn: sqlite3.Connection, capture_ids: list[int], knowledge_id: int
    ):
        """标记 captures 已被合并进 knowledge"""
        placeholders = ','.join('?' * len(capture_ids))
        conn.execute(
            f"UPDATE captures SET knowledge_id = ? WHERE id IN ({placeholders})",
            [knowledge_id] + capture_ids,
        )
        conn.commit()

    def _group_idle_minutes(self, group: list[dict], now_ms: int) -> float:
        """计算片段距当前时间的静默分钟数"""
        if not group:
            return 0.0
        return max(0.0, (now_ms - group[-1]['ts']) / 60000)

    def _should_finalize_last_group(
        self,
        group: list[dict],
        now_ms: int,
        fetched_count: int,
    ) -> tuple[bool, str]:
        """判断最后一组是否已经足够成熟，可以落成 knowledge"""
        if not group:
            return False, 'empty_group'

        group_size = len(group)
        idle_minutes = self._group_idle_minutes(group, now_ms)
        soft_window = FragmentGrouper.SOFT_SPLIT_MINUTES
        hard_window = FragmentGrouper.HARD_SPLIT_MINUTES
        min_group_wait = FragmentGrouper.MIN_GROUP_WAIT

        if idle_minutes >= hard_window:
            return True, 'hard_timeout'

        if group_size >= min_group_wait and idle_minutes >= soft_window:
            return True, 'idle_window_reached'

        if fetched_count < self.batch_size and idle_minutes >= soft_window:
            return True, 'tail_batch_idle'

        if group_size < min_group_wait:
            return False, 'group_too_small'

        return False, 'idle_not_enough'

    async def _process_capture_group(self, group: list[dict]):
        """将一组 captures 合并提炼为一个 knowledge 条目"""
        try:
            capture_ids = [c['id'] for c in group]
            logger.info(
                "开始片段提炼: size=%s first_id=%s last_id=%s",
                len(group),
                capture_ids[0] if capture_ids else None,
                capture_ids[-1] if capture_ids else None,
            )
            extractor = self._get_knowledge_extractor()
            logger.info("KnowledgeExtractor 已就绪，开始执行 extract_merged")
            knowledge = extractor.extract_merged(captures=group)

            if not knowledge:
                logger.warning(f"片段提炼未产出 knowledge ({len(group)} 条 captures)")
                return False

            conn = sqlite3.connect(self.db_path)

            # 跨批次去重：若新 knowledge 与已有条目高度相似，则合并而非插入
            overview = knowledge.get('overview') or knowledge.get('summary', '')
            similar_id = extractor._find_similar_knowledge(overview, conn) if overview else None

            if similar_id:
                # 合并：occurrence_count+1，追加 details（去重保留新信息）
                existing = conn.execute(
                    "SELECT details FROM knowledge_entries WHERE id = ?", (similar_id,)
                ).fetchone()
                existing_details = (existing[0] or "") if existing else ""
                new_details = knowledge.get('details', '')
                if new_details and new_details not in existing_details:
                    from datetime import datetime as _dt
                    merged_details = existing_details + f"\n\n--- 补充 ({_dt.now().strftime('%Y-%m-%d %H:%M')}) ---\n{new_details}"
                else:
                    merged_details = existing_details
                conn.execute(
                    "UPDATE knowledge_entries SET occurrence_count = occurrence_count + 1, details = ? WHERE id = ?",
                    (merged_details, similar_id),
                )
                conn.commit()
                self._mark_captures_processed(conn, capture_ids, similar_id)
                conn.close()
                logger.info(
                    f"🔀 知识已合并到已有条目: {len(group)} captures → knowledge_id={similar_id} (重复)"
                )
                return True

            knowledge_id = self._save_knowledge(conn, knowledge)
            self._mark_captures_processed(conn, capture_ids, knowledge_id)
            conn.close()

            await self._process_knowledge_vectorization(group, knowledge_id, knowledge)

            logger.info(
                f"✅ 片段提炼完成: {len(group)} captures → knowledge_id={knowledge_id}, "
                f"时长={knowledge.get('duration_minutes')}分钟"
            )
            return True

        except Exception as e:
            logger.error(f"片段提炼异常: {e}")
            return False

    async def _process_vectorization_batch(self, group: list[dict]):
        """对一组 captures 批量向量化"""
        for capture in group:
            text = self._build_capture_embedding_text(capture)
            if text:
                await self._process_vectorization(capture, text)
                await asyncio.sleep(0.1)

    @staticmethod
    def _build_capture_embedding_text(capture: dict) -> str:
        parts: list[str] = []
        if capture.get('app_name'):
            parts.append(f"应用：{capture['app_name']}")
        if capture.get('window_title'):
            parts.append(f"窗口：{capture['window_title']}")
        if capture.get('ocr_text'):
            parts.append(f"OCR：{capture['ocr_text']}")
        if capture.get('ax_text'):
            parts.append(f"AX：{capture['ax_text']}")
        return "\n".join(part for part in parts if part)

    @staticmethod
    def _build_knowledge_embedding_text(group: list[dict], knowledge: dict) -> str:
        try:
            entities_raw = knowledge.get('entities') or '[]'
            if isinstance(entities_raw, str):
                entities = json.loads(entities_raw) if entities_raw else []
            else:
                entities = entities_raw
        except Exception:
            entities = []

        parts: list[str] = []
        overview = knowledge.get('overview') or knowledge.get('summary')
        if overview:
            parts.append(f"概述：{overview}")
        if knowledge.get('details'):
            parts.append(f"详情：{knowledge['details']}")
        if entities:
            parts.append(f"实体：{'、'.join(str(entity) for entity in entities if entity)}")
        if knowledge.get('frag_app_name'):
            parts.append(f"应用：{knowledge['frag_app_name']}")
        if knowledge.get('frag_win_title'):
            parts.append(f"窗口：{knowledge['frag_win_title']}")
        if group:
            evidence = [capture.get('window_title') or capture.get('app_name') or '' for capture in group[:3]]
            evidence = [item for item in evidence if item]
            if evidence:
                parts.append(f"证据：{' | '.join(evidence)}")
        return "\n".join(parts)

    async def _process_vectorization(self, capture: dict, text: str):
        """处理单条记录的向量化"""
        capture_id = capture['id']
        try:
            worker = self._get_embed_worker()

            # 创建 IPC 请求格式
            from memory_bread_ipc import IpcRequest, EmbedRequest

            embed_req = EmbedRequest(
                capture_id=capture_id,
                texts=[text]  # 注意：texts 是列表
            )

            req = IpcRequest(
                id=f"bg_{capture_id}",
                ts=int(time.time() * 1000),
                task=embed_req
            )
            response = await worker.handle(req)

            if response.status == "ok":
                from embedding.vector_storage import get_vector_storage

                vectors = response.result.vectors
                if vectors and len(vectors) > 0:
                    storage = get_vector_storage()
                    success = storage.store_vector(
                        capture_id=capture_id,
                        text=text,
                        vector=vectors[0],
                        metadata={
                            "doc_key": f"capture:{capture_id}",
                            "source_type": "capture",
                            "ts": capture.get('ts') or req.ts,
                            "timestamp": req.ts,
                            "app_name": capture.get('app_name'),
                            "win_title": capture.get('window_title'),
                        }
                    )

                    if success:
                        logger.info(f"✅ 向量化+存储完成: capture_id={capture_id}")
                        return True
                    else:
                        logger.warning(f"⚠️ 向量存储失败，继续知识提炼: capture_id={capture_id}")
                        return False
                else:
                    logger.warning(f"⚠️  向量化返回空结果: capture_id={capture_id}")
                    return False
            else:
                logger.error(f"❌ 向量化失败: capture_id={capture_id}, error={response.error}")
                return False

        except Exception as e:
            logger.error(f"❌ 向量化异常: capture_id={capture_id}, error={e}")
            return False

    async def _process_knowledge_vectorization(self, group: list[dict], knowledge_id: int, knowledge: dict) -> bool:
        """对知识条目执行向量化并写入向量索引。"""
        try:
            text = self._build_knowledge_embedding_text(group, knowledge)
            if not text:
                return False

            worker = self._get_embed_worker()
            from memory_bread_ipc import IpcRequest, EmbedRequest
            from embedding.vector_storage import get_vector_storage

            primary_capture_id = group[0]['id'] if group else int(knowledge.get('capture_id') or 0)
            embed_req = EmbedRequest(
                capture_id=primary_capture_id,
                texts=[text],
            )
            req = IpcRequest(
                id=f"bg_knowledge_{knowledge_id}",
                ts=int(time.time() * 1000),
                task=embed_req,
            )
            response = await worker.handle(req)
            if response.status != "ok" or not response.result.vectors:
                logger.warning("知识向量化失败: knowledge_id=%s error=%s", knowledge_id, response.error)
                return False

            success = get_vector_storage().store_vector(
                capture_id=primary_capture_id,
                text=text,
                vector=response.result.vectors[0],
                metadata={
                    "doc_key": f"knowledge:{knowledge_id}",
                    "source_type": "knowledge",
                    "knowledge_id": knowledge_id,
                    "start_time": knowledge.get('start_time'),
                    "end_time": knowledge.get('end_time'),
                    "observed_at": knowledge.get('observed_at') or knowledge.get('end_time') or knowledge.get('start_time'),
                    "event_time_start": knowledge.get('event_time_start'),
                    "event_time_end": knowledge.get('event_time_end'),
                    "history_view": knowledge.get('history_view', False),
                    "content_origin": knowledge.get('content_origin'),
                    "activity_type": knowledge.get('activity_type'),
                    "is_self_generated": knowledge.get('is_self_generated', False),
                    "evidence_strength": knowledge.get('evidence_strength'),
                    "app_name": knowledge.get('frag_app_name') or (group[0].get('app_name') if group else None),
                    "win_title": knowledge.get('frag_win_title') or (group[0].get('window_title') if group else None),
                    "category": knowledge.get('category', '其他'),
                    "user_verified": False,
                },
            )
            if success:
                logger.info("✅ 知识向量化完成: knowledge_id=%s", knowledge_id)
            return success
        except Exception as exc:
            logger.warning("知识向量化异常: knowledge_id=%s error=%s", knowledge_id, exc)
            return False

    async def _process_knowledge_extraction(self, capture_data: dict):
        """处理单条记录的知识提炼"""
        try:
            extractor = self._get_knowledge_extractor()

            # 打开数据库连接用于去重
            conn = sqlite3.connect(self.db_path)

            # 使用同步方法提炼（V2 版本）
            knowledge = extractor.extract_sync(capture_data, db_conn=conn)

            if knowledge:
                # 保存到数据库
                cursor = conn.cursor()

                # 支持新旧两种格式
                overview = knowledge.get('overview') or knowledge.get('summary', '')
                details = knowledge.get('details', '')

                cursor.execute("""
                    INSERT INTO knowledge_entries
                    (
                        capture_id, summary, overview, details, entities, category, importance, occurrence_count,
                        observed_at, event_time_start, event_time_end, history_view, content_origin,
                        activity_type, is_self_generated, evidence_strength
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    capture_data['id'],
                    overview,  # 保持向后兼容
                    overview,
                    details,
                    knowledge.get('entities', '[]'),
                    knowledge.get('category', '其他'),
                    knowledge.get('importance', 3),
                    knowledge.get('occurrence_count', 1),
                    knowledge.get('observed_at') or capture_data.get('ts'),
                    knowledge.get('event_time_start'),
                    knowledge.get('event_time_end'),
                    int(bool(knowledge.get('history_view', False))),
                    knowledge.get('content_origin'),
                    knowledge.get('activity_type'),
                    int(bool(knowledge.get('is_self_generated', False))),
                    knowledge.get('evidence_strength'),
                ))

                conn.commit()
                conn.close()

                logger.info(f"✅ 知识提炼完成: capture_id={capture_data['id']}, category={knowledge.get('category')}")
                return True
            else:
                conn.close()
                logger.debug(f"⏭️  跳过无价值或重复内容: capture_id={capture_data['id']}")
                return False

        except Exception as e:
            logger.error(f"❌ 知识提炼异常: capture_id={capture_data['id']}, error={e}")
            return False

    async def _process_batch(self):
        """处理一批未处理的记录（基于语义分组）"""
        try:
            conn = sqlite3.connect(self.db_path)
            captures = self._get_unprocessed_captures(conn, self.batch_size)
            conn.close()

            if not captures:
                return 0

            now_ms = int(time.time() * 1000)
            first_capture = captures[0]
            last_capture = captures[-1]

            logger.info(
                "📦 发现 %s 条待处理 captures，开始语义分组 (first_id=%s, last_id=%s)",
                len(captures),
                first_capture['id'],
                last_capture['id'],
            )

            # 数据太少时，仅在尾巴已明显静默时才落知识，避免短尾巴永久卡住
            if len(captures) < FragmentGrouper.MIN_GROUP_WAIT:
                should_finalize, reason = self._should_finalize_last_group(captures, now_ms, len(captures))
                idle_minutes = self._group_idle_minutes(captures, now_ms)
                logger.info(
                    "片段候选不足最小数量: count=%s idle=%.1fmin finalize=%s reason=%s",
                    len(captures), idle_minutes, should_finalize, reason,
                )
                if not should_finalize:
                    return 0
                groups = [captures]
            else:
                # 语义分组
                grouper = self._get_fragment_grouper()
                groups = grouper.group_captures(captures)

            groups_to_process = groups[:-1] if len(groups) > 1 else []
            last_group = groups[-1] if groups else []
            finalize_last_group = False
            finalize_reason = 'no_groups'
            last_group_idle = self._group_idle_minutes(last_group, now_ms) if last_group else 0.0

            if last_group:
                finalize_last_group, finalize_reason = self._should_finalize_last_group(
                    last_group, now_ms, len(captures)
                )
                if finalize_last_group:
                    groups_to_process.append(last_group)

            logger.info(
                "分组结果: captures=%s groups=%s process_now=%s last_group_size=%s last_group_idle=%.1fmin finalize_last=%s reason=%s",
                len(captures),
                len(groups),
                len(groups_to_process),
                len(last_group),
                last_group_idle,
                finalize_last_group,
                finalize_reason,
            )

            if not groups_to_process:
                logger.debug("所有 captures 可能仍属于进行中的任务，等待下一轮")
                return 0

            processed = 0
            for group in groups_to_process:
                # 1. 向量化（每条 capture 独立向量化，用于 RAG 检索）
                await self._process_vectorization_batch(group)

                # 2. 合并提炼为一个 knowledge 片段
                if await self._process_capture_group(group):
                    processed += 1

                await asyncio.sleep(0.5)

            logger.info("批处理完成: processed=%s fetched=%s", processed, len(captures))
            return processed

        except Exception as e:
            logger.error(f"批处理异常: {e}")
            return 0

    async def run(self):
        """运行后台处理循环"""
        self.running = True
        logger.info(f"🚀 后台处理器启动 (间隔={self.interval}s, 批量={self.batch_size})")

        while self.running:
            try:
                processed = await self._process_batch()

                if processed > 0:
                    logger.info(f"✅ 本轮处理完成: {processed} 条记录")

                # 等待下一轮
                await asyncio.sleep(self.interval)

            except Exception as e:
                logger.error(f"后台处理循环异常: {e}")
                await asyncio.sleep(self.interval)

    def stop(self):
        """停止后台处理器"""
        logger.info("⏹️  停止后台处理器")
        self.running = False
