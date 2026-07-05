import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  useCreateBakeTemplate,
  useDeleteBakeKnowledge,
  useDeleteBakeSop,
  useDeleteBakeTemplate,
  useFetchBakeKnowledge,
  useFetchBakeKnowledgeDetail,
  useFetchBakeMemories,
  useFetchBakeOverview,
  useFetchBakeSop,
  useFetchBakeSops,
  useFetchBakeTemplate,
  useFetchBakeTemplates,
  useToggleBakeTemplateStatus,
  useUpdateBakeTemplate,
  useModelStatus,
} from '../hooks/useApi'
import { useAppStore, type BakeNavigationTarget } from '../store/useAppStore'
import type {
  ArticleTemplate,
  BakeKnowledgeItem,
  BakeOverview,
  SopCandidate,
  TimelineItem,
} from '../types'
import BakeHeader from './bake/BakeHeader'
import BakeOverviewTab from './bake/BakeOverviewTab'
import BakeTemplatesTab from './bake/BakeTemplatesTab'
import BakeSopTab from './bake/BakeSopTab'
import BakeKnowledgeTab from './bake/BakeKnowledgeTab'
import BakeTabs from './bake/BakeTabs'
import { BakeButton } from './bake/BakeShared'
import { parseDateInputToMs } from './bake/BakeCaptureTab'
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
    bakeTemplateFocusId,
    bakeKnowledgeFocusId,
    bakeSopFocusId,
    bakeKnowledgeOffset,
    bakeKnowledgeQuery,
    bakeKnowledgeFrom,
    bakeKnowledgeTo,
    bakeKnowledgeLimit,
    bakeTemplateOffset,
    bakeTemplateQuery,
    bakeTemplateFrom,
    bakeTemplateTo,
    bakeTemplateLimit,
    bakeSopOffset,
    bakeSopQuery,
    bakeSopFrom,
    bakeSopTo,
    bakeSopLimit,
    setBakeTab,
    setRepositoryTab,
    setWindowMode,
    bakeNavigationStack,
    pushBakeNavigationTarget,
    popBakeNavigationTarget,
    setSelectedMemoryId,
    setSelectedTemplateId,
    setSelectedSopId,
    setSelectedKnowledgeId,
    setSelectedCaptureId,
    setRepositoryMemoryFocusId,
    setBakeTemplateFocusId,
    setBakeKnowledgeFocusId,
    setBakeSopFocusId,
    setBakeKnowledgeOffset,
    setBakeKnowledgeQuery,
    setBakeKnowledgeLimit,
    setBakeTemplateOffset,
    setBakeTemplateLimit,
    setBakeSopOffset,
    setBakeSopLimit,
    setRepositoryCaptureSourceCaptureId,
    creationBackTarget,
    clearCreationBackTarget,
  } = useAppStore()

  const { status: modelStatus, ready: modelsReady, loading: modelStatusLoading } = useModelStatus()
  const fetchOverview = useFetchBakeOverview()
  const fetchKnowledge = useFetchBakeKnowledge()
  const fetchKnowledgeDetail = useFetchBakeKnowledgeDetail()
  const fetchMemories = useFetchBakeMemories()
  const deleteKnowledge = useDeleteBakeKnowledge()
  const fetchTemplates = useFetchBakeTemplates()
  const fetchTemplate = useFetchBakeTemplate()
  const createTemplate = useCreateBakeTemplate()
  const updateTemplate = useUpdateBakeTemplate()
  const toggleTemplateStatus = useToggleBakeTemplateStatus()
  const deleteTemplate = useDeleteBakeTemplate()
  const fetchSops = useFetchBakeSops()
  const fetchSop = useFetchBakeSop()
  const deleteSop = useDeleteBakeSop()

  const [overview, setOverview] = useState<BakeOverview>(defaultOverview)
  const [knowledgeItems, setKnowledgeItems] = useState<BakeKnowledgeItem[]>([])
  const [knowledgeTotal, setKnowledgeTotal] = useState(0)
  const [memoryItems, setMemoryItems] = useState<TimelineItem[]>([])
  const [templates, setTemplates] = useState<ArticleTemplate[]>([])
  const [templateTotal, setTemplateTotal] = useState(0)
  const [sopCandidates, setSopCandidates] = useState<SopCandidate[]>([])
  const [sopTotal, setSopTotal] = useState(0)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [draftKnowledgeQuery, setDraftKnowledgeQuery] = useState(bakeKnowledgeQuery)
  const [draftKnowledgeFrom, setDraftKnowledgeFrom] = useState(bakeKnowledgeFrom)
  const [draftKnowledgeTo, setDraftKnowledgeTo] = useState(bakeKnowledgeTo)
  const [draftTemplateQuery, setDraftTemplateQuery] = useState(bakeTemplateQuery)
  const [draftTemplateFrom, setDraftTemplateFrom] = useState(bakeTemplateFrom)
  const [draftTemplateTo, setDraftTemplateTo] = useState(bakeTemplateTo)
  const [draftSopQuery, setDraftSopQuery] = useState(bakeSopQuery)
  const [draftSopFrom, setDraftSopFrom] = useState(bakeSopFrom)
  const [draftSopTo, setDraftSopTo] = useState(bakeSopTo)
  const knowledgeRequestSeqRef = useRef(0)

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
    if (!['templates', 'knowledge', 'sop'].includes(bakeTab)) return
    void fetchMemories({ limit: 1000, offset: 0 }).then((data) => {
      setMemoryItems(data.items)
    }).catch(() => {
      setMemoryItems([])
    })
  }, [bakeTab, fetchMemories])

  useEffect(() => {
    if (bakeTab !== 'knowledge') return
    if (bakeKnowledgeFocusId) {
      const requestSeq = knowledgeRequestSeqRef.current + 1
      knowledgeRequestSeqRef.current = requestSeq
      void fetchKnowledgeDetail(bakeKnowledgeFocusId).then((item) => {
        if (requestSeq !== knowledgeRequestSeqRef.current) return
        setKnowledgeItems([item])
        setKnowledgeTotal(1)
        setSelectedKnowledgeId(item.id)
      }).catch((error) => {
        if (requestSeq !== knowledgeRequestSeqRef.current) return
        setKnowledgeItems([])
        setKnowledgeTotal(0)
        setStatusMessage(error instanceof Error ? error.message : `未找到知识 #${bakeKnowledgeFocusId}`)
      })
      return
    }
    const requestSeq = knowledgeRequestSeqRef.current + 1
    knowledgeRequestSeqRef.current = requestSeq
    void fetchKnowledge({
      q: bakeKnowledgeQuery.trim() || undefined,
      from: parseDateInputToMs(bakeKnowledgeFrom),
      to: parseDateInputToMs(bakeKnowledgeTo, true),
      limit: bakeKnowledgeLimit,
      offset: bakeKnowledgeOffset,
    }).then((data) => {
      if (requestSeq !== knowledgeRequestSeqRef.current) return
      setKnowledgeItems(data.items)
      setKnowledgeTotal(data.total)
    }).catch((error) => {
      if (requestSeq !== knowledgeRequestSeqRef.current) return
      setStatusMessage(error instanceof Error ? error.message : '知识加载失败')
    })
  }, [bakeKnowledgeFocusId, bakeKnowledgeFrom, bakeKnowledgeLimit, bakeKnowledgeOffset, bakeKnowledgeQuery, bakeKnowledgeTo, bakeTab, fetchKnowledge, fetchKnowledgeDetail, setSelectedKnowledgeId])

  useEffect(() => {
    if (bakeTab !== 'templates') return
    if (bakeTemplateFocusId) {
      void fetchTemplate(bakeTemplateFocusId).then((item) => {
        setTemplates([item])
        setTemplateTotal(1)
        setSelectedTemplateId(item.id)
      }).catch((error) => {
        setTemplates([])
        setTemplateTotal(0)
        setStatusMessage(error instanceof Error ? error.message : `未找到文档 #${bakeTemplateFocusId}`)
      })
      return
    }
    void fetchTemplates({
      q: bakeTemplateQuery.trim() || undefined,
      from: parseDateInputToMs(bakeTemplateFrom),
      to: parseDateInputToMs(bakeTemplateTo, true),
      limit: bakeTemplateLimit,
      offset: bakeTemplateOffset,
    }).then((data) => {
      setTemplates(data.items)
      setTemplateTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '模板加载失败')
    })
  }, [bakeTab, bakeTemplateFocusId, bakeTemplateFrom, bakeTemplateLimit, bakeTemplateOffset, bakeTemplateQuery, bakeTemplateTo, fetchTemplate, fetchTemplates, setSelectedTemplateId])

  useEffect(() => {
    if (bakeTab !== 'templates' || !selectedTemplateId) return
    if (templates.some(item => item.id === selectedTemplateId)) return
    void fetchTemplate(selectedTemplateId).then((item) => {
      setTemplates(prev => [item, ...prev.filter(existing => existing.id !== item.id)])
    }).catch(() => {
      setStatusMessage(`未找到文档 #${selectedTemplateId}`)
    })
  }, [bakeTab, fetchTemplate, selectedTemplateId, templates])

  useEffect(() => {
    if (bakeTab !== 'sop') return
    if (bakeSopFocusId) {
      void fetchSop(bakeSopFocusId).then((item) => {
        setSopCandidates([item])
        setSopTotal(1)
        setSelectedSopId(item.id)
      }).catch((error) => {
        setSopCandidates([])
        setSopTotal(0)
        setStatusMessage(error instanceof Error ? error.message : `未找到操作 #${bakeSopFocusId}`)
      })
      return
    }
    void fetchSops({
      q: bakeSopQuery.trim() || undefined,
      from: parseDateInputToMs(bakeSopFrom),
      to: parseDateInputToMs(bakeSopTo, true),
      limit: bakeSopLimit,
      offset: bakeSopOffset,
    }).then((data) => {
      setSopCandidates(data.items)
      setSopTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '操作手册加载失败')
    })
  }, [bakeSopFocusId, bakeSopFrom, bakeSopLimit, bakeSopOffset, bakeSopQuery, bakeSopTo, bakeTab, fetchSop, fetchSops, setSelectedSopId])

  useEffect(() => {
    if (!statusMessage) return
    const timer = window.setTimeout(() => setStatusMessage(null), 2400)
    return () => window.clearTimeout(timer)
  }, [statusMessage])

  useEffect(() => {
    setDraftKnowledgeQuery(bakeKnowledgeQuery)
  }, [bakeKnowledgeQuery])

  useEffect(() => {
    setDraftKnowledgeFrom(bakeKnowledgeFrom)
  }, [bakeKnowledgeFrom])

  useEffect(() => {
    setDraftKnowledgeTo(bakeKnowledgeTo)
  }, [bakeKnowledgeTo])

  useEffect(() => {
    setDraftTemplateQuery(bakeTemplateQuery)
  }, [bakeTemplateQuery])

  useEffect(() => {
    setDraftTemplateFrom(bakeTemplateFrom)
  }, [bakeTemplateFrom])

  useEffect(() => {
    setDraftTemplateTo(bakeTemplateTo)
  }, [bakeTemplateTo])

  useEffect(() => {
    setDraftSopQuery(bakeSopQuery)
  }, [bakeSopQuery])

  useEffect(() => {
    setDraftSopFrom(bakeSopFrom)
  }, [bakeSopFrom])

  useEffect(() => {
    setDraftSopTo(bakeSopTo)
  }, [bakeSopTo])

  const resolvedTemplateId = selectedTemplateId ?? templates[0]?.id ?? null
  const resolvedSopId = selectedSopId ?? sopCandidates[0]?.id ?? null
  const resolvedKnowledgeId = selectedKnowledgeId ?? knowledgeItems[0]?.id ?? null
  const resolvedKnowledgeItem = knowledgeItems.find(item => item.id === resolvedKnowledgeId)
  const resolvedSopItem = sopCandidates.find(item => item.id === resolvedSopId)
  const memoryTitleById = useMemo(() => new Map(memoryItems.map(item => [item.id, item.title])), [memoryItems])

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
      from: parseDateInputToMs(bakeKnowledgeFrom),
      to: parseDateInputToMs(bakeKnowledgeTo, true),
      limit: bakeKnowledgeLimit,
      offset,
    })
    setKnowledgeItems(data.items)
    setKnowledgeTotal(data.total)
  }

  const refreshTemplates = async (offset = bakeTemplateOffset) => {
    const data = await fetchTemplates({
      q: bakeTemplateQuery.trim() || undefined,
      from: parseDateInputToMs(bakeTemplateFrom),
      to: parseDateInputToMs(bakeTemplateTo, true),
      limit: bakeTemplateLimit,
      offset,
    })
    setTemplates(data.items)
    setTemplateTotal(data.total)
  }

  const refreshSops = async (offset = bakeSopOffset) => {
    const data = await fetchSops({
      q: bakeSopQuery.trim() || undefined,
      from: parseDateInputToMs(bakeSopFrom),
      to: parseDateInputToMs(bakeSopTo, true),
      limit: bakeSopLimit,
      offset,
    })
    setSopCandidates(data.items)
    setSopTotal(data.total)
  }

  const currentNavigationTarget = () => ({
    windowMode: 'bake' as const,
    bakeTab,
    selectedMemoryId,
    selectedTemplateId: resolvedTemplateId,
    selectedSopId: resolvedSopId,
    selectedKnowledgeId: resolvedKnowledgeId,
    bakeTemplateFocusId,
    bakeKnowledgeFocusId,
    bakeSopFocusId,
  })

  const restoreNavigationTarget = (target: BakeNavigationTarget) => {
    setWindowMode(target.windowMode)
    if (target.bakeTab) setBakeTab(target.bakeTab)
    if (target.repositoryTab) setRepositoryTab(target.repositoryTab)
    if (target.selectedMemoryId !== undefined) setSelectedMemoryId(target.selectedMemoryId)
    if (target.selectedTemplateId !== undefined) setSelectedTemplateId(target.selectedTemplateId)
    if (target.selectedSopId !== undefined) setSelectedSopId(target.selectedSopId)
    if (target.selectedKnowledgeId !== undefined) setSelectedKnowledgeId(target.selectedKnowledgeId)
    if (target.selectedCaptureId !== undefined) setSelectedCaptureId(target.selectedCaptureId)
    if (target.repositoryMemoryFocusId !== undefined) setRepositoryMemoryFocusId(target.repositoryMemoryFocusId)
    if (target.bakeTemplateFocusId !== undefined) setBakeTemplateFocusId(target.bakeTemplateFocusId)
    if (target.bakeKnowledgeFocusId !== undefined) setBakeKnowledgeFocusId(target.bakeKnowledgeFocusId)
    if (target.bakeSopFocusId !== undefined) setBakeSopFocusId(target.bakeSopFocusId)
    if (target.repositoryCaptureSourceCaptureId !== undefined) {
      setRepositoryCaptureSourceCaptureId(target.repositoryCaptureSourceCaptureId)
    }
  }

  const handleGoBack = () => {
    const target = popBakeNavigationTarget()
    if (!target) {
      setStatusMessage('当前没有可返回的上一步页面')
      return
    }
    restoreNavigationTarget(target)
    setStatusMessage('已返回上一步页面')
  }

  const handleSearchKnowledge = () => {
    setSelectedKnowledgeId(null)
    setBakeKnowledgeFocusId(null)
    useAppStore.setState({
      bakeKnowledgeQuery: draftKnowledgeQuery,
      bakeKnowledgeFrom: draftKnowledgeFrom,
      bakeKnowledgeTo: draftKnowledgeTo,
      bakeKnowledgeOffset: 0,
    })
  }

  const handleClearKnowledgeFilters = () => {
    setDraftKnowledgeQuery('')
    setDraftKnowledgeFrom('')
    setDraftKnowledgeTo('')
    setSelectedKnowledgeId(null)
    useAppStore.setState({
      bakeKnowledgeFocusId: null,
      bakeKnowledgeQuery: '',
      bakeKnowledgeFrom: '',
      bakeKnowledgeTo: '',
      bakeKnowledgeOffset: 0,
    })
  }

  const handleSearchTemplate = () => {
    setSelectedTemplateId(null)
    setBakeTemplateFocusId(null)
    useAppStore.setState({
      bakeTemplateQuery: draftTemplateQuery,
      bakeTemplateFrom: draftTemplateFrom,
      bakeTemplateTo: draftTemplateTo,
      bakeTemplateOffset: 0,
    })
  }

  const handleClearTemplateFilters = () => {
    setDraftTemplateQuery('')
    setDraftTemplateFrom('')
    setDraftTemplateTo('')
    setSelectedTemplateId(null)
    useAppStore.setState({
      bakeTemplateFocusId: null,
      bakeTemplateQuery: '',
      bakeTemplateFrom: '',
      bakeTemplateTo: '',
      bakeTemplateOffset: 0,
    })
  }

  const handleSearchSop = () => {
    setSelectedSopId(null)
    setBakeSopFocusId(null)
    useAppStore.setState({
      bakeSopQuery: draftSopQuery,
      bakeSopFrom: draftSopFrom,
      bakeSopTo: draftSopTo,
      bakeSopOffset: 0,
    })
  }

  const handleClearSopFilters = () => {
    setDraftSopQuery('')
    setDraftSopFrom('')
    setDraftSopTo('')
    setSelectedSopId(null)
    useAppStore.setState({
      bakeSopFocusId: null,
      bakeSopQuery: '',
      bakeSopFrom: '',
      bakeSopTo: '',
      bakeSopOffset: 0,
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

  const handleOpenLink = (url?: string, sourceCaptureId?: string) => {
    if (sourceCaptureId) {
      pushBakeNavigationTarget(currentNavigationTarget())
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
    pushBakeNavigationTarget(currentNavigationTarget())
    setWindowMode('knowledge')
    setRepositoryTab('memory')
    setRepositoryMemoryFocusId(memoryId)
    setSelectedMemoryId(memoryId)
    setStatusMessage('已切换到来源时间线')
  }

  const handleViewRelatedDocument = async (timelineId: string) => {
    const relatedDoc = templates.find(t => t.sourceMemoryIds.includes(timelineId))
    if (!relatedDoc) {
      setStatusMessage('当前时间线还没有被提炼为文档')
      return
    }
    pushBakeNavigationTarget(currentNavigationTarget())
    setBakeTab('templates')
    setBakeTemplateOffset(0)
    setBakeTemplateFocusId(relatedDoc.id)
    setSelectedTemplateId(relatedDoc.id)
    setStatusMessage(`已切换到关联文档「${relatedDoc.title}」`)
  }

  const handleViewLinkedKnowledge = (knowledgeId: string) => {
    pushBakeNavigationTarget(currentNavigationTarget())
    setBakeTab('knowledge')
    setBakeKnowledgeFocusId(knowledgeId)
    useAppStore.setState({
      bakeKnowledgeFocusId: knowledgeId,
      bakeKnowledgeQuery: '',
      bakeKnowledgeFrom: '',
      bakeKnowledgeTo: '',
      bakeKnowledgeOffset: 0,
    })
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
      {bakeNavigationStack.length > 0 && (
        <div className="bake-backbar">
          <span>可以返回上一步页面</span>
          <BakeButton compact onClick={handleGoBack}>
            <ArrowLeft size={14} />
            返回上一步
          </BakeButton>
        </div>
      )}
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
              pushBakeNavigationTarget(currentNavigationTarget())
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
            from={bakeKnowledgeFrom}
            to={bakeKnowledgeTo}
            draftFrom={draftKnowledgeFrom}
            draftTo={draftKnowledgeTo}
            selectedKnowledgeId={resolvedKnowledgeId}
            onSelectKnowledge={setSelectedKnowledgeId}
            onPageChange={setBakeKnowledgeOffset}
            onLimitChange={setBakeKnowledgeLimit}
            onDraftQueryChange={setDraftKnowledgeQuery}
            onDraftFromChange={setDraftKnowledgeFrom}
            onDraftToChange={setDraftKnowledgeTo}
            onSearch={handleSearchKnowledge}
            onClearFilters={handleClearKnowledgeFilters}
            focusId={bakeKnowledgeFocusId}
            onDeleteKnowledge={handleDeleteKnowledge}
            onViewSourceTimeline={handleViewSourceMemory}
            sourceTimelineTitle={resolvedKnowledgeItem?.sourceTimelineId ? memoryTitleById.get(resolvedKnowledgeItem.sourceTimelineId) : undefined}
            onOpenCapture={(captureId?: string) => {
              if (!captureId) {
                setStatusMessage('当前内容暂无关联采集记录')
                return
              }
              pushBakeNavigationTarget(currentNavigationTarget())
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
            from={bakeTemplateFrom}
            to={bakeTemplateTo}
            draftQuery={draftTemplateQuery}
            draftFrom={draftTemplateFrom}
            draftTo={draftTemplateTo}
            selectedTemplateId={resolvedTemplateId}
            onSelectTemplate={setSelectedTemplateId}
            onCreateTemplate={handleCreateTemplate}
            onUpdateTemplate={handleUpdateTemplate}
            onToggleTemplateStatus={handleToggleTemplateStatus}
            onDeleteTemplate={handleDeleteTemplate}
            onViewSourceMemory={handleViewSourceMemory}
            memoryTitleById={memoryTitleById}
            onPageChange={setBakeTemplateOffset}
            onLimitChange={setBakeTemplateLimit}
            onDraftQueryChange={setDraftTemplateQuery}
            onDraftFromChange={setDraftTemplateFrom}
            onDraftToChange={setDraftTemplateTo}
            onSearch={handleSearchTemplate}
            onClearFilters={handleClearTemplateFilters}
            focusId={bakeTemplateFocusId}
          />
        )}
        {bakeTab === 'sop' && (
          <BakeSopTab
            candidates={sopCandidates}
            total={sopTotal}
            offset={bakeSopOffset}
            limit={bakeSopLimit}
            query={bakeSopQuery}
            from={bakeSopFrom}
            to={bakeSopTo}
            draftQuery={draftSopQuery}
            draftFrom={draftSopFrom}
            draftTo={draftSopTo}
            selectedSopId={resolvedSopId}
            onSelectSop={setSelectedSopId}
            onDeleteSop={handleDeleteSop}
            onViewSourceTimeline={handleViewSourceMemory}
            sourceTimelineTitle={resolvedSopItem?.sourceTimelineId ? memoryTitleById.get(resolvedSopItem.sourceTimelineId) : undefined}
            onPageChange={setBakeSopOffset}
            onLimitChange={setBakeSopLimit}
            onDraftQueryChange={setDraftSopQuery}
            onDraftFromChange={setDraftSopFrom}
            onDraftToChange={setDraftSopTo}
            onSearch={handleSearchSop}
            onClearFilters={handleClearSopFilters}
            focusId={bakeSopFocusId}
          />
        )}
      </div>
    </div>
  )
}

export default BakePanel
