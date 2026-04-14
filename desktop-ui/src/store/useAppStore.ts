import { create } from 'zustand'
import type { ActionCommand, BakeTab, RagContext, RepositoryTab, WindowMode } from '../types'

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
  reset:                 () => void
}

const SETUP_KEY = 'memory-bread_setup_done'
const SKIP_KEY  = 'memory-bread_setup_skipped'

const safeLocalStorage = typeof window !== 'undefined' && typeof window.localStorage?.getItem === 'function'
  ? window.localStorage
  : null

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

  reset: () => set(initialState),
}))
