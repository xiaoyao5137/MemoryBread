import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  useCreateBakeTemplate,
  useDeleteBakeKnowledge,
  useDeleteBakeSop,
  useDeleteBakeTemplate,
  useFetchBakeKnowledge,
  useFetchBakeOverview,
  useFetchBakeSops,
  useFetchBakeTemplates,
  useToggleBakeTemplateStatus,
  useUpdateBakeTemplate,
  useModelStatus,
} from '../hooks/useApi'
import { useAppStore } from '../store/useAppStore'
import type {
  ArticleTemplate,
  BakeKnowledgeItem,
  BakeOverview,
  SopCandidate,
} from '../types'
import BakeHeader from './bake/BakeHeader'
import BakeOverviewTab from './bake/BakeOverviewTab'
import BakeTemplatesTab from './bake/BakeTemplatesTab'
import BakeSopTab from './bake/BakeSopTab'
import BakeKnowledgeTab from './bake/BakeKnowledgeTab'
import BakeTabs from './bake/BakeTabs'
import './bake/BakePanel.css'

const PAGE_SIZE = 20

const getFallbackOffsetAfterRemoval = (currentCount: number, offset: number, limit: number) => (
  currentCount <= 1 && offset > 0 ? Math.max(0, offset - limit) : offset
)

const createDraftTemplate = (): ArticleTemplate => ({
  id: `template-draft-${Date.now()}`,
  title: '新模板',
  docType: 'article',
  status: 'draft',
  tags: [],
  applicableTasks: ['creation'],
  sourceMemoryIds: [],
  sourceCaptureIds: [],
  sourceEpisodeIds: [],
  linkedKnowledgeIds: [],
  sections: [],
  stylePhrases: [],
  replacementRules: [],
  promptHint: '',
  usageCount: 0,
  reviewStatus: 'draft',
  updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
})

const defaultOverview: BakeOverview = {
  captureCount: 0,
  memoryCount: 0,
  knowledgeCount: 0,
  templateCount: 0,
  pendingCandidates: 0,
  recentActivities: [],
}

const BakePanel: React.FC = () => {
  const {
    bakeTab,
    selectedMemoryId,
    selectedTemplateId,
    selectedSopId,
    selectedKnowledgeId,
    bakeKnowledgeOffset,
    bakeKnowledgeQuery,
    bakeKnowledgeLimit,
    bakeTemplateOffset,
    bakeTemplateQuery,
    bakeTemplateLimit,
    bakeSopOffset,
    bakeSopQuery,
    bakeSopLimit,
    setBakeTab,
    setRepositoryTab,
    setWindowMode,
    setCaptureBackTarget,
    setSelectedMemoryId,
    setSelectedTemplateId,
    setSelectedSopId,
    setSelectedKnowledgeId,
    setSelectedCaptureId,
    setBakeKnowledgeOffset,
    setBakeKnowledgeQuery,
    setBakeKnowledgeLimit,
    setBakeTemplateOffset,
    setBakeTemplateQuery,
    setBakeTemplateLimit,
    setBakeSopOffset,
    setBakeSopQuery,
    setBakeSopLimit,
    setRepositoryCaptureSourceCaptureId,
    creationBackTarget,
    clearCreationBackTarget,
  } = useAppStore()

  const { status: modelStatus, ready: modelsReady, loading: modelStatusLoading } = useModelStatus()
  const fetchOverview = useFetchBakeOverview()
  const fetchKnowledge = useFetchBakeKnowledge()
  const deleteKnowledge = useDeleteBakeKnowledge()
  const fetchTemplates = useFetchBakeTemplates()
  const createTemplate = useCreateBakeTemplate()
  const updateTemplate = useUpdateBakeTemplate()
  const toggleTemplateStatus = useToggleBakeTemplateStatus()
  const deleteTemplate = useDeleteBakeTemplate()
  const fetchSops = useFetchBakeSops()
  const deleteSop = useDeleteBakeSop()

  const [overview, setOverview] = useState<BakeOverview>(defaultOverview)
  const [knowledgeItems, setKnowledgeItems] = useState<BakeKnowledgeItem[]>([])
  const [knowledgeTotal, setKnowledgeTotal] = useState(0)
  const [templates, setTemplates] = useState<ArticleTemplate[]>([])
  const [templateTotal, setTemplateTotal] = useState(0)
  const [sopCandidates, setSopCandidates] = useState<SopCandidate[]>([])
  const [sopTotal, setSopTotal] = useState(0)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [draftKnowledgeQuery, setDraftKnowledgeQuery] = useState(bakeKnowledgeQuery)

  useEffect(() => {
    void fetchOverview().then((data) => {
      setOverview({
        captureCount: data.capture_count,
        memoryCount: data.memory_count,
        knowledgeCount: data.knowledge_count,
        templateCount: data.template_count,
        pendingCandidates: data.pending_candidates,
        recentActivities: data.recent_activities ?? [],
      })
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '收藏数据加载失败')
    })
  }, [fetchOverview])

  useEffect(() => {
    if (bakeTab !== 'knowledge') return
    void fetchKnowledge({
      q: bakeKnowledgeQuery.trim() || undefined,
      limit: bakeKnowledgeLimit,
      offset: bakeKnowledgeOffset,
    }).then((data) => {
      setKnowledgeItems(data.items)
      setKnowledgeTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '知识加载失败')
    })
  }, [bakeKnowledgeLimit, bakeKnowledgeOffset, bakeKnowledgeQuery, bakeTab, fetchKnowledge])

  useEffect(() => {
    if (bakeTab !== 'templates') return
    void fetchTemplates({
      q: bakeTemplateQuery.trim() || undefined,
      limit: bakeTemplateLimit,
      offset: bakeTemplateOffset,
    }).then((data) => {
      setTemplates(data.items)
      setTemplateTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '模板加载失败')
    })
  }, [bakeTab, bakeTemplateLimit, bakeTemplateOffset, bakeTemplateQuery, fetchTemplates])

  useEffect(() => {
    if (bakeTab !== 'sop') return
    void fetchSops({
      q: bakeSopQuery.trim() || undefined,
      limit: bakeSopLimit,
      offset: bakeSopOffset,
    }).then((data) => {
      setSopCandidates(data.items)
      setSopTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '操作手册加载失败')
    })
  }, [bakeSopLimit, bakeSopOffset, bakeSopQuery, bakeTab, fetchSops])

  useEffect(() => {
    if (!statusMessage) return
    const timer = window.setTimeout(() => setStatusMessage(null), 2400)
    return () => window.clearTimeout(timer)
  }, [statusMessage])

  useEffect(() => {
    setDraftKnowledgeQuery(bakeKnowledgeQuery)
  }, [bakeKnowledgeQuery])

  const resolvedTemplateId = selectedTemplateId ?? templates[0]?.id ?? null
  const resolvedSopId = selectedSopId ?? sopCandidates[0]?.id ?? null
  const resolvedKnowledgeId = selectedKnowledgeId ?? knowledgeItems[0]?.id ?? null

  const refreshOverview = async () => {
    const data = await fetchOverview()
    setOverview({
      captureCount: data.capture_count,
      memoryCount: data.memory_count,
      knowledgeCount: data.knowledge_count,
      templateCount: data.template_count,
      pendingCandidates: data.pending_candidates,
      recentActivities: data.recent_activities ?? [],
    })
  }

  const refreshKnowledge = async (offset = bakeKnowledgeOffset) => {
    const data = await fetchKnowledge({
      q: bakeKnowledgeQuery.trim() || undefined,
      limit: bakeKnowledgeLimit,
      offset,
    })
    setKnowledgeItems(data.items)
    setKnowledgeTotal(data.total)
  }

  const refreshTemplates = async (offset = bakeTemplateOffset) => {
    const data = await fetchTemplates({
      q: bakeTemplateQuery.trim() || undefined,
      limit: bakeTemplateLimit,
      offset,
    })
    setTemplates(data.items)
    setTemplateTotal(data.total)
  }

  const refreshSops = async (offset = bakeSopOffset) => {
    const data = await fetchSops({
      q: bakeSopQuery.trim() || undefined,
      limit: bakeSopLimit,
      offset,
    })
    setSopCandidates(data.items)
    setSopTotal(data.total)
  }

  const handleSearchKnowledge = () => {
    useAppStore.setState({
      bakeKnowledgeQuery: draftKnowledgeQuery,
      bakeKnowledgeOffset: 0,
    })
  }

  const handleClearKnowledgeFilters = () => {
    setDraftKnowledgeQuery('')
    useAppStore.setState({
      bakeKnowledgeQuery: '',
      bakeKnowledgeOffset: 0,
    })
  }

  const handleCreateTemplate = async () => {
    try {
      const created = await createTemplate(createDraftTemplate())
      setTemplates(prev => [created, ...prev.filter(item => item.id !== created.id)])
      setBakeTab('templates')
      setBakeTemplateOffset(0)
      setSelectedTemplateId(created.id)
      setStatusMessage(`已新建模板「${created.title}」`)
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '新建模板失败')
    }
  }

  const handleCopy = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setStatusMessage(successMessage)
    } catch {
      setStatusMessage('复制失败，请稍后重试')
    }
  }

  const handleOpenLink = (url?: string, sourceCaptureId?: string) => {
    if (sourceCaptureId) {
      setCaptureBackTarget({
        windowMode: 'bake',
        bakeTab,
        selectedMemoryId,
        selectedTemplateId: resolvedTemplateId,
        selectedSopId: resolvedSopId,
        selectedKnowledgeId: resolvedKnowledgeId,
      })
      setWindowMode('knowledge')
      setRepositoryTab('capture')
      setRepositoryCaptureSourceCaptureId(sourceCaptureId)
      setSelectedCaptureId(sourceCaptureId)
      setStatusMessage('已打开关联采集记录')
      return
    }
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer')
      setStatusMessage('已打开原文链接')
      return
    }
    setStatusMessage('当前内容没有可打开的原文或关联采集记录')
  }

  const handleUpdateTemplate = async (templateId: string, updater: (template: ArticleTemplate) => ArticleTemplate) => {
    const target = templates.find(item => item.id === templateId)
    if (!target) return
    try {
      const updated = await updateTemplate(updater(target))
      setTemplates(prev => prev.map(item => item.id === templateId ? updated : item))
      setStatusMessage(`已更新模板「${updated.title}」`)
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '更新模板失败')
    }
  }

  const handleToggleTemplateStatus = async (templateId: string) => {
    try {
      const updated = await toggleTemplateStatus(templateId)
      setTemplates(prev => prev.map(item => item.id === templateId ? updated : item))
      setStatusMessage(`模板状态已切换为「${updated.status}」`)
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '切换模板状态失败')
    }
  }

  const handleDeleteTemplate = async (templateId: string) => {
    try {
      await deleteTemplate(templateId)
      const nextOffset = getFallbackOffsetAfterRemoval(templates.length, bakeTemplateOffset, bakeTemplateLimit)
      if (nextOffset !== bakeTemplateOffset) {
        setBakeTemplateOffset(nextOffset)
      } else {
        await refreshTemplates(nextOffset)
      }
      if (selectedTemplateId === templateId || resolvedTemplateId === templateId) {
        setSelectedTemplateId(null)
      }
      setStatusMessage('已删除模板')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '删除模板失败')
    }
  }

  const handleViewSourceMemory = (memoryId?: string) => {
    if (!memoryId) {
      setStatusMessage('当前模板还没有关联来源时间线')
      return
    }
    setWindowMode('knowledge')
    setRepositoryTab('memory')
    setSelectedMemoryId(memoryId)
    setStatusMessage('已切换到来源时间线')
  }

  const handleViewRelatedDocument = async (timelineId: string) => {
    const relatedDoc = templates.find(t => t.sourceMemoryIds.includes(timelineId))
    if (!relatedDoc) {
      setStatusMessage('当前时间线还没有被提炼为文档')
      return
    }
    setBakeTab('templates')
    setBakeTemplateOffset(0)
    setSelectedTemplateId(relatedDoc.id)
    setStatusMessage(`已切换到关联文档「${relatedDoc.title}」`)
  }

  const handleViewLinkedKnowledge = (knowledgeId: string) => {
    setBakeTab('knowledge')
    setBakeKnowledgeQuery('')
    setBakeKnowledgeOffset(0)
    setSelectedKnowledgeId(knowledgeId)
    setStatusMessage('已切换到关联知识')
  }

  const handleDeleteKnowledge = async (id: string) => {
    try {
      await deleteKnowledge(id)
      const nextOffset = getFallbackOffsetAfterRemoval(knowledgeItems.length, bakeKnowledgeOffset, bakeKnowledgeLimit)
      if (selectedKnowledgeId === id || resolvedKnowledgeId === id) {
        setSelectedKnowledgeId(null)
      }
      if (nextOffset !== bakeKnowledgeOffset) {
        setBakeKnowledgeOffset(nextOffset)
      } else {
        await refreshKnowledge(nextOffset)
      }
      setStatusMessage('已删除知识条目')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '删除知识失败')
    }
  }

  const handleDeleteSop = async (id: string) => {
    try {
      await deleteSop(id)
      const nextOffset = getFallbackOffsetAfterRemoval(sopCandidates.length, bakeSopOffset, bakeSopLimit)
      if (selectedSopId === id || resolvedSopId === id) {
        setSelectedSopId(null)
      }
      if (nextOffset !== bakeSopOffset) {
        setBakeSopOffset(nextOffset)
      } else {
        await refreshSops(nextOffset)
      }
      setStatusMessage('已删除操作手册')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '删除操作手册失败')
    }
  }

  return (
    <div className="bake-panel">
      {creationBackTarget && (
        <div style={{
          padding: '10px 16px',
          background: '#f0fdfa',
          borderBottom: '1px solid #99f6e4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 13, color: '#0f766e' }}>
            从智能创作的参考资料跳转而来
          </span>
          <button
            type="button"
            onClick={() => {
              const target = creationBackTarget
              clearCreationBackTarget()
              setWindowMode(target.windowMode)
            }}
            style={{
              padding: '6px 12px',
              border: '1px solid #0f766e',
              borderRadius: 6,
              background: '#fff',
              color: '#0f766e',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <ArrowLeft size={14} />
            返回创作
          </button>
        </div>
      )}
      <BakeHeader />
      {statusMessage && <div className="bake-inline-message">{statusMessage}</div>}

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
            请前往「模型」界面检查模型状态，提炼功能需要所有模型就绪
          </div>
        </div>
      )}

      <BakeTabs current={bakeTab} onChange={setBakeTab} />

      <div className="bake-tab-content">
        {bakeTab === 'overview' && (
          <BakeOverviewTab
            overview={overview}
            onOpenTab={setBakeTab}
            onOpenRepository={(tab) => {
              setWindowMode('knowledge')
              setRepositoryTab(tab)
            }}
          />
        )}
        {bakeTab === 'knowledge' && (
          <BakeKnowledgeTab
            items={knowledgeItems}
            total={knowledgeTotal}
            offset={bakeKnowledgeOffset}
            limit={bakeKnowledgeLimit}
            query={bakeKnowledgeQuery}
            draftQuery={draftKnowledgeQuery}
            selectedKnowledgeId={resolvedKnowledgeId}
            onSelectKnowledge={setSelectedKnowledgeId}
            onPageChange={setBakeKnowledgeOffset}
            onLimitChange={setBakeKnowledgeLimit}
            onDraftQueryChange={setDraftKnowledgeQuery}
            onSearch={handleSearchKnowledge}
            onClearFilters={handleClearKnowledgeFilters}
            onDeleteKnowledge={handleDeleteKnowledge}
            onViewSourceTimeline={handleViewSourceMemory}
            onCreateKnowledge={(knowledge) => {
              setStatusMessage('手工录入功能需要后端API支持，当前仅为UI演示')
            }}
            onOpenCapture={(captureId?: string) => {
              if (!captureId) {
                setStatusMessage('当前内容暂无关联采集记录')
                return
              }
              setCaptureBackTarget({
                windowMode: 'bake',
                bakeTab,
                selectedMemoryId,
                selectedTemplateId: resolvedTemplateId,
                selectedSopId: resolvedSopId,
                selectedKnowledgeId: resolvedKnowledgeId,
              })
              setWindowMode('knowledge')
              setRepositoryTab('capture')
              setRepositoryCaptureSourceCaptureId(captureId)
              setSelectedCaptureId(captureId)
              setStatusMessage('已切换到关联采集记录')
            }}
          />
        )}
        {bakeTab === 'templates' && (
          <BakeTemplatesTab
            templates={templates}
            total={templateTotal}
            offset={bakeTemplateOffset}
            limit={bakeTemplateLimit}
            query={bakeTemplateQuery}
            selectedTemplateId={resolvedTemplateId}
            onSelectTemplate={setSelectedTemplateId}
            onCreateTemplate={handleCreateTemplate}
            onUpdateTemplate={handleUpdateTemplate}
            onToggleTemplateStatus={handleToggleTemplateStatus}
            onDeleteTemplate={handleDeleteTemplate}
            onViewSourceMemory={handleViewSourceMemory}
            onPageChange={setBakeTemplateOffset}
            onLimitChange={setBakeTemplateLimit}
            onQueryChange={setBakeTemplateQuery}
          />
        )}
        {bakeTab === 'sop' && (
          <BakeSopTab
            candidates={sopCandidates}
            total={sopTotal}
            offset={bakeSopOffset}
            limit={bakeSopLimit}
            query={bakeSopQuery}
            selectedSopId={resolvedSopId}
            onSelectSop={setSelectedSopId}
            onDeleteSop={handleDeleteSop}
            onViewLinkedKnowledge={handleViewLinkedKnowledge}
            onViewSourceTimeline={handleViewSourceMemory}
            onCopySteps={(candidate: SopCandidate) => handleCopy(candidate.steps.map((step, idx) => `${idx + 1}. ${step}`).join('\n'), '已复制流程步骤')}
            onCreateSop={(sop) => {
              setStatusMessage('手工录入功能需要后端API支持，当前仅为UI演示')
            }}
            onPageChange={setBakeSopOffset}
            onLimitChange={setBakeSopLimit}
            onQueryChange={setBakeSopQuery}
          />
        )}
      </div>
    </div>
  )
}

export default BakePanel
