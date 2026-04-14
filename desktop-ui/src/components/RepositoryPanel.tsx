import React, { useEffect, useMemo, useState } from 'react'
import {
  useFetchBakeMemories,
  useFetchBakeCaptureDetail,
  useFetchBakeCaptures,
} from '../hooks/useApi'
import { useAppStore } from '../store/useAppStore'
import type { BakeCaptureItem, EpisodicMemoryItem, RepositoryTab } from '../types'
import BakeCaptureTab, { parseDateInputToMs } from './bake/BakeCaptureTab'
import BakeHeader from './bake/BakeHeader'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './bake/BakeShared'
import './bake/BakePanel.css'

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

const RepositoryPanel: React.FC = () => {
  const {
    repositoryTab,
    selectedMemoryId,
    selectedCaptureId,
    bakeMemoryOffset,
    bakeCaptureOffset,
    repositoryMemoryQuery,
    repositoryMemoryFrom,
    repositoryMemoryTo,
    repositoryMemoryLimit,
    repositoryCaptureQuery,
    repositoryCaptureFrom,
    repositoryCaptureTo,
    repositoryCaptureLimit,
    repositoryCaptureSourceCaptureId,
    setWindowMode,
    setBakeTab,
    setRepositoryTab,
    setSelectedMemoryId,
    setSelectedKnowledgeId,
    setSelectedCaptureId,
    setBakeMemoryOffset,
    setBakeCaptureOffset,
    setRepositoryMemoryLimit,
    setRepositoryCaptureLimit,
    setRepositoryCaptureSourceCaptureId,
  } = useAppStore()

  const fetchMemories = useFetchBakeMemories()
  const fetchCaptures = useFetchBakeCaptures()
  const fetchCaptureDetail = useFetchBakeCaptureDetail()

  const [memories, setMemories] = useState<EpisodicMemoryItem[]>([])
  const [memoryTotal, setMemoryTotal] = useState(0)
  const [captureItems, setCaptureItems] = useState<BakeCaptureItem[]>([])
  const [captureTotal, setCaptureTotal] = useState(0)
  const [captureDetail, setCaptureDetail] = useState<BakeCaptureItem | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [memoryPageInput, setMemoryPageInput] = useState('')
  const [draftMemoryQuery, setDraftMemoryQuery] = useState(repositoryMemoryQuery)
  const [draftMemoryFrom, setDraftMemoryFrom] = useState(repositoryMemoryFrom)
  const [draftMemoryTo, setDraftMemoryTo] = useState(repositoryMemoryTo)
  const [draftCaptureQuery, setDraftCaptureQuery] = useState(repositoryCaptureQuery)
  const [draftCaptureFrom, setDraftCaptureFrom] = useState(repositoryCaptureFrom)
  const [draftCaptureTo, setDraftCaptureTo] = useState(repositoryCaptureTo)

  useEffect(() => {
    if (repositoryTab !== 'memory') return
    void fetchMemories({
      q: repositoryMemoryQuery.trim() || undefined,
      from: parseDateInputToMs(repositoryMemoryFrom),
      to: parseDateInputToMs(repositoryMemoryTo, true),
      limit: repositoryMemoryLimit,
      offset: bakeMemoryOffset,
    }).then((data) => {
      setMemories(data.items)
      setMemoryTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '情节记忆加载失败')
    })
  }, [
    bakeMemoryOffset,
    fetchMemories,
    repositoryMemoryFrom,
    repositoryMemoryLimit,
    repositoryMemoryQuery,
    repositoryMemoryTo,
    repositoryTab,
  ])

  useEffect(() => {
    if (repositoryTab !== 'capture') return
    void fetchCaptures({
      q: repositoryCaptureQuery.trim() || undefined,
      from: parseDateInputToMs(repositoryCaptureFrom),
      to: parseDateInputToMs(repositoryCaptureTo, true),
      source_capture_id: repositoryCaptureSourceCaptureId ? Number(repositoryCaptureSourceCaptureId) : undefined,
      limit: repositoryCaptureLimit,
      offset: bakeCaptureOffset,
    }).then((data) => {
      setCaptureItems(data.items)
      setCaptureTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '记忆片段加载失败')
    })
  }, [
    bakeCaptureOffset,
    fetchCaptures,
    repositoryCaptureFrom,
    repositoryCaptureLimit,
    repositoryCaptureQuery,
    repositoryCaptureSourceCaptureId,
    repositoryCaptureTo,
    repositoryTab,
  ])

  useEffect(() => {
    if (repositoryTab !== 'capture' || !selectedCaptureId) {
      setCaptureDetail(null)
      return
    }
    void fetchCaptureDetail(selectedCaptureId).then(setCaptureDetail).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '记忆片段详情加载失败')
    })
  }, [fetchCaptureDetail, repositoryTab, selectedCaptureId])

  useEffect(() => {
    if (!statusMessage) return
    const timer = window.setTimeout(() => setStatusMessage(null), 2400)
    return () => window.clearTimeout(timer)
  }, [statusMessage])

  useEffect(() => {
    setDraftMemoryQuery(repositoryMemoryQuery)
    setDraftMemoryFrom(repositoryMemoryFrom)
    setDraftMemoryTo(repositoryMemoryTo)
  }, [repositoryMemoryFrom, repositoryMemoryQuery, repositoryMemoryTo])

  useEffect(() => {
    setDraftCaptureQuery(repositoryCaptureQuery)
    setDraftCaptureFrom(repositoryCaptureFrom)
    setDraftCaptureTo(repositoryCaptureTo)
  }, [repositoryCaptureFrom, repositoryCaptureQuery, repositoryCaptureTo])

  useEffect(() => {
    if (repositoryTab !== 'memory') return
    if (memories.length === 0) {
      setSelectedMemoryId(null)
      return
    }
    if (!selectedMemoryId || !memories.some(item => item.id === selectedMemoryId)) {
      setSelectedMemoryId(memories[0].id)
    }
  }, [memories, repositoryTab, selectedMemoryId, setSelectedMemoryId])

  useEffect(() => {
    if (repositoryTab !== 'capture') return
    if (captureItems.length === 0) {
      setSelectedCaptureId(null)
      setCaptureDetail(null)
      return
    }
    if (!selectedCaptureId || !captureItems.some(item => item.id === selectedCaptureId)) {
      setSelectedCaptureId(captureItems[0].id)
    }
  }, [captureItems, repositoryTab, selectedCaptureId, setSelectedCaptureId])

  const resolvedMemoryId = selectedMemoryId ?? memories[0]?.id ?? null
  const resolvedCaptureId = selectedCaptureId ?? captureItems[0]?.id ?? null
  const selectedMemory = memories.find(item => item.id === resolvedMemoryId) ?? memories[0] ?? null
  const memoryPage = Math.floor(bakeMemoryOffset / repositoryMemoryLimit) + 1
  const memoryTotalPages = Math.max(1, Math.ceil(memoryTotal / repositoryMemoryLimit))
  const memoryFilterPills = useMemo(() => {
    const pills: string[] = []
    if (repositoryMemoryQuery.trim()) pills.push(`关键词：${repositoryMemoryQuery.trim()}`)
    if (repositoryMemoryFrom) pills.push(`开始：${repositoryMemoryFrom}`)
    if (repositoryMemoryTo) pills.push(`结束：${repositoryMemoryTo}`)
    return pills
  }, [repositoryMemoryFrom, repositoryMemoryQuery, repositoryMemoryTo])

  const handleSearchMemories = () => {
    useAppStore.setState({
      repositoryMemoryQuery: draftMemoryQuery,
      repositoryMemoryFrom: draftMemoryFrom,
      repositoryMemoryTo: draftMemoryTo,
      bakeMemoryOffset: 0,
    })
  }

  const handleClearMemoryFilters = () => {
    setDraftMemoryQuery('')
    setDraftMemoryFrom('')
    setDraftMemoryTo('')
    useAppStore.setState({
      repositoryMemoryQuery: '',
      repositoryMemoryFrom: '',
      repositoryMemoryTo: '',
      bakeMemoryOffset: 0,
    })
  }

  const handleSearchCaptures = () => {
    useAppStore.setState({
      repositoryCaptureQuery: draftCaptureQuery,
      repositoryCaptureFrom: draftCaptureFrom,
      repositoryCaptureTo: draftCaptureTo,
      bakeCaptureOffset: 0,
    })
  }

  const handleClearCaptureFilters = () => {
    setDraftCaptureQuery('')
    setDraftCaptureFrom('')
    setDraftCaptureTo('')
    useAppStore.setState({
      repositoryCaptureQuery: '',
      repositoryCaptureFrom: '',
      repositoryCaptureTo: '',
      repositoryCaptureSourceCaptureId: null,
      bakeCaptureOffset: 0,
    })
  }

  const handleViewLinkedKnowledge = (knowledgeId?: string | null) => {
    if (!knowledgeId) {
      setStatusMessage('当前情节记忆尚未提炼出 bake 知识')
      return
    }
    setWindowMode('bake')
    setBakeTab('knowledge')
    setSelectedKnowledgeId(null)
    setStatusMessage('已切换到已提炼知识页；来源 knowledge 不在这里展示')
  }

  const tabs: Array<{ key: RepositoryTab; label: string }> = [
    { key: 'memory', label: '情节记忆' },
    { key: 'capture', label: '记忆片段' },
  ]

  return (
    <div className="bake-panel">
      <BakeHeader title="醒发箱" subtitle="集中浏览情节记忆与记忆片段，只做回溯原始上下文" />
      {statusMessage && <div className="bake-inline-message">{statusMessage}</div>}
      <section className="bake-tabs bake-tabs--scroll">
        {tabs.map(tab => (
          <BakeButton key={tab.key} active={repositoryTab === tab.key} onClick={() => setRepositoryTab(tab.key)}>
            {tab.label}
          </BakeButton>
        ))}
      </section>

      <div className="bake-tab-content">
        {repositoryTab === 'memory' && (
          <div className="bake-split-list-detail bake-split-list-detail--memories-fixed">
            <BakeCard className="bake-memory-list-card bake-memory-list-card--fixed">
              <BakeSectionHeader
                title="情节记忆"
                subtitle="只做浏览与回溯，不在这里执行提炼动作"
              />

              <form
                className="bake-list-toolbar bake-list-toolbar--repository"
                onSubmit={(event) => {
                  event.preventDefault()
                  handleSearchMemories()
                }}
              >
                <div className="bake-list-toolbar__repository">
                  <div className="bake-list-toolbar__repository-row bake-list-toolbar__repository-row--search">
                    <label className="bake-form-field bake-filter-field bake-filter-field--search">
                      <span className="bake-filter-label">关键词</span>
                      <input
                        className="bake-input"
                        value={draftMemoryQuery}
                        onChange={(event) => setDraftMemoryQuery(event.target.value)}
                        placeholder="搜索情节记忆标题、摘要或详情"
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
                        value={draftMemoryFrom}
                        onChange={(event) => setDraftMemoryFrom(event.target.value)}
                      />
                    </label>
                    <label className="bake-form-field bake-filter-field">
                      <span className="bake-filter-label">结束日期</span>
                      <input
                        className="bake-input"
                        type="date"
                        value={draftMemoryTo}
                        onChange={(event) => setDraftMemoryTo(event.target.value)}
                      />
                    </label>
                    <div className="bake-list-toolbar__repository-actions bake-list-toolbar__repository-actions--secondary">
                      {(draftMemoryQuery || draftMemoryFrom || draftMemoryTo || repositoryMemoryQuery || repositoryMemoryFrom || repositoryMemoryTo) && (
                        <BakeButton compact onClick={handleClearMemoryFilters}>清除筛选</BakeButton>
                      )}
                    </div>
                  </div>
                </div>
              </form>

              {memoryFilterPills.length > 0 && (
                <div className="bake-filter-summary">
                  {memoryFilterPills.map(item => <BakePill key={item} text={item} />)}
                </div>
              )}

              {memories.length === 0 ? (
                <div className="bake-muted">当前筛选条件下没有可浏览的情节记忆。</div>
              ) : (
                <>
                  <div className="bake-list bake-memory-list bake-memory-list--paged">
                    {memories.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedMemoryId(item.id)}
                        className={`bake-list-item bake-memory-list-item bake-memory-list-item--compact ${item.id === selectedMemory?.id ? 'bake-list-item--active' : ''}`.trim()}
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
                    ))}
                  </div>
                  <div className="bake-pagination bake-pagination--extended">
                    <div className="bake-pagination__controls">
                      <BakeButton compact onClick={() => setBakeMemoryOffset(Math.max(0, bakeMemoryOffset - repositoryMemoryLimit))}>上一页</BakeButton>
                      <BakeButton compact onClick={() => setBakeMemoryOffset(bakeMemoryOffset + repositoryMemoryLimit)}>
                        {bakeMemoryOffset + repositoryMemoryLimit >= memoryTotal ? '已到底' : '下一页'}
                      </BakeButton>
                    </div>
                    <div className="bake-pagination__summary-group bake-muted">
                      <span className="bake-pagination__summary">共 {memoryTotal} 条</span>
                      <span className="bake-pagination__summary">第 {memoryPage}/{memoryTotalPages} 页</span>
                    </div>
                    <div className="bake-pagination__right">
                      <label className="bake-pagination__field">
                        <span className="bake-muted">每页</span>
                        <select
                          className="bake-input bake-pagination__select"
                          value={String(repositoryMemoryLimit)}
                          onChange={(event) => setRepositoryMemoryLimit(Number(event.target.value))}
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
                          max={memoryTotalPages}
                          value={memoryPageInput}
                          onChange={(event) => setMemoryPageInput(event.target.value)}
                          placeholder={String(memoryPage)}
                        />
                        <span className="bake-muted">页</span>
                        <BakeButton
                          compact
                          onClick={() => {
                            const target = Number(memoryPageInput)
                            if (!Number.isFinite(target) || target < 1) return
                            const nextPage = Math.min(memoryTotalPages, Math.floor(target))
                            setBakeMemoryOffset((nextPage - 1) * repositoryMemoryLimit)
                            setMemoryPageInput('')
                          }}
                        >
                          前往
                        </BakeButton>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </BakeCard>

            <BakeCard className="bake-memory-detail-card bake-memory-detail-card--stacked">
              {selectedMemory ? (
                <div className="bake-memory-detail bake-memory-detail--fixed">
                  <div className="bake-memory-detail__header-block">
                    <div className="bake-inline-meta">
                      <div style={{ minWidth: 0 }}>
                        <div className="bake-title" style={{ fontSize: 20, lineHeight: 1.4 }}>{selectedMemory.title}</div>
                        <div className="bake-muted bake-line-clamp-1" style={{ marginTop: 6 }}>{selectedMemory.url || `片段 #${selectedMemory.sourceCaptureId || '—'}`}</div>
                      </div>
                      <BakePill text="情节记忆浏览" />
                    </div>
                    <div className="bake-memory-detail__stats">
                      <span className="bake-stat-chip">创建于 {formatMemoryTime(selectedMemory)}</span>
                      <span className="bake-stat-chip">权重 {selectedMemory.weight}</span>
                      <span className="bake-stat-chip">打开 {selectedMemory.openCount} 次</span>
                      <span className="bake-stat-chip">停留 {selectedMemory.dwellSeconds}s</span>
                      <span className="bake-stat-chip">重复观察 {selectedMemory.knowledgeRefCount} 次</span>
                    </div>
                  </div>

                  <div className="bake-grid-2">
                    <div className="bake-memory-action-card">
                      <div className="bake-kv__title">情节记忆摘要</div>
                      <div className="bake-muted" style={{ lineHeight: 1.8 }}>{selectedMemory.summary || '暂无摘要'}</div>
                    </div>
                    <div className="bake-memory-action-card">
                      <div className="bake-kv__title">浏览提示</div>
                      <div className="bake-muted" style={{ lineHeight: 1.8 }}>醒发箱只用于浏览情节记忆与回溯上下文；如需提炼为知识、模板或 SOP，请回到烤面包的情节记忆页。</div>
                    </div>
                  </div>

                  <div className="bake-memory-action-card bake-memory-action-card--secondary">
                    <div>
                      <div className="bake-kv__title">回溯</div>
                      <div className="bake-muted" style={{ marginTop: 4, lineHeight: 1.7 }}>从醒发箱中的情节记忆跳到来源记忆片段，或回到烤面包查看已提炼出的知识、模板与 SOP。</div>
                    </div>
                    <div className="bake-actions bake-actions--secondary bake-memory-detail__action-copy">
                      <BakeButton compact onClick={() => {
                        if (!selectedMemory.sourceCaptureId) {
                          setStatusMessage('当前情节记忆暂无来源记忆片段')
                          return
                        }
                        setRepositoryTab('capture')
                        setRepositoryCaptureSourceCaptureId(selectedMemory.sourceCaptureId)
                        setSelectedCaptureId(selectedMemory.sourceCaptureId)
                        setStatusMessage('已切换到来源记忆片段')
                      }}>来源记忆片段</BakeButton>
                      <BakeButton compact onClick={() => handleViewLinkedKnowledge(selectedMemory.sourceKnowledgeId)}>关联知识</BakeButton>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bake-muted">暂无情节记忆详情</div>
              )}
            </BakeCard>
          </div>
        )}
        {repositoryTab === 'capture' && (
          <BakeCaptureTab
            captures={captureItems}
            total={captureTotal}
            limit={repositoryCaptureLimit}
            offset={bakeCaptureOffset}
            query={repositoryCaptureQuery}
            from={repositoryCaptureFrom}
            to={repositoryCaptureTo}
            draftQuery={draftCaptureQuery}
            draftFrom={draftCaptureFrom}
            draftTo={draftCaptureTo}
            sourceCaptureId={repositoryCaptureSourceCaptureId}
            selectedCaptureId={resolvedCaptureId}
            selectedCaptureDetail={captureDetail}
            onSelectCapture={setSelectedCaptureId}
            onPageChange={setBakeCaptureOffset}
            onLimitChange={setRepositoryCaptureLimit}
            onDraftQueryChange={setDraftCaptureQuery}
            onDraftFromChange={setDraftCaptureFrom}
            onDraftToChange={setDraftCaptureTo}
            onSearch={handleSearchCaptures}
            onClearFilters={handleClearCaptureFilters}
            onClearScope={() => setRepositoryCaptureSourceCaptureId(null)}
            onViewLinkedKnowledge={handleViewLinkedKnowledge}
          />
        )}
      </div>
    </div>
  )
}

export default RepositoryPanel
