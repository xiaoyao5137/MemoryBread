import type { TaskTemplate } from '../types'

// 内置任务模板（与 Python 侧 BUILTIN_TEMPLATES 保持一致）
// 同时供 RagPanel（快捷问答）和 ScheduledTasksPanel（定时任务）使用
export const BUILTIN_TEMPLATES: TaskTemplate[] = [
  // ── 工作总结 ──────────────────────────────────────────────────────────────
  { id: 'daily_journal',       name: '生成昨日工作日记', cron: '0 9 * * *',    category: '工作总结',   user_instruction: '请根据昨天的工作记录，生成高度浓缩的工作日记。要求：\n默认使用简体中文；即使原始记录主要为英文，也使用中文叙述，产品名和代码标识符可保留原文。\n1. 【今日产出】最多 4 条，只写真正完成的成果、修复、决策或交付，每条不超过 45 个中文字符。\n2. 【问题与解决】最多 2 条，仅记录已解决问题或明确结论；没有则写「无」。\n3. 【明日计划】最多 3 条，只写可交付、可验证目标。\n过滤掉：浏览、阅读、搜索、应用切换、会议过程、配置环境、失败尝试等流水账。' },
  { id: 'weekly_report',       name: '生成上周工作周记', cron: '0 9 * * 1',    category: '工作总结',   user_instruction: '请根据上周每日工作日记，生成一份工作周记。要求：\n1. 【本周核心产出】每条说明做了什么（结果）、为什么重要（价值），有量化数据的必须写出。\n2. 【项目进展】各项目阶段状态，用「已完成/进行中/待启动」标注。\n3. 【下周计划】每条是具体可交付目标，不写「继续推进」等模糊描述。\n4. 【风险/阻塞】（如有）描述具体问题和影响范围。\n过滤掉：阅读文档、安装依赖、无结论的调研等活动流水账。' },
  { id: 'monthly_summary',     name: '生成上月工作月记', cron: '0 9 1 * *',   category: '工作总结',   user_instruction: '请根据上月每日工作日记，生成工作月记。要求：\n1. 【主要成果】列出上月最重要的 3-5 项交付物，说明其业务价值，有数据的写数据。\n2. 【时间分配】按项目/类别分析时间投入占比，指出是否与优先级匹配。\n3. 【效率亮点与问题】各一条，基于事实。\n4. 【下月目标】具体、可验收的目标。\n过滤掉：活动流水、工具配置、无结论的探索。' },
  { id: 'project_summary',     name: '生成项目总结报告', cron: '',             category: '工作总结',   user_instruction: '帮我写项目总结' },
  { id: 'project_weekly_report', name: '生成项目周报',   cron: '0 18 * * 5',   category: '工作总结',   user_instruction: '请根据本周项目相关工作记录，生成项目周报。要求：\n1. 【本周核心产出】按项目/专项列出完成结果与业务价值，优先写可验证数字。\n2. 【项目进展】按「已完成 / 进行中 / 待启动」标注状态，并说明关键里程碑。\n3. 若涉及 OKR/KPI/专项，必须提取并呈现可验证的量化进展。\n4. 【下周计划】仅写可验收交付项。\n5. 【风险/阻塞】写明影响范围与依赖。' },
  // ── 学习成长 ──────────────────────────────────────────────────────────────
  { id: 'daily_learning',      name: '整理今日学习笔记', cron: '0 21 * * *',   category: '学习成长',   user_instruction: '请整理今天浏览的技术文档、代码、文章，提取关键知识点，生成学习笔记。重点记录新学到的概念、技术细节和待深入研究的方向。' },
  { id: 'tech_weekly',         name: '生成个人技术周刊', cron: '0 10 * * 0',   category: '学习成长',   user_instruction: '请汇总本周接触的新技术、工具、最佳实践，生成个人技术周刊。包括：技术动态、学习收获、值得分享的内容。' },
  // ── 文档管理 ──────────────────────────────────────────────────────────────
  { id: 'doc_update_reminder', name: '检查文档更新待办',  cron: '0 9 * * 1',    category: '文档管理',   user_instruction: '请检查上周修改过的项目文件和代码，列出需要同步更新文档的地方，生成文档待办清单。' },
  { id: 'code_review_summary', name: '生成今日代码审查',  cron: '0 17 * * 1-5', category: '文档管理',   user_instruction: '请总结今天编写和修改的代码，分析代码质量、潜在问题和改进点，生成代码审查报告。' },
  // ── 效率分析 ──────────────────────────────────────────────────────────────
  { id: 'time_analysis',       name: '分析本周时间使用',  cron: '0 20 * * 0',   category: '效率分析',   user_instruction: '请分析本周在各个应用和任务上的时间分配，识别时间浪费点和高效时段，提供时间管理优化建议。' },
  { id: 'focus_report',        name: '查看今日专注报告',  cron: '0 19 * * 1-5', category: '效率分析',   user_instruction: '请分析今天的工作模式，识别高效时段和分心时段，统计深度工作时间，生成专注力报告。' },
  // ── 目标跟踪 ──────────────────────────────────────────────────────────────
  { id: 'okr_tracking',        name: '更新 OKR 进度',    cron: '0 12 * * 3',   category: '目标跟踪',   user_instruction: '请根据本周工作记录，评估各项目标的推进情况，识别风险和阻碍，生成 OKR 进度报告。' },
  // ── 协作沟通 ──────────────────────────────────────────────────────────────
  { id: 'weekly_qa',           name: '汇总本周答疑记录',  cron: '0 17 * * 5',   category: '协作沟通',   user_instruction: '请整理本周在各个沟通工具中回答的问题，按主题分类汇总，生成 FAQ 文档，方便后续复用。' },
  { id: 'meeting_minutes',     name: '生成今日会议纪要',  cron: '0 18 * * 1-5', category: '协作沟通',   user_instruction: '请根据今天的会议记录和讨论内容，生成会议纪要。包括：决策事项、待办任务、责任人和截止时间。' },
  // ── 运维值班 ──────────────────────────────────────────────────────────────
  { id: 'oncall_summary',      name: '生成值班交接报告',  cron: '0 9 * * 1',    category: '运维值班',   user_instruction: '请总结值班期间处理的告警、事故、用户问题，分析根因，记录解决方案，生成值班交接报告。' },
  { id: 'system_health',       name: '查看系统健康状态',  cron: '0 9 * * 1',    category: '运维值班',   user_instruction: '请分析上周的系统日志、错误信息、性能指标，识别潜在风险和异常趋势，生成系统健康报告。' },
  // ── 邮件文档 ──────────────────────────────────────────────────────────────
  { id: 'email_todo',          name: '提取邮件待办事项',  cron: '0 9 * * 1-5',  category: '邮件文档',   user_instruction: '请从昨天的邮件往来中提取需要跟进的事项、待回复的问题，生成今日邮件待办清单，按优先级排序。' },
  { id: 'doc_changelog',       name: '生成文档变更日志',  cron: '0 16 * * 5',   category: '邮件文档',   user_instruction: '请追踪本周修改的所有文档，生成变更日志，包括修改内容摘要和版本说明。' },
]

export const CATEGORY_COLORS: Record<string, string> = {
  '工作总结': '#007AFF',
  '学习成长': '#34C759',
  '文档管理': '#AF52DE',
  '效率分析': '#FF9500',
  '目标跟踪': '#FF3B30',
  '协作沟通': '#5AC8FA',
  '运维值班': '#FF2D55',
  '邮件文档': '#FFCC00',
}

// 按 category 分组
export function groupTemplatesByCategory(templates: TaskTemplate[]): Record<string, TaskTemplate[]> {
  return templates.reduce((acc, t) => {
    ;(acc[t.category] = acc[t.category] || []).push(t)
    return acc
  }, {} as Record<string, TaskTemplate[]>)
}
