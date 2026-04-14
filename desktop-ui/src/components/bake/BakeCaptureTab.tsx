import React, { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { BakeCaptureItem } from '../../types'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './BakeShared'

const formatCaptureTime = (ts?: number) => {
  if (!ts) return '—'
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

const parseDateInputToMs = (value: string, endOfDay = false) => {
  if (!value) return undefined
  const iso = endOfDay ? `${value}T23:59:59.999` : `${value}T00:00:00.000`
  const ts = new Date(iso).getTime()
  return Number.isNaN(ts) ? undefined : ts
}

const BakeCaptureTab: React.FC<{
  captures: BakeCaptureItem[]
  total: number
  limit: number
  offset: number
  query: string
  from: string
  to: string
  draftQuery: string
  draftFrom: string
  draftTo: string
  sourceCaptureId: string | null
  selectedCaptureId: string | null
  selectedCaptureDetail: BakeCaptureItem | null
  onSelectCapture: (id: string | null) => void
  onPageChange: (offset: number) => void
  onLimitChange: (limit: number) => void
  onDraftQueryChange: (query: string) => void
  onDraftFromChange: (value: string) => void
  onDraftToChange: (value: string) => void
  onSearch: () => void
  onClearFilters: () => void
  onClearScope: () => void
  onViewLinkedKnowledge: (knowledgeId?: string | null) => void
}> = ({
  captures,
  total,
  limit,
  offset,
  query,
  from,
  to,
  draftQuery,
  draftFrom,
  draftTo,
  sourceCaptureId,
  selectedCaptureId,
  selectedCaptureDetail,
  onSelectCapture,
  onPageChange,
  onLimitChange,
  onDraftQueryChange,
  onDraftFromChange,
  onDraftToChange,
  onSearch,
  onClearFilters,
  onClearScope,
  onViewLinkedKnowledge,
}) => {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)
  const [pageInput, setPageInput] = useState('')
  const [isScreenshotOpen, setIsScreenshotOpen] = useState(false)
  const selected = selectedCaptureDetail ?? captures.find(item => item.id === selectedCaptureId) ?? captures[0] ?? null
  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const screenshotUrl = selected?.screenshotPath ? `${apiBaseUrl}/api/bake/captures/${encodeURIComponent(selected.id)}/screenshot` : null
  const activeFilters = useMemo(() => {
    const items: string[] = []
    if (query.trim()) items.push(`关键词：${query.trim()}`)
    if (from) items.push(`开始：${from}`)
    if (to) items.push(`结束：${to}`)
    return items
  }, [from, query, to])

  useEffect(() => {
    if (!screenshotUrl && isScreenshotOpen) {
      setIsScreenshotOpen(false)
    }
  }, [isScreenshotOpen, screenshotUrl])

  useEffect(() => {
    if (!isScreenshotOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsScreenshotOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isScreenshotOpen])

  return (
    <div className="bake-split-list-detail bake-split-list-detail--capture">
      <BakeCard className="bake-capture-list-card">
        <BakeSectionHeader
          title="记忆片段"
          subtitle="浏览原始采集片段与关联知识"
        />

        <form
          className="bake-list-toolbar bake-list-toolbar--repository"
          onSubmit={(event) => {
            event.preventDefault()
            onSearch()
          }}
        >
          <div className="bake-list-toolbar__repository">
            <div className="bake-list-toolbar__repository-row bake-list-toolbar__repository-row--search">
              <label className="bake-form-field bake-filter-field bake-filter-field--search">
                <span className="bake-filter-label">关键词</span>
                <input
                  className="bake-input"
                  value={draftQuery}
                  onChange={(event) => onDraftQueryChange(event.target.value)}
                  placeholder="搜索标题、正文或 OCR"
                />
              </label>
              <div className="bake-list-toolbar__repository-actions bake-list-toolbar__repository-actions--search">
                <BakeButton compact primary type="submit">搜索</BakeButton>
              </div>
            </div>
            <div className="bake-list-toolbar__repository-row bake-list-toolbar__repository-row--dates">
              <label className="bake-form-field bake-filter-field">
                <span className="bake-filter-label">开始日期</span>
                <input
                  className="bake-input"
                  type="date"
                  value={draftFrom}
                  onChange={(event) => onDraftFromChange(event.target.value)}
                />
              </label>
              <label className="bake-form-field bake-filter-field">
                <span className="bake-filter-label">结束日期</span>
                <input
                  className="bake-input"
                  type="date"
                  value={draftTo}
                  onChange={(event) => onDraftToChange(event.target.value)}
                />
              </label>
              <div className="bake-list-toolbar__repository-actions bake-list-toolbar__repository-actions--secondary">
                {(draftQuery || draftFrom || draftTo || query || from || to || sourceCaptureId) && (
                  <BakeButton compact onClick={onClearFilters}>清除筛选</BakeButton>
                )}
              </div>
            </div>
          </div>
        </form>

        {(sourceCaptureId || activeFilters.length > 0) && (
          <div className="bake-filter-summary">
            {sourceCaptureId && <BakePill text={`仅看来源片段 #${sourceCaptureId}`} />}
            {activeFilters.map(item => <BakePill key={item} text={item} />)}
            {sourceCaptureId && <BakeButton compact onClick={onClearScope}>查看全部片段</BakeButton>}
          </div>
        )}

        <div className="bake-list bake-capture-list">
          {captures.length === 0 ? (
            <div className="bake-muted">当前筛选条件下没有可浏览的记忆片段。</div>
          ) : captures.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectCapture(item.id)}
              className={`bake-list-item bake-capture-list-item ${item.id === selected?.id ? 'bake-list-item--active' : ''}`.trim()}
            >
              <div className="bake-list-item__title bake-line-clamp-1">{item.summary || item.winTitle || `片段 #${item.id}`}</div>
              <div className="bake-muted bake-line-clamp-2">{item.bestText || item.axText || item.ocrText || '暂无正文'}</div>
              <div className="bake-memory-list-item__meta">
                <span>{item.appName || '未知应用'}</span>
                <span>{formatCaptureTime(item.ts)}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="bake-pagination bake-pagination--extended">
          <div className="bake-pagination__controls">
            <BakeButton compact onClick={() => onPageChange(Math.max(0, offset - limit))}>上一页</BakeButton>
            <BakeButton compact onClick={() => onPageChange(offset + limit)}>{offset + limit >= total ? '已到底' : '下一页'}</BakeButton>
          </div>
          <div className="bake-pagination__summary-group bake-muted">
            <span className="bake-pagination__summary">共 {total} 条</span>
            <span className="bake-pagination__summary">第 {page}/{totalPages} 页</span>
          </div>
          <div className="bake-pagination__right">
            <label className="bake-pagination__field">
              <span className="bake-muted">每页</span>
              <select
                className="bake-input bake-pagination__select"
                value={String(limit)}
                onChange={(event) => onLimitChange(Number(event.target.value))}
              >
                {[10, 20, 50, 100].map(option => (
                  <option key={option} value={option}>{option} 条</option>
                ))}
              </select>
            </label>
            <div className="bake-pagination__jump">
              <span className="bake-muted">第</span>
              <input
                className="bake-input bake-pagination__input"
                type="number"
                min={1}
                max={totalPages}
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                placeholder={String(page)}
              />
              <span className="bake-muted">页</span>
              <BakeButton
                compact
                onClick={() => {
                  const target = Number(pageInput)
                  if (!Number.isFinite(target) || target < 1) return
                  const nextPage = Math.min(totalPages, Math.floor(target))
                  onPageChange((nextPage - 1) * limit)
                  setPageInput('')
                }}
              >
                前往
              </BakeButton>
            </div>
          </div>
        </div>
      </BakeCard>

      <BakeCard className="bake-capture-detail-card">
        {selected ? (
          <div className="bake-kv bake-capture-detail">
            <div className="bake-inline-meta">
              <div>
                <div className="bake-title" style={{ fontSize: 18 }}>{selected.summary || selected.winTitle || `片段 #${selected.id}`}</div>
                <div className="bake-muted" style={{ marginTop: 4 }}>{selected.appName || '未知应用'} · {formatCaptureTime(selected.ts)}</div>
              </div>
              <BakePill text={`片段 #${selected.id}`} />
            </div>

            <div className="bake-grid-2 bake-capture-detail__meta-grid">
              <div className="bake-capture-detail__meta-card">
                <div className="bake-kv__title">窗口 / 页面</div>
                <div className="bake-muted" style={{ lineHeight: 1.7 }}>{selected.winTitle || '—'}</div>
              </div>
              <div className="bake-capture-detail__meta-card">
                <div className="bake-kv__title">记忆类型</div>
                <div className="bake-capture-detail__type-stack">
                  <div className="bake-capture-detail__type-primary">{selected.semanticTypeLabel || '未识别类型'}</div>
                  <div className="bake-muted">原始模态：{selected.rawTypeLabel || selected.eventType || '—'}</div>
                </div>
              </div>
            </div>

            <div>
              <div className="bake-kv__title">截图预览</div>
              {screenshotUrl ? (
                <div className="bake-capture-detail__screenshot-wrap">
                  <button
                    type="button"
                    className="bake-capture-detail__screenshot-button"
                    onClick={() => setIsScreenshotOpen(true)}
                  >
                    <img
                      className="bake-capture-detail__screenshot-image"
                      src={screenshotUrl}
                      alt={selected.summary || selected.winTitle || `片段 #${selected.id}`}
                      loading="lazy"
                    />
                    <span className="bake-capture-detail__screenshot-hint">点击查看大图</span>
                  </button>
                  <div className="bake-capture-detail__screenshot-path">{selected.screenshotPath}</div>
                </div>
              ) : (
                <div className="bake-muted">当前没有截图文件。</div>
              )}
            </div>

            <div>
              <div className="bake-kv__title">摘要</div>
              <div className="bake-capture-detail__text">{selected.bestText || selected.summary || '暂无摘要'}</div>
            </div>

            <div>
              <div className="bake-kv__title">AX 文本</div>
              <div className="bake-capture-detail__text">{selected.axText || '暂无 AX 文本'}</div>
            </div>

            <div>
              <div className="bake-kv__title">OCR 文本</div>
              <div className="bake-capture-detail__text">{selected.ocrText || '暂无 OCR 文本'}</div>
            </div>

            <div>
              <div className="bake-kv__title">输入 / 音频</div>
              <div className="bake-capture-detail__text">{selected.inputText || selected.audioText || '暂无输入或音频文本'}</div>
            </div>

            <div className="bake-actions">
              <BakeButton onClick={() => onViewLinkedKnowledge(selected.linkedKnowledgeId)}>
                {selected.linkedKnowledgeId ? '查看关联知识' : '暂无关联知识'}
              </BakeButton>
            </div>
          </div>
        ) : (
          <div className="bake-muted">暂无记忆片段详情</div>
        )}
      </BakeCard>

      {selected && screenshotUrl && isScreenshotOpen && (
        <div
          className="bake-capture-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="截图预览大图"
          onClick={() => setIsScreenshotOpen(false)}
        >
          <div
            className="bake-capture-lightbox__dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="bake-capture-lightbox__header">
              <div>
                <div className="bake-kv__title">截图大图</div>
                <div className="bake-muted">{selected.summary || selected.winTitle || `片段 #${selected.id}`}</div>
              </div>
              <BakeButton compact onClick={() => setIsScreenshotOpen(false)}>关闭</BakeButton>
            </div>
            <div className="bake-capture-lightbox__body">
              <img
                className="bake-capture-lightbox__image"
                src={screenshotUrl}
                alt={selected.summary || selected.winTitle || `片段 #${selected.id}`}
              />
            </div>
            <div className="bake-capture-lightbox__footer bake-muted">{selected.screenshotPath}</div>
          </div>
        </div>
      )}
    </div>
  )
}

export { parseDateInputToMs }

export default BakeCaptureTab
