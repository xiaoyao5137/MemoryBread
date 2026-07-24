import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { AtSign, CloudOff, CloudUpload, Copy, ExternalLink, Eye, FileText, Image, Library, Loader2, PackageCheck, PackagePlus, Paperclip, Pencil, Search, Sparkles, Square, Store, Trash2, X } from 'lucide-react'
import { serviceEnvironmentHeaders, useAppStore } from '../store/useAppStore'
import type { CreationReferenceItem, CreationReferencePreview } from '../store/useAppStore'
import { fetchWithLocalhostFallback } from '../hooks/useApi'
import { fetchBillingBalance } from '../utils/authApi'
import { CREATION_MODEL_DEFS, LOCAL_CREATION_MODEL_ID, REMOTE_CREATION_MODEL_ID, canUseRemoteCreationModel, getEffectiveCreationModelId, getModelDisplayName } from '../utils/modelSelection'
import { buildAttachmentMetadata, buildAttachmentPrompt, filesToAttachments, formatAttachmentSize, type UserAttachment } from '../utils/attachments'
import { toUserFacingError } from '../utils/userFacingError'
import {
  buildCreationSkillInstruction,
  categoryPathFor,
  creationSkillCategoryOptions,
  deleteLocalCreationSkill,
  fetchCreationSkillCategories,
  listLocalCreationSkills,
  marketCreationSkillToLocalInput,
  matchCreationSkills,
  publishCreationSkill,
  saveLocalCreationSkill,
  searchCreationSkillMarket,
  type CreationSkillMarketItem,
  type CreationSkillSource,
  type LocalCreationSkill,
} from '../utils/creationSkills'
import { OFFLINE_CREATION_SKILL_CATEGORIES } from '../data/creationSkillCategories'
import ModelSelect from './ModelSelect'
import CreationSkillEditor from './CreationSkillEditor'
import CreationSkillDetail, {
  localSkillDetail,
  marketSkillDetail,
  type CreationSkillDetailData,
} from './CreationSkillDetail'
import { HistoryPagination, HistorySearch } from './HistoryBrowserControls'

interface CreationPanelProps {
  className?: string
}

type ReferenceItem = CreationReferenceItem
type ReferencePreview = CreationReferencePreview
interface CreationHistoryItem {
  id: number
  prompt: string
  timestamp: string
  preview: string
  fullContent: string
  docType: string
  audience: string
  references: CreationReferenceItem[]
  model?: string | null
  latencyMs?: number | null
}
type MarkdownBlock =
  | { type: 'markdown'; content: string }
  | { type: 'table'; headers: string[]; alignments: Array<'left' | 'center' | 'right'>; rows: string[][] }

const defaultPrompt = '请生成一份“数据治理平台建设方案”，参考历史项目方案、知识库和操作手册，风格正式，包含总体架构、功能设计、实施计划和后续核验清单。'
const HISTORY_PAGE_SIZE = 20
const SKILL_MARKET_PAGE_SIZE = 18

const sanitizeGeneratedContent = (content: string) =>
  content.replace(/<a\s+(?:id|name)=["'][^"']+["']\s*>\s*<\/a>/gi, '')

const readApiErrorMessage = async (response: Response, fallback: string) => {
  try {
    const text = await response.text()
    if (!text.trim()) return fallback

    try {
      const data = JSON.parse(text)
      if (typeof data === 'string') return data
      if (data?.detail) return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
      if (data?.message) return data.message
      if (data?.error?.message) return data.error.message
      if (data?.error?.code) return data.error.code
      if (data?.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
    } catch {
      return text
    }

    return text
  } catch {
    return fallback
  }
}

const normalizeLatencyMs = (value: unknown): number | null => {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
}

const formatInferenceLatency = (latencyMs?: number | null) => {
  if (latencyMs == null) return '未记录'
  if (latencyMs < 1000) return `${latencyMs} ms`
  return `${(latencyMs / 1000).toFixed(latencyMs < 10_000 ? 1 : 0)} 秒`
}

const mapCreationHistory = (histories: any[]): CreationHistoryItem[] => histories.map((h: any) => {
  const fullContent = sanitizeGeneratedContent(h.generated_content)
  let references: CreationReferenceItem[] = []
  try {
    const parsed = typeof h.references_json === 'string' ? JSON.parse(h.references_json || '[]') : h.references_json
    references = Array.isArray(parsed) ? parsed : []
  } catch {
    references = []
  }
  return {
    id: Number(h.id),
    prompt: h.prompt,
    timestamp: new Date(h.created_at).toLocaleString('zh-CN'),
    preview: fullContent.slice(0, 100) + (fullContent.length > 100 ? '...' : ''),
    fullContent,
    docType: h.doc_type || '',
    audience: h.audience || '',
    references,
    model: h.model || null,
    latencyMs: normalizeLatencyMs(h.latency_ms),
  }
})

const splitTableRow = (line: string) => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char === '|' && trimmed[index - 1] !== '\\') {
      cells.push(cell.replace(/\\\|/g, '|').trim())
      cell = ''
    } else {
      cell += char
    }
  }

  cells.push(cell.replace(/\\\|/g, '|').trim())
  return cells
}

const isTableSeparator = (line: string) => {
  const cells = splitTableRow(line)
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

const isPotentialTableRow = (line: string) => {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && splitTableRow(trimmed).length > 1
}

const tableAlignments = (separatorLine: string): Array<'left' | 'center' | 'right'> =>
  splitTableRow(separatorLine).map(cell => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
    if (cell.endsWith(':')) return 'right'
    return 'left'
  })

const parseMarkdownBlocks = (content: string): MarkdownBlock[] => {
  const lines = content.split('\n')
  const blocks: MarkdownBlock[] = []
  let markdownBuffer: string[] = []
  let index = 0

  const flushMarkdown = () => {
    const markdown = markdownBuffer.join('\n').trim()
    if (markdown) blocks.push({ type: 'markdown', content: markdown })
    markdownBuffer = []
  }

  while (index < lines.length) {
    const current = lines[index]
    const next = lines[index + 1]
    if (isPotentialTableRow(current) && next && isTableSeparator(next)) {
      flushMarkdown()
      const headers = splitTableRow(current)
      const alignments = tableAlignments(next)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && isPotentialTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      blocks.push({ type: 'table', headers, alignments, rows })
      continue
    }

    markdownBuffer.push(current)
    index += 1
  }

  flushMarkdown()
  return blocks
}

const CreationPanel: React.FC<CreationPanelProps> = ({ className = '' }) => {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)
  const adminApiBaseUrl = useAppStore((s) => s.adminApiBaseUrl)
  const gatewayApiBaseUrl = useAppStore((s) => s.gatewayApiBaseUrl)
  const authToken = useAppStore((s) => s.authToken)
  const currentUser = useAppStore((s) => s.currentUser)
  const cloudBalance = useAppStore((s) => s.cloudBalance)
  const setCloudBalance = useAppStore((s) => s.setCloudBalance)
  const localDebugModeEnabled = useAppStore((s) => s.localDebugModeEnabled)
  const draft = useAppStore((s) => s.creationDraft)
  const setCreationDraft = useAppStore((s) => s.setCreationDraft)
  const setWindowMode = useAppStore((s) => s.setWindowMode)
  const setBakeTab = useAppStore((s) => s.setBakeTab)
  const setSelectedTemplateId = useAppStore((s) => s.setSelectedTemplateId)
  const setBakeTemplateFocusId = useAppStore((s) => s.setBakeTemplateFocusId)
  const setBakeTemplateOffset = useAppStore((s) => s.setBakeTemplateOffset)
  const setBakeTemplateQuery = useAppStore((s) => s.setBakeTemplateQuery)
  const setBakeTemplateLimit = useAppStore((s) => s.setBakeTemplateLimit)
  const pushBakeNavigationTarget = useAppStore((s) => s.pushBakeNavigationTarget)
  const creationModelConfigs = useAppStore((s) => s.creationModelConfigs)
  const setCreationModelConfig = useAppStore((s) => s.setCreationModelConfig)

  const {
    prompt,
    docType,
    audience,
    generatedContent,
    inheritFormat,
    enableRag,
    enableWebSearch,
    enableImageGeneration,
    contentWeight,
    qualityWeight,
    completenessWeight,
    usageWeight,
    formatWeight,
    freshnessWeight,
    referencePreview,
  } = draft

  const setPrompt = (v: string) => setCreationDraft({ prompt: v })
  const setDocType = (v: string) => setCreationDraft({ docType: v })
  const setAudience = (v: string) => setCreationDraft({ audience: v })
  const setGeneratedContent = (updater: string | ((prev: string) => string)) => {
    if (typeof updater === 'function') {
      setCreationDraft({ generatedContent: sanitizeGeneratedContent(updater(useAppStore.getState().creationDraft.generatedContent)) })
    } else {
      setCreationDraft({ generatedContent: sanitizeGeneratedContent(updater) })
    }
  }
  const setInheritFormat = (v: boolean) => setCreationDraft({ inheritFormat: v })
  const setEnableRag = (v: boolean) => setCreationDraft({ enableRag: v })
  const setEnableWebSearch = (v: boolean) => setCreationDraft({ enableWebSearch: v })
  const setEnableImageGeneration = (v: boolean) => setCreationDraft({ enableImageGeneration: v })
  const setContentWeight = (v: number) => setCreationDraft({ contentWeight: v })
  const setQualityWeight = (v: number) => setCreationDraft({ qualityWeight: v })
  const setCompletenessWeight = (v: number) => setCreationDraft({ completenessWeight: v })
  const setUsageWeight = (v: number) => setCreationDraft({ usageWeight: v })
  const setFormatWeight = (v: number) => setCreationDraft({ formatWeight: v })
  const setFreshnessWeight = (v: number) => setCreationDraft({ freshnessWeight: v })
  const setReferencePreview = (v: ReferencePreview | null) => setCreationDraft({ referencePreview: v })

  const [isGenerating, setIsGenerating] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copySuccess, setCopySuccess] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [topTab, setTopTab] = useState<'creation' | 'history' | 'skills'>('creation')
  const [activeBottomTab, setActiveBottomTab] = useState<'reference' | 'config' | null>(null)
  const toggleBottomTab = (tab: 'reference' | 'config') =>
    setActiveBottomTab(prev => prev === tab ? null : tab)
  const [creationHistory, setCreationHistory] = useState<CreationHistoryItem[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyPage, setHistoryPage] = useState(1)
  const [historySearch, setHistorySearch] = useState('')
  const [debouncedHistorySearch, setDebouncedHistorySearch] = useState('')
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [lastInferenceMeta, setLastInferenceMeta] = useState<{ model: string; latencyMs: number | null } | null>(null)
  const [attachments, setAttachments] = useState<UserAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [currentDocumentSource, setCurrentDocumentSource] = useState<CreationSkillSource | null>(null)
  const [localSkills, setLocalSkills] = useState<LocalCreationSkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState('')
  const [publishingSkillId, setPublishingSkillId] = useState<number | null>(null)
  const [skillLibraryView, setSkillLibraryView] = useState<'mine' | 'market'>('mine')
  const [marketQueryDraft, setMarketQueryDraft] = useState('')
  const [marketQuery, setMarketQuery] = useState('')
  const [marketCategoryIdDraft, setMarketCategoryIdDraft] = useState('')
  const [marketCategoryId, setMarketCategoryId] = useState('')
  const [marketCategories, setMarketCategories] = useState(OFFLINE_CREATION_SKILL_CATEGORIES)
  const [marketOffset, setMarketOffset] = useState(0)
  const [marketSkills, setMarketSkills] = useState<CreationSkillMarketItem[]>([])
  const [marketTotal, setMarketTotal] = useState(0)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState('')
  const [installingMarketSkillId, setInstallingMarketSkillId] = useState<string | null>(null)
  const [skillEditor, setSkillEditor] = useState<{ source?: CreationSkillSource; initialSkill?: LocalCreationSkill } | null>(null)
  const [skillDetail, setSkillDetail] = useState<CreationSkillDetailData | null>(null)
  const [skillDetailMarketItem, setSkillDetailMarketItem] = useState<CreationSkillMarketItem | null>(null)
  const [currentDocumentSkills, setCurrentDocumentSkills] = useState<LocalCreationSkill[]>([])
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const promptInputRef = useRef<HTMLTextAreaElement>(null)

  const startTimer = () => {
    setElapsedSeconds(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1)
    }, 1000)
  }

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => () => stopTimer(), [])

  const loadCreationHistory = useCallback(async (signal?: AbortSignal) => {
    setHistoryLoading(true)
    setHistoryError(null)
    const params = new URLSearchParams({
      paged: 'true',
      limit: String(HISTORY_PAGE_SIZE),
      offset: String((historyPage - 1) * HISTORY_PAGE_SIZE),
    })
    if (debouncedHistorySearch) params.set('q', debouncedHistorySearch)

    try {
      const response = await fetchWithLocalhostFallback(`${apiBaseUrl}/api/creation/history?${params}`, { signal })
      if (!response.ok) throw new Error(`creation history fetch failed: ${response.status}`)
      const data = await response.json()
      if (signal?.aborted) return
      const records = Array.isArray(data) ? data : data.items ?? []
      setCreationHistory(mapCreationHistory(records))
      setHistoryTotal(Number.isFinite(Number(data?.total)) ? Number(data.total) : records.length)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.error('加载创作记录失败:', err)
      setCreationHistory([])
      setHistoryTotal(0)
      setHistoryError('创作记录加载失败，请稍后重试。')
    } finally {
      if (!signal?.aborted) setHistoryLoading(false)
    }
  }, [apiBaseUrl, debouncedHistorySearch, historyPage])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setHistoryPage(1)
      setDebouncedHistorySearch(historySearch.trim())
    }, 300)
    return () => window.clearTimeout(timer)
  }, [historySearch])

  useEffect(() => {
    const controller = new AbortController()
    void loadCreationHistory(controller.signal)
    return () => controller.abort()
  }, [loadCreationHistory])

  const handleOpenReferenceSource = (item: Pick<ReferenceItem, 'id'>) => {
    const templateId = String(item.id)
    pushBakeNavigationTarget({ windowMode: 'creation' })
    setBakeTemplateQuery('')
    setBakeTemplateOffset(0)
    setBakeTemplateLimit(100)
    setBakeTemplateFocusId(templateId)
    setBakeTab('templates')
    setSelectedTemplateId(templateId)
    setWindowMode('bake')
  }

  const handleRestoreHistory = (item: typeof creationHistory[0]) => {
    setPrompt(item.prompt)
    setGeneratedContent(item.fullContent)
    setReferencePreview({
      requirement: {
        topic: item.prompt,
        doc_type: item.docType || docType,
        audience: item.audience || audience,
        style: '',
        keywords: [],
      },
      references: item.references || [],
    })
    setCurrentDocumentSource({
      kind: 'creation_history',
      id: String(item.id),
      title: item.prompt,
      content: item.fullContent,
      docType: item.docType || docType,
    })
    if (contentRef.current) {
      setTimeout(() => contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 100)
    }
  }

  const loadLocalSkills = useCallback(async () => {
    setSkillsLoading(true)
    setSkillsError('')
    try {
      setLocalSkills(await listLocalCreationSkills(apiBaseUrl))
    } catch (err) {
      setLocalSkills([])
      setSkillsError(toUserFacingError(err, '创作 Skill 加载失败'))
    } finally {
      setSkillsLoading(false)
    }
  }, [apiBaseUrl])

  useEffect(() => {
    void loadLocalSkills()
  }, [loadLocalSkills])

  const loadMarketSkills = useCallback(async () => {
    setMarketLoading(true)
    setMarketError('')
    try {
      const page = await searchCreationSkillMarket(adminApiBaseUrl, {
        query: marketQuery,
        categoryId: marketCategoryId,
        limit: SKILL_MARKET_PAGE_SIZE,
        offset: marketOffset,
      })
      setMarketSkills(page.items)
      setMarketTotal(page.total)
    } catch (err) {
      setMarketSkills([])
      setMarketTotal(0)
      setMarketError(toUserFacingError(err, '创作 Skill 市场加载失败'))
    } finally {
      setMarketLoading(false)
    }
  }, [adminApiBaseUrl, marketCategoryId, marketOffset, marketQuery])

  const loadMarketCategories = useCallback(async () => {
    setMarketCategories(await fetchCreationSkillCategories(adminApiBaseUrl))
  }, [adminApiBaseUrl])

  useEffect(() => {
    if (topTab === 'skills' && skillLibraryView === 'market') {
      void loadMarketSkills()
      void loadMarketCategories()
    }
  }, [loadMarketCategories, loadMarketSkills, skillLibraryView, topTab])

  useEffect(() => {
    if (!currentDocumentSource) {
      setCurrentDocumentSkills([])
      return
    }
    let cancelled = false
    listLocalCreationSkills(apiBaseUrl, {
      sourceKind: currentDocumentSource.kind,
      sourceId: currentDocumentSource.id,
    }).then(items => {
      if (!cancelled) setCurrentDocumentSkills(items)
    }).catch(() => {
      if (!cancelled) setCurrentDocumentSkills([])
    })
    return () => { cancelled = true }
  }, [apiBaseUrl, currentDocumentSource])

  const openCurrentDocumentSkill = () => {
    if (!generatedContent.trim()) return
    setSkillEditor({
      source: currentDocumentSource || {
        kind: 'creation_history',
        id: `unsaved-${Date.now()}`,
        title: prompt.trim() || docType || '创作文档',
        content: generatedContent,
        docType,
      },
    })
  }

  const handleSkillSaved = (skill: LocalCreationSkill) => {
    setLocalSkills(prev => [skill, ...prev.filter(item => item.id !== skill.id)])
    if (currentDocumentSource?.kind === skill.sourceKind && currentDocumentSource.id === skill.sourceId) {
      setCurrentDocumentSkills(prev => [skill, ...prev.filter(item => item.id !== skill.id)])
    }
  }

  const handleToggleSkillInstalled = async (skill: LocalCreationSkill) => {
    if (skill.status !== 'saved') {
      setSkillsError('请先打开草稿并保存 Skill，再安装使用。')
      return
    }
    setSkillsError('')
    const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = skill
    try {
      const saved = await saveLocalCreationSkill(apiBaseUrl, { ...input, installed: !skill.installed }, id)
      handleSkillSaved(saved)
    } catch (err) {
      setSkillsError(toUserFacingError(err, skill.installed ? '卸载 Skill 失败' : '安装 Skill 失败'))
    }
  }

  const handlePublishSkill = async (skill: LocalCreationSkill, published: boolean) => {
    if (skill.status !== 'saved') {
      setSkillsError('请先打开草稿并保存 Skill，再发布到市场。')
      return
    }
    if (!authToken || !currentUser) {
      setSkillsError('请先登录 MemoryBread 账户，再发布到创作市场。')
      return
    }
    setPublishingSkillId(skill.id)
    setSkillsError('')
    const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = skill
    try {
      const cloud = await publishCreationSkill(adminApiBaseUrl, authToken, input, published)
      const saved = await saveLocalCreationSkill(apiBaseUrl, {
        ...input,
        cloudSkillId: cloud.id,
        published: cloud.published,
      }, id)
      handleSkillSaved(saved)
    } catch (err) {
      setSkillsError(toUserFacingError(err, published ? '发布 Skill 失败' : '取消发布 Skill 失败'))
    } finally {
      setPublishingSkillId(null)
    }
  }

  const handleInstallMarketSkill = async (marketSkill: CreationSkillMarketItem) => {
    setInstallingMarketSkillId(marketSkill.id)
    setMarketError('')
    const existing = localSkills.find(skill => skill.cloudSkillId === marketSkill.id)
    try {
      const marketInput = marketCreationSkillToLocalInput(marketSkill)
      let input = marketInput
      if (existing) {
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...existingInput } = existing
        input = existing.sourceKind === 'market'
          ? { ...marketInput, clientSkillKey: existing.clientSkillKey }
          : { ...existingInput, installed: true }
      }
      const saved = await saveLocalCreationSkill(
        apiBaseUrl,
        input,
        existing?.id,
      )
      handleSkillSaved(saved)
      setSkillDetail(current => current?.id === marketSkill.id
        ? { ...current, installed: true }
        : current)
    } catch (err) {
      setMarketError(toUserFacingError(err, '安装市场 Skill 失败'))
    } finally {
      setInstallingMarketSkillId(null)
    }
  }

  const showLocalSkillDetail = (skill: LocalCreationSkill) => {
    const path = categoryPathFor(OFFLINE_CREATION_SKILL_CATEGORIES, skill.categoryId)
      .map(item => item.name)
    setSkillDetailMarketItem(null)
    setSkillDetail(localSkillDetail(skill, path))
  }

  const showMarketSkillDetail = (skill: CreationSkillMarketItem) => {
    const installed = localSkills.some(item =>
      item.cloudSkillId === skill.id && item.installed,
    )
    setSkillDetailMarketItem(skill)
    setSkillDetail(marketSkillDetail(skill, installed))
  }

  const closeSkillDetail = useCallback(() => {
    setSkillDetail(null)
    setSkillDetailMarketItem(null)
  }, [])

  const handleDeleteSkill = async (skill: LocalCreationSkill) => {
    if (skill.published) {
      setSkillsError('已发布的 Skill 暂不能删除。')
      return
    }
    try {
      await deleteLocalCreationSkill(apiBaseUrl, skill.id)
      setLocalSkills(prev => prev.filter(item => item.id !== skill.id))
    } catch (err) {
      setSkillsError(toUserFacingError(err, '删除创作 Skill 失败'))
    }
  }

  const remoteModelAllowed = canUseRemoteCreationModel(currentUser, cloudBalance)
  const activeCreationModelId = getEffectiveCreationModelId(creationModelConfigs, remoteModelAllowed)
  const useGatewayCreation = activeCreationModelId === REMOTE_CREATION_MODEL_ID
  const installedSkills = useMemo(
    () => localSkills.filter(skill => skill.status === 'saved' && skill.installed),
    [localSkills],
  )
  const installedMarketSkillIds = useMemo(
    () => new Set(
      localSkills
        .filter(skill => skill.installed && skill.cloudSkillId)
        .map(skill => skill.cloudSkillId as string),
    ),
    [localSkills],
  )
  const marketCategoryOptions = useMemo(
    () => creationSkillCategoryOptions(marketCategories),
    [marketCategories],
  )
  const matchedSkills = useMemo(
    () => matchCreationSkills(prompt, installedSkills),
    [installedSkills, prompt],
  )
  const skillPickerItems = useMemo(() => {
    const query = skillQuery.trim().toLowerCase()
    return installedSkills
      .filter(skill => !query || `${skill.title}\n${skill.summary}`.toLowerCase().includes(query))
      .slice(0, 8)
  }, [installedSkills, skillQuery])
  const promptWithAttachments = () => {
    const attachmentPrompt = buildAttachmentPrompt(attachments)
    const basePrompt = attachmentPrompt ? `${prompt.trim()}\n\n${attachmentPrompt}` : prompt.trim()
    return `${basePrompt}${buildCreationSkillInstruction(matchedSkills)}`
  }

  const handlePromptChange = (value: string, caret: number | null) => {
    setPrompt(value)
    const beforeCaret = value.slice(0, caret ?? value.length)
    const mention = beforeCaret.match(/@([^@\n]{0,48})$/)
    setSkillPickerOpen(Boolean(mention))
    setSkillQuery(mention?.[1] || '')
  }

  const selectPromptSkill = (skill: LocalCreationSkill) => {
    const textarea = promptInputRef.current
    const caret = textarea?.selectionStart ?? prompt.length
    const beforeCaret = prompt.slice(0, caret)
    const mentionStart = beforeCaret.lastIndexOf('@')
    const nextPrompt = `${mentionStart >= 0 ? beforeCaret.slice(0, mentionStart) : beforeCaret}@${skill.title} ${prompt.slice(caret)}`
    const nextCaret = (mentionStart >= 0 ? mentionStart : beforeCaret.length) + skill.title.length + 2
    setPrompt(nextPrompt)
    setSkillPickerOpen(false)
    setSkillQuery('')
    window.requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const handleMarketSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const query = marketQueryDraft.trim()
    const categoryId = marketCategoryIdDraft
    setMarketOffset(0)
    if (query === marketQuery && categoryId === marketCategoryId && marketOffset === 0) {
      void loadMarketSkills()
    } else {
      setMarketQuery(query)
      setMarketCategoryId(categoryId)
    }
  }

  const handleSelectModel = (modelId: string) => {
    if (modelId === REMOTE_CREATION_MODEL_ID && !remoteModelAllowed) return
    setCreationModelConfig(modelId, { enabled: true })
  }

  useEffect(() => {
    if (!authToken || !currentUser) {
      setCloudBalance(null)
      return
    }
    let cancelled = false
    fetchBillingBalance(adminApiBaseUrl, authToken)
      .then(balance => {
        if (!cancelled) setCloudBalance(balance)
      })
      .catch(() => {
        if (!cancelled) setCloudBalance(null)
      })
    return () => { cancelled = true }
  }, [adminApiBaseUrl, authToken, currentUser, setCloudBalance])

  useEffect(() => {
    const active = creationModelConfigs.find(config => config.enabled)?.id
    if (active === REMOTE_CREATION_MODEL_ID && !remoteModelAllowed) {
      setCreationModelConfig(LOCAL_CREATION_MODEL_ID, { enabled: true })
    }
  }, [creationModelConfigs, remoteModelAllowed, setCreationModelConfig])

  const buildPayload = () => {
    const activeModel = creationModelConfigs.find(c => c.id === LOCAL_CREATION_MODEL_ID)
    return {
      user_prompt: promptWithAttachments(),
      design_templates: [],
      design_ids: [],
      timeline_ids: [],
      capture_ids: [],
      doc_type: docType,
      audience,
      output_format: 'markdown',
      inherit_format: inheritFormat,
      enable_rag: enableRag,
      enable_web_search: enableWebSearch,
      enable_image_generation: enableImageGeneration,
      content_weight: contentWeight / 100,
      quality_weight: qualityWeight / 100,
      completeness_weight: completenessWeight / 100,
      usage_weight: usageWeight / 100,
      format_weight: formatWeight / 100,
      freshness_weight: freshnessWeight / 100,
      max_references: 6,
      attachments: buildAttachmentMetadata(attachments),
      ...(activeCreationModelId === LOCAL_CREATION_MODEL_ID && activeModel ? {
        creation_model: 'qwen3.5:4b',
        creation_base_url: activeModel.baseUrl || undefined,
      } : {}),
    }
  }

  const buildGatewayMessages = (references: CreationReferenceItem[]) => {
    const systemPrompt = [
      '你是 MemoryBread 的咨询创作助手。',
      '请用专业、结构化的中文输出 Markdown 文档。',
      '不要提及底层供应商或模型实现。',
    ].join('\n')
    const referenceText = references.length
      ? `\n\n本地记忆参考资料：\n${references.map((item, index) => {
        const rawText = item.summary || item.reason || ''
        const text = rawText.length > 900 ? `${rawText.slice(0, 900)}...` : rawText
        return `R#${index + 1} ${item.title || `参考资料 ${index + 1}`}\n类型：${item.doc_type || '未分类'}\n${text}`.trim()
      }).join('\n\n')}`
      : ''
    const options = [
      `文档类型：${docType || '建设方案'}`,
      `目标读者：${audience || '客户'}`,
      `继承历史格式：${inheritFormat ? '是' : '否'}`,
      `启用 RAG 参考：${enableRag ? '是' : '否'}，参考数量：${references.length}`,
      `权重：内容 ${contentWeight}%，质量 ${qualityWeight}%，完整性 ${completenessWeight}%，热度 ${usageWeight}%，格式 ${formatWeight}%，时效 ${freshnessWeight}%`,
    ].join('\n')
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${options}\n\n创作需求：\n${promptWithAttachments()}${referenceText}` },
    ]
  }

  const postGatewayCreation = async (references: CreationReferenceItem[], signal?: AbortSignal) => {
    const response = await fetch(`${gatewayApiBaseUrl.replace(/\/+$/, '')}/v1/gateway/chat`, {
      method: 'POST',
      headers: { ...serviceEnvironmentHeaders(), 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        request_id: `creation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        user_id: currentUser?.id || null,
        brand_model_id: 'mbcd-plus-v1',
        caller: 'creation',
        messages: buildGatewayMessages(references),
        stream: false,
        privacy: { content_logging: false, client_scrubbed: true },
        limits: { max_output_tokens: 8192, max_credit: '100.0000' },
      }),
    })
    if (!response.ok) {
      throw new Error(await readApiErrorMessage(response, `生成失败: ${response.status}`))
    }
    return response.json()
  }

  const postLocalCreation = async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBaseUrl}/api/creation/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(buildPayload()),
    })

    if (!response.ok) {
      const message = await readApiErrorMessage(response, `生成失败: ${response.status}`)
      throw new Error(message.startsWith('生成失败') ? message : `生成失败: ${message}`)
    }

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    if (!reader) throw new Error('无法读取响应流')

    let buffer = ''
    let finalContent = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6)
        let event: any
        try {
          event = JSON.parse(jsonStr)
        } catch {
          finalContent += jsonStr
          setGeneratedContent(prev => prev + jsonStr)
          continue
        }

        if (typeof event === 'string') {
          finalContent += event
          setGeneratedContent(prev => prev + event)
          continue
        }
        if (event?.error) {
          throw new Error(`生成失败: ${event.error}`)
        }
        if (event?.done) {
          continue
        }
        const content = typeof event?.content === 'string' ? event.content : ''
        if (content) {
          finalContent += content
          setGeneratedContent(prev => prev + content)
        }
      }
    }

    if (!finalContent.trim()) {
      throw new Error('生成结束但没有返回内容，请检查本地运行环境和创作模型状态')
    }
    return finalContent
  }

  const postReferencePreview = async (signal?: AbortSignal) => {
    const payload = buildPayload()
    const response = await fetch(`${apiBaseUrl}/api/creation/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(payload),
    })

    if (response.ok) return response
    if (response.status !== 404) return response

    return fetch('http://127.0.0.1:8001/creation/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(payload),
    })
  }

  const addFiles = async (files: Iterable<File>) => {
    setAttachmentError(null)
    try {
      const next = await filesToAttachments(files, attachments.length)
      setAttachments(prev => [...prev, ...next])
    } catch (err) {
      setAttachmentError(toUserFacingError(err, '附件读取失败'))
    }
  }

  const handlePreviewReferences = async () => {
    if (!prompt.trim()) return
    setIsPreviewing(true)
    setError(null)
    try {
      const response = await postReferencePreview()
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, `参考资料预览失败: ${response.status}`))
      }
      const data = await response.json()
      setReferencePreview(data)
    } catch (err) {
      setError(toUserFacingError(err, '参考资料预览失败'))
    } finally {
      setIsPreviewing(false)
    }
  }

  const handleGenerate = async () => {
    if (!prompt.trim()) return

    setIsGenerating(true)
    setError(null)
    setGeneratedContent('')
    setLastInferenceMeta(null)
    const controller = new AbortController()
    abortRef.current = controller
    startTimer()

    try {
      let refCount = 0
      let referencesForHistory: CreationReferenceItem[] = []
      let finalSaveContent = ''
      let usedModelId = activeCreationModelId
      let inferenceLatencyMs: number | null = null
      if (enableRag) {
        try {
          const refResponse = await postReferencePreview(controller.signal)
          if (refResponse.ok) {
            const refData = await refResponse.json()
            setReferencePreview(refData)
            referencesForHistory = Array.isArray(refData?.references) ? refData.references : []
            refCount = referencesForHistory.length
          }
        } catch (refErr) {
          console.warn('参考资料同步加载失败,继续生成:', refErr)
        }
      }

      if (useGatewayCreation && currentUser?.id) {
        if (!localDebugModeEnabled) {
          console.info('MBCD Plus v1.0 将通过 gateway 调用')
        }
        try {
          usedModelId = REMOTE_CREATION_MODEL_ID
          const inferenceStartedAt = Date.now()
          const data = await postGatewayCreation(referencesForHistory, controller.signal)
          const content = sanitizeGeneratedContent(data.content || '')
          if (!content.trim()) throw new Error('生成结束但没有返回内容，请稍后重试或切换为本地创作模型')
          setGeneratedContent(content)
          finalSaveContent = content
          inferenceLatencyMs = Date.now() - inferenceStartedAt
        } catch (gatewayErr) {
          console.warn('云端创作不可用，自动回落本地创作:', gatewayErr)
          usedModelId = LOCAL_CREATION_MODEL_ID
          const inferenceStartedAt = Date.now()
          const content = await postLocalCreation(controller.signal)
          finalSaveContent = content
          inferenceLatencyMs = Date.now() - inferenceStartedAt
        }
      } else {
        usedModelId = LOCAL_CREATION_MODEL_ID
        const inferenceStartedAt = Date.now()
        const content = await postLocalCreation(controller.signal)
        finalSaveContent = content
        inferenceLatencyMs = Date.now() - inferenceStartedAt
      }

      if (finalSaveContent) {
        setLastInferenceMeta({ model: usedModelId, latencyMs: inferenceLatencyMs })
        try {
          const saveResponse = await fetchWithLocalhostFallback(`${apiBaseUrl}/api/creation/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: prompt.trim(),
              generated_content: sanitizeGeneratedContent(finalSaveContent),
              doc_type: docType || null,
              audience: audience || null,
              reference_count: refCount,
              references: referencesForHistory,
              model: usedModelId,
              latency_ms: inferenceLatencyMs,
            }),
          })
          if (saveResponse.ok) {
            const saved = await saveResponse.json()
            setCurrentDocumentSource({
              kind: 'creation_history',
              id: String(saved.id),
              title: prompt.trim(),
              content: sanitizeGeneratedContent(finalSaveContent),
              docType,
            })
          }
          if (historyPage === 1) {
            void loadCreationHistory()
          } else {
            setHistoryPage(1)
          }
        } catch (saveErr) {
          console.error('保存创作记录失败:', saveErr)
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('已中止本次创作')
        return
      }
      setError(toUserFacingError(err, '生成失败，请稍后重试'))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setIsGenerating(false)
      stopTimer()
    }
  }

  const handleStopGenerate = () => {
    abortRef.current?.abort()
    setIsGenerating(false)
    stopTimer()
    setError('已中止本次创作')
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(generatedContent)
    setCopySuccess(true)
    setTimeout(() => setCopySuccess(false), 2000)
  }

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = contentRef.current.scrollHeight
  }, [generatedContent])

  const totalWeight = contentWeight + qualityWeight + completenessWeight + usageWeight + formatWeight + freshnessWeight
  const generationProgress = isGenerating
    ? Math.min(95, Math.max(5, Math.round((elapsedSeconds / 90) * 100)))
    : generatedContent
      ? 100
      : 0

  const handleReferenceClick = (refId: string) => {
    const normalizedId = Number(refId)
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) return
    handleOpenReferenceSource({ id: normalizedId })
  }

  const headingId = (node: any) =>
    node.children.map((c: any) => c.value || '').join('').toLowerCase().replace(/\s+/g, '-')

  const markdownComponents = {
    h1: ({ node, children, ...props }: any) => <h1 id={headingId(node)} style={{ fontSize: 26, lineHeight: 1.25, margin: '0 0 18px' }} {...props}>{children}</h1>,
    h2: ({ node, children, ...props }: any) => <h2 id={headingId(node)} style={{ fontSize: 20, lineHeight: 1.35, margin: '24px 0 12px' }} {...props}>{children}</h2>,
    h3: ({ node, children, ...props }: any) => <h3 id={headingId(node)} style={{ fontSize: 16, lineHeight: 1.45, margin: '18px 0 9px' }} {...props}>{children}</h3>,
    p: ({ node, ...props }: any) => <p style={{ margin: '9px 0', lineHeight: 1.75 }} {...props} />,
    li: ({ node, ...props }: any) => <li style={{ margin: '6px 0', lineHeight: 1.65 }} {...props} />,
    code: ({ node, ...props }: any) => <code style={{ background: '#f2f4f7', padding: '2px 5px', borderRadius: 4 }} {...props} />,
    a: ({ node, href, children, ...props }: any) => {
      if (href?.startsWith('#ref-')) {
        const refId = href.substring(5)
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault()
              handleReferenceClick(refId)
            }}
            style={{
              color: '#0f766e',
              textDecoration: 'underline',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            {children}
            <sup style={{ fontSize: '0.75em', marginLeft: 2 }}>📚</sup>
          </a>
        )
      }
      if (href?.startsWith('#')) {
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault()
              document.getElementById(decodeURIComponent(href.substring(1)))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
            style={{ color: '#0f766e', textDecoration: 'underline', cursor: 'pointer' }}
          >{children}</a>
        )
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#0f766e', textDecoration: 'underline' }} {...props}>{children}</a>
    }
  }

  return (
    <div className={className} style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#f6f7f9', color: '#172033' }}>

      {/* 顶部 Tab 栏 */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e1e5ea', background: '#fff', padding: '0 22px', flexShrink: 0 }}>
        {(['creation', 'history', 'skills'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setTopTab(tab)}
            style={{
              padding: '12px 16px',
              border: 'none',
              borderBottom: topTab === tab ? '2px solid #0f766e' : '2px solid transparent',
              background: 'none',
              color: topTab === tab ? '#0f766e' : '#667085',
              fontWeight: topTab === tab ? 650 : 400,
              fontSize: 14,
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {tab === 'creation'
              ? '方案创作'
              : tab === 'history'
                ? `创作记录${historyTotal ? ` (${historyTotal})` : ''}`
                : `创作 Skill${localSkills.length ? ` (${localSkills.length})` : ''}`}
          </button>
        ))}
      </div>

      {topTab === 'history' ? (
        <div className="creation-history-page">
          <HistorySearch
            value={historySearch}
            onChange={setHistorySearch}
            placeholder="搜索主题、正文、文档类型或受众"
            ariaLabel="搜索创作记录"
            total={historyTotal}
            loading={historyLoading}
          />
          <div className="history-browser__list-scroll">
            {historyLoading && creationHistory.length === 0 ? (
              <div className="history-browser__state">正在加载创作记录…</div>
            ) : historyError ? (
              <div className="history-browser__state history-browser__state--error" role="alert">
                <span>{historyError}</span>
                <button type="button" onClick={() => void loadCreationHistory()}>重新加载</button>
              </div>
            ) : creationHistory.length > 0 ? (
              <div className="creation-history__list">
                {creationHistory.map((item) => (
                  <article className="creation-history__entry" key={item.id}>
                    <button
                      type="button"
                      className="creation-history__item"
                      onClick={() => { handleRestoreHistory(item); setTopTab('creation') }}
                    >
                      <span className="creation-history__title">{item.prompt}</span>
                      <span className="creation-history__meta">
                        {item.timestamp} · 模型：{getModelDisplayName(item.model)} · 推理耗时：{formatInferenceLatency(item.latencyMs)}
                      </span>
                      <span className="creation-history__preview">{item.preview}</span>
                    </button>
                    <button
                      className="creation-history__skill-action"
                      type="button"
                      onClick={() => setSkillEditor({ source: {
                        kind: 'creation_history',
                        id: String(item.id),
                        title: item.prompt,
                        content: item.fullContent,
                        docType: item.docType,
                      } })}
                    >
                      <Sparkles size={14} /> 沉淀 Skill
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="history-browser__state">
                {debouncedHistorySearch ? '没有找到匹配的创作记录。' : '暂无创作记录。'}
              </div>
            )}
          </div>
          <HistoryPagination
            page={historyPage}
            pageSize={HISTORY_PAGE_SIZE}
            total={historyTotal}
            loading={historyLoading}
            onPageChange={setHistoryPage}
          />
        </div>
      ) : topTab === 'skills' ? (
        <div className="creation-skill-library">
          <header>
            <div>
              <h2>{skillLibraryView === 'mine' ? '我的创作 Skill' : '创作 Skill 市场'}</h2>
              <p>{skillLibraryView === 'mine' ? '管理本地 Skill、发布状态和安装状态。' : '直接在客户端搜索并安装公开 Skill。'}</p>
            </div>
            <div className="creation-skill-library__header-actions">
              <div className="creation-skill-library__switcher" role="tablist" aria-label="创作 Skill 来源">
                <button
                  type="button"
                  role="tab"
                  aria-selected={skillLibraryView === 'mine'}
                  className={skillLibraryView === 'mine' ? 'is-active' : ''}
                  onClick={() => setSkillLibraryView('mine')}
                >
                  <Library size={14} /> 我的 Skill
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={skillLibraryView === 'market'}
                  className={skillLibraryView === 'market' ? 'is-active' : ''}
                  onClick={() => setSkillLibraryView('market')}
                >
                  <Store size={14} /> Skill 市场
                </button>
              </div>
              <button
                type="button"
                onClick={() => void (skillLibraryView === 'mine'
                  ? loadLocalSkills()
                  : Promise.all([loadMarketSkills(), loadMarketCategories()]))}
                disabled={skillLibraryView === 'mine' ? skillsLoading : marketLoading}
              >
                刷新
              </button>
            </div>
          </header>

          {skillLibraryView === 'market' && (
            <form className="creation-skill-market-search" onSubmit={handleMarketSearch} role="search">
              <label className="creation-skill-market-search__field">
                <span>搜索市场 Skill</span>
                <span className="creation-skill-market-search__query">
                  <Search size={16} />
                  <input
                    value={marketQueryDraft}
                    onChange={event => setMarketQueryDraft(event.target.value)}
                    placeholder="搜索标题或适用场景"
                  />
                </span>
              </label>
              <label className="creation-skill-market-search__field">
                <span>创作类目</span>
                <select
                  value={marketCategoryIdDraft}
                  onChange={event => setMarketCategoryIdDraft(event.target.value)}
                >
                  <option value="">全部行业与工种</option>
                  {marketCategoryOptions.map(category => (
                    <option key={category.id} value={category.id}>
                      {`${'　'.repeat(category.depth)}${category.depth > 0 ? '└ ' : ''}${category.name}`}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={marketLoading}>搜索</button>
            </form>
          )}

          {skillLibraryView === 'mine' ? (
            <>
              {skillsError && <div className="creation-skill-library__feedback is-error" role="alert">{skillsError}</div>}
              {skillsLoading && localSkills.length === 0 ? (
                <div className="history-browser__state"><Loader2 className="spin" size={17} /> 正在加载创作 Skill…</div>
              ) : localSkills.length === 0 ? (
                <div className="creation-skill-library__empty"><Library size={32} /><strong>还没有创作 Skill</strong><span>可以从创作记录沉淀，或去市场安装一份。</span><button type="button" onClick={() => setSkillLibraryView('market')}>浏览 Skill 市场</button></div>
              ) : (
                <div className="creation-skill-library__grid">
                  {localSkills.map(skill => {
                    const fromMarket = skill.sourceKind === 'market'
                    return (
                      <article key={skill.id}>
                        <div className="creation-skill-library__status-row">
                          <div className="creation-skill-library__status">
                            {fromMarket ? '来自市场' : skill.published ? '已发布' : skill.status === 'draft' ? '草稿' : '已保存'}
                          </div>
                          <span className={skill.installed ? 'is-installed' : ''}>{skill.installed ? '已安装' : '未安装'}</span>
                        </div>
                        <button
                          type="button"
                          className="creation-skill-library__title"
                          onClick={() => showLocalSkillDetail(skill)}
                        >
                          {skill.title}
                        </button>
                        <p>{skill.summary}</p>
                        <div className="creation-skill-library__meta">{skill.commonTitles.length} 个标题 · {skill.structurePattern.length} 个章节</div>
                        <footer className={fromMarket ? 'is-compact' : ''}>
                          <button
                            type="button"
                            className={skill.installed ? 'is-installed' : ''}
                            onClick={() => void handleToggleSkillInstalled(skill)}
                            disabled={skill.status === 'draft'}
                            title={skill.status === 'draft' ? '保存 Skill 后才能安装' : undefined}
                          >
                            {skill.installed ? <PackageCheck size={14} /> : <PackagePlus size={14} />}
                            {skill.installed ? '卸载' : '安装'}
                          </button>
                          <button type="button" onClick={() => showLocalSkillDetail(skill)}>
                            <Eye size={14} /> 查看详情
                          </button>
                          {!fromMarket && (
                            <>
                              <button
                                type="button"
                                className={skill.published ? 'is-unpublish' : ''}
                                onClick={() => void handlePublishSkill(skill, !skill.published)}
                                disabled={skill.status === 'draft' || publishingSkillId === skill.id}
                                title={skill.status === 'draft'
                                  ? '保存 Skill 后才能发布'
                                  : skill.published
                                    ? '从创作市场取消发布'
                                    : '发布到创作市场'}
                              >
                                {publishingSkillId === skill.id
                                  ? <Loader2 className="spin" size={14} />
                                  : skill.published
                                    ? <CloudOff size={14} />
                                    : <CloudUpload size={14} />}
                                {skill.published ? '取消发布' : '发布'}
                              </button>
                              <button type="button" onClick={() => setSkillEditor({ initialSkill: skill })}><Pencil size={14} /> 编辑</button>
                              <button type="button" onClick={() => void handleDeleteSkill(skill)} disabled={skill.published}><Trash2 size={14} /> 删除</button>
                            </>
                          )}
                        </footer>
                      </article>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              {marketError && <div className="creation-skill-library__feedback is-error" role="alert">{marketError}</div>}
              {marketLoading && marketSkills.length === 0 ? (
                <div className="history-browser__state"><Loader2 className="spin" size={17} /> 正在搜索市场 Skill…</div>
              ) : marketSkills.length === 0 ? (
                <div className="creation-skill-library__empty">
                  <Store size={32} />
                  <strong>{marketQuery || marketCategoryId ? '没有找到匹配的 Skill' : '市场暂时还没有公开 Skill'}</strong>
                  <span>{marketQuery || marketCategoryId ? '换个关键词或类目再试试。' : '稍后刷新即可看到新发布的 Skill。'}</span>
                </div>
              ) : (
                <>
                  <div className="creation-skill-market-count">找到 {marketTotal} 个公开 Skill</div>
                  <div className="creation-skill-library__grid creation-skill-market-grid">
                    {marketSkills.map(skill => {
                      const installed = installedMarketSkillIds.has(skill.id)
                      return (
                        <article key={skill.id}>
                          <div className="creation-skill-library__status-row">
                            <div className="creation-skill-library__status">市场 Skill</div>
                            <span className={installed ? 'is-installed' : ''}>{installed ? '已安装' : '可安装'}</span>
                          </div>
                          <button
                            type="button"
                            className="creation-skill-library__title"
                            onClick={() => showMarketSkillDetail(skill)}
                          >
                            {skill.title}
                          </button>
                          <p>{skill.summary}</p>
                          <div className="creation-skill-library__meta">
                            {skill.author.nickname} · {skill.categoryPath.map(item => item.name).join(' / ')}
                          </div>
                          <footer className="is-compact">
                            <button type="button" onClick={() => showMarketSkillDetail(skill)}>
                              <Eye size={14} /> 查看详情
                            </button>
                            <button
                              type="button"
                              className={installed ? 'is-installed' : ''}
                              disabled={installed || installingMarketSkillId === skill.id}
                              onClick={() => void handleInstallMarketSkill(skill)}
                            >
                              {installingMarketSkillId === skill.id
                                ? <Loader2 className="spin" size={14} />
                                : installed
                                  ? <PackageCheck size={14} />
                                  : <PackagePlus size={14} />}
                              {installed ? '已安装' : '安装'}
                            </button>
                          </footer>
                        </article>
                      )
                    })}
                  </div>
                  {marketTotal > SKILL_MARKET_PAGE_SIZE && (
                    <div className="creation-skill-market-pagination">
                      <button
                        type="button"
                        disabled={marketOffset === 0 || marketLoading}
                        onClick={() => setMarketOffset(offset => Math.max(0, offset - SKILL_MARKET_PAGE_SIZE))}
                      >
                        上一页
                      </button>
                      <span>{Math.floor(marketOffset / SKILL_MARKET_PAGE_SIZE) + 1} / {Math.ceil(marketTotal / SKILL_MARKET_PAGE_SIZE)}</span>
                      <button
                        type="button"
                        disabled={marketOffset + SKILL_MARKET_PAGE_SIZE >= marketTotal || marketLoading}
                        onClick={() => setMarketOffset(offset => offset + SKILL_MARKET_PAGE_SIZE)}
                      >
                        下一页
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <section style={{ padding: 22, borderBottom: '1px solid #e1e5ea', background: '#fff', flexShrink: 0 }}>
            <div className="creation-prompt-skill-shell">
              <textarea
                ref={promptInputRef}
                value={prompt}
                onChange={(event) => handlePromptChange(event.target.value, event.target.selectionStart)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && skillPickerOpen) {
                    event.preventDefault()
                    setSkillPickerOpen(false)
                  }
                }}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files || [])
                  if (files.length) void addFiles(files)
                }}
                placeholder={`${defaultPrompt}\n输入 @ 可选择已安装的创作 Skill。`}
                style={{ ...inputStyle, minHeight: 118, resize: 'vertical', lineHeight: 1.6 }}
                disabled={isGenerating}
                aria-expanded={skillPickerOpen}
                aria-controls="creation-skill-picker"
              />
              {skillPickerOpen && (
                <div className="creation-skill-picker" id="creation-skill-picker" role="listbox" aria-label="选择创作 Skill">
                  <header><AtSign size={15} /><span>选择已安装的 Skill</span><small>{skillPickerItems.length} 项</small></header>
                  {skillPickerItems.length ? skillPickerItems.map(skill => (
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      key={skill.id}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => selectPromptSkill(skill)}
                    >
                      <strong>{skill.title}</strong>
                      <span>{skill.summary}</span>
                    </button>
                  )) : (
                    <div className="creation-skill-picker__empty">
                      {installedSkills.length ? '没有匹配的已安装 Skill。' : '还没有已安装的 Skill，请先到「创作 Skill」页面安装。'}
                    </div>
                  )}
                </div>
              )}
            </div>
            {matchedSkills.length > 0 && (
              <div className="creation-matched-skills" aria-label="本次使用的创作 Skill">
                <span>本次将使用</span>
                {matchedSkills.map(match => (
                  <button type="button" key={match.skill.id} onClick={() => showLocalSkillDetail(match.skill)}>
                    <Sparkles size={13} /> {match.skill.title}
                    <small>{match.reason === 'mentioned' ? '@ 已选择' : '自动匹配'}</small>
                  </button>
                ))}
              </div>
            )}
            {attachments.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {attachments.map(item => (
                  <span key={item.id} style={attachmentPillStyle}>
                    <Paperclip size={13} />
                    <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                    <small style={{ color: '#667085' }}>{formatAttachmentSize(item.size)}</small>
                    <button
                      type="button"
                      onClick={() => setAttachments(prev => prev.filter(existing => existing.id !== item.id))}
                      disabled={isGenerating}
                      style={attachmentRemoveStyle}
                      aria-label={`移除 ${item.name}`}
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachmentError && <div style={{ marginTop: 8, color: '#b42318', fontSize: 12 }}>{attachmentError}</div>}
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
            <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', flex: '1 1 320px' }}>
                <ModelSelect
                  label="模型"
                  value={activeCreationModelId}
                  options={CREATION_MODEL_DEFS}
                  disabled={isGenerating}
                  remoteAllowed={remoteModelAllowed}
                  onChange={handleSelectModel}
                  title="选择创作生成模型"
                />
                {activeCreationModelId === REMOTE_CREATION_MODEL_ID && cloudBalance && (
                  <span style={{ color: '#667085', fontSize: 12 }}>
                    Credit {cloudBalance.available}
                  </span>
                )}
              </div>
              <button onClick={handlePreviewReferences} disabled={!prompt.trim() || isPreviewing || isGenerating} style={secondaryButtonStyle}>
                {isPreviewing ? <Loader2 size={16} className="spin" /> : <FileText size={16} />}
                预览参考
              </button>
              <button onClick={() => fileInputRef.current?.click()} disabled={isGenerating} style={secondaryButtonStyle}>
                <Paperclip size={16} />
                附件
              </button>
              <button onClick={isGenerating ? handleStopGenerate : handleGenerate} disabled={!isGenerating && !prompt.trim()} style={isGenerating ? dangerButtonStyle : primaryButtonStyle}>
                {isGenerating ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                {isGenerating ? '中止' : '开始创作'}
              </button>
            </div>
            {isGenerating && (
              <ProgressStrip
                label={`已思考 ${elapsedSeconds} 秒`}
                percent={generationProgress}
              />
            )}
            {error && <div style={{ marginTop: 12, color: '#b42318', fontSize: 13 }}>{error}</div>}
          </section>

          <section style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 22 }}>
            <div style={{ height: '100%', border: '1px solid #e1e5ea', borderRadius: 8, background: '#fff', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ height: 48, padding: '0 16px', borderBottom: '1px solid #e1e5ea', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 650 }}>创作文档</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {isGenerating && (
                    <span style={{ fontSize: 12, color: '#0f766e', fontWeight: 650 }}>
                      {generationProgress}% · {elapsedSeconds} 秒
                    </span>
                  )}
                  {isGenerating && (
                    <button onClick={handleStopGenerate} style={compactDangerButtonStyle}>
                      <Square size={14} />
                      中止
                    </button>
                  )}
                  <button onClick={handleCopy} disabled={!generatedContent} style={compactButtonStyle}>
                    <Copy size={15} />
                    {copySuccess ? '已复制' : '复制'}
                  </button>
                  <button onClick={openCurrentDocumentSkill} disabled={!generatedContent || isGenerating} style={compactButtonStyle}>
                    <Sparkles size={15} /> 沉淀 Skill
                  </button>
                </div>
              </div>
              {currentDocumentSkills.length > 0 && (
                <div className="creation-document-skills" aria-label="当前文档关联 Skill">
                  <span>关联 Skill</span>
                  {currentDocumentSkills.map(skill => (
                    <button type="button" key={skill.id} onClick={() => showLocalSkillDetail(skill)}>
                      <Sparkles size={13} /> {skill.title}
                      <small>{skill.status === 'draft' ? '草稿' : skill.installed ? '已安装' : '已保存'}</small>
                    </button>
                  ))}
                </div>
              )}
              <div ref={contentRef} style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {generatedContent ? (
                  <MarkdownContent content={generatedContent} components={markdownComponents} />
                ) : isGenerating ? (
                  <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#667085', fontSize: 14, gap: 12 }}>
                    <Loader2 size={28} className="spin" color="#0f766e" />
                    <div style={{ textAlign: 'center', lineHeight: 1.6 }}>
                      <div style={{ fontWeight: 600, color: '#0f766e', marginBottom: 4 }}>模型正在深度推理中</div>
                      <div>已思考 {elapsedSeconds} 秒，预计进度 {generationProgress}%</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#98a2b3', fontSize: 14 }}>
                    输入创作需求后，可以先预览参考资料，也可以直接开始生成。
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* 底部互斥 Tab */}
          <div style={{ background: '#fff', borderTop: '1px solid #e1e5ea', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px' }}>
              {([
                { key: 'reference', label: '参考资料', badge: referencePreview?.references?.length || 0 },
                { key: 'config', label: '创作参数', badge: 0 },
              ] as const).map(({ key, label, badge }) => (
                <button
                  key={key}
                  onClick={() => toggleBottomTab(key)}
                  style={{
                    padding: '10px 16px',
                    border: 'none',
                    borderTop: activeBottomTab === key ? '2px solid #0f766e' : '2px solid transparent',
                    background: 'none',
                    color: activeBottomTab === key ? '#0f766e' : '#667085',
                    fontWeight: activeBottomTab === key ? 650 : 400,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {label}{badge > 0 ? ` (${badge})` : ''}
                </button>
              ))}
              {activeBottomTab && (
                <button
                  onClick={() => setActiveBottomTab(null)}
                  style={{ marginLeft: 'auto', padding: '4px 10px', border: '1px solid #e1e5ea', borderRadius: 5, background: '#f3f4f6', color: '#6b7280', fontSize: 12, cursor: 'pointer' }}
                >
                  收起
                </button>
              )}
            </div>
            {activeBottomTab === 'reference' && (
              <div style={{ padding: 16, maxHeight: 280, overflowY: 'auto', background: '#fafbfc', borderTop: '1px solid #e1e5ea' }}>
                {referencePreview?.references?.length ? (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {referencePreview.references.map((ref: any) => (
                      <ReferenceRow key={ref.id} item={ref} onOpenSource={handleOpenReferenceSource} />
                    ))}
                  </div>
                ) : (
                  <div style={{ color: '#667085', fontSize: 13 }}>暂无资料，请先点击「预览参考」。</div>
                )}
              </div>
            )}
            {activeBottomTab === 'config' && (
              <div style={{ padding: 16, maxHeight: 280, overflowY: 'auto', background: '#fafbfc', borderTop: '1px solid #e1e5ea', display: 'grid', gap: 12 }}>
                <label style={{ display: 'grid', gap: 7, fontSize: 13 }}>
                  文档类型
                  <input value={docType} onChange={(e) => setDocType(e.target.value)} placeholder="建设方案" style={inputStyle} />
                </label>
                <label style={{ display: 'grid', gap: 7, fontSize: 13 }}>
                  目标读者
                  <input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="客户" style={inputStyle} />
                </label>
                <Toggle label="启用 RAG 参考" checked={enableRag} onChange={setEnableRag} />
                <Toggle label="继承历史格式" checked={inheritFormat} onChange={setInheritFormat} />
                <Toggle label="互联网检索" checked={enableWebSearch} onChange={setEnableWebSearch} icon={<Search size={16} />} />
                <Toggle label="图片生成建议" checked={enableImageGeneration} onChange={setEnableImageGeneration} icon={<Image size={16} />} />
                <div style={{ height: 1, background: '#e1e5ea', margin: '4px 0' }} />
                <div style={{ fontSize: 12, color: '#475467', display: 'flex', justifyContent: 'space-between' }}>
                  <span>权重配置</span>
                  <span style={{ color: totalWeight === 100 ? '#0f766e' : '#b54708' }}>{totalWeight}%</span>
                </div>
                <WeightSlider label="内容相关度" value={contentWeight} onChange={setContentWeight} />
                <WeightSlider label="文档质量" value={qualityWeight} onChange={setQualityWeight} />
                <WeightSlider label="完整性" value={completenessWeight} onChange={setCompletenessWeight} />
                <WeightSlider label="打开/引用热度" value={usageWeight} onChange={setUsageWeight} />
                <WeightSlider label="格式匹配" value={formatWeight} onChange={setFormatWeight} />
                <WeightSlider label="时效性" value={freshnessWeight} onChange={setFreshnessWeight} />
              </div>
            )}
          </div>
        </main>
      )}

      {skillEditor && (
        <CreationSkillEditor
          source={skillEditor.source}
          initialSkill={skillEditor.initialSkill}
          onClose={() => setSkillEditor(null)}
          onSaved={handleSkillSaved}
        />
      )}

      {skillDetail && (
        <CreationSkillDetail
          skill={skillDetail}
          onClose={closeSkillDetail}
          primaryAction={skillDetailMarketItem && !skillDetail.installed
            ? {
              label: '安装 Skill',
              loadingLabel: '正在安装…',
              loading: installingMarketSkillId === skillDetailMarketItem.id,
              onClick: () => void handleInstallMarketSkill(skillDetailMarketItem),
            }
            : undefined}
        />
      )}

    </div>
  )
}

const MarkdownContent = ({ content, components }: { content: string; components: any }) => {
  const inlineComponents = {
    ...components,
    p: ({ children }: any) => <>{children}</>,
  }

  return (
    <>
      {parseMarkdownBlocks(content).map((block, index) => {
        if (block.type === 'markdown') {
          return <ReactMarkdown key={`markdown-${index}`} components={components}>{block.content}</ReactMarkdown>
        }

        return (
          <div key={`table-${index}`} style={{ overflowX: 'auto', margin: '16px 0' }}>
            <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 14, lineHeight: 1.55 }}>
              <thead>
                <tr>
                  {block.headers.map((header, cellIndex) => (
                    <th
                      key={cellIndex}
                      style={{
                        border: '1px solid #d0d5dd',
                        background: '#f8fafc',
                        color: '#172033',
                        fontWeight: 700,
                        padding: '10px 12px',
                        textAlign: block.alignments[cellIndex] || 'left',
                        verticalAlign: 'top',
                      }}
                    >
                      <ReactMarkdown components={inlineComponents}>{header}</ReactMarkdown>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {block.headers.map((_, cellIndex) => (
                      <td
                        key={cellIndex}
                        style={{
                          border: '1px solid #d0d5dd',
                          padding: '10px 12px',
                          textAlign: block.alignments[cellIndex] || 'left',
                          verticalAlign: 'top',
                          background: rowIndex % 2 === 0 ? '#fff' : '#fbfcfe',
                        }}
                      >
                        <ReactMarkdown components={inlineComponents}>{row[cellIndex] || ''}</ReactMarkdown>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </>
  )
}

const Toggle = ({ label, checked, onChange, icon }: { label: string; checked: boolean; onChange: (value: boolean) => void; icon?: React.ReactNode }) => (
  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 14, color: '#344054' }}>
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{icon}{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  </label>
)

const WeightSlider = ({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) => (
  <label style={{ display: 'grid', gap: 6, marginBottom: 11, fontSize: 12, color: '#667085' }}>
    <span style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span>{label}</span>
      <span>{value}%</span>
    </span>
    <input type="range" min={0} max={70} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </label>
)

const ProgressStrip = ({ label, percent }: { label: string; percent: number }) => (
  <div style={{ marginTop: 12, display: 'grid', gap: 6, maxWidth: 360 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475467' }}>
      <span>{label}</span>
      <span>{percent}%</span>
    </div>
    <div style={{ height: 6, borderRadius: 999, background: '#e4e7ec', overflow: 'hidden' }}>
      <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: '#0f766e', transition: 'width 0.25s ease' }} />
    </div>
  </div>
)

const ReferenceRow = ({ item, onOpenSource }: { item: ReferenceItem; onOpenSource: (item: ReferenceItem) => void }) => (
  <div style={{ border: '1px solid #e1e5ea', borderRadius: 8, padding: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ fontSize: 14, fontWeight: 650, lineHeight: 1.35 }}>{item.title}</div>
    </div>
    <div style={{ marginTop: 6, fontSize: 12, color: '#667085' }}>{item.doc_type || '未分类'} · 打开/引用 {item.usage_count}</div>
    <div style={{ marginTop: 8, fontSize: 12, color: '#475467', lineHeight: 1.55 }}>{item.reason}</div>
    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, fontSize: 11, color: '#667085' }}>
      <span>相关 {Math.round(item.relevance_score * 100)}</span>
      <span>完整 {Math.round(item.completeness_score * 100)}</span>
      <span>格式 {Math.round(item.format_score * 100)}</span>
    </div>
    <button
      type="button"
      onClick={() => onOpenSource(item)}
      style={{
        marginTop: 10,
        padding: '6px 10px',
        border: '1px solid #d0d5dd',
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
      <ExternalLink size={13} />
      资料来源
    </button>
  </div>
)

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
  background: '#fff',
}

const primaryButtonStyle: React.CSSProperties = {
  height: 38,
  padding: '0 15px',
  border: '1px solid #0f766e',
  borderRadius: 8,
  background: '#0f766e',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  fontWeight: 650,
}

const secondaryButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  background: '#fff',
  color: '#344054',
  border: '1px solid #d0d5dd',
}

const dangerButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  background: '#b42318',
  border: '1px solid #b42318',
}

const compactButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  height: 32,
  padding: '0 10px',
  fontSize: 13,
}

const compactDangerButtonStyle: React.CSSProperties = {
  ...dangerButtonStyle,
  height: 32,
  padding: '0 10px',
  fontSize: 13,
}

const attachmentPillStyle: React.CSSProperties = {
  minHeight: 30,
  padding: '0 8px',
  border: '1px solid #d0d5dd',
  borderRadius: 999,
  background: '#fff',
  color: '#344054',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
}

const attachmentRemoveStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  border: 0,
  borderRadius: 999,
  background: '#f2f4f7',
  color: '#475467',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
}

export default CreationPanel
