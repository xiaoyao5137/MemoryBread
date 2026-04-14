import React from 'react'
import type { EpisodicMemoryItem } from '../../types'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './BakeShared'

const PAGE_SIZE = 20

const formatMemoryTime = (item: Pick<EpisodicMemoryItem, 'createdAt' | 'createdAtMs'>) => {
  if (item.createdAtMs > 0) {
    return new Date(item.createdAtMs).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }
  return item.createdAt || '创建时间未知'
}

const formatMatchPill = (label: string, score?: number, level?: string) => (
  score != null && level
    ? `${label}匹配 ${score.toFixed(2)} / ${level}`
    : `${label}匹配 未命中`
)

const BakeMemoriesTab: React.FC<{
  memories: EpisodicMemoryItem[]
  total: number
  offset: number
  selectedMemoryId: string | null
  onSelectMemory: (id: string | null) => void
  onPageChange: (offset: number) => void
  onPromoteToTemplate: (id: string) => void
  onPromoteToSop: (id: string) => void
  onPromoteToKnowledge: (id: string) => void
  onIgnoreMemory: (id: string) => void
  onCopyMemory: (memory: EpisodicMemoryItem) => void
  onOpenMemoryLink: (url?: string, sourceCaptureId?: string) => void
  onInitializeMemories: () => void
  isInitializing: boolean
}> = ({
  memories,
  total,
  offset,
  selectedMemoryId,
  onSelectMemory,
  onPageChange,
  onPromoteToTemplate,
  onPromoteToSop,
  onPromoteToKnowledge,
  onIgnoreMemory,
  onCopyMemory,
  onOpenMemoryLink,
  onInitializeMemories,
  isInitializing,
}) => {
  const selected = memories.find(item => item.id === selectedMemoryId) ?? memories[0]
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasPrev = offset > 0
  const hasNext = offset + PAGE_SIZE < total

  return (
    <div className="bake-split-list-detail bake-split-list-detail--memories-fixed">
      <BakeCard className="bake-memory-list-card bake-memory-list-card--fixed">
        <BakeSectionHeader
          title="情节记忆"
          subtitle="左侧只展示 20 条，选中后在下方完成提炼与查看来源记忆片段"
        />
        {memories.length === 0 ? (
          <div className="bake-kv">
            <div className="bake-muted">当前还没有初始化出的情节记忆，可以基于现有 knowledge 与关联 capture 回填一批候选。</div>
            <div className="bake-actions">
              <BakeButton primary onClick={onInitializeMemories}>{isInitializing ? '初始化中…' : '初始化情节记忆'}</BakeButton>
            </div>
          </div>
        ) : (
          <>
            <div className="bake-list bake-memory-list bake-memory-list--paged">
              {memories.map(item => {
                const active = item.id === selected?.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectMemory(item.id)}
                    className={`bake-list-item bake-memory-list-item bake-memory-list-item--compact ${active ? 'bake-list-item--active' : ''}`.trim()}
                  >
                    <div className="bake-list-item__title bake-line-clamp-1">{item.title}</div>
                    <div className="bake-muted bake-line-clamp-2">{item.summary || '暂无摘要'}</div>
                    <div className="bake-memory-list-item__meta">
                      <span>创建于 {formatMemoryTime(item)}</span>
                      <span>权重 {item.weight}</span>
                      <span>打开 {item.openCount} 次</span>
                      <span>停留 {item.dwellSeconds}s</span>
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="bake-pagination bake-pagination--extended">
              <div className="bake-pagination__controls">
                <BakeButton compact disabled={!hasPrev} onClick={() => onPageChange(Math.max(0, offset - PAGE_SIZE))}>上一页</BakeButton>
                <BakeButton compact disabled={!hasNext} onClick={() => onPageChange(offset + PAGE_SIZE)}>下一页</BakeButton>
              </div>
              <div className="bake-pagination__summary-group bake-muted">
                <span className="bake-pagination__summary">共 {total} 条</span>
                <span className="bake-pagination__summary">第 {page}/{totalPages} 页</span>
              </div>
            </div>
          </>
        )}
      </BakeCard>

      <BakeCard className="bake-memory-detail-card bake-memory-detail-card--stacked">
        {selected ? (
          <div className="bake-memory-detail bake-memory-detail--fixed">
            <div className="bake-memory-detail__header-block">
              <div className="bake-inline-meta">
                <div style={{ minWidth: 0 }}>
                  <div className="bake-title" style={{ fontSize: 20, lineHeight: 1.4 }}>{selected.title}</div>
                  <div className="bake-muted bake-line-clamp-1" style={{ marginTop: 6 }}>{selected.url || `片段 #${selected.sourceCaptureId || '—'}`}</div>
                </div>
                <BakePill text={`建议：${selected.suggestedAction || 'template'}`} />
              </div>
              <div className="bake-memory-detail__stats">
                <span className="bake-stat-chip">创建于 {formatMemoryTime(selected)}</span>
                <span className="bake-stat-chip">权重 {selected.weight}</span>
                <span className="bake-stat-chip">打开 {selected.openCount} 次</span>
                <span className="bake-stat-chip">停留 {selected.dwellSeconds}s</span>
                <span className="bake-stat-chip">重复观察 {selected.knowledgeRefCount} 次</span>
              </div>
            </div>

            <div className="bake-kv bake-memory-detail__content-block">
              <div>
                <div className="bake-kv__title">系统判断原因</div>
                <div className="bake-muted" style={{ lineHeight: 1.8 }}>
                  最近 7 天访问 {selected.openCount} 次，累计停留 {selected.dwellSeconds}s，
                  {selected.hasEditAction ? '存在编辑行为，' : '暂无编辑行为，'}
                  已被重复观察 {selected.knowledgeRefCount} 次。
                </div>
              </div>
              <div>
                <div className="bake-kv__title">自动提炼匹配</div>
                <div className="bake-actions bake-actions--secondary" style={{ marginTop: 8 }}>
                  <BakePill text={formatMatchPill('知识', selected.knowledgeMatchScore, selected.knowledgeMatchLevel)} />
                  <BakePill text={formatMatchPill('模板', selected.templateMatchScore, selected.templateMatchLevel)} />
                  <BakePill text={formatMatchPill('SOP ', selected.sopMatchScore, selected.sopMatchLevel)} />
                </div>
              </div>
              <div>
                <div className="bake-kv__title">摘要概览</div>
                <div className="bake-muted" style={{ lineHeight: 1.8 }}>{selected.summary || '暂无摘要'}</div>
              </div>
            </div>

            <div className="bake-memory-detail__stack">
              <div className="bake-memory-action-card bake-memory-action-card--primary">
                <div>
                  <div className="bake-kv__title">提炼</div>
                  <div className="bake-muted" style={{ marginTop: 4, lineHeight: 1.7 }}>将当前情节记忆加工为稳定、可复用的内容资产，三种提炼方式同级处理。</div>
                </div>
                <div className="bake-actions bake-actions--primary bake-memory-detail__action-copy">
                  <BakeButton onClick={() => onPromoteToTemplate(selected.id)}>文档模板（面包片）</BakeButton>
                  <BakeButton onClick={() => onPromoteToSop(selected.id)}>操作手册（火腿）</BakeButton>
                  <BakeButton onClick={() => onPromoteToKnowledge(selected.id)}>知识</BakeButton>
                </div>
              </div>

              <div className="bake-memory-action-card bake-memory-action-card--secondary">
                <div>
                  <div className="bake-kv__title">辅助操作</div>
                  <div className="bake-muted" style={{ marginTop: 4, lineHeight: 1.7 }}>回看来源记忆片段、复制链接与忽略操作单独放置，避免和提炼动作混在一起。</div>
                </div>
                <div className="bake-actions bake-actions--secondary bake-memory-detail__action-copy">
                  <BakeButton compact onClick={() => onOpenMemoryLink(selected.url, selected.sourceCaptureId)}>来源记忆片段</BakeButton>
                  <BakeButton compact onClick={() => onCopyMemory(selected)}>复制标题/链接</BakeButton>
                  <BakeButton compact onClick={() => onIgnoreMemory(selected.id)}>忽略</BakeButton>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bake-muted">暂无情节记忆</div>
        )}
      </BakeCard>
    </div>
  )
}

export default BakeMemoriesTab
