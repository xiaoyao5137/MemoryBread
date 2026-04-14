import React, { useEffect, useMemo, useState } from 'react'
import type { ArticleTemplate, BakeBucket } from '../../types'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './BakeShared'

const formatTemplateStatus = (status: ArticleTemplate['status']) => {
  if (status === 'enabled') return '已启用'
  if (status === 'pending_review') return '待确认'
  if (status === 'disabled') return '已停用'
  if (status === 'auto_generated') return '自动生成'
  return '草稿'
}

const formatReviewStatus = (status?: string) => {
  if (!status) return '状态未知'
  if (status === 'candidate') return '待提炼'
  if (status === 'confirmed') return '已确认'
  if (status === 'auto_created') return '自动入库'
  if (status === 'pending_review') return '待复核'
  if (status === 'ignored') return '已忽略'
  if (status === 'draft') return '草稿'
  return status
}

const bucketMeta: Record<BakeBucket, { title: string; subtitle: string; empty: string }> = {
  extracted: {
    title: '已提炼',
    subtitle: '内容生成时会优先参考这些已入库模板',
    empty: '当前还没有已提炼模板。',
  },
  pending: {
    title: '待提炼',
    subtitle: '这里展示待确认候选模板，可直接调整后入库',
    empty: '当前还没有待提炼模板候选。',
  },
}

const BakeTemplatesTab: React.FC<{
  bucket: BakeBucket
  templates: ArticleTemplate[]
  total: number
  limit: number
  offset: number
  query: string
  selectedTemplateId: string | null
  onSelectTemplate: (id: string | null) => void
  onBucketChange: (bucket: BakeBucket) => void
  onCreateTemplate: () => void
  onUpdateTemplate: (templateId: string, updater: (template: ArticleTemplate) => ArticleTemplate) => void
  onToggleTemplateStatus: (templateId: string) => void
  onDeleteTemplate: (templateId: string) => void
  onViewSourceMemory: (memoryId?: string) => void
  onPageChange: (offset: number) => void
  onLimitChange: (limit: number) => void
  onQueryChange: (query: string) => void
}> = ({
  bucket,
  templates,
  total,
  limit,
  offset,
  query,
  selectedTemplateId,
  onSelectTemplate,
  onBucketChange,
  onCreateTemplate,
  onUpdateTemplate,
  onToggleTemplateStatus,
  onDeleteTemplate,
  onViewSourceMemory,
  onPageChange,
  onLimitChange,
  onQueryChange,
}) => {
  const selected = templates.find(item => item.id === selectedTemplateId) ?? templates[0]
  const [isEditing, setIsEditing] = useState(false)
  const [pageInput, setPageInput] = useState('')
  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const editingValues = useMemo(() => ({
    name: selected?.name || '',
    category: selected?.category || '',
    promptHint: selected?.promptHint || '',
    structureSections: selected?.structureSections.map(section => section.title).join('\n') || '',
    stylePhrases: selected?.stylePhrases.join('\n') || '',
    replacementRules: selected?.replacementRules.map(item => `${item.from} => ${item.to}`).join('\n') || '',
  }), [selected])

  const [draftName, setDraftName] = useState('')
  const [draftCategory, setDraftCategory] = useState('')
  const [draftPromptHint, setDraftPromptHint] = useState('')
  const [draftStructureSections, setDraftStructureSections] = useState('')
  const [draftStylePhrases, setDraftStylePhrases] = useState('')
  const [draftReplacementRules, setDraftReplacementRules] = useState('')

  useEffect(() => {
    setDraftName(editingValues.name)
    setDraftCategory(editingValues.category)
    setDraftPromptHint(editingValues.promptHint)
    setDraftStructureSections(editingValues.structureSections)
    setDraftStylePhrases(editingValues.stylePhrases)
    setDraftReplacementRules(editingValues.replacementRules)
    setIsEditing(false)
  }, [editingValues])

  const handleSave = () => {
    if (!selected) return
    onUpdateTemplate(selected.id, template => ({
      ...template,
      name: draftName.trim() || template.name,
      category: draftCategory.trim() || template.category,
      promptHint: draftPromptHint.trim(),
      structureSections: draftStructureSections
        .split('\n')
        .map(item => item.trim())
        .filter(Boolean)
        .map(title => ({ title, keywords: [] })),
      stylePhrases: draftStylePhrases
        .split('\n')
        .map(item => item.trim())
        .filter(Boolean),
      replacementRules: draftReplacementRules
        .split('\n')
        .map(item => item.trim())
        .filter(Boolean)
        .map(line => {
          const [from, to] = line.split('=>').map(item => item.trim())
          return { from: from || line, to: to || '' }
        }),
      updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    }))
    setIsEditing(false)
  }

  return (
    <div className="bake-split-list-detail bake-split-list-detail--templates">
      <BakeCard className="bake-knowledge-list-card">
        <BakeSectionHeader
          title="文档模板（面包片）"
          subtitle={bucketMeta[bucket].subtitle}
          right={(
            <div className="bake-section-header__actions">
              <div className="bake-segmented-actions">
                <BakeButton compact active={bucket === 'extracted'} onClick={() => onBucketChange('extracted')}>已提炼</BakeButton>
                <BakeButton compact active={bucket === 'pending'} onClick={() => onBucketChange('pending')}>待提炼</BakeButton>
              </div>
              <BakeButton primary onClick={onCreateTemplate}>新建模板</BakeButton>
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
                placeholder="搜索模板名称、分类或提示词"
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
          {templates.length === 0 ? (
            <div className="bake-muted">{query.trim() ? '当前筛选条件下没有模板。' : bucketMeta[bucket].empty}</div>
          ) : templates.map(item => {
            const active = item.id === selected?.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTemplate(item.id)}
                className={`bake-list-item bake-knowledge-list-item ${active ? 'bake-list-item--active' : ''}`.trim()}
              >
                <div className="bake-inline-meta">
                  <div style={{ minWidth: 0 }}>
                    <div className="bake-list-item__title bake-line-clamp-2">{item.name}</div>
                    <div className="bake-muted bake-line-clamp-1">{item.category} · 使用 {item.usageCount} 次</div>
                  </div>
                  <BakePill text={formatTemplateStatus(item.status)} />
                </div>
                <div className="bake-inline-pills">
                  <BakePill text={formatReviewStatus(item.reviewStatus)} />
                  {item.matchLevel && <BakePill text={item.matchLevel} />}
                  {item.matchScore != null && <BakePill text={`匹配分 ${item.matchScore.toFixed(2)}`} />}
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
          <div className="bake-pagination__summary bake-muted">模板共 {total} 条</div>
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
                <div className="bake-title" style={{ fontSize: 18 }}>{selected.name}</div>
                <div className="bake-muted" style={{ marginTop: 4 }}>{selected.category} · 最近更新 {selected.updatedAt || '—'}</div>
              </div>
              <div className="bake-inline-pills">
                <BakePill text={bucketMeta[bucket].title} />
                <BakePill text={formatTemplateStatus(selected.status)} />
                <BakePill text={formatReviewStatus(selected.reviewStatus)} />
              </div>
            </div>

            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">提炼状态</div>
              <div className="bake-memory-detail__stats">
                <span className="bake-stat-chip">复核：{formatReviewStatus(selected.reviewStatus)}</span>
                {selected.matchScore != null && <span className="bake-stat-chip">匹配分：{selected.matchScore.toFixed(2)}</span>}
                {selected.matchLevel && <span className="bake-stat-chip">匹配等级：{selected.matchLevel}</span>}
                <span className="bake-stat-chip">来源记忆：{selected.sourceMemoryIds.length}</span>
                <span className="bake-stat-chip">关联知识：{selected.linkedKnowledgeIds.length}</span>
              </div>
            </div>

            {isEditing ? (
              <div className="bake-grid-2">
                <label className="bake-form-field">
                  <span className="bake-kv__title">模板名称</span>
                  <input value={draftName} onChange={(event) => setDraftName(event.target.value)} className="bake-input" />
                </label>
                <label className="bake-form-field">
                  <span className="bake-kv__title">模板分类</span>
                  <input value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)} className="bake-input" />
                </label>
                <label className="bake-form-field bake-form-field--full">
                  <span className="bake-kv__title">提示词说明</span>
                  <textarea value={draftPromptHint} onChange={(event) => setDraftPromptHint(event.target.value)} className="bake-textarea" rows={3} />
                </label>
                <label className="bake-form-field">
                  <span className="bake-kv__title">结构字段（每行一项）</span>
                  <textarea value={draftStructureSections} onChange={(event) => setDraftStructureSections(event.target.value)} className="bake-textarea" rows={6} />
                </label>
                <label className="bake-form-field">
                  <span className="bake-kv__title">风格短语（每行一项）</span>
                  <textarea value={draftStylePhrases} onChange={(event) => setDraftStylePhrases(event.target.value)} className="bake-textarea" rows={6} />
                </label>
                <label className="bake-form-field bake-form-field--full">
                  <span className="bake-kv__title">替换规则（格式：原词 =&gt; 替代词）</span>
                  <textarea value={draftReplacementRules} onChange={(event) => setDraftReplacementRules(event.target.value)} className="bake-textarea" rows={5} />
                </label>
              </div>
            ) : (
              <>
                <div className="bake-knowledge-detail__section">
                  <div className="bake-kv__title">结构字段</div>
                  <div className="bake-list">
                    {selected.structureSections.length > 0 ? selected.structureSections.map(section => (
                      <div key={section.title} className="bake-list-item">
                        <div className="bake-list-item__title">{section.title}</div>
                        <div className="bake-muted">关键词：{section.keywords.join(' / ') || '未设置'}</div>
                      </div>
                    )) : <div className="bake-muted">暂无结构字段</div>}
                  </div>
                </div>

                <div className="bake-knowledge-detail__section">
                  <div className="bake-kv__title">风格字段</div>
                  <div className="bake-muted">常用口语：{selected.stylePhrases.join('、') || '—'}</div>
                  <div className="bake-muted" style={{ marginTop: 6 }}>
                    AI 替代词：{selected.replacementRules.map(item => `${item.from} → ${item.to}`).join('；') || '—'}
                  </div>
                  <div className="bake-muted" style={{ marginTop: 6 }}>提示词：{selected.promptHint || '—'}</div>
                </div>
              </>
            )}

            <div className="bake-knowledge-detail__section">
              <div className="bake-kv__title">关联资产</div>
              <div className="bake-muted">来源情节记忆 {selected.sourceMemoryIds.length} 条 · 关联 Knowledge {selected.linkedKnowledgeIds.length} 条</div>
            </div>

            <div className="bake-actions--primary">
              {isEditing ? (
                <>
                  <BakeButton primary onClick={handleSave}>保存模板</BakeButton>
                  <BakeButton onClick={() => setIsEditing(false)}>取消编辑</BakeButton>
                </>
              ) : (
                <>
                  <BakeButton primary onClick={() => setIsEditing(true)}>编辑模板</BakeButton>
                  <BakeButton onClick={() => onToggleTemplateStatus(selected.id)}>{selected.status === 'enabled' ? '停用' : '启用'}</BakeButton>
                  <BakeButton onClick={() => onDeleteTemplate(selected.id)}>{bucket === 'pending' ? '移出候选' : '删除模板'}</BakeButton>
                  <BakeButton compact onClick={() => onViewSourceMemory(selected.sourceMemoryIds[0])}>查看来源情节记忆</BakeButton>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="bake-muted">暂无模板</div>
        )}
      </BakeCard>
    </div>
  )
}

export default BakeTemplatesTab
