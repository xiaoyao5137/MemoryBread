/**
 * RagPanel v2 — 记忆面包面板（优化版）
 *
 * 改进：
 * 1. 移除收起功能（不再支持收起到 buddy 模式）
 * 2. 更换图标为工作相关的图标
 * 3. 优化布局和样式
 */

import React, { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { RAG_REFERENCE_LIMIT, useRagQuery } from '../hooks/useApi'
import { buildAttachmentMetadata, buildAttachmentPrompt, filesToAttachments, formatAttachmentSize, type UserAttachment } from '../utils/attachments'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback for older browsers
      const el = document.createElement('textarea')
      el.value = text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [text])

  return (
    <button
      className={`rag-panel__copy-btn${copied ? ' rag-panel__copy-btn--copied' : ''}`}
      onClick={handleCopy}
      title="复制内容"
      type="button"
    >
      {copied ? (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          已复制
        </>
      ) : (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          复制
        </>
      )}
    </button>
  )
}

interface RagPanelProps {
  className?: string
}

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
  const [attachments, setAttachments] = useState<UserAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const doQuery = useRagQuery()

  const addFiles = useCallback(async (files: Iterable<File>) => {
    setAttachmentError(null)
    try {
      const next = await filesToAttachments(files, attachments.length)
      setAttachments(prev => [...prev, ...next])
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : '附件读取失败')
    }
  }, [attachments.length])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const q = inputValue.trim()
      if (!q) return
      setRagQuery(q)
      const controller = new AbortController()
      abortRef.current = controller
      const attachmentPrompt = buildAttachmentPrompt(attachments)
      const queryWithAttachments = attachmentPrompt ? `${q}\n\n${attachmentPrompt}` : q
      try {
        await doQuery(queryWithAttachments, RAG_REFERENCE_LIMIT, attachments.length ? { attachments: buildAttachmentMetadata(attachments) } : {}, controller.signal)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        // error is set in store by useRagQuery
      } finally {
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    [attachments, inputValue, setRagQuery, doQuery]
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    useAppStore.getState().setRagLoading(false)
  }, [])

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
          {/* 消息图标 - message-circle */}
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
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files || [])
            if (files.length) void addFiles(files)
          }}
          rows={3}
          disabled={ragLoading}
        />
        {attachments.length > 0 && (
          <div className="rag-panel__attachments">
            {attachments.map(item => (
              <span className="rag-panel__attachment" key={item.id}>
                <span>{item.name}</span>
                <small>{formatAttachmentSize(item.size)}</small>
                <button type="button" onClick={() => setAttachments(prev => prev.filter(existing => existing.id !== item.id))} aria-label={`移除 ${item.name}`}>×</button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && <div className="rag-panel__attachment-error">{attachmentError}</div>}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.doc,.docx"
          style={{ display: 'none' }}
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files)
            event.currentTarget.value = ''
          }}
        />
        <button
          type={ragLoading ? 'button' : 'submit'}
          className="rag-panel__submit"
          data-testid="rag-panel-submit"
          disabled={!ragLoading && !inputValue.trim()}
          onClick={ragLoading ? handleStop : undefined}
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
              中止
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
        <button
          type="button"
          className="rag-panel__attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={ragLoading}
        >
          附件
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
            <CopyButton text={ragAnswer} />
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
              <div className="rag-panel__context-text">{ctx.text}</div>
            </div>
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!ragLoading && !ragAnswer && !ragError && (
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
            问我任何工作相关的问题，我会基于你的工作记录给出答案
          </p>
        </div>
      )}
    </div>
  )
}

export default RagPanel
