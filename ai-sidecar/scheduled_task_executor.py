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
        "user_instruction": "请根据今天的工作记录，生成一份工作日记。包括：主要完成的工作、遇到的问题和解决方案、明天的计划。语言简洁，重点突出。",
    },
    {
        "id": "weekly_report",
        "name": "每周工作周报",
        "cron": "0 18 * * 5",
        "category": "工作总结",
        "user_instruction": "请根据本周的工作记录，生成一份工作周报。包括：本周完成的主要工作、项目进展、遇到的挑战和解决方案、下周计划。",
    },
    {
        "id": "monthly_summary",
        "name": "月度工作总结",
        "cron": "0 18 28 * *",
        "category": "工作总结",
        "user_instruction": "请根据本月的工作记录，生成月度工作总结。包括：主要成果、时间分配分析、效率变化、下月目标。",
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

            # 4. 构建上下文（根据 token 预算决定压缩策略）
            context_text, token_estimate = self._build_context(knowledge_list)

            # 5. 调用 LLM 生成报告
            result_text = self._llm_generate(
                user_instruction=task['user_instruction'],
                context=context_text,
                task_id=task_id,
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
            SELECT id, overview, details, category, importance,
                   start_time, end_time, duration_minutes,
                   frag_app_name, entities
            FROM knowledge_entries
            WHERE importance >= 2
              AND (start_time IS NULL OR start_time >= ?)
            ORDER BY COALESCE(start_time, created_at) DESC
            LIMIT 500
        """, (int(time.time() * 1000) - 30 * 24 * 3600 * 1000,))

        rows = cursor.fetchall()
        return [
            {
                "id": r[0],
                "overview": r[1] or "",
                "details": r[2] or "",
                "category": r[3] or "其他",
                "importance": r[4] or 3,
                "start_time": r[5],
                "end_time": r[6],
                "duration_minutes": r[7],
                "app_name": r[8],
                "entities": json.loads(r[9]) if r[9] else [],
            }
            for r in rows
        ]

    def _build_context(self, knowledge_list: list[dict]) -> tuple[str, int]:
        """
        根据 token 预算构建上下文文本。

        策略：
        - 预估 token 数 <= FULL_CONTEXT_TOKEN_LIMIT：overview + details 全用
        - 预估 token 数 <= OVERVIEW_ONLY_TOKEN_LIMIT：只用 overview
        - 超出：按重要性截断到 OVERVIEW_ONLY_TOKEN_LIMIT
        """
        estimated_tokens = len(knowledge_list) * AVG_TOKENS_PER_KNOWLEDGE

        if estimated_tokens <= FULL_CONTEXT_TOKEN_LIMIT:
            # 全量：overview + details
            blocks = []
            for k in knowledge_list:
                ts = self._format_time(k.get('start_time'))
                duration = f"（{k['duration_minutes']}分钟）" if k.get('duration_minutes') else ""
                block = f"[{ts}{duration}][{k['category']}] {k['overview']}"
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
                blocks.append(f"[{ts}{duration}][{k['category']}] {k['overview']}")
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
                blocks.append(f"[{ts}][{k['category']}] {k['overview']}")
            context = "\n".join(blocks)
            estimated_tokens = len(truncated) * 80
            logger.info(f"上下文策略：截断，{len(truncated)}/{len(knowledge_list)} 条，预估 {estimated_tokens} tokens")

        return context, estimated_tokens

    def _llm_generate(self, user_instruction: str, context: str, task_id: int = None) -> str:
        """调用 LLM 生成报告"""
        from monitor.llm_tracker import LLMCallTracker, estimate_tokens

        system_prompt = (
            "你是用户的个人工作助手。以下是用户近期的工作记录摘要（按时间顺序）。"
            "请严格按照用户的指令，基于这些工作记录生成相应的报告或总结。"
            "输出使用 Markdown 格式，语言简洁专业。"
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
