import React, { useEffect, useMemo, useState } from 'react'
import {
  useAdoptBakeSop,
  useCreateBakeTemplate,
  useDeleteBakeKnowledge,
  useDeleteBakeSop,
  useDeleteBakeTemplate,
  useFetchBakeMemories,
  useFetchBakeKnowledge,
  useFetchBakeOverview,
  useFetchBakeSops,
  useFetchBakeStyleConfig,
  useFetchBakeTemplates,
  useIgnoreBakeKnowledge,
  useIgnoreBakeMemory,
  useIgnoreBakeSop,
  useInitializeBakeMemories,
  usePromoteBakeMemoryToSop,
  usePromoteBakeMemoryToTemplate,
  useToggleBakeTemplateStatus,
  useUpdateBakeStyleConfig,
  useUpdateBakeTemplate,
} from '../hooks/useApi'
import { useAppStore } from '../store/useAppStore'
import type {
  ArticleTemplate,
  BakeBucket,
  BakeKnowledgeItem,
  BakeOverview,
  EpisodicMemoryItem,
  SopCandidate,
  WritingStyleConfig,
} from '../types'
import BakeHeader from './bake/BakeHeader'
import BakeOverviewTab from './bake/BakeOverviewTab'
import BakeMemoriesTab from './bake/BakeMemoriesTab'
import BakeTemplatesTab from './bake/BakeTemplatesTab'
import BakeStyleTab from './bake/BakeStyleTab'
import BakeSopTab from './bake/BakeSopTab'
import BakeKnowledgeTab from './bake/BakeKnowledgeTab'
import BakeTabs from './bake/BakeTabs'
import './bake/BakePanel.css'

const PAGE_SIZE = 20

const resolveTemplateBucket = (template?: Pick<ArticleTemplate, 'reviewStatus'> | null): BakeBucket => (
  template?.reviewStatus === 'candidate' ? 'pending' : 'extracted'
)

const resolveSopBucket = (candidate?: Pick<SopCandidate, 'status'> | null): BakeBucket => (
  candidate?.status === 'candidate' ? 'pending' : 'extracted'
)

const getFallbackOffsetAfterRemoval = (currentCount: number, offset: number, limit: number) => (
  currentCount <= 1 && offset > 0 ? Math.max(0, offset - limit) : offset
)

const createDraftTemplate = (): ArticleTemplate => ({
  id: `template-draft-${Date.now()}`,
  name: '新模板',
  category: '未分类',
  status: 'draft',
  tags: [],
  applicableTasks: ['creation'],
  sourceMemoryIds: [],
  linkedKnowledgeIds: [],
  structureSections: [],
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

const defaultStyleConfig: WritingStyleConfig = {
  preferredPhrases: [],
  replacementRules: [],
  styleSamples: [],
  applyToCreation: true,
  applyToTemplateEditing: true,
}

const BakePanel: React.FC = () => {
  const {
    bakeTab,
    selectedMemoryId,
    selectedTemplateId,
    selectedSopId,
    selectedKnowledgeId,
    bakeMemoryOffset,
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
    setSelectedMemoryId,
    setSelectedTemplateId,
    setSelectedSopId,
    setSelectedKnowledgeId,
    setSelectedCaptureId,
    setBakeMemoryOffset,
    setBakeKnowledgeOffset,
    setBakeKnowledgeLimit,
    setBakeTemplateOffset,
    setBakeTemplateQuery,
    setBakeTemplateLimit,
    setBakeSopOffset,
    setBakeSopQuery,
    setBakeSopLimit,
  } = useAppStore()

  const fetchOverview = useFetchBakeOverview()
  const fetchMemories = useFetchBakeMemories()
  const fetchKnowledge = useFetchBakeKnowledge()
  const deleteKnowledge = useDeleteBakeKnowledge()
  const ignoreKnowledge = useIgnoreBakeKnowledge()
  const ignoreMemory = useIgnoreBakeMemory()
  const initializeMemories = useInitializeBakeMemories()
  const promoteMemoryToTemplate = usePromoteBakeMemoryToTemplate()
  const promoteMemoryToSop = usePromoteBakeMemoryToSop()
  const fetchTemplates = useFetchBakeTemplates()
  const createTemplate = useCreateBakeTemplate()
  const updateTemplate = useUpdateBakeTemplate()
  const toggleTemplateStatus = useToggleBakeTemplateStatus()
  const deleteTemplate = useDeleteBakeTemplate()
  const fetchSops = useFetchBakeSops()
  const adoptSop = useAdoptBakeSop()
  const ignoreSop = useIgnoreBakeSop()
  const deleteSop = useDeleteBakeSop()
  const fetchStyleConfig = useFetchBakeStyleConfig()
  const updateStyleConfig = useUpdateBakeStyleConfig()

  const [overview, setOverview] = useState<BakeOverview>(defaultOverview)
  const [memories, setMemories] = useState<EpisodicMemoryItem[]>([])
  const [memoryTotal, setMemoryTotal] = useState(0)
  const [knowledgeBucket, setKnowledgeBucket] = useState<BakeBucket>('extracted')
  const [knowledgeItems, setKnowledgeItems] = useState<BakeKnowledgeItem[]>([])
  const [knowledgeTotal, setKnowledgeTotal] = useState(0)
  const [templateBucket, setTemplateBucket] = useState<BakeBucket>('extracted')
  const [templates, setTemplates] = useState<ArticleTemplate[]>([])
  const [templateTotal, setTemplateTotal] = useState(0)
  const [sopBucket, setSopBucket] = useState<BakeBucket>('extracted')
  const [sopCandidates, setSopCandidates] = useState<SopCandidate[]>([])
  const [sopTotal, setSopTotal] = useState(0)
  const [styleConfig, setStyleConfig] = useState<WritingStyleConfig>(defaultStyleConfig)
  const [isSavingStyle, setIsSavingStyle] = useState(false)
  const [isInitializingMemories, setIsInitializingMemories] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [draftKnowledgeQuery, setDraftKnowledgeQuery] = useState(bakeKnowledgeQuery)

  useEffect(() => {
    void Promise.all([
      fetchOverview().then((data) => {
        setOverview({
          captureCount: data.capture_count,
          memoryCount: data.memory_count,
          knowledgeCount: data.knowledge_count,
          templateCount: data.template_count,
          pendingCandidates: data.pending_candidates,
          recentActivities: data.recent_activities ?? [],
        })
      }),
      fetchStyleConfig().then(setStyleConfig),
    ]).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '烤面包数据加载失败')
    })
  }, [fetchOverview, fetchStyleConfig])

  useEffect(() => {
    void fetchMemories({ limit: PAGE_SIZE, offset: bakeMemoryOffset }).then((data) => {
      const maxOffset = data.total > 0 ? Math.max(0, Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE) : 0
      setMemoryTotal(data.total)
      if (data.items.length === 0 && bakeMemoryOffset > maxOffset) {
        setBakeMemoryOffset(maxOffset)
        return
      }
      setMemories(data.items)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '情节记忆加载失败')
    })
  }, [bakeMemoryOffset, fetchMemories, setBakeMemoryOffset])

  useEffect(() => {
    if (bakeTab !== 'knowledge') return
    void fetchKnowledge({
      q: bakeKnowledgeQuery.trim() || undefined,
      bucket: knowledgeBucket,
      limit: bakeKnowledgeLimit,
      offset: bakeKnowledgeOffset,
    }).then((data) => {
      setKnowledgeItems(data.items)
      setKnowledgeTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '知识加载失败')
    })
  }, [bakeKnowledgeLimit, bakeKnowledgeOffset, bakeKnowledgeQuery, bakeTab, fetchKnowledge, knowledgeBucket])

  useEffect(() => {
    if (bakeTab !== 'templates') return
    void fetchTemplates({
      q: bakeTemplateQuery.trim() || undefined,
      bucket: templateBucket,
      limit: bakeTemplateLimit,
      offset: bakeTemplateOffset,
    }).then((data) => {
      setTemplates(data.items)
      setTemplateTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '模板加载失败')
    })
  }, [bakeTab, bakeTemplateLimit, bakeTemplateOffset, bakeTemplateQuery, fetchTemplates, templateBucket])

  useEffect(() => {
    if (bakeTab !== 'sop') return
    void fetchSops({
      q: bakeSopQuery.trim() || undefined,
      bucket: sopBucket,
      limit: bakeSopLimit,
      offset: bakeSopOffset,
    }).then((data) => {
      setSopCandidates(data.items)
      setSopTotal(data.total)
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '操作手册加载失败')
    })
  }, [bakeSopLimit, bakeSopOffset, bakeSopQuery, bakeTab, fetchSops, sopBucket])

  useEffect(() => {
    if (!statusMessage) return
    const timer = window.setTimeout(() => setStatusMessage(null), 2400)
    return () => window.clearTimeout(timer)
  }, [statusMessage])

  useEffect(() => {
    setDraftKnowledgeQuery(bakeKnowledgeQuery)
  }, [bakeKnowledgeQuery])

  const resolvedMemoryId = selectedMemoryId ?? memories[0]?.id ?? null
  const resolvedTemplateId = selectedTemplateId ?? templates[0]?.id ?? null
  const resolvedSopId = selectedSopId ?? sopCandidates[0]?.id ?? null
  const resolvedKnowledgeId = selectedKnowledgeId ?? knowledgeItems[0]?.id ?? null

  const visibleMemories = useMemo(() => memories.filter(item => item.status !== 'ignored'), [memories])

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

  const refreshMemories = async (offset = bakeMemoryOffset) => {
    const data = await fetchMemories({ limit: PAGE_SIZE, offset })
    const maxOffset = data.total > 0 ? Math.max(0, Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE) : 0
    setMemoryTotal(data.total)
    if (data.items.length === 0 && offset > maxOffset) {
      setBakeMemoryOffset(maxOffset)
      return
    }
    setMemories(data.items)
  }

  const refreshKnowledge = async (offset = bakeKnowledgeOffset, bucket = knowledgeBucket) => {
    const data = await fetchKnowledge({
      q: bakeKnowledgeQuery.trim() || undefined,
      bucket,
      limit: bakeKnowledgeLimit,
      offset,
    })
    setKnowledgeItems(data.items)
    setKnowledgeTotal(data.total)
  }

  const refreshTemplates = async (offset = bakeTemplateOffset, bucket = templateBucket) => {
    const data = await fetchTemplates({
      q: bakeTemplateQuery.trim() || undefined,
      bucket,
      limit: bakeTemplateLimit,
      offset,
    })
    setTemplates(data.items)
    setTemplateTotal(data.total)
  }

  const refreshSops = async (offset = bakeSopOffset, bucket = sopBucket) => {
    const data = await fetchSops({
      q: bakeSopQuery.trim() || undefined,
      bucket,
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

  const handleKnowledgeBucketChange = (bucket: BakeBucket) => {
    setKnowledgeBucket(bucket)
    setSelectedKnowledgeId(null)
    setBakeKnowledgeOffset(0)
  }

  const handleTemplateBucketChange = (bucket: BakeBucket) => {
    setTemplateBucket(bucket)
    setSelectedTemplateId(null)
    setBakeTemplateOffset(0)
  }

  const handleSopBucketChange = (bucket: BakeBucket) => {
    setSopBucket(bucket)
    setSelectedSopId(null)
    setBakeSopOffset(0)
  }

  const handleOpenMemory = (id: string) => {
    setBakeTab('memories')
    setSelectedMemoryId(id)
  }

  const handleIgnoreMemory = async (id: string) => {
    try {
      await ignoreMemory(id)
      const nextOffset = getFallbackOffsetAfterRemoval(visibleMemories.length, bakeMemoryOffset, PAGE_SIZE)
      if (selectedMemoryId === id || resolvedMemoryId === id) {
        setSelectedMemoryId(null)
      }
      if (nextOffset !== bakeMemoryOffset) {
        setBakeMemoryOffset(nextOffset)
      } else {
        await refreshMemories(nextOffset)
      }
      setStatusMessage('已忽略情节记忆')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '忽略情节记忆失败')
    }
  }

  const handleCreateTemplate = async () => {
    try {
      const created = await createTemplate(createDraftTemplate())
      const nextBucket = resolveTemplateBucket(created)
      setTemplateBucket(nextBucket)
      setTemplates(prev => [created, ...prev.filter(item => item.id !== created.id)])
      setBakeTab('templates')
      setBakeTemplateOffset(0)
      setSelectedTemplateId(created.id)
      setStatusMessage(`已新建模板「${created.name}」`)
      await refreshOverview()
      if (nextBucket !== templateBucket) {
        await refreshTemplates(0, nextBucket)
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '新建模板失败')
    }
  }

  const handlePromoteToTemplate = async (id: string) => {
    try {
      const created = await promoteMemoryToTemplate(id)
      const nextBucket = resolveTemplateBucket(created)
      setTemplateBucket(nextBucket)
      setTemplates(prev => [created, ...prev.filter(item => item.id !== created.id)])
      await refreshMemories()
      setBakeTab('templates')
      setBakeTemplateOffset(0)
      setSelectedTemplateId(created.id)
      setStatusMessage(`已创建模板「${created.name}」`)
      await refreshOverview()
      if (nextBucket !== templateBucket) {
        await refreshTemplates(0, nextBucket)
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '纳入模板失败')
    }
  }

  const handleInitializeMemories = async () => {
    setIsInitializingMemories(true)
    try {
      const result = await initializeMemories(20)
      await refreshMemories(0)
      setBakeMemoryOffset(0)
      setStatusMessage(result.created_count > 0 ? `已初始化 ${result.created_count} 条情节记忆` : '没有可初始化的新情节记忆')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '初始化情节记忆失败')
    } finally {
      setIsInitializingMemories(false)
    }
  }

  const handlePromoteToSop = async (id: string) => {
    try {
      const created = await promoteMemoryToSop(id)
      const nextBucket = resolveSopBucket(created)
      setSopBucket(nextBucket)
      setSopCandidates(prev => [created, ...prev.filter(item => item.id !== created.id)])
      setBakeTab('sop')
      setBakeSopOffset(0)
      setSelectedSopId(created.id)
      setStatusMessage(`已生成工作流程指导「${created.extractedProblem || created.sourceTitle || created.id}」`)
      await refreshOverview()
      if (nextBucket !== sopBucket) {
        await refreshSops(0, nextBucket)
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '生成工作流程指导失败')
    }
  }

  const handlePromoteToKnowledge = async (_id: string) => {
    setSelectedKnowledgeId(null)
    setBakeKnowledgeOffset(0)
    setBakeTab('knowledge')
    setStatusMessage('已切换到已提炼知识页；这里不会显示来源 knowledge')
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
      setWindowMode('knowledge')
      setRepositoryTab('capture')
      setSelectedCaptureId(sourceCaptureId)
      setStatusMessage('已打开关联记忆片段')
      return
    }
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer')
      setStatusMessage('已打开原文链接')
      return
    }
    setStatusMessage('当前内容没有可打开的原文或关联记忆片段')
  }

  const handleUpdateTemplate = async (templateId: string, updater: (template: ArticleTemplate) => ArticleTemplate) => {
    const target = templates.find(item => item.id === templateId)
    if (!target) return
    try {
      const updated = await updateTemplate(updater(target))
      const nextBucket = resolveTemplateBucket(updated)
      if (nextBucket !== templateBucket) {
        setSelectedTemplateId(null)
        setTemplates(prev => prev.filter(item => item.id !== templateId))
        setTemplateBucket(nextBucket)
        setBakeTemplateOffset(0)
        await refreshTemplates(0, nextBucket)
      } else {
        setTemplates(prev => prev.map(item => item.id === templateId ? updated : item))
      }
      setStatusMessage(`已更新模板「${updated.name}」`)
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
      setStatusMessage('当前模板还没有关联来源情节记忆')
      return
    }
    setBakeTab('memories')
    setSelectedMemoryId(memoryId)
    setStatusMessage('已切换到来源情节记忆')
  }

  const handleAdoptSop = async (id: string) => {
    try {
      const adopted = await adoptSop(id)
      if (sopBucket === 'pending') {
        const nextOffset = getFallbackOffsetAfterRemoval(sopCandidates.length, bakeSopOffset, bakeSopLimit)
        setSelectedSopId(null)
        if (nextOffset !== bakeSopOffset) {
          setBakeSopOffset(nextOffset)
        } else {
          await refreshSops(nextOffset, sopBucket)
        }
      } else {
        setSopCandidates(prev => prev.map(item => item.id === id ? adopted : item))
      }
      setStatusMessage(`已采纳工作流程指导「${adopted.extractedProblem || adopted.sourceTitle || id}」`)
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '采纳工作流程指导失败')
    }
  }

  const handleIgnoreKnowledge = async (id: string) => {
    try {
      await ignoreKnowledge(id)
      const nextOffset = getFallbackOffsetAfterRemoval(knowledgeItems.length, bakeKnowledgeOffset, bakeKnowledgeLimit)
      if (selectedKnowledgeId === id || resolvedKnowledgeId === id) {
        setSelectedKnowledgeId(null)
      }
      if (nextOffset !== bakeKnowledgeOffset) {
        setBakeKnowledgeOffset(nextOffset)
      } else {
        await refreshKnowledge(nextOffset, knowledgeBucket)
      }
      setStatusMessage('已忽略待提炼知识')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '忽略知识失败')
    }
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
        await refreshKnowledge(nextOffset, knowledgeBucket)
      }
      setStatusMessage('已删除知识条目')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '删除知识失败')
    }
  }

  const handleIgnoreSop = async (id: string) => {
    try {
      await ignoreSop(id)
      const nextOffset = getFallbackOffsetAfterRemoval(sopCandidates.length, bakeSopOffset, bakeSopLimit)
      if (selectedSopId === id || resolvedSopId === id) {
        setSelectedSopId(null)
      }
      if (nextOffset !== bakeSopOffset) {
        setBakeSopOffset(nextOffset)
      } else {
        await refreshSops(nextOffset, sopBucket)
      }
      setStatusMessage('已忽略待提炼操作手册')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '忽略操作手册失败')
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
        await refreshSops(nextOffset, sopBucket)
      }
      setStatusMessage('已删除操作手册')
      await refreshOverview()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '删除操作手册失败')
    }
  }

  const handleSaveStyle = async (nextConfig: WritingStyleConfig) => {
    setStyleConfig(nextConfig)
    setIsSavingStyle(true)
    try {
      const saved = await updateStyleConfig(nextConfig)
      setStyleConfig(saved)
      setStatusMessage('已保存写作自然感提升配置')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '保存写作自然感失败')
    } finally {
      setIsSavingStyle(false)
    }
  }

  return (
    <div className="bake-panel">
      <BakeHeader />
      {statusMessage && <div className="bake-inline-message">{statusMessage}</div>}
      <BakeTabs current={bakeTab} onChange={setBakeTab} />

      <div className="bake-tab-content">
        {bakeTab === 'overview' && (
          <BakeOverviewTab
            memories={visibleMemories}
            overview={overview}
            onOpenMemory={handleOpenMemory}
            onOpenTab={setBakeTab}
            onOpenRepository={(tab) => {
              setWindowMode('knowledge')
              setRepositoryTab(tab)
            }}
          />
        )}
        {bakeTab === 'memories' && (
          <BakeMemoriesTab
            memories={visibleMemories}
            total={memoryTotal}
            offset={bakeMemoryOffset}
            selectedMemoryId={resolvedMemoryId}
            onSelectMemory={setSelectedMemoryId}
            onPageChange={setBakeMemoryOffset}
            onPromoteToTemplate={handlePromoteToTemplate}
            onPromoteToSop={handlePromoteToSop}
            onPromoteToKnowledge={handlePromoteToKnowledge}
            onIgnoreMemory={handleIgnoreMemory}
            onCopyMemory={(memory: EpisodicMemoryItem) => handleCopy(`${memory.title}${memory.url ? `\n${memory.url}` : ''}`, `已复制情节记忆「${memory.title}」信息`)}
            onOpenMemoryLink={handleOpenLink}
            onInitializeMemories={handleInitializeMemories}
            isInitializing={isInitializingMemories}
          />
        )}
        {bakeTab === 'knowledge' && (
          <BakeKnowledgeTab
            bucket={knowledgeBucket}
            items={knowledgeItems}
            total={knowledgeTotal}
            offset={bakeKnowledgeOffset}
            limit={bakeKnowledgeLimit}
            query={bakeKnowledgeQuery}
            draftQuery={draftKnowledgeQuery}
            selectedKnowledgeId={resolvedKnowledgeId}
            onSelectKnowledge={setSelectedKnowledgeId}
            onBucketChange={handleKnowledgeBucketChange}
            onPageChange={setBakeKnowledgeOffset}
            onLimitChange={setBakeKnowledgeLimit}
            onDraftQueryChange={setDraftKnowledgeQuery}
            onSearch={handleSearchKnowledge}
            onClearFilters={handleClearKnowledgeFilters}
            onIgnoreKnowledge={handleIgnoreKnowledge}
            onDeleteKnowledge={handleDeleteKnowledge}
            onOpenCapture={(captureId?: string) => {
              if (!captureId) {
                setStatusMessage('当前内容暂无关联记忆片段')
                return
              }
              setWindowMode('knowledge')
              setRepositoryTab('capture')
              setSelectedCaptureId(captureId)
              setStatusMessage('已切换到关联记忆片段')
            }}
          />
        )}
        {bakeTab === 'templates' && (
          <BakeTemplatesTab
            bucket={templateBucket}
            templates={templates}
            total={templateTotal}
            offset={bakeTemplateOffset}
            limit={bakeTemplateLimit}
            query={bakeTemplateQuery}
            selectedTemplateId={resolvedTemplateId}
            onSelectTemplate={setSelectedTemplateId}
            onBucketChange={handleTemplateBucketChange}
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
        {bakeTab === 'style' && (
          <BakeStyleTab
            config={styleConfig}
            onSave={handleSaveStyle}
            isSaving={isSavingStyle}
          />
        )}
        {bakeTab === 'sop' && (
          <BakeSopTab
            bucket={sopBucket}
            candidates={sopCandidates}
            total={sopTotal}
            offset={bakeSopOffset}
            limit={bakeSopLimit}
            query={bakeSopQuery}
            selectedSopId={resolvedSopId}
            onSelectSop={setSelectedSopId}
            onBucketChange={handleSopBucketChange}
            onAdoptSop={handleAdoptSop}
            onIgnoreSop={handleIgnoreSop}
            onDeleteSop={handleDeleteSop}
            onCopySteps={(candidate: SopCandidate) => handleCopy(candidate.steps.map((step, idx) => `${idx + 1}. ${step}`).join('\n'), '已复制流程步骤')}
            onCopyPrompt={(candidate: SopCandidate) => handleCopy(`问题：${candidate.extractedProblem || candidate.sourceTitle || '未命名'}\n建议流程：${candidate.steps.join(' → ')}`, '已复制操作手册提示')}
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
