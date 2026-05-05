"""
定时任务执行器

负责：
1. 从数据库查询 knowledge 条目（已是精炼的工作片段）
2. 根据 token 预算决定是否压缩上下文
3. 调用 LLM 按用户指令生成报告
4. 将结果写入 task_executions 表
"""

import json
import logging
import re
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# 内置场景模板（UI 展示用，执行时直接用 user_instruction）
BUILTIN_TEMPLATES = [
    # ── 工作总结类 ──────────────────────────────────────────────────────────
    {
        "id": "daily_journal",
        "name": "每日工作日记",
        "cron": "0 20 * * *",
        "category": "工作总结",
        "user_instruction": (
            "请根据今天的工作记录，生成一份工作日记。要求：\n"
            "1. 【今日产出】列出今天完成的具体成果（功能、修复、决策、文档等），每条以「完成了…」「修复了…」「确定了…」等结果动词开头，有数据的写数据。\n"
            "2. 【问题与解决】仅记录今天真正解决的问题及解决方案，未解决的问题不写入此项。\n"
            "3. 【明日计划】列出明天的具体可交付目标，不写「继续研究」「了解」等模糊计划。\n"
            "过滤掉：查看文档、配置环境、参加会议（无结论时）等无产出的活动。"
        ),
    },
    {
        "id": "weekly_report",
        "name": "每周工作周报",
        "cron": "0 18 * * 5",
        "category": "工作总结",
        "user_instruction": (
            "请根据本周的工作记录，生成一份工作周报。要求：\n"
            "1. 【本周核心产出】按重要性排列，每条说明：做了什么（结果）、为什么重要（价值/影响），有量化数据的必须写出。\n"
            "2. 【项目进展】当前各项目的阶段状态，用「已完成 / 进行中 / 待启动」标注。\n"
            "3. 【下周计划】每条是具体可交付目标，不写「继续推进」「调研」等模糊描述。\n"
            "4. 【风险/阻塞】（如有）描述具体问题和影响范围。\n"
            "过滤掉：阅读文档、安装依赖、无结论的调研等活动流水账。"
        ),
    },
    {
        "id": "monthly_summary",
        "name": "月度工作总结",
        "cron": "0 18 28 * *",
        "category": "工作总结",
        "user_instruction": (
            "请根据本月的工作记录，生成月度工作总结。要求：\n"
            "1. 【主要成果】列出本月最重要的 3-5 项交付物，每项说明其业务价值或影响，有数据的写数据。\n"
            "2. 【时间分配】按项目/类别分析时间投入占比，指出是否与优先级匹配。\n"
            "3. 【效率亮点与问题】各一条，基于事实而非感受。\n"
            "4. 【下月目标】具体、可验收的目标，不写方向性描述。\n"
            "过滤掉：活动流水、工具配置、无结论的探索等低价值记录。"
        ),
    },
    {
        "id": "project_weekly_report",
        "name": "生成项目周报",
        "cron": "0 18 * * 5",
        "category": "工作总结",
        "user_instruction": (
            "请根据本周项目相关工作记录，生成项目周报。要求：\n"
            "1. 【本周核心产出】按项目/专项列出完成结果与业务价值，优先写可验证数字。\n"
            "2. 【项目进展】按「已完成 / 进行中 / 待启动」标注状态，并说明关键里程碑。\n"
            "3. 若涉及 OKR/KPI/专项，必须提取并呈现可验证的量化进展。\n"
            "4. 【下周计划】仅写可验收交付项。\n"
            "5. 【风险/阻塞】写明影响范围与依赖。"
        ),
    },
    # ── 学习成长类 ──────────────────────────────────────────────────────────
    {
        "id": "daily_learning",
        "name": "每日学习笔记",
        "cron": "0 21 * * *",
        "category": "学习成长",
        "user_instruction": "请整理今天浏览的技术文档、代码、文章，提取关键知识点，生成学习笔记。重点记录新学到的概念、技术细节和待深入研究的方向。",
    },
    {
        "id": "tech_weekly",
        "name": "个人技术周刊",
        "cron": "0 10 * * 0",
        "category": "学习成长",
        "user_instruction": "请汇总本周接触的新技术、工具、最佳实践，生成个人技术周刊。包括：技术动态、学习收获、值得分享的内容。",
    },
    # ── 文档管理类 ──────────────────────────────────────────────────────────
    {
        "id": "doc_update_reminder",
        "name": "文档更新提醒",
        "cron": "0 9 * * 1",
        "category": "文档管理",
        "user_instruction": "请检查上周修改过的项目文件和代码，列出需要同步更新文档的地方，生成文档待办清单。",
    },
    {
        "id": "code_review_summary",
        "name": "每日代码审查摘要",
        "cron": "0 17 * * 1-5",
        "category": "文档管理",
        "user_instruction": "请总结今天编写和修改的代码，分析代码质量、潜在问题和改进点，生成代码审查报告。",
    },
    # ── 效率分析类 ──────────────────────────────────────────────────────────
    {
        "id": "time_analysis",
        "name": "每周时间使用分析",
        "cron": "0 20 * * 0",
        "category": "效率分析",
        "user_instruction": "请分析本周在各个应用和任务上的时间分配，识别时间浪费点和高效时段，提供时间管理优化建议。",
    },
    {
        "id": "focus_report",
        "name": "每日专注力报告",
        "cron": "0 19 * * 1-5",
        "category": "效率分析",
        "user_instruction": "请分析今天的工作模式，识别高效时段和分心时段，统计深度工作时间，生成专注力报告。",
    },
    # ── 目标跟踪类 ──────────────────────────────────────────────────────────
    {
        "id": "okr_tracking",
        "name": "OKR 进度跟踪",
        "cron": "0 12 * * 3",
        "category": "目标跟踪",
        "user_instruction": "请根据本周工作记录，评估各项目标的推进情况，识别风险和阻碍，生成 OKR 进度报告。",
    },
    # ── 协作沟通类 ──────────────────────────────────────────────────────────
    {
        "id": "weekly_qa",
        "name": "每周答疑汇总",
        "cron": "0 17 * * 5",
        "category": "协作沟通",
        "user_instruction": "请整理本周在各个沟通工具中回答的问题，按主题分类汇总，生成 FAQ 文档，方便后续复用。",
    },
    {
        "id": "meeting_minutes",
        "name": "每日会议纪要",
        "cron": "0 18 * * 1-5",
        "category": "协作沟通",
        "user_instruction": "请根据今天的会议记录和讨论内容，生成会议纪要。包括：决策事项、待办任务、责任人和截止时间。",
    },
    # ── 运维值班类 ──────────────────────────────────────────────────────────
    {
        "id": "oncall_summary",
        "name": "On-call 值班总结",
        "cron": "0 9 * * 1",
        "category": "运维值班",
        "user_instruction": "请总结值班期间处理的告警、事故、用户问题，分析根因，记录解决方案，生成值班交接报告。",
    },
    {
        "id": "system_health",
        "name": "系统健康周报",
        "cron": "0 9 * * 1",
        "category": "运维值班",
        "user_instruction": "请分析上周的系统日志、错误信息、性能指标，识别潜在风险和异常趋势，生成系统健康报告。",
    },
    # ── 邮件文档类 ──────────────────────────────────────────────────────────
    {
        "id": "email_todo",
        "name": "邮件待办提取",
        "cron": "0 9 * * 1-5",
        "category": "邮件文档",
        "user_instruction": "请从昨天的邮件往来中提取需要跟进的事项、待回复的问题，生成今日邮件待办清单，按优先级排序。",
    },
    {
        "id": "doc_changelog",
        "name": "文档变更日志",
        "cron": "0 16 * * 5",
        "category": "邮件文档",
        "user_instruction": "请追踪本周修改的所有文档，生成变更日志，包括修改内容摘要和版本说明。",
    },
]

# 每条 knowledge 的平均 token 估算（overview + details）
AVG_TOKENS_PER_KNOWLEDGE = 300
# 直接全量使用的 token 上限
FULL_CONTEXT_TOKEN_LIMIT = 24000
# 只用 overview 的 token 上限
OVERVIEW_ONLY_TOKEN_LIMIT = 60000


class TaskExecutor:
    """定时任务执行器"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._llm_client = None

    def _get_llm_client(self):
        if self._llm_client is None:
            from ollama import Client
            self._llm_client = Client()
        return self._llm_client

    # ─────────────────────────────────────────────────────────────────────────
    # 核心执行入口
    # ─────────────────────────────────────────────────────────────────────────

    def execute_task(self, task_id: int) -> dict:
        """
        执行一个定时任务，返回执行结果。
        由 Rust 调度器通过 HTTP 调用触发。
        """
        started_at = int(time.time() * 1000)
        conn = sqlite3.connect(self.db_path)

        # 1. 读取任务定义
        task = self._get_task(conn, task_id)
        if not task:
            conn.close()
            return {"status": "failed", "error": f"任务 {task_id} 不存在"}

        # 2. 创建执行记录（running 状态）
        exec_id = self._create_execution(conn, task_id, started_at)

        try:
            # 3. 查询 knowledge 上下文
            knowledge_list = self._query_knowledge(conn, task['user_instruction'])
            knowledge_count = len(knowledge_list)
            is_weekly_report = self._is_weekly_report_instruction(task['user_instruction'])
            kpi_mode = is_weekly_report and self._is_kpi_mode_instruction(task['user_instruction'])

            # 4. 构建上下文（根据 token 预算决定压缩策略）
            context_text, token_estimate = self._build_context(
                knowledge_list,
                user_instruction=task['user_instruction'],
            )

            # 5. 调用 LLM 生成报告
            result_text = self._llm_generate(
                user_instruction=task['user_instruction'],
                context=context_text,
                task_id=task_id,
                is_weekly_report=is_weekly_report,
                kpi_mode=kpi_mode,
            )

            # 6. 更新执行记录为成功
            completed_at = int(time.time() * 1000)
            self._update_execution(conn, exec_id, {
                "status": "success",
                "completed_at": completed_at,
                "result_text": result_text,
                "knowledge_count": knowledge_count,
                "token_used": token_estimate,
                "latency_ms": completed_at - started_at,
            })

            # 7. 更新任务统计
            self._update_task_stats(conn, task_id, "success", completed_at)

            conn.close()
            logger.info(f"✅ 任务 {task_id} 执行成功，耗时 {completed_at - started_at}ms")
            return {"status": "success", "exec_id": exec_id, "result": result_text}

        except Exception as e:
            completed_at = int(time.time() * 1000)
            self._update_execution(conn, exec_id, {
                "status": "failed",
                "completed_at": completed_at,
                "error_message": str(e),
                "latency_ms": completed_at - started_at,
            })
            self._update_task_stats(conn, task_id, "failed", completed_at)
            conn.close()
            logger.error(f"❌ 任务 {task_id} 执行失败: {e}")
            return {"status": "failed", "error": str(e)}

    # ─────────────────────────────────────────────────────────────────────────
    # Knowledge 查询与上下文构建
    # ─────────────────────────────────────────────────────────────────────────

    def _query_knowledge(self, conn: sqlite3.Connection, user_instruction: str) -> list[dict]:
        """
        查询 knowledge 表。
        完全由 LLM 根据用户指令决定时间范围，这里默认取最近 30 天、
        重要性 >= 2 的条目，按时间倒序，最多 500 条。
        LLM 会在生成时自行判断哪些内容相关。
        """
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, capture_id, overview, details, category, importance,
                   start_time, end_time, duration_minutes,
                   frag_app_name, entities,
                   user_verified, observed_at, event_time_start, event_time_end,
                   history_view, content_origin, activity_type, is_self_generated,
                   evidence_strength, created_at
            FROM episodic_memories
            WHERE importance >= 2
              AND (start_time IS NULL OR start_time >= ?)
            ORDER BY COALESCE(start_time, created_at) DESC
            LIMIT 500
        """, (int(time.time() * 1000) - 30 * 24 * 3600 * 1000,))

        rows = cursor.fetchall()
        return [
            {
                "id": r[0],
                "capture_id": r[1],
                "overview": r[2] or "",
                "details": r[3] or "",
                "category": r[4] or "其他",
                "importance": r[5] or 3,
                "start_time": r[6],
                "end_time": r[7],
                "duration_minutes": r[8],
                "app_name": r[9],
                "entities": json.loads(r[10]) if r[10] else [],
                "user_verified": bool(r[11]) if r[11] is not None else False,
                "observed_at": r[12],
                "event_time_start": r[13],
                "event_time_end": r[14],
                "history_view": bool(r[15]) if r[15] is not None else False,
                "content_origin": r[16],
                "activity_type": r[17],
                "is_self_generated": bool(r[18]) if r[18] is not None else False,
                "evidence_strength": r[19],
                "created_at": r[20],
            }
            for r in rows
        ]

    def _build_context(
        self,
        knowledge_list: list[dict],
        user_instruction: str = "",
    ) -> tuple[str, int]:
        """
        根据 token 预算构建上下文文本。

        策略：
        - 预估 token 数 <= FULL_CONTEXT_TOKEN_LIMIT：overview + details 全用
        - 预估 token 数 <= OVERVIEW_ONLY_TOKEN_LIMIT：只用 overview
        - 超出：按重要性截断到 OVERVIEW_ONLY_TOKEN_LIMIT
        """
        estimated_tokens = len(knowledge_list) * AVG_TOKENS_PER_KNOWLEDGE
        is_weekly_report = self._is_weekly_report_instruction(user_instruction)
        kpi_mode = is_weekly_report and self._is_kpi_mode_instruction(user_instruction)

        if estimated_tokens <= FULL_CONTEXT_TOKEN_LIMIT:
            # 全量：overview + details
            blocks = []
            for k in knowledge_list:
                ts = self._format_time(k.get('start_time'))
                duration = f"（{k['duration_minutes']}分钟）" if k.get('duration_minutes') else ""
                work_item = k.get('work_item') or k['category']
                block = f"[{ts}{duration}][{work_item}] {k['overview']}"
                if k.get('work_progress'):
                    block += f"（{k['work_progress']}）"
                if k.get('details'):
                    block += f"\n详情：{k['details']}"
                blocks.append(block)
            context = "\n\n".join(blocks)
            logger.info(f"上下文策略：全量，{len(knowledge_list)} 条，预估 {estimated_tokens} tokens")

        elif estimated_tokens <= OVERVIEW_ONLY_TOKEN_LIMIT:
            # 只用 overview
            blocks = []
            for k in knowledge_list:
                ts = self._format_time(k.get('start_time'))
                duration = f"（{k['duration_minutes']}分钟）" if k.get('duration_minutes') else ""
                work_item = k.get('work_item') or k['category']
                line = f"[{ts}{duration}][{work_item}] {k['overview']}"
                if k.get('work_progress'):
                    line += f"（{k['work_progress']}）"
                blocks.append(line)
            context = "\n".join(blocks)
            estimated_tokens = len(knowledge_list) * 80
            logger.info(f"上下文策略：仅概述，{len(knowledge_list)} 条，预估 {estimated_tokens} tokens")

        else:
            # 按重要性截断
            sorted_k = sorted(knowledge_list, key=lambda x: x['importance'], reverse=True)
            max_count = OVERVIEW_ONLY_TOKEN_LIMIT // 80
            truncated = sorted_k[:max_count]
            # 截断后按时间重新排序
            truncated.sort(key=lambda x: x.get('start_time') or 0)
            blocks = []
            for k in truncated:
                ts = self._format_time(k.get('start_time'))
                work_item = k.get('work_item') or k['category']
                line = f"[{ts}][{work_item}] {k['overview']}"
                if k.get('work_progress'):
                    line += f"（{k['work_progress']}）"
                blocks.append(line)
            context = "\n".join(blocks)
            estimated_tokens = len(truncated) * 80
            logger.info(f"上下文策略：截断，{len(truncated)}/{len(knowledge_list)} 条，预估 {estimated_tokens} tokens")

        if is_weekly_report and knowledge_list:
            quant_block = self._build_quant_evidence_block(
                knowledge_list,
                kpi_mode=kpi_mode,
                top_n=10 if kpi_mode else 6,
            )
            if quant_block:
                context = f"{context}\n\n{quant_block}" if context else quant_block
                estimated_tokens += max(40, len(quant_block) // 4)

        return context, estimated_tokens


    @staticmethod
    def _is_weekly_report_instruction(user_instruction: str) -> bool:
        lowered = (user_instruction or "").lower()
        return any(token in lowered for token in (
            "周报",
            "weekly report",
            "weekly",
        ))

    @staticmethod
    def _is_kpi_mode_instruction(user_instruction: str) -> bool:
        lowered = (user_instruction or "").lower()
        return any(token in lowered for token in (
            "okr",
            "kpi",
            "专项",
            "关键结果",
            "指标",
            "里程碑",
            "达成率",
            "完成率",
        ))

    def _build_quant_evidence_block(
        self,
        knowledge_list: list[dict],
        kpi_mode: bool = False,
        top_n: int = 6,
    ) -> str:
        if not knowledge_list:
            return ""

        candidates: list[tuple[str, str, float]] = []
        for item in knowledge_list:
            text_parts = [item.get("overview") or ""]
            if item.get("details"):
                text_parts.append(item["details"])
            fact_lines = self._extract_quant_fact_lines("\n".join(text_parts), kpi_mode=kpi_mode)
            if not fact_lines:
                continue

            evidence_ref = self._format_evidence_ref(item)
            evidence_score = self._score_evidence(item)
            for fact in fact_lines:
                candidates.append((fact, evidence_ref, evidence_score))

        if not candidates:
            return ""

        dedup: dict[str, tuple[str, str, float]] = {}
        for fact, ref, score in candidates:
            key = self._normalize_fact_key(fact)
            prev = dedup.get(key)
            if prev is None or score > prev[2]:
                dedup[key] = (fact, ref, score)

        ranked = sorted(dedup.values(), key=lambda item: (-item[2], len(item[0])))
        picked = ranked[: max(1, top_n)]

        lines = ["【量化证据】（仅可引用以下证据中的数字结论）"]
        for idx, (fact, ref, _) in enumerate(picked, 1):
            lines.append(f"- [{idx}] {fact}（证据：{ref}）")
        return "\n".join(lines)

    @staticmethod
    def _extract_quant_fact_lines(text: str, kpi_mode: bool = False) -> list[str]:
        if not text:
            return []

        progress_keywords = (
            "完成", "达成", "推进", "上线", "交付", "修复", "关闭", "处理", "新增", "减少", "降低", "提升", "优化",
            "通过率", "成功率", "失败率", "耗时", "时延", "里程碑", "okr", "kpi", "专项", "progress", "improve", "fixed", "delivered",
        )
        number_pattern = re.compile(
            r"(\d+(?:\.\d+)?\s*%|\d+\s*/\s*\d+|\d+(?:\.\d+)?\s*(?:个|项|次|处|条|页|分钟|小时|天|周|月|年|ms|s|秒|模块|接口|问题|bug|任务|需求|pr|PR|commit|人天|台|条告警))"
        )

        candidates: list[str] = []
        segments = re.split(r"[\n。；;！？!?]+", text)
        for seg in segments:
            line = " ".join(seg.strip().split())
            if len(line) < 6:
                continue
            if not number_pattern.search(line):
                continue

            lowered = line.lower()
            if not any((kw in line) or (kw in lowered) for kw in progress_keywords):
                continue
            if TaskExecutor._looks_like_noise_numeric_line(line):
                continue
            if kpi_mode and not any(token in lowered for token in ("okr", "kpi", "专项", "达成", "完成", "提升", "降低", "上线", "交付", "通过率")):
                continue

            candidates.append(line[:120])

        return candidates[:8]

    @staticmethod
    def _looks_like_noise_numeric_line(line: str) -> bool:
        if re.fullmatch(r"[\d\s\-/:年月日.]+", line):
            return True

        has_progress_word = any(
            token in line for token in ("完成", "达成", "提升", "下降", "减少", "增加", "修复", "关闭", "交付", "上线", "通过率", "耗时")
        )
        if re.search(r"\b20\d{2}[-/年]\d{1,2}(?:[-/月]\d{1,2})?", line) and not has_progress_word:
            return True
        if re.search(r"\bv?\d+\.\d+\.\d+\b", line) and not has_progress_word:
            return True

        return False

    @staticmethod
    def _normalize_fact_key(fact: str) -> str:
        normalized = fact.lower()
        normalized = re.sub(r"\s+", "", normalized)
        normalized = re.sub(r"[，,。；;：:（）()\[\]【】'\"]", "", normalized)
        return normalized

    @staticmethod
    def _format_evidence_ref(item: dict) -> str:
        knowledge_ref = None
        capture_ref = None

        try:
            if item.get("id") is not None:
                knowledge_ref = f"K#{int(item['id'])}"
        except Exception:
            knowledge_ref = None

        try:
            if item.get("capture_id") is not None:
                capture_ref = f"C#{int(item['capture_id'])}"
        except Exception:
            capture_ref = None

        if knowledge_ref and capture_ref:
            return f"{knowledge_ref}/{capture_ref}"
        if knowledge_ref:
            return knowledge_ref
        if capture_ref:
            return capture_ref
        return "未知证据"

    @staticmethod
    def _score_evidence(item: dict) -> float:
        evidence_strength = str(item.get("evidence_strength") or "").lower()
        strength_score = {"high": 1.6, "medium": 1.0, "low": 0.2}.get(evidence_strength, 0.5)

        try:
            importance = float(item.get("importance") or 3)
        except Exception:
            importance = 3.0
        importance_score = max(0.0, min(importance, 5.0)) * 0.25

        user_verified_score = 2.0 if item.get("user_verified") else 0.0

        ts_value = item.get("observed_at") or item.get("event_time_end") or item.get("end_time") or item.get("start_time")
        recency_score = 0.0
        try:
            ts_int = int(ts_value)
            age_days = (int(time.time() * 1000) - ts_int) / (24 * 60 * 60 * 1000)
            recency_score = max(0.0, 1.2 - age_days / 14)
        except Exception:
            recency_score = 0.0

        return user_verified_score + strength_score + importance_score + recency_score

    def _llm_generate(
        self,
        user_instruction: str,
        context: str,
        task_id: int = None,
        is_weekly_report: bool = False,
        kpi_mode: bool = False,
    ) -> str:
        """调用 LLM 生成报告"""
        from monitor.llm_tracker import LLMCallTracker, estimate_tokens

        weekly_rules = ""
        if is_weekly_report:
            if kpi_mode:
                weekly_rules = (
                    "\n5. 你必须输出“## 本周量化进展（OKR/KPI/专项）”章节，且每条量化结论都必须附证据编号（证据：K#xx/C#yy）。"
                    "\n6. 未出现在“量化证据”区块中的数字禁止输出；缺少证据时改写为定性描述。"
                )
            else:
                weekly_rules = (
                    "\n5. 若上下文包含“量化证据”区块，优先引用其中数字并附证据编号（证据：K#xx/C#yy）。"
                    "\n6. 无证据支撑时不得编造数字。"
                )

        system_prompt = (
            "你是用户的个人工作助手。以下是用户近期的工作记录摘要（按时间顺序）。"
            "每条记录的格式为：[时间][工作项] 概述（进度）\n\n"
            "请严格按照用户的指令，基于这些工作记录生成相应的报告或总结。"
            "输出使用 Markdown 格式，语言简洁专业。\n\n"
            "【重要】生成报告时必须遵守以下规则：\n"
            "1. 每条产出必须明确说明是哪个项目/工作项的成果，格式：【工作项】完成了…\n"
            "2. 项目进展章节必须按工作项分组，每个工作项说明当前状态（待启动/进行中/已完成/阻塞）和具体进度\n"
            "3. 以「产出」为中心，而非「活动」。每一条内容必须体现可见的价值或结果。\n"
            "4. 以下类型的活动禁止直接写入报告：纯阅读/查看文档、安装配置环境、无结论的调研、中间态的失败尝试。"
            "若这些活动产生了明确结论或结果，则以结论为主语来描述。\n"
            "5. 凡有可量化数据（测试通过率、性能指标、完成模块数等），必须写出具体数字。\n"
            "6. 每条工作项须能回答「这件事带来了什么价值？」，否则删除该条。"
            f"{weekly_rules}"
        )
        user_prompt = f"## 工作记录\n\n{context}\n\n---\n\n## 用户指令\n\n{user_instruction}"
        model = "qwen2.5:3b"

        client = self._get_llm_client()
        with LLMCallTracker(
            caller="task",
            model_name=model,
            caller_id=str(task_id) if task_id else None,
            db_path=self.db_path,
        ) as tracker:
            response = client.chat(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                options={"temperature": 0.5, "num_predict": 2048},
            )
            tracker.set_response(response)
            # 如果 Ollama 没返回 token 信息，用估算补充
            if tracker._prompt_tokens == 0:
                tracker.set_tokens(
                    prompt=estimate_tokens(system_prompt + user_prompt),
                    completion=estimate_tokens(response['message']['content']),
                )
        return response['message']['content']


    # ─────────────────────────────────────────────────────────────────────────
    # 数据库操作
    # ─────────────────────────────────────────────────────────────────────────

    def _get_task(self, conn: sqlite3.Connection, task_id: int) -> Optional[dict]:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, name, user_instruction, cron_expression FROM scheduled_tasks WHERE id = ?",
            (task_id,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        return {"id": row[0], "name": row[1], "user_instruction": row[2], "cron_expression": row[3]}

    def _create_execution(self, conn: sqlite3.Connection, task_id: int, started_at: int) -> int:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO task_executions (task_id, started_at, status) VALUES (?, ?, 'running')",
            (task_id, started_at)
        )
        conn.commit()
        return cursor.lastrowid

    def _update_execution(self, conn: sqlite3.Connection, exec_id: int, data: dict):
        fields = ", ".join(f"{k} = ?" for k in data if k != "exec_id")
        values = [v for k, v in data.items() if k != "exec_id"]
        conn.execute(
            f"UPDATE task_executions SET {fields} WHERE id = ?",
            values + [exec_id]
        )
        conn.commit()

    def _update_task_stats(
        self, conn: sqlite3.Connection, task_id: int, status: str, completed_at: int
    ):
        conn.execute(
            """UPDATE scheduled_tasks
               SET run_count = run_count + 1,
                   last_run_at = ?,
                   last_run_status = ?,
                   updated_at = ?
               WHERE id = ?""",
            (completed_at, status, completed_at, task_id)
        )
        conn.commit()

    def _format_time(self, ts_ms: Optional[int]) -> str:
        if not ts_ms:
            return "未知时间"
        return datetime.fromtimestamp(ts_ms / 1000).strftime('%m-%d %H:%M')
