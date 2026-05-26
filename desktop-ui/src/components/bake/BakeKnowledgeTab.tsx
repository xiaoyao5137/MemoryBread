import React, { useMemo, useState } from 'react'
import type { BakeKnowledgeItem } from '../../types'
import { BakeButton, BakeCard, BakeMarkdown, BakePill, BakeSectionHeader } from './BakeShared'

const BakeKnowledgeTab: React.FC<{
  items: BakeKnowledgeItem[]
  total: number
  limit: number
  offset: number
  query: string
  draftQuery: string
  selectedKnowledgeId: string | null
  onSelectKnowledge: (id: string | null) => void
  onPageChange: (offset: number) => void
  onLimitChange: (limit: number) => void
  onDraftQueryChange: (query: string) => void
  onSearch: () => void
  onClearFilters: () => void
  onDeleteKnowledge: (id: string) => void
  onOpenCapture: (captureId?: string) => void
  onCreateKnowledge?: (knowledge: Partial<BakeKnowledgeItem>) => void
}> = ({
  items,
  total,
  limit,
  offset,
  query,
  draftQuery,
  selectedKnowledgeId,
  onSelectKnowledge,
  onPageChange,
  onLimitChange,
  onDraftQueryChange,
  onSearch,
  onClearFilters,
  onDeleteKnowledge,
  onOpenCapture,
  onCreateKnowledge,
}) => {
  const selected = items.find(item => item.id === selectedKnowledgeId) ?? items[0]
  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const [pageInput, setPageInput] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newKnowledge, setNewKnowledge] = useState({
    summary: '',
    overview: '',
    details: '',
    category: '',
    importance: 5,
  })
  const filterPills = useMemo(() => {
    const pills: string[] = []
    if (query.trim()) pills.push(`关键词：${query.trim()}`)
    return pills
  }, [query])

  const handleCreate = () => {
    if (!newKnowledge.summary.trim()) return
    onCreateKnowledge?.({
      ...newKnowledge,
      id: `knowledge-manual-${Date.now()}`,
      captureId: '',
      entities: [],
      occurrenceCount: 1,
      status: 'confirmed',
      reviewStatus: 'confirmed',
      updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      updatedAtMs: Date.now(),
    })
    setShowCreateDialog(false)
    setNewKnowledge({
      summary: '',
      overview: '',
      details: '',
      category: '',
      importance: 5,
    })
  }

  return (
    <>
      <BakeCard>
        <BakeSectionHeader
          title="知识"
          subtitle="浏览已提炼的知识条目，并追溯其来源采集记录"
          right={onCreateKnowledge && <BakeButton primary onClick={() => setShowCreateDialog(true)}>新建知识</BakeButton>}
        />
        <div className="bake-list-toolbar">
          <div className="bake-list-toolbar__filters">
            <label className="bake-form-field bake-filter-field bake-filter-field--search">
              <span className="bake-filter-label">关键词</span>
              <input
                className="bake-input"
                value={draftQuery}
                onChange={(event) => onDraftQueryChange(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && onSearch()}
                placeholder="搜索知识摘要、概述、详情或分类"
              />
            </label>
          </div>
          <div className="bake-list-toolbar__actions">
            <BakeButton compact primary onClick={onSearch}>搜索</BakeButton>
            {(draftQuery || query) && <BakeButton compact onClick={onClearFilters}>清除筛选</BakeButton>}
          </div>
        </div>
        {filterPills.length > 0 && (
          <div className="bake-filter-summary">
            {filterPills.map(item => <BakePill key={item} text={item} />)}
          </div>
        )}
      </BakeCard>
      <div className="bake-split-list-detail bake-split-list-detail--knowledge">
        <BakeCard className="bake-knowledge-list-card">
        <div className="bake-list bake-knowledge-list">
          {items.length === 0 ? (
            <div className="bake-muted">{query.trim() ? '当前筛选条件下没有可展示的知识条目。' : '当前还没有知识条目。'}</div>
          ) : items.map(item => {
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectKnowledge(item.id)}
                className={`bake-list-item bake-knowledge-list-item ${item.id === selected?.id ? 'bake-list-item--active' : ''}`.trim()}
              >
                <div className="bake-list-item__title bake-line-clamp-2">{item.summary}</div>
                <div className="bake-muted bake-line-clamp-2">{item.overview || '暂无概述'}</div>
                <div className="bake-memory-list-item__meta">
                  <span>{item.category || '未分类'}</span>
                  <span>重要度 {item.importance}</span>
                  <span>重复观察 {item.occurrenceCount} 次</span>
                  {item.matchLevel && <span>{item.matchLevel}</span>}
                  {item.matchScore != null && <span>匹配 {item.matchScore.toFixed(2)}</span>}
                </div>
              </button>
            )
          })}
        </div>
        <div className="bake-pagination bake-pagination--extended">
          <div className="bake-pagination__controls">
            <BakeButton compact onClick={() => onPageChange(Math.max(0, offset - limit))}>上一页</BakeButton>
            <BakeButton compact onClick={() => onPageChange(offset + limit)}>{offset + limit >= total ? '已到底' : '下一页'}</BakeButton>
          </div>
          <div className="bake-pagination__summary-group bake-muted">
            <span className="bake-pagination__summary">知识条目共 {total} 条</span>
            <span className="bake-pagination__summary">第 {page}/{totalPages} 页</span>
          </div>
          <div className="bake-pagination__right">
            <label className="bake-pagination__field">
              <span className="bake-muted">每页</span>
              <select className="bake-input bake-pagination__select" value={String(limit)} onChange={(event) => onLimitChange(Number(event.target.value))}>
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
              <BakeButton compact onClick={() => {
                const target = Number(pageInput)
                if (!Number.isFinite(target) || target < 1) return
                const nextPage = Math.min(totalPages, Math.floor(target))
                onPageChange((nextPage - 1) * limit)
                setPageInput('')
              }}>前往</BakeButton>
            </div>
          </div>
        </div>
      </BakeCard>

      <BakeCard className="bake-knowledge-detail-card">
        {selected ? (
          <div className="bake-kv bake-capture-detail bake-knowledge-detail">
            <div className="bake-inline-meta">
              <div>
                <div className="bake-title" style={{ fontSize: 18 }}>{selected.summary}</div>
                <div className="bake-muted" style={{ marginTop: 4 }}>
                  分类：{selected.category || '—'} · 片段 #{selected.captureId}
                </div>
              </div>
              <div className="bake-inline-pills">
                {selected.matchLevel && <BakePill text={selected.matchLevel} />}
                {selected.matchScore != null && <BakePill text={`匹配 ${selected.matchScore.toFixed(2)}`} />}
              </div>
            </div>
            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">概述</div>
              <div className="bake-muted" style={{ lineHeight: 1.7 }}>{selected.overview || '暂无概述'}</div>
            </div>
            {selected.detailedContent && (
              <div className="bake-knowledge-detail__section">
                <div className="bake-kv__title">详细内容</div>
                <BakeMarkdown content={selected.detailedContent} />
              </div>
            )}
            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">元数据</div>
              <div className="bake-muted" style={{ lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                {(() => {
                  if (!selected.details) return '暂无元数据'
                  try {
                    const parsed = JSON.parse(selected.details)
                    return JSON.stringify(parsed, null, 2)
                  } catch {
                    return selected.details
                  }
                })()}
              </div>
            </div>
            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">提炼状态</div>
              <div className="bake-memory-detail__stats">
                {selected.matchScore != null && <span className="bake-stat-chip">匹配分：{selected.matchScore.toFixed(2)}</span>}
                {selected.matchLevel && <span className="bake-stat-chip">匹配等级：{selected.matchLevel}</span>}
                <span className="bake-stat-chip">重复观察：{selected.occurrenceCount} 次</span>
              </div>
            </div>
            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">实体 / 标签</div>
              <div className="bake-memory-detail__stats">
                {selected.entities.length > 0 ? selected.entities.map(entity => (
                  <span key={entity} className="bake-stat-chip">{entity}</span>
                )) : <span className="bake-muted">暂无实体</span>}
              </div>
            </div>
            <div className="bake-actions--primary">
              <BakeButton onClick={() => onOpenCapture(selected.captureId)}>来源采集记录</BakeButton>
              <BakeButton onClick={() => onDeleteKnowledge(selected.id)}>删除知识</BakeButton>
            </div>
          </div>
        ) : (
          <div className="bake-muted">暂无知识条目</div>
        )}
      </BakeCard>
      </div>
      {showCreateDialog && (
        <div className="bake-modal-overlay" onClick={() => setShowCreateDialog(false)}>
          <div className="bake-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bake-modal__header">
              <h3>新建知识</h3>
              <button className="bake-modal__close" onClick={() => setShowCreateDialog(false)}>×</button>
            </div>
            <div className="bake-modal__body">
              <label className="bake-form-field">
                <span className="bake-form-label">摘要 *</span>
                <input
                  className="bake-input"
                  value={newKnowledge.summary}
                  onChange={(e) => setNewKnowledge({ ...newKnowledge, summary: e.target.value })}
                  placeholder="简短描述这条知识"
                />
              </label>
              <label className="bake-form-field">
                <span className="bake-form-label">概述</span>
                <textarea
                  className="bake-textarea"
                  rows={3}
                  value={newKnowledge.overview}
                  onChange={(e) => setNewKnowledge({ ...newKnowledge, overview: e.target.value })}
                  placeholder="对知识的概括性说明"
                />
              </label>
              <label className="bake-form-field">
                <span className="bake-form-label">详细内容</span>
                <textarea
                  className="bake-textarea"
                  rows={6}
                  value={newKnowledge.details}
                  onChange={(e) => setNewKnowledge({ ...newKnowledge, details: e.target.value })}
                  placeholder="详细的知识内容，支持 Markdown 格式"
                />
              </label>
              <label className="bake-form-field">
                <span className="bake-form-label">分类</span>
                <input
                  className="bake-input"
                  value={newKnowledge.category}
                  onChange={(e) => setNewKnowledge({ ...newKnowledge, category: e.target.value })}
                  placeholder="如：技术、业务、流程等"
                />
              </label>
              <label className="bake-form-field">
                <span className="bake-form-label">重要度 (1-10)</span>
                <input
                  className="bake-input"
                  type="number"
                  min={1}
                  max={10}
                  value={newKnowledge.importance}
                  onChange={(e) => setNewKnowledge({ ...newKnowledge, importance: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="bake-modal__footer">
              <BakeButton onClick={() => setShowCreateDialog(false)}>取消</BakeButton>
              <BakeButton primary onClick={handleCreate} disabled={!newKnowledge.summary.trim()}>创建</BakeButton>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default BakeKnowledgeTab
