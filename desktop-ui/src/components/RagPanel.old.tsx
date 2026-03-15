/**
 * RagPanel — 知识唤醒面板
 *
 * 用户输入问题 → 调用 /query → 展示 LLM 回答与引用上下文。
 * 设计为半透明侧边面板，可快速开关。
 */

import React, { useCallback, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useRagQuery } from '../hooks/useApi'

interface RagPanelProps {
  className?: string
}

const RagPanel: React.FC<RagPanelProps> = ({ className = '' }) => {
  const {
    ragQuery, ragAnswer, ragContexts, ragLoading, ragError,
    setRagQuery, setWindowMode,
  } = useAppStore()

  const [inputValue, setInputValue] = useState(ragQuery)
  const doQuery = useRagQuery()

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const q = inputValue.trim()
    if (!q) return
    setRagQuery(q)
    try {
      await doQuery(q)
    } catch {
      // error is set in store by useRagQuery
    }
  }, [inputValue, setRagQuery, doQuery])

  const handleClose = () => setWindowMode('buddy')

  return (
    <div
      className={`rag-panel ${className}`}
      data-testid="rag-panel"
      role="dialog"
      aria-label="知识唤醒面板"
    >
      {/* 标题栏 */}
      <div className="rag-panel__header" data-testid="rag-panel-header">
        <h2 className="rag-panel__title">工作搭子</h2>
        <button
          className="rag-panel__close"
          data-testid="rag-panel-close"
          onClick={handleClose}
          aria-label="关闭面板"
          type="button"
        >
          ✕
        </button>
      </div>

      {/* 输入区域 */}
      <form
        className="rag-panel__form"
        data-testid="rag-form"
        onSubmit={handleSubmit}
      >
        <input
          className="rag-panel__input"
          data-testid="rag-input"
          type="text"
          placeholder="问我任何工作问题…"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          disabled={ragLoading}
          aria-label="查询输入框"
          autoFocus
        />
        <button
          className="rag-panel__submit"
          data-testid="rag-submit"
          type="submit"
          disabled={ragLoading || !inputValue.trim()}
          aria-label="发送查询"
        >
          {ragLoading ? '查询中…' : '发送'}
        </button>
      </form>

      {/* 错误提示 */}
      {ragError && (
        <div
          className="rag-panel__error"
          data-testid="rag-error"
          role="alert"
        >
          ⚠️ {ragError}
        </div>
      )}

      {/* 回答区域 */}
      {ragAnswer && (
        <div className="rag-panel__answer" data-testid="rag-answer">
          <div className="rag-panel__answer-text">{ragAnswer}</div>
        </div>
      )}

      {/* 引用上下文 */}
      {ragContexts.length > 0 && (
        <div className="rag-panel__contexts" data-testid="rag-contexts">
          <h3 className="rag-panel__contexts-title">参考记录</h3>
          {ragContexts.map((ctx, i) => (
            <div
              key={ctx.capture_id}
              className="rag-panel__context-item"
              data-testid={`rag-context-${i}`}
            >
              <span className="rag-panel__context-source">[{ctx.source}]</span>
              <span className="rag-panel__context-text">
                {ctx.text.slice(0, 120)}{ctx.text.length > 120 ? '…' : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!ragLoading && !ragAnswer && !ragError && (
        <div className="rag-panel__empty" data-testid="rag-empty">
          <p>提问来了解您的工作记录，例如：</p>
          <ul>
            <li>今天做了哪些工作？</li>
            <li>关于飞书会议的记录有哪些？</li>
            <li>帮我整理本周工作总结</li>
          </ul>
        </div>
      )}
    </div>
  )
}

export default RagPanel
