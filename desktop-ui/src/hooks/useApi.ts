import { useCallback } from 'react'
import { useAppStore }  from '../store/useAppStore'
import type {
  ArticleTemplate,
  BakeBucket,
  BakeCaptureItem,
  BakeKnowledgeItem,
  CaptureRecord,
  DebugLogContent,
  DebugLogFile,
  EpisodicMemoryItem,
  PaginatedBakeResponse,
  PreferenceRecord,
  RagQueryResponse,
  ActionResult,
  SopCandidate,
  WritingStyleConfig,
} from '../types'

export function useHealthCheck() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (): Promise<{ status: string; version: string }> => {
    const resp = await fetch(`${apiBaseUrl}/health`)
    if (!resp.ok) throw new Error(`health check failed: ${resp.status}`)
    return resp.json()
  }, [apiBaseUrl])
}

export interface FetchCapturesParams {
  from?:  number
  to?:    number
  app?:   string
  q?:     string
  limit?: number
  offset?: number
}

export function useFetchCaptures() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (params: FetchCapturesParams = {}): Promise<{
    total: number
    captures: CaptureRecord[]
  }> => {
    const url   = new URL(`${apiBaseUrl}/captures`)
    if (params.from  != null) url.searchParams.set('from',  String(params.from))
    if (params.to    != null) url.searchParams.set('to',    String(params.to))
    if (params.app)            url.searchParams.set('app',   params.app)
    if (params.q)              url.searchParams.set('q',     params.q)
    if (params.limit != null)  url.searchParams.set('limit', String(params.limit))
    if (params.offset != null) url.searchParams.set('offset', String(params.offset))

    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`captures fetch failed: ${resp.status}`)
    return resp.json()
  }, [apiBaseUrl])
}

export function useRagQuery() {
  const apiBaseUrl   = useAppStore((s) => s.apiBaseUrl)
  const setLoading   = useAppStore((s) => s.setRagLoading)
  const setResult    = useAppStore((s) => s.setRagResult)
  const setError     = useAppStore((s) => s.setRagError)

  return useCallback(async (query: string, topK = 5): Promise<RagQueryResponse> => {
    setLoading(true)
    try {
      const resp = await fetch(`${apiBaseUrl}/query`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query, top_k: topK }),
      })
      if (!resp.ok) {
        const err = await resp.text()
        throw new Error(`query failed: ${resp.status} ${err}`)
      }
      const data: RagQueryResponse = await resp.json()
      setResult(data.answer, data.contexts ?? [])
      return data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      throw err
    }
  }, [apiBaseUrl, setLoading, setResult, setError])
}

export function useFetchPreferences() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (): Promise<PreferenceRecord[]> => {
    const resp = await fetch(`${apiBaseUrl}/preferences`)
    if (!resp.ok) throw new Error(`preferences fetch failed: ${resp.status}`)
    const data = await resp.json()
    return data.preferences
  }, [apiBaseUrl])
}

export function useFetchDebugLogFiles() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (): Promise<DebugLogFile[]> => {
    const resp = await fetch(`${apiBaseUrl}/api/debug/log-files`)
    if (!resp.ok) throw new Error(`debug log files fetch failed: ${resp.status}`)
    const data = await resp.json()
    return data.items ?? []
  }, [apiBaseUrl])
}

export function useFetchDebugLogContent() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (key: string): Promise<DebugLogContent> => {
    const resp = await fetch(`${apiBaseUrl}/api/debug/log-files/${encodeURIComponent(key)}`)
    if (!resp.ok) throw new Error(`debug log content fetch failed: ${resp.status}`)
    return resp.json()
  }, [apiBaseUrl])
}

export function useUpdatePreference() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (key: string, value: string): Promise<PreferenceRecord> => {
    const resp = await fetch(`${apiBaseUrl}/preferences/${encodeURIComponent(key)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value }),
    })
    if (!resp.ok) throw new Error(`update preference failed: ${resp.status}`)
    return resp.json()
  }, [apiBaseUrl])
}

export interface ScreenshotCleanupResult {
  keep_days: number
  deleted_count: number
  freed_bytes: number
}

export function useRunScreenshotCleanup() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (): Promise<ScreenshotCleanupResult> => {
    const resp = await fetch(`${apiBaseUrl}/preferences/screenshot-cleanup/run`, {
      method: 'POST',
    })
    if (!resp.ok) throw new Error(`run screenshot cleanup failed: ${resp.status}`)
    return resp.json()
  }, [apiBaseUrl])
}

export function useExecuteAction() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (action: Record<string, unknown>): Promise<ActionResult> => {
    const resp = await fetch(`${apiBaseUrl}/action/execute`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(action),
    })
    if (!resp.ok) throw new Error(`execute action failed: ${resp.status}`)
    return resp.json()
  }, [apiBaseUrl])
}

export interface BakeOverviewResponse {
  capture_count: number
  memory_count: number
  knowledge_count: number
  template_count: number
  pending_candidates: number
  recent_activities: string[]
}

export function useFetchBakeOverview() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (): Promise<BakeOverviewResponse> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/overview`)
    if (!resp.ok) throw new Error(`bake overview fetch failed: ${resp.status}`)
    return resp.json()
  }, [apiBaseUrl])
}

export interface BakeListQueryParams {
  q?: string
  bucket?: BakeBucket
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export interface BakeCaptureListQueryParams extends BakeListQueryParams {
  source_capture_id?: number
}

export function useFetchBakeMemories() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (params: BakeListQueryParams = {}): Promise<PaginatedBakeResponse<EpisodicMemoryItem>> => {
    const buildUrl = (path: string) => {
      const url = new URL(`${apiBaseUrl}${path}`)
      if (params.q) url.searchParams.set('q', params.q)
      if (params.from != null) url.searchParams.set('from', String(params.from))
      if (params.to != null) url.searchParams.set('to', String(params.to))
      if (params.limit != null) url.searchParams.set('limit', String(params.limit))
      if (params.offset != null) url.searchParams.set('offset', String(params.offset))
      return url
    }

    let resp = await fetch(buildUrl('/api/bake/memories').toString())
    if (resp.status === 404) {
      resp = await fetch(buildUrl('/api/bake/articles').toString())
    }
    if (!resp.ok) throw new Error(`bake memories fetch failed: ${resp.status}`)
    const data = await resp.json()
    return {
      items: (data.memories ?? data.articles ?? []).map(mapBakeMemory),
      total: data.total ?? 0,
      limit: data.limit ?? params.limit ?? 20,
      offset: data.offset ?? params.offset ?? 0,
    }
  }, [apiBaseUrl])
}

export function useFetchBakeKnowledge() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (params: BakeListQueryParams = {}): Promise<PaginatedBakeResponse<BakeKnowledgeItem>> => {
    const url = new URL(`${apiBaseUrl}/api/bake/knowledge`)
    if (params.q) url.searchParams.set('q', params.q)
    if (params.bucket) url.searchParams.set('bucket', params.bucket)
    if (params.limit != null) url.searchParams.set('limit', String(params.limit))
    if (params.offset != null) url.searchParams.set('offset', String(params.offset))

    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`bake knowledge fetch failed: ${resp.status}`)
    const data = await resp.json()
    return {
      items: (data.items ?? []).map(mapBakeKnowledge),
      total: data.total ?? 0,
      limit: data.limit ?? params.limit ?? 20,
      offset: data.offset ?? params.offset ?? 0,
    }
  }, [apiBaseUrl])
}

export function useDeleteBakeKnowledge() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<void> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!resp.ok) throw new Error(`delete bake knowledge failed: ${resp.status}`)
  }, [apiBaseUrl])
}

export function useIgnoreBakeKnowledge() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<BakeKnowledgeItem> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/knowledge/${encodeURIComponent(id)}/ignore`, { method: 'POST' })
    if (!resp.ok) throw new Error(`ignore bake knowledge failed: ${resp.status}`)
    return mapBakeKnowledge(await resp.json())
  }, [apiBaseUrl])
}

export function useFetchBakeCaptures() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (params: BakeCaptureListQueryParams = {}): Promise<PaginatedBakeResponse<BakeCaptureItem>> => {
    const url = new URL(`${apiBaseUrl}/api/bake/captures`)
    if (params.q) url.searchParams.set('q', params.q)
    if (params.from != null) url.searchParams.set('from', String(params.from))
    if (params.to != null) url.searchParams.set('to', String(params.to))
    if (params.source_capture_id != null) url.searchParams.set('source_capture_id', String(params.source_capture_id))
    if (params.limit != null) url.searchParams.set('limit', String(params.limit))
    if (params.offset != null) url.searchParams.set('offset', String(params.offset))

    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`bake captures fetch failed: ${resp.status}`)
    const data = await resp.json()
    return {
      items: (data.items ?? data.captures ?? []).map(mapBakeCapture),
      total: data.total ?? 0,
      limit: data.limit ?? params.limit ?? 20,
      offset: data.offset ?? params.offset ?? 0,
    }
  }, [apiBaseUrl])
}

export function useFetchBakeCaptureDetail() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<BakeCaptureItem> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/captures/${encodeURIComponent(id)}`)
    if (!resp.ok) throw new Error(`bake capture detail fetch failed: ${resp.status}`)
    return mapBakeCapture(await resp.json())
  }, [apiBaseUrl])
}

export function useInitializeBakeMemories() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (limit = 20): Promise<{ created_count: number; skipped_count: number; memories: EpisodicMemoryItem[] }> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/memories/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit }),
    })
    if (!resp.ok) throw new Error(`initialize bake memories failed: ${resp.status}`)
    const data = await resp.json()
    return {
      created_count: data.created_count ?? 0,
      skipped_count: data.skipped_count ?? 0,
      memories: (data.memories ?? data.articles ?? []).map(mapBakeMemory),
    }
  }, [apiBaseUrl])
}

export function useIgnoreBakeMemory() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<EpisodicMemoryItem> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/memories/${encodeURIComponent(id)}/ignore`, { method: 'POST' })
    if (!resp.ok) throw new Error(`ignore bake memory failed: ${resp.status}`)
    return mapBakeMemory(await resp.json())
  }, [apiBaseUrl])
}

export function usePromoteBakeMemoryToTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/memories/${encodeURIComponent(id)}/promote-template`, { method: 'POST' })
    if (!resp.ok) throw new Error(`promote bake memory to template failed: ${resp.status}`)
    const item = await resp.json()
    return mapBakeTemplate(item)
  }, [apiBaseUrl])
}

export function usePromoteBakeMemoryToSop() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<SopCandidate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/memories/${encodeURIComponent(id)}/promote-sop`, { method: 'POST' })
    if (!resp.ok) throw new Error(`promote bake memory to sop failed: ${resp.status}`)
    const item = await resp.json()
    return mapBakeSop(item)
  }, [apiBaseUrl])
}

export function useFetchBakeTemplates() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (params: BakeListQueryParams = {}): Promise<PaginatedBakeResponse<ArticleTemplate>> => {
    const url = new URL(`${apiBaseUrl}/api/bake/templates`)
    if (params.q) url.searchParams.set('q', params.q)
    if (params.bucket) url.searchParams.set('bucket', params.bucket)
    if (params.limit != null) url.searchParams.set('limit', String(params.limit))
    if (params.offset != null) url.searchParams.set('offset', String(params.offset))

    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`bake templates fetch failed: ${resp.status}`)
    const data = await resp.json()
    return {
      items: (data.items ?? data.templates ?? []).map(mapBakeTemplate),
      total: data.total ?? 0,
      limit: data.limit ?? params.limit ?? 20,
      offset: data.offset ?? params.offset ?? 0,
    }
  }, [apiBaseUrl])
}

export function useCreateBakeTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (template: ArticleTemplate): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeBakeTemplate(template)),
    })
    if (!resp.ok) throw new Error(`create bake template failed: ${resp.status}`)
    return mapBakeTemplate(await resp.json())
  }, [apiBaseUrl])
}

export function useUpdateBakeTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (template: ArticleTemplate): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/templates/${encodeURIComponent(template.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeBakeTemplate(template)),
    })
    if (!resp.ok) throw new Error(`update bake template failed: ${resp.status}`)
    return mapBakeTemplate(await resp.json())
  }, [apiBaseUrl])
}

export function useToggleBakeTemplateStatus() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/templates/${encodeURIComponent(id)}/toggle-status`, { method: 'POST' })
    if (!resp.ok) throw new Error(`toggle bake template failed: ${resp.status}`)
    return mapBakeTemplate(await resp.json())
  }, [apiBaseUrl])
}

export function useDeleteBakeTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<void> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!resp.ok) throw new Error(`delete bake template failed: ${resp.status}`)
  }, [apiBaseUrl])
}

export function useFetchBakeSops() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (params: BakeListQueryParams = {}): Promise<PaginatedBakeResponse<SopCandidate>> => {
    const url = new URL(`${apiBaseUrl}/api/bake/sops`)
    if (params.q) url.searchParams.set('q', params.q)
    if (params.bucket) url.searchParams.set('bucket', params.bucket)
    if (params.limit != null) url.searchParams.set('limit', String(params.limit))
    if (params.offset != null) url.searchParams.set('offset', String(params.offset))

    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`bake sops fetch failed: ${resp.status}`)
    const data = await resp.json()
    return {
      items: (data.items ?? data.candidates ?? []).map(mapBakeSop),
      total: data.total ?? 0,
      limit: data.limit ?? params.limit ?? 20,
      offset: data.offset ?? params.offset ?? 0,
    }
  }, [apiBaseUrl])
}

export function useAdoptBakeSop() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<SopCandidate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/sops/${encodeURIComponent(id)}/adopt`, { method: 'POST' })
    if (!resp.ok) throw new Error(`adopt bake sop failed: ${resp.status}`)
    return mapBakeSop(await resp.json())
  }, [apiBaseUrl])
}

export function useIgnoreBakeSop() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<SopCandidate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/sops/${encodeURIComponent(id)}/ignore`, { method: 'POST' })
    if (!resp.ok) throw new Error(`ignore bake sop failed: ${resp.status}`)
    return mapBakeSop(await resp.json())
  }, [apiBaseUrl])
}

export function useDeleteBakeSop() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<void> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/sops/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!resp.ok) throw new Error(`delete bake sop failed: ${resp.status}`)
  }, [apiBaseUrl])
}

export function useFetchBakeStyleConfig() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (): Promise<WritingStyleConfig> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/style-config`)
    if (!resp.ok) throw new Error(`bake style config fetch failed: ${resp.status}`)
    const item = await resp.json()
    return {
      preferredPhrases: item.preferred_phrases ?? [],
      replacementRules: item.replacement_rules ?? [],
      styleSamples: item.style_samples ?? [],
      applyToCreation: item.apply_to_creation ?? true,
      applyToTemplateEditing: item.apply_to_template_editing ?? true,
    }
  }, [apiBaseUrl])
}

export function useUpdateBakeStyleConfig() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (config: WritingStyleConfig): Promise<WritingStyleConfig> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/style-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preferred_phrases: config.preferredPhrases,
        replacement_rules: config.replacementRules,
        style_samples: config.styleSamples,
        apply_to_creation: config.applyToCreation,
        apply_to_template_editing: config.applyToTemplateEditing,
      }),
    })
    if (!resp.ok) throw new Error(`update bake style config failed: ${resp.status}`)
    const item = await resp.json()
    return {
      preferredPhrases: item.preferred_phrases ?? [],
      replacementRules: item.replacement_rules ?? [],
      styleSamples: item.style_samples ?? [],
      applyToCreation: item.apply_to_creation ?? true,
      applyToTemplateEditing: item.apply_to_template_editing ?? true,
    }
  }, [apiBaseUrl])
}

function mapBakeMemory(item: any): EpisodicMemoryItem {
  return {
    id: String(item.id),
    title: item.title,
    url: item.url,
    sourceCaptureId: item.source_capture_id ?? '',
    sourceKnowledgeId: item.source_knowledge_id ?? undefined,
    summary: item.summary,
    weight: item.weight,
    openCount: item.open_count,
    dwellSeconds: item.dwell_seconds,
    hasEditAction: item.has_edit_action,
    knowledgeRefCount: item.knowledge_ref_count,
    status: item.status,
    suggestedAction: item.suggested_action,
    tags: item.tags ?? [],
    lastVisitedAt: item.last_visited_at,
    createdAt: item.created_at ?? '',
    createdAtMs: item.created_at_ms ?? 0,
    knowledgeMatchScore: item.knowledge_match_score ?? undefined,
    knowledgeMatchLevel: item.knowledge_match_level ?? undefined,
    templateMatchScore: item.template_match_score ?? undefined,
    templateMatchLevel: item.template_match_level ?? undefined,
    sopMatchScore: item.sop_match_score ?? undefined,
    sopMatchLevel: item.sop_match_level ?? undefined,
  }
}

function mapBakeKnowledge(item: any): BakeKnowledgeItem {
  return {
    id: String(item.id),
    captureId: String(item.capture_id),
    summary: item.summary,
    overview: item.overview,
    details: item.details,
    entities: item.entities ?? [],
    category: item.category,
    importance: item.importance ?? 0,
    occurrenceCount: item.occurrence_count ?? 0,
    observedAt: item.observed_at,
    status: item.status ?? '',
    reviewStatus: item.review_status ?? item.status ?? '',
    matchScore: item.match_score ?? undefined,
    matchLevel: item.match_level ?? undefined,
    updatedAt: item.updated_at ?? '',
    updatedAtMs: item.updated_at_ms ?? 0,
  }
}

function mapBakeCapture(item: any): BakeCaptureItem {
  return {
    id: String(item.id),
    ts: item.ts,
    appName: item.app_name,
    appBundleId: item.app_bundle_id,
    winTitle: item.win_title,
    eventType: item.event_type,
    semanticTypeLabel: item.semantic_type_label ?? item.event_type ?? '未知片段',
    rawTypeLabel: item.raw_type_label ?? item.event_type ?? '未知模态',
    axText: item.ax_text,
    axFocusedRole: item.ax_focused_role,
    axFocusedId: item.ax_focused_id,
    ocrText: item.ocr_text,
    inputText: item.input_text,
    audioText: item.audio_text,
    screenshotPath: item.screenshot_path,
    isSensitive: item.is_sensitive ?? false,
    piiScrubbed: item.pii_scrubbed ?? false,
    bestText: item.best_text,
    summary: item.summary,
    linkedKnowledgeId: item.linked_knowledge_id,
    linkedKnowledgeSummary: item.linked_knowledge_summary,
  }
}

function mapBakeTemplate(item: any): ArticleTemplate {
  return {
    id: String(item.id),
    name: item.name,
    category: item.category,
    status: item.status,
    tags: item.tags ?? [],
    applicableTasks: item.applicable_tasks ?? [],
    sourceMemoryIds: item.source_memory_ids ?? item.source_article_ids ?? [],
    linkedKnowledgeIds: item.linked_knowledge_ids ?? [],
    structureSections: item.structure_sections ?? [],
    stylePhrases: item.style_phrases ?? [],
    replacementRules: item.replacement_rules ?? [],
    promptHint: item.prompt_hint,
    diagramCode: item.diagram_code,
    imageAssets: item.image_assets ?? [],
    usageCount: item.usage_count ?? 0,
    reviewStatus: item.review_status ?? '',
    matchScore: item.match_score ?? undefined,
    matchLevel: item.match_level ?? undefined,
    updatedAt: item.updated_at,
  }
}

function serializeBakeTemplate(template: ArticleTemplate) {
  return {
    name: template.name,
    category: template.category,
    status: template.status,
    tags: template.tags,
    applicable_tasks: template.applicableTasks,
    source_memory_ids: template.sourceMemoryIds,
    source_article_ids: template.sourceMemoryIds,
    linked_knowledge_ids: template.linkedKnowledgeIds,
    structure_sections: template.structureSections,
    style_phrases: template.stylePhrases,
    replacement_rules: template.replacementRules,
    prompt_hint: template.promptHint,
    diagram_code: template.diagramCode,
    image_assets: template.imageAssets ?? [],
    usage_count: template.usageCount,
    match_score: template.matchScore ?? null,
    match_level: template.matchLevel ?? null,
    review_status: template.reviewStatus ?? null,
  }
}

function mapBakeSop(item: any): SopCandidate {
  return {
    id: String(item.id),
    sourceCaptureId: item.source_capture_id ?? '',
    sourceTitle: item.source_title,
    triggerKeywords: item.trigger_keywords ?? [],
    confidence: item.confidence,
    extractedProblem: item.extracted_problem,
    steps: item.steps ?? [],
    linkedKnowledgeIds: item.linked_knowledge_ids ?? [],
    status: item.status,
  }
}
