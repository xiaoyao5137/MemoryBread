import { create } from 'zustand'
import type { ActionCommand, BakeTab, RagContext, RepositoryTab, WindowMode } from '../types'

interface CaptureBackTarget {
  windowMode: WindowMode
  bakeTab?: BakeTab
  repositoryTab?: RepositoryTab
  selectedMemoryId?: string | null
  selectedTemplateId?: string | null
  selectedSopId?: string | null
  selectedKnowledgeId?: string | null
  selectedCaptureId?: string | null
  repositoryCaptureSourceCaptureId?: string | null
}

export interface CreationModelConfig {
  id: string
  enabled: boolean
  apiKey: string
  baseUrl?: string
}

export interface CreationReferenceItem {
  id: number
  title: string
  doc_type: string
  final_weight: number
  relevance_score: number
  quality_score: number
  completeness_score: number
  usage_score: number
  format_score: number
  freshness_score: number
  usage_count: number
  reason: string
  summary?: string
  source_url?: string
}

export interface CreationReferencePreview {
  requirement: {
    topic: string
    doc_type: string
    audience: string
    style: string
    keywords: string[]
  }
  references: CreationReferenceItem[]
}

export interface CreationDraft {
  prompt: string
  docType: string
  audience: string
  generatedContent: string
  inheritFormat: boolean
  enableRag: boolean
  enableWebSearch: boolean
  enableImageGeneration: boolean
  contentWeight: number
  qualityWeight: number
  completenessWeight: number
  usageWeight: number
  formatWeight: number
  freshnessWeight: number
  referencePreview: CreationReferencePreview | null
}

export interface CreationBackTarget {
  windowMode: WindowMode
  bakeTab?: BakeTab
  selectedTemplateId?: string | null
}

export interface AppState {
  // ── 窗口模式 ────────────────────────────────────────────────────────────────
  windowMode: WindowMode
  bakeTab: BakeTab
  repositoryTab: RepositoryTab
  selectedMemoryId: string | null
  selectedTemplateId: string | null
  selectedSopId: string | null
  selectedKnowledgeId: string | null
  selectedCaptureId: string | null
  bakeMemoryOffset: number
  bakeKnowledgeOffset: number
  bakeKnowledgeQuery: string
  bakeKnowledgeLimit: number
  bakeTemplateOffset: number
  bakeTemplateQuery: string
  bakeTemplateLimit: number
  bakeSopOffset: number
  bakeSopQuery: string
  bakeSopLimit: number
  bakeCaptureOffset: number
  repositoryMemoryQuery: string
  repositoryMemoryFrom: string
  repositoryMemoryTo: string
  repositoryMemoryLimit: number
  repositoryCaptureQuery: string
  repositoryCaptureFrom: string
  repositoryCaptureTo: string
  repositoryCaptureLimit: number
  repositoryCaptureSourceCaptureId: string | null
  captureBackTarget: CaptureBackTarget | null
  creationDraft: CreationDraft
  creationBackTarget: CreationBackTarget | null

  // ── RAG Panel ───────────────────────────────────────────────────────────────
  ragQuery:     string
  ragAnswer:    string
  ragContexts:  RagContext[]
  ragLoading:   boolean
  ragError:     string | null

  // ── Action Confirm ──────────────────────────────────────────────────────────
  pendingAction:    ActionCommand | null
  actionConfirmed:  boolean

  // ── 全局配置 ─────────────────────────────────────────────────────────────────
  apiBaseUrl:     string
  sidecarVersion: string

  // ── 首次引导 ─────────────────────────────────────────────────────────────────
  hasCompletedSetup: boolean
  setupSkipped:      boolean
  creationModelConfigs: CreationModelConfig[]

  // ── 操作方法 ─────────────────────────────────────────────────────────────────
  setWindowMode:         (mode: WindowMode) => void
  setBakeTab:            (tab: BakeTab) => void
  setRepositoryTab:      (tab: RepositoryTab) => void
  setSelectedMemoryId:  (id: string | null) => void
  setSelectedTemplateId: (id: string | null) => void
  setSelectedSopId:      (id: string | null) => void
  setSelectedKnowledgeId:(id: string | null) => void
  setSelectedCaptureId:  (id: string | null) => void
  setBakeMemoryOffset:  (offset: number) => void
  setBakeKnowledgeOffset:(offset: number) => void
  setBakeKnowledgeQuery: (query: string) => void
  setBakeKnowledgeLimit: (limit: number) => void
  setBakeTemplateOffset: (offset: number) => void
  setBakeTemplateQuery:  (query: string) => void
  setBakeTemplateLimit:  (limit: number) => void
  setBakeSopOffset:      (offset: number) => void
  setBakeSopQuery:       (query: string) => void
  setBakeSopLimit:       (limit: number) => void
  setBakeCaptureOffset:  (offset: number) => void
  setRepositoryMemoryQuery: (query: string) => void
  setRepositoryMemoryFrom:  (value: string) => void
  setRepositoryMemoryTo:    (value: string) => void
  setRepositoryMemoryLimit: (limit: number) => void
  setRepositoryCaptureQuery: (query: string) => void
  setRepositoryCaptureFrom:  (value: string) => void
  setRepositoryCaptureTo:    (value: string) => void
  setRepositoryCaptureLimit: (limit: number) => void
  setRepositoryCaptureSourceCaptureId: (id: string | null) => void
  setCaptureBackTarget: (target: CaptureBackTarget | null) => void
  clearCaptureBackTarget: () => void
  setCreationDraft: (patch: Partial<CreationDraft>) => void
  resetCreationDraft: () => void
  setCreationBackTarget: (target: CreationBackTarget | null) => void
  clearCreationBackTarget: () => void
  setRagQuery:           (q: string) => void
  setRagResult:          (answer: string, contexts: RagContext[]) => void
  setRagLoading:         (loading: boolean) => void
  setRagError:           (err: string | null) => void
  setPendingAction:      (action: ActionCommand | null) => void
  confirmAction:         () => void
  cancelAction:          () => void
  setApiBaseUrl:         (url: string) => void
  setSidecarVersion:     (v: string) => void
  setHasCompletedSetup:  (v: boolean) => void
  setSetupSkipped:       (v: boolean) => void
  setCreationModelConfigs: (configs: CreationModelConfig[]) => void
  setCreationModelConfig: (id: string, patch: Partial<CreationModelConfig>) => void
  reset:                 () => void
}

const SETUP_KEY = 'memory-bread_setup_done'
const SKIP_KEY  = 'memory-bread_setup_skipped'
export const CREATION_MODEL_KEY = 'memory-bread_creation_models'
export const CREATION_MODEL_PREFERENCE_KEY = 'creation.models'

const safeLocalStorage = typeof window !== 'undefined' && typeof window.localStorage?.getItem === 'function'
  ? window.localStorage
  : null

const DEFAULT_CREATION_MODELS: CreationModelConfig[] = [
  { id: 'claude-opus-4-8', enabled: false, apiKey: '', baseUrl: 'https://api.anthropic.com' },
  { id: 'gpt-5-5',         enabled: false, apiKey: '' },
  { id: 'qwen-3-7',        enabled: false, apiKey: '' },
  { id: 'qwen-3-5-4b',     enabled: false, apiKey: '' },
  { id: 'glm-latest',      enabled: false, apiKey: '' },
  { id: 'kimi-latest',     enabled: false, apiKey: '' },
]

export function normalizeCreationModels(models: CreationModelConfig[]): CreationModelConfig[] {
  const byId = new Map(models.map(model => [model.id, model]))
  let hasEnabled = false
  return DEFAULT_CREATION_MODELS.map(defaultModel => {
    const model = { ...defaultModel, ...byId.get(defaultModel.id) }
    if (!model.enabled) return model
    if (hasEnabled) return { ...model, enabled: false }
    hasEnabled = true
    return model
  })
}

export function loadCreationModels(): CreationModelConfig[] {
  try {
    const raw = safeLocalStorage?.getItem(CREATION_MODEL_KEY)
    if (raw) return normalizeCreationModels(JSON.parse(raw))
  } catch { /* ignore */ }
  return normalizeCreationModels(DEFAULT_CREATION_MODELS)
}

const initialCreationDraft: CreationDraft = {
  prompt: '',
  docType: '',
  audience: '',
  generatedContent: '',
  inheritFormat: true,
  enableRag: true,
  enableWebSearch: false,
  enableImageGeneration: false,
  contentWeight: 45,
  qualityWeight: 15,
  completenessWeight: 15,
  usageWeight: 10,
  formatWeight: 10,
  freshnessWeight: 5,
  referencePreview: null,
}

const initialState = {
  windowMode:          'rag' as WindowMode,
  bakeTab:             'overview' as BakeTab,
  repositoryTab:       'memory' as RepositoryTab,
  selectedMemoryId:   null,
  selectedTemplateId:  null,
  selectedSopId:       null,
  selectedKnowledgeId: null,
  selectedCaptureId:   null,
  bakeMemoryOffset:   0,
  bakeKnowledgeOffset: 0,
  bakeKnowledgeQuery:  '',
  bakeKnowledgeLimit:  20,
  bakeTemplateOffset:  0,
  bakeTemplateQuery:   '',
  bakeTemplateLimit:   20,
  bakeSopOffset:       0,
  bakeSopQuery:        '',
  bakeSopLimit:        20,
  bakeCaptureOffset:   0,
  repositoryMemoryQuery: '',
  repositoryMemoryFrom:  '',
  repositoryMemoryTo:    '',
  repositoryMemoryLimit: 20,
  repositoryCaptureQuery: '',
  repositoryCaptureFrom:  '',
  repositoryCaptureTo:    '',
  repositoryCaptureLimit: 20,
  repositoryCaptureSourceCaptureId: null,
  captureBackTarget: null,
  creationDraft: initialCreationDraft,
  creationBackTarget: null,
  ragQuery:            '',
  ragAnswer:           '',
  ragContexts:         [] as RagContext[],
  ragLoading:          false,
  ragError:            null,
  pendingAction:       null,
  actionConfirmed:     false,
  apiBaseUrl:          'http://localhost:7070',
  sidecarVersion:      '0.1.0',
  hasCompletedSetup:   safeLocalStorage?.getItem(SETUP_KEY) === 'true',
  setupSkipped:        safeLocalStorage?.getItem(SKIP_KEY)  === 'true',
  creationModelConfigs: loadCreationModels(),
}

export const useAppStore = create<AppState>((set) => ({
  ...initialState,

  setWindowMode: (mode) => set({ windowMode: mode }),

  setBakeTab: (tab) => set({ bakeTab: tab }),

  setRepositoryTab: (tab) => set({ repositoryTab: tab }),

  setSelectedMemoryId: (id) => set({ selectedMemoryId: id }),

  setSelectedTemplateId: (id) => set({ selectedTemplateId: id }),

  setSelectedSopId: (id) => set({ selectedSopId: id }),

  setSelectedKnowledgeId: (id) => set({ selectedKnowledgeId: id }),

  setSelectedCaptureId: (id) => set({ selectedCaptureId: id }),

  setBakeMemoryOffset: (offset) => set({ bakeMemoryOffset: offset }),

  setBakeKnowledgeOffset: (offset) => set({ bakeKnowledgeOffset: offset }),

  setBakeKnowledgeQuery: (query) => set({ bakeKnowledgeQuery: query, bakeKnowledgeOffset: 0 }),

  setBakeKnowledgeLimit: (limit) => set({ bakeKnowledgeLimit: limit, bakeKnowledgeOffset: 0 }),

  setBakeTemplateOffset: (offset) => set({ bakeTemplateOffset: offset }),

  setBakeTemplateQuery: (query) => set({ bakeTemplateQuery: query, bakeTemplateOffset: 0 }),

  setBakeTemplateLimit: (limit) => set({ bakeTemplateLimit: limit, bakeTemplateOffset: 0 }),

  setBakeSopOffset: (offset) => set({ bakeSopOffset: offset }),

  setBakeSopQuery: (query) => set({ bakeSopQuery: query, bakeSopOffset: 0 }),

  setBakeSopLimit: (limit) => set({ bakeSopLimit: limit, bakeSopOffset: 0 }),

  setBakeCaptureOffset: (offset) => set({ bakeCaptureOffset: offset }),

  setRepositoryMemoryQuery: (query) => set({ repositoryMemoryQuery: query, bakeMemoryOffset: 0 }),

  setRepositoryMemoryFrom: (value) => set({ repositoryMemoryFrom: value, bakeMemoryOffset: 0 }),

  setRepositoryMemoryTo: (value) => set({ repositoryMemoryTo: value, bakeMemoryOffset: 0 }),

  setRepositoryMemoryLimit: (limit) => set({ repositoryMemoryLimit: limit, bakeMemoryOffset: 0 }),

  setRepositoryCaptureQuery: (query) => set({ repositoryCaptureQuery: query, bakeCaptureOffset: 0 }),

  setRepositoryCaptureFrom: (value) => set({ repositoryCaptureFrom: value, bakeCaptureOffset: 0 }),

  setRepositoryCaptureTo: (value) => set({ repositoryCaptureTo: value, bakeCaptureOffset: 0 }),

  setRepositoryCaptureLimit: (limit) => set({ repositoryCaptureLimit: limit, bakeCaptureOffset: 0 }),

  setRepositoryCaptureSourceCaptureId: (id) => set({ repositoryCaptureSourceCaptureId: id, bakeCaptureOffset: 0 }),

  setCaptureBackTarget: (target) => set({ captureBackTarget: target }),

  clearCaptureBackTarget: () => set({ captureBackTarget: null }),

  setCreationDraft: (patch) => set((state) => ({
    creationDraft: { ...state.creationDraft, ...patch },
  })),

  resetCreationDraft: () => set({ creationDraft: initialCreationDraft }),

  setCreationBackTarget: (target) => set({ creationBackTarget: target }),

  clearCreationBackTarget: () => set({ creationBackTarget: null }),

  setRagQuery:   (q) => set({ ragQuery: q }),

  setRagResult:  (answer, contexts) => set({
    ragAnswer:  answer,
    ragContexts: contexts,
    ragLoading:  false,
    ragError:    null,
  }),

  setRagLoading: (loading) => set({ ragLoading: loading }),

  setRagError:   (err) => set({ ragError: err, ragLoading: false }),

  setPendingAction: (action) => set({
    pendingAction:   action,
    actionConfirmed: false,
  }),

  confirmAction: () => set({ actionConfirmed: true }),

  cancelAction:  () => set({
    pendingAction:   null,
    actionConfirmed: false,
  }),

  setApiBaseUrl:     (url) => set({ apiBaseUrl: url }),

  setSidecarVersion: (v) => set({ sidecarVersion: v }),

  setHasCompletedSetup: (v) => {
    safeLocalStorage?.setItem(SETUP_KEY, String(v))
    set({ hasCompletedSetup: v })
  },

  setSetupSkipped: (v) => {
    safeLocalStorage?.setItem(SKIP_KEY, String(v))
    set({ setupSkipped: v })
  },

  setCreationModelConfigs: (configs) => {
    const normalized = normalizeCreationModels(configs)
    safeLocalStorage?.setItem(CREATION_MODEL_KEY, JSON.stringify(normalized))
    set({ creationModelConfigs: normalized })
  },

  setCreationModelConfig: (id, patch) => {
    set((state) => {
      const updated = normalizeCreationModels(state.creationModelConfigs.map(c =>
        c.id === id
          ? { ...c, ...patch }
          : patch.enabled === true
            ? { ...c, enabled: false }
            : c
      ))
      safeLocalStorage?.setItem(CREATION_MODEL_KEY, JSON.stringify(updated))
      return { creationModelConfigs: updated }
    })
  },

  reset: () => set(initialState),
}))
