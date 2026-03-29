import type { TaskTemplate } from '../types'

// 内置任务模板（与 Python 侧 BUILTIN_TEMPLATES 保持一致）
// 同时供 RagPanel（快捷问答）和 ScheduledTasksPanel（定时任务）使用
export const BUILTIN_TEMPLATES: TaskTemplate[] = [
  // ── 工作总结 ──────────────────────────────────────────────────────────────
  { id: 'daily_journal',       name: '每日工作日记',     cron: '0 20 * * *',   category: '工作总结',   user_instruction: '请根据今天的工作记录，生成一份工作日记。包括：主要完成的工作、遇到的问题和解决方案、明天的计划。语言简洁，重点突出。' },
  { id: 'weekly_report',       name: '每周工作周报',     cron: '0 18 * * 5',   category: '工作总结',   user_instruction: '帮我写工作周报' },
  { id: 'monthly_summary',     name: '月度工作总结',     cron: '0 18 28 * *',  category: '工作总结',   user_instruction: '请根据本月的工作记录，生成月度工作总结。包括：主要成果、时间分配分析、效率变化、下月目标。' },
  { id: 'project_summary',     name: '项目总结报告',     cron: '',             category: '工作总结',   user_instruction: '帮我写项目总结' },
  // ── 学习成长 ──────────────────────────────────────────────────────────────
  { id: 'daily_learning',      name: '每日学习笔记',     cron: '0 21 * * *',   category: '学习成长',   user_instruction: '请整理今天浏览的技术文档、代码、文章，提取关键知识点，生成学习笔记。重点记录新学到的概念、技术细节和待深入研究的方向。' },
  { id: 'tech_weekly',         name: '个人技术周刊',     cron: '0 10 * * 0',   category: '学习成长',   user_instruction: '请汇总本周接触的新技术、工具、最佳实践，生成个人技术周刊。包括：技术动态、学习收获、值得分享的内容。' },
  // ── 文档管理 ──────────────────────────────────────────────────────────────
  { id: 'doc_update_reminder', name: '文档更新提醒',     cron: '0 9 * * 1',    category: '文档管理',   user_instruction: '请检查上周修改过的项目文件和代码，列出需要同步更新文档的地方，生成文档待办清单。' },
  { id: 'code_review_summary', name: '每日代码审查摘要', cron: '0 17 * * 1-5', category: '文档管理',   user_instruction: '请总结今天编写和修改的代码，分析代码质量、潜在问题和改进点，生成代码审查报告。' },
  // ── 效率分析 ──────────────────────────────────────────────────────────────
  { id: 'time_analysis',       name: '每周时间使用分析', cron: '0 20 * * 0',   category: '效率分析',   user_instruction: '请分析本周在各个应用和任务上的时间分配，识别时间浪费点和高效时段，提供时间管理优化建议。' },
  { id: 'focus_report',        name: '每日专注力报告',   cron: '0 19 * * 1-5', category: '效率分析',   user_instruction: '请分析今天的工作模式，识别高效时段和分心时段，统计深度工作时间，生成专注力报告。' },
  // ── 目标跟踪 ──────────────────────────────────────────────────────────────
  { id: 'okr_tracking',        name: 'OKR 进度跟踪',    cron: '0 12 * * 3',   category: '目标跟踪',   user_instruction: '请根据本周工作记录，评估各项目标的推进情况，识别风险和阻碍，生成 OKR 进度报告。' },
  // ── 协作沟通 ──────────────────────────────────────────────────────────────
  { id: 'weekly_qa',           name: '每周答疑汇总',     cron: '0 17 * * 5',   category: '协作沟通',   user_instruction: '请整理本周在各个沟通工具中回答的问题，按主题分类汇总，生成 FAQ 文档，方便后续复用。' },
  { id: 'meeting_minutes',     name: '每日会议纪要',     cron: '0 18 * * 1-5', category: '协作沟通',   user_instruction: '请根据今天的会议记录和讨论内容，生成会议纪要。包括：决策事项、待办任务、责任人和截止时间。' },
  // ── 运维值班 ──────────────────────────────────────────────────────────────
  { id: 'oncall_summary',      name: 'On-call 值班总结', cron: '0 9 * * 1',    category: '运维值班',   user_instruction: '请总结值班期间处理的告警、事故、用户问题，分析根因，记录解决方案，生成值班交接报告。' },
  { id: 'system_health',       name: '系统健康周报',     cron: '0 9 * * 1',    category: '运维值班',   user_instruction: '请分析上周的系统日志、错误信息、性能指标，识别潜在风险和异常趋势，生成系统健康报告。' },
  // ── 邮件文档 ──────────────────────────────────────────────────────────────
  { id: 'email_todo',          name: '邮件待办提取',     cron: '0 9 * * 1-5',  category: '邮件文档',   user_instruction: '请从昨天的邮件往来中提取需要跟进的事项、待回复的问题，生成今日邮件待办清单，按优先级排序。' },
  { id: 'doc_changelog',       name: '文档变更日志',     cron: '0 16 * * 5',   category: '邮件文档',   user_instruction: '请追踪本周修改的所有文档，生成变更日志，包括修改内容摘要和版本说明。' },
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
