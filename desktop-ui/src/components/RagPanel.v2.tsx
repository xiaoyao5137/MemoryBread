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

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useRagQuery, useModelStatus } from '../hooks/useApi'
import { BUILTIN_TEMPLATES, CATEGORY_COLORS, groupTemplatesByCategory } from '../data/taskTemplates'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// 配置 marked：换行处理
marked.setOptions({ breaks: true })

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
  const [contextsExpanded, setContextsExpanded] = useState(false)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const doQuery = useRagQuery()
  const { status: modelStatus, ready: modelsReady, loading: modelStatusLoading } = useModelStatus()

  // 内容变化时自动调整高度
  const adjustHeight = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  // inputValue 变化时（含模板填入、外部更新）同步高度
  useEffect(() => {
    if (textareaRef.current) adjustHeight(textareaRef.current)
  }, [inputValue, adjustHeight])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value)
    adjustHeight(e.target)
  }, [adjustHeight])

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
    (instruction: string) => {
      setInputValue(instruction)
      setRagQuery(instruction)
    },
    [setRagQuery]
  )

  const answerHtml = useMemo(() => {
    if (!ragAnswer) return ''
    const raw = marked.parse(ragAnswer) as string
    return DOMPurify.sanitize(raw)
  }, [ragAnswer])

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
          <h2 className="rag-panel__title">咨询</h2>
        </div>
        <p className="rag-panel__subtitle">看见就会记住，记住就会理解<br />理解就能生产，生产就有希望</p>
      </div>

      {/* 模型未就绪提示 */}
      {!modelStatusLoading && !modelsReady && (
        <div style={{
          margin: '12px 16px',
          padding: '12px',
          background: '#FFF3CD',
          border: '1px solid #FFE69C',
          borderRadius: 8,
          fontSize: 13,
          color: '#856404',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>⚠️ 模型未就绪</div>
          <div style={{ marginBottom: 8 }}>
            {!modelStatus.ollama && '• Ollama 推理引擎未运行'}
            {!modelStatus.llm && '• LLM 推理模型未加载'}
            {!modelStatus.embedding && '• 向量模型未加载'}
          </div>
          <div style={{ fontSize: 12 }}>
            请前往「模型」界面检查模型状态
          </div>
        </div>
      )}

      {/* 输入区域 */}
      <form
        className="rag-panel__form"
        onSubmit={handleSubmit}
        data-testid="rag-panel-form"
      >
        <textarea
          ref={textareaRef}
          className="rag-panel__input"
          data-testid="rag-panel-input"
          placeholder={modelsReady ? "问我任何工作相关的问题..." : "模型未就绪，请先配置模型"}
          value={inputValue}
          onChange={handleInputChange}
          rows={3}
          style={{ resize: 'none', overflow: 'hidden' }}
          disabled={ragLoading || !modelsReady}
        />
        <button
          type="submit"
          className="rag-panel__submit"
          data-testid="rag-panel-submit"
          disabled={ragLoading || !inputValue.trim() || !modelsReady}
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
          <div className="rag-panel__answer-content rag-panel__answer-content--markdown" dangerouslySetInnerHTML={{ __html: answerHtml }} />
        </div>
      )}

      {/* 引用上下文 */}
      {ragContexts && ragContexts.length > 0 && (
        <div className="rag-panel__contexts" data-testid="rag-panel-contexts">
          <div
            className="rag-panel__contexts-header"
            onClick={() => setContextsExpanded(v => !v)}
            style={{ cursor: 'pointer', userSelect: 'none' }}
          >
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
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginLeft: 'auto', transform: contextsExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
          {contextsExpanded && ragContexts.map((ctx, idx) => (
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

      {/* ── 任务模板区：始终展示 ── */}
      {!ragLoading && (
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
      )}
    </div>
  )
}

export default RagPanel
