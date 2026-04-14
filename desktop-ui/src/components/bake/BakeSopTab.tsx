import React, { useState } from 'react'
import type { BakeBucket, SopCandidate } from '../../types'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './BakeShared'

const confidenceLabel: Record<SopCandidate['confidence'], string> = {
  low: '低',
  medium: '中',
  high: '高',
}

const statusLabel: Record<SopCandidate['status'], string> = {
  candidate: '待采纳',
  confirmed: '已采纳',
  ignored: '已忽略',
}

const bucketMeta: Record<BakeBucket, { title: string; subtitle: string; empty: string }> = {
  extracted: {
    title: '已提炼',
    subtitle: '按高频问题与已有知识沉淀可复用流程',
    empty: '当前还没有已提炼操作手册。',
  },
  pending: {
    title: '待提炼',
    subtitle: '这里展示待确认候选，可决定采纳或忽略',
    empty: '当前还没有待提炼操作手册候选。',
  },
}

const buildPromptPreview = (candidate: SopCandidate) => {
  const title = candidate.extractedProblem || candidate.sourceTitle || '未命名问题'
  return `当用户提到“${title}”相关问题时，可按以下流程处理：${candidate.steps.join(' → ')}。回答时优先引用关联 Knowledge，并补充标准说明。`
}

const BakeSopTab: React.FC<{
  bucket: BakeBucket
  candidates: SopCandidate[]
  total: number
  limit: number
  offset: number
  query: string
  selectedSopId: string | null
  onSelectSop: (id: string | null) => void
  onBucketChange: (bucket: BakeBucket) => void
  onAdoptSop: (id: string) => void
  onIgnoreSop: (id: string) => void
  onDeleteSop: (id: string) => void
  onCopySteps: (candidate: SopCandidate) => void
  onCopyPrompt: (candidate: SopCandidate) => void
  onPageChange: (offset: number) => void
  onLimitChange: (limit: number) => void
  onQueryChange: (query: string) => void
}> = ({
  bucket,
  candidates,
  total,
  limit,
  offset,
  query,
  selectedSopId,
  onSelectSop,
  onBucketChange,
  onAdoptSop,
  onIgnoreSop,
  onDeleteSop,
  onCopySteps,
  onCopyPrompt,
  onPageChange,
  onLimitChange,
  onQueryChange,
}) => {
  const selected = candidates.find(item => item.id === selectedSopId) ?? candidates[0]
  const [pageInput, setPageInput] = useState('')
  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="bake-split-list-detail bake-split-list-detail--sop">
      <BakeCard className="bake-knowledge-list-card">
        <BakeSectionHeader
          title="操作手册（火腿）"
          subtitle={bucketMeta[bucket].subtitle}
          right={(
            <div className="bake-segmented-actions">
              <BakeButton compact active={bucket === 'extracted'} onClick={() => onBucketChange('extracted')}>已提炼</BakeButton>
              <BakeButton compact active={bucket === 'pending'} onClick={() => onBucketChange('pending')}>待提炼</BakeButton>
            </div>
          )}
        />
        <div className="bake-list-toolbar">
          <div className="bake-list-toolbar__filters">
            <label className="bake-form-field bake-filter-field bake-filter-field--search">
              <span className="bake-filter-label">关键词</span>
              <input
                className="bake-input"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="搜索问题、来源或关键词"
              />
            </label>
          </div>
          <div className="bake-list-toolbar__meta">
            {query && <BakeButton compact onClick={() => onQueryChange('')}>清除筛选</BakeButton>}
            <BakePill text={bucketMeta[bucket].title} />
            <BakePill text={`第 ${page}/${totalPages} 页`} />
          </div>
        </div>
        <div className="bake-list bake-knowledge-list">
          {candidates.length === 0 ? (
            <div className="bake-muted">{query.trim() ? '当前筛选条件下没有操作手册。' : bucketMeta[bucket].empty}</div>
          ) : candidates.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectSop(item.id)}
              className={`bake-list-item bake-knowledge-list-item ${item.id === selected?.id ? 'bake-list-item--active' : ''}`.trim()}
            >
              <div className="bake-inline-meta">
                <div style={{ minWidth: 0 }}>
                  <div className="bake-list-item__title bake-line-clamp-2">{item.extractedProblem || item.sourceTitle || '未命名问题'}</div>
                  <div className="bake-muted bake-line-clamp-1">关键词：{item.triggerKeywords.join(' / ') || '暂无'}</div>
                </div>
                <BakePill text={statusLabel[item.status]} />
              </div>
              <div className="bake-inline-pills">
                <BakePill text={`置信度 ${confidenceLabel[item.confidence]}`} />
                <BakePill text={`关联知识 ${item.linkedKnowledgeIds.length}`} />
              </div>
            </button>
          ))}
        </div>
        <div className="bake-pagination bake-pagination--extended">
          <div className="bake-pagination__controls">
            <BakeButton compact onClick={() => onPageChange(Math.max(0, offset - limit))}>上一页</BakeButton>
            <BakeButton compact onClick={() => onPageChange(offset + limit)}>{offset + limit >= total ? '已到底' : '下一页'}</BakeButton>
          </div>
          <div className="bake-pagination__summary bake-muted">操作手册共 {total} 条</div>
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
          <div className="bake-kv bake-knowledge-detail">
            <div className="bake-inline-meta">
              <div>
                <div className="bake-title" style={{ fontSize: 18 }}>{selected.extractedProblem || selected.sourceTitle || '未命名问题'}</div>
                <div className="bake-muted" style={{ marginTop: 4 }}>来源：{selected.sourceTitle || '—'} · 置信度：{confidenceLabel[selected.confidence]}</div>
              </div>
              <div className="bake-inline-pills">
                <BakePill text={bucketMeta[bucket].title} />
                <BakePill text={statusLabel[selected.status]} />
              </div>
            </div>
            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">触发关键词</div>
              <div className="bake-memory-detail__stats">
                {selected.triggerKeywords.length > 0 ? selected.triggerKeywords.map(keyword => (
                  <span key={keyword} className="bake-stat-chip">{keyword}</span>
                )) : <span className="bake-muted">暂无触发关键词</span>}
              </div>
            </div>
            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">处理步骤</div>
              <div className="bake-list">
                {selected.steps.length > 0 ? selected.steps.map((step, idx) => (
                  <div key={`${selected.id}-${idx}`} className="bake-list-item">
                    <div className="bake-muted">{idx + 1}. {step}</div>
                  </div>
                )) : <div className="bake-muted">暂无处理步骤</div>}
              </div>
            </div>
            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">关联 Knowledge</div>
              <div className="bake-muted">{selected.linkedKnowledgeIds.join('、') || '暂无'}</div>
            </div>
            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">工作提示预览</div>
              <div className="bake-muted" style={{ lineHeight: 1.7 }}>{buildPromptPreview(selected)}</div>
            </div>
            <div className="bake-actions--primary">
              {bucket === 'pending' && (
                <BakeButton primary onClick={() => onAdoptSop(selected.id)}>采纳为操作手册</BakeButton>
              )}
              {bucket === 'extracted' && (
                <BakeButton primary onClick={() => onAdoptSop(selected.id)}>更新采纳状态</BakeButton>
              )}
              {bucket === 'pending'
                ? <BakeButton onClick={() => onIgnoreSop(selected.id)}>忽略候选</BakeButton>
                : <BakeButton onClick={() => onDeleteSop(selected.id)}>删除操作手册</BakeButton>}
              <BakeButton compact onClick={() => onCopySteps(selected)}>复制流程</BakeButton>
              <BakeButton compact onClick={() => onCopyPrompt(selected)}>复制工作提示</BakeButton>
            </div>
          </div>
        ) : (
          <div className="bake-muted">暂无操作手册</div>
        )}
      </BakeCard>
    </div>
  )
}

export default BakeSopTab
