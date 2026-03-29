/**
 * RagPanel v2 — 记忆面包面板（优化版）
 *
 * 改进：
 * 1. 移除收起功能（不再支持收起到 buddy 模式）
 * 2. 更换图标为工作相关的图标
 * 3. 优化布局和样式
 * 4. 增加任务模板快捷入口：
 *    - 空状态：展示全量模板（按分类分组）
 *    - 有回答时：模板区折叠在参考来源下方，可展开/收起
 */

import React, { useCallback, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useRagQuery } from '../hooks/useApi'
import { BUILTIN_TEMPLATES, CATEGORY_COLORS, groupTemplatesByCategory } from '../data/taskTemplates'

interface RagPanelProps {
  className?: string
}

const GROUPED_TEMPLATES = groupTemplatesByCategory(BUILTIN_TEMPLATES)

const RagPanel: React.FC<RagPanelProps> = ({ className = '' }) => {
  const {
    ragQuery,
    ragAnswer,
    ragContexts,
    ragLoading,
    ragError,
    setRagQuery,
  } = useAppStore()

  const [inputValue, setInputValue] = useState(ragQuery)
  const [templatesExpanded, setTemplatesExpanded] = useState(false)
  const doQuery = useRagQuery()

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const q = inputValue.trim()
      if (!q) return
      setRagQuery(q)
      try {
        await doQuery(q)
      } catch {
        // error is set in store by useRagQuery
      }
    },
    [inputValue, setRagQuery, doQuery]
  )

  const handleTemplateClick = useCallback(
    async (instruction: string) => {
      setInputValue(instruction)
      setRagQuery(instruction)
      try {
        await doQuery(instruction)
      } catch {
        // error is set in store by useRagQuery
      }
    },
    [setRagQuery, doQuery]
  )

  const hasResult = !!(ragAnswer || ragError)

  return (
    <div
      className={`rag-panel ${className}`}
      data-testid="rag-panel"
      role="dialog"
      aria-label="记忆面包问答面板"
    >
      {/* 标题栏 */}
      <div className="rag-panel__header" data-testid="rag-panel-header">
        <div className="rag-panel__title-group">
          {/* 工作图标 - briefcase */}
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="rag-panel__icon"
          >
            <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          </svg>
          <h2 className="rag-panel__title">记忆面包</h2>
        </div>
        <p className="rag-panel__subtitle">看过就会记住,记住就会理解</p>
      </div>

      {/* 输入区域 */}
      <form
        className="rag-panel__form"
        onSubmit={handleSubmit}
        data-testid="rag-panel-form"
      >
        <textarea
          className="rag-panel__input"
          data-testid="rag-panel-input"
          placeholder="问我任何工作相关的问题..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          rows={3}
          disabled={ragLoading}
        />
        <button
          type="submit"
          className="rag-panel__submit"
          data-testid="rag-panel-submit"
          disabled={ragLoading || !inputValue.trim()}
        >
          {ragLoading ? (
            <>
              {/* 加载图标 */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="rag-panel__loading-icon"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              思考中...
            </>
          ) : (
            <>
              {/* 发送图标 */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
              提问
            </>
          )}
        </button>
      </form>

      {/* 错误提示 */}
      {ragError && (
        <div
          className="rag-panel__error"
          data-testid="rag-panel-error"
          role="alert"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="m15 9-6 6" />
            <path d="m9 9 6 6" />
          </svg>
          {ragError}
        </div>
      )}

      {/* 回答区域 */}
      {ragAnswer && (
        <div className="rag-panel__answer" data-testid="rag-panel-answer">
          <div className="rag-panel__answer-header">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
              <path d="M9 13a4.5 4.5 0 0 0 3-4" />
              <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
              <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
              <path d="M6 18a4 4 0 0 1-1.967-.516" />
              <path d="M12 13h4" />
              <path d="M12 18h6a2 2 0 0 1 2 2v1" />
              <path d="M12 8h8" />
              <path d="M16 8V5a2 2 0 0 1 2-2" />
              <circle cx="16" cy="13" r=".5" />
              <circle cx="18" cy="3" r=".5" />
              <circle cx="20" cy="21" r=".5" />
              <circle cx="20" cy="8" r=".5" />
            </svg>
            <strong>AI 回答</strong>
          </div>
          <div className="rag-panel__answer-content">{ragAnswer}</div>
        </div>
      )}

      {/* 引用上下文 */}
      {ragContexts && ragContexts.length > 0 && (
        <div className="rag-panel__contexts" data-testid="rag-panel-contexts">
          <div className="rag-panel__contexts-header">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
            </svg>
            <strong>参考来源 ({ragContexts.length})</strong>
          </div>
          {ragContexts.map((ctx, idx) => (
            <div
              key={idx}
              className="rag-panel__context-item"
              data-testid={`context-item-${idx}`}
            >
              <div className="rag-panel__context-meta">
                <span className="rag-panel__context-app">{ctx.app_name}</span>
                <span className="rag-panel__context-score">
                  相关度: {(ctx.score * 100).toFixed(0)}%
                </span>
              </div>
              <div className="rag-panel__context-text">
                  {ctx.text.split('\n').map((line, i) => (
                    <React.Fragment key={i}>{line}{i < ctx.text.split('\n').length - 1 && <br />}</React.Fragment>
                  ))}
                </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 任务模板区 ── */}
      {/* 空状态：大图标 + 全量模板展示 */}
      {!ragLoading && !hasResult && (
        <div className="rag-panel__empty" data-testid="rag-panel-empty">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="rag-panel__empty-icon"
          >
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
            <path d="M9 13a4.5 4.5 0 0 0 3-4" />
            <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
            <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
            <path d="M6 18a4 4 0 0 1-1.967-.516" />
            <path d="M12 13h4" />
            <path d="M12 18h6a2 2 0 0 1 2 2v1" />
            <path d="M12 8h8" />
            <path d="M16 8V5a2 2 0 0 1 2-2" />
            <circle cx="16" cy="13" r=".5" />
            <circle cx="18" cy="3" r=".5" />
            <circle cx="20" cy="21" r=".5" />
            <circle cx="20" cy="8" r=".5" />
          </svg>
          <p>你好！我是记忆面包</p>
          <p className="rag-panel__empty-hint">
            问我任何工作相关的问题，或从下方选择一个任务模板快速开始
          </p>

          <div className="rag-panel__templates">
            {Object.entries(GROUPED_TEMPLATES).map(([category, templates]) => (
              <div key={category} className="rag-panel__template-group">
                <div
                  className="rag-panel__template-category"
                  style={{ borderColor: CATEGORY_COLORS[category] ?? '#999', color: CATEGORY_COLORS[category] ?? '#999' }}
                >
                  {category}
                </div>
                <div className="rag-panel__template-chips">
                  {templates.map((tpl) => (
                    <button
                      key={tpl.id}
                      className="rag-panel__template-chip"
                      style={{ '--chip-color': CATEGORY_COLORS[category] ?? '#4a90e2' } as React.CSSProperties}
                      onClick={() => handleTemplateClick(tpl.user_instruction)}
                      disabled={ragLoading}
                      title={tpl.user_instruction}
                    >
                      {tpl.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 有结果时：模板区折叠在底部，可展开 */}
      {!ragLoading && hasResult && (
        <div className="rag-panel__templates-collapsed">
          <button
            className="rag-panel__templates-toggle"
            onClick={() => setTemplatesExpanded((v) => !v)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="7" height="7" x="3" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="14" rx="1" />
              <rect width="7" height="7" x="3" y="14" rx="1" />
            </svg>
            任务模板
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`rag-panel__toggle-arrow ${templatesExpanded ? 'rag-panel__toggle-arrow--up' : ''}`}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          {templatesExpanded && (
            <div className="rag-panel__templates rag-panel__templates--inline">
              {Object.entries(GROUPED_TEMPLATES).map(([category, templates]) => (
                <div key={category} className="rag-panel__template-group">
                  <div
                    className="rag-panel__template-category"
                    style={{ borderColor: CATEGORY_COLORS[category] ?? '#999', color: CATEGORY_COLORS[category] ?? '#999' }}
                  >
                    {category}
                  </div>
                  <div className="rag-panel__template-chips">
                    {templates.map((tpl) => (
                      <button
                        key={tpl.id}
                        className="rag-panel__template-chip"
                        style={{ '--chip-color': CATEGORY_COLORS[category] ?? '#4a90e2' } as React.CSSProperties}
                        onClick={() => handleTemplateClick(tpl.user_instruction)}
                        disabled={ragLoading}
                        title={tpl.user_instruction}
                      >
                        {tpl.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default RagPanel
