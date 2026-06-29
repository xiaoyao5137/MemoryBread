import { useCallback, useEffect, useState } from 'react'
import { useAppStore }  from '../store/useAppStore'
import type { CreationModelConfig } from '../store/useAppStore'
import type {
  ArticleTemplate,
  BakeBucket,
  BakeCaptureItem,
  BakeKnowledgeItem,
  CaptureRecord,
  ConfigCheckActionResult,
  ConfigCheckItem,
  DebugLogContent,
  DebugLogFile,
  TimelineItem,
  PaginatedBakeResponse,
  PreferenceRecord,
  RagHistoryItem,
  RagQueryResponse,
  ActionResult,
  SopCandidate,
  WritingStyleConfig,
} from '../types'

const LOCAL_CORE_API = 'http://127.0.0.1:7070'
const LOCAL_MODEL_API = 'http://127.0.0.1:7071'

const normalizeLocalApiBaseUrl = (baseUrl: string) =>
  baseUrl.replace(/^http:\/\/localhost(?::7070)?$/i, LOCAL_CORE_API)

const isNetworkLoadFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return message === 'Load failed' || message.includes('Failed to fetch') || message.includes('NetworkError')
}

const fetchWithLocalhostFallback = async (input: string, init?: RequestInit) => {
  try {
    return await fetch(input, init)
  } catch (error) {
    if (!isNetworkLoadFailure(error)) throw error
    const fallbackInput = input.replace(/^http:\/\/localhost(?=:7070\/|\/)/i, 'http://127.0.0.1')
    if (fallbackInput === input) throw error
    return fetch(fallbackInput, init)
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const parseApiErrorMessage = async (resp: Response, fallback: string) => {
  let errMsg = fallback
  try {
    const errJson = await resp.json()
    if (errJson.error === 'MODEL_NOT_READY') {
      errMsg = '向量模型或推理模型尚未就绪，请前往「模型」界面检查模型状态'
    } else if (errJson.error || errJson.message) {
      errMsg = errJson.message || errJson.error
    }
  } catch {
    const errText = await resp.text()
    if (errText) errMsg += ` ${errText}`
  }
  if ((resp.status === 503 || resp.status === 504) && errMsg.startsWith(fallback) && !errMsg.includes('模型')) {
    errMsg = 'AI 正在处理其他任务，请稍候 1-2 分钟再试'
  }
  return errMsg
}

interface RagJobCreateResponse {
  job_id: string
  status: string
}

interface RagJobStatusResponse {
  id: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | string
  result?: RagQueryResponse | null
  error?: string | null
  created_at_ms: number
  updated_at_ms: number
}

const LOCAL_CREATION_MODEL_ID = 'mbcd-std-v1'
const CREATION_MODEL_NAMES: Record<string, string> = {
  'mbcd-plus-v1': 'claude-opus-4-8',
  'mbcd-std-v1': 'qwen3.5:4b',
  'claude-opus-4-8': 'claude-opus-4-8',
  'qwen-3-5-4b': 'qwen3.5:4b',
}

const getActiveCreationModelPayload = (configs: CreationModelConfig[]) => {
  const active = configs.find(config =>
    config.enabled && (config.id === LOCAL_CREATION_MODEL_ID || config.apiKey)
  )
  if (!active) return {}
  const payload: Record<string, string> = {
    creation_model: CREATION_MODEL_NAMES[active.id] || active.id,
  }
  if (active.id !== LOCAL_CREATION_MODEL_ID && active.apiKey) {
    payload.creation_api_key = active.apiKey
  }
  if (active.baseUrl) {
    payload.creation_base_url = active.baseUrl
  }
  return payload
}

export interface ModelStatus {
  llm: boolean
  embedding: boolean
  ollama: boolean
}

export function useModelStatus() {
  const [status, setStatus] = useState<ModelStatus>({ llm: false, embedding: false, ollama: false })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const check = async () => {
      try {
        const resp = await fetch(`${LOCAL_MODEL_API}/api/models`)
        if (!resp.ok) {
          setStatus({ llm: false, embedding: false, ollama: false })
          return
        }
        const data = await resp.json()
        const models = data.models || []
        const llm = models.some((m: any) => m.category === 'llm' && (m.status === 'active' || m.is_active))
        const embedding = models.some((m: any) => m.category === 'embedding' && (m.status === 'active' || m.is_active))
        const ollama = models.some((m: any) => m.id === 'ollama' && (m.status === 'active' || m.is_active))
        setStatus({ llm, embedding, ollama })
      } catch {
        setStatus({ llm: false, embedding: false, ollama: false })
      } finally {
        setLoading(false)
      }
    }
    check()
    const interval = setInterval(check, 10000)
    return () => clearInterval(interval)
  }, [])

  return { status, loading, ready: status.llm && status.embedding && status.ollama }
}

export function useHealthCheck() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (): Promise<{ status: string; version: string }> => {
    const resp = await fetch(`${normalizeLocalApiBaseUrl(apiBaseUrl)}/health`)
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
  ids?:   string
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
    if (params.ids)            url.searchParams.set('ids',   params.ids)

    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`captures fetch failed: ${resp.status}`)
    return resp.json()
  }, [apiBaseUrl])
}

export function useRagQuery() {
  const apiBaseUrl   = useAppStore((s) => normalizeLocalApiBaseUrl(s.apiBaseUrl))
  const creationModelConfigs = useAppStore((s) => s.creationModelConfigs)
  const setLoading   = useAppStore((s) => s.setRagLoading)
  const setResult    = useAppStore((s) => s.setRagResult)
  const setError     = useAppStore((s) => s.setRagError)

  return useCallback(async (query: string, topK = 5): Promise<RagQueryResponse> => {
    setLoading(true)
    try {
      const createResp = await fetchWithLocalhostFallback(`${apiBaseUrl}/api/rag/jobs`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          query,
          top_k: topK,
          ...getActiveCreationModelPayload(creationModelConfigs),
        }),
      })
      if (!createResp.ok) {
        throw new Error(await parseApiErrorMessage(createResp, `query job create failed: ${createResp.status}`))
      }

      const created: RagJobCreateResponse = await createResp.json()
      const deadline = Date.now() + 10 * 60 * 1000
      let data: RagQueryResponse | null = null

      while (Date.now() < deadline) {
        await sleep(2000)
        const statusResp = await fetchWithLocalhostFallback(`${apiBaseUrl}/api/rag/jobs/${encodeURIComponent(created.job_id)}`)
        if (!statusResp.ok) {
          throw new Error(await parseApiErrorMessage(statusResp, `query job status failed: ${statusResp.status}`))
        }

        const job: RagJobStatusResponse = await statusResp.json()
        if (job.status === 'succeeded') {
          data = job.result ?? null
          break
        }
        if (job.status === 'failed') {
          throw new Error(job.error || '咨询生成失败，请稍后重试')
        }
      }

      if (!data) {
        throw new Error('咨询生成等待超时，请稍后在「咨询记录」中查看是否已完成')
      }

      setResult(data.answer, data.contexts ?? [])
      return data
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err)
      const msg = rawMsg === 'Load failed'
        ? '咨询请求连接失败，请确认 MemoryBread 后端已启动，并稍后重试'
        : rawMsg
      setError(msg)
      throw err
    }
  }, [apiBaseUrl, creationModelConfigs, setLoading, setResult, setError])
}

export function useFetchRagHistory() {
  const apiBaseUrl = useAppStore((s) => normalizeLocalApiBaseUrl(s.apiBaseUrl))

  return useCallback(async (limit = 20): Promise<RagHistoryItem[]> => {
    const resp = await fetchWithLocalhostFallback(`${apiBaseUrl}/api/rag/history?limit=${encodeURIComponent(String(limit))}`)
    if (resp.status === 404) return []
    if (!resp.ok) throw new Error(`rag history fetch failed: ${resp.status}`)
    const data = await resp.json()
    return data.items ?? []
  }, [apiBaseUrl])
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

export function useFetchConfigChecks() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (): Promise<ConfigCheckItem[]> => {
    const resp = await fetch(`${apiBaseUrl}/api/config-checks`)
    if (!resp.ok) throw new Error(`config checks fetch failed: ${resp.status}`)
    const data = await resp.json()
    return data.items ?? []
  }, [apiBaseUrl])
}

export function useRunConfigCheckAction() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (
    id: string,
    action: 'verify' | 'install' | 'delete',
  ): Promise<ConfigCheckActionResult> => {
    const path = action === 'delete'
      ? `${apiBaseUrl}/api/config-checks/${encodeURIComponent(id)}`
      : `${apiBaseUrl}/api/config-checks/${encodeURIComponent(id)}/${action}`
    const resp = await fetch(path, {
      method: action === 'delete' ? 'DELETE' : 'POST',
    })
    if (!resp.ok) throw new Error(`config check ${action} failed: ${resp.status}`)
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

  return useCallback(async (params: BakeListQueryParams = {}): Promise<PaginatedBakeResponse<TimelineItem>> => {
    const buildUrl = (path: string) => {
      const url = new URL(`${apiBaseUrl}${path}`)
      if (params.q) url.searchParams.set('q', params.q)
      if (params.from != null) url.searchParams.set('from', String(params.from))
      if (params.to != null) url.searchParams.set('to', String(params.to))
      if (params.limit != null) url.searchParams.set('limit', String(params.limit))
      if (params.offset != null) url.searchParams.set('offset', String(params.offset))
      return url
    }

    const resp = await fetch(buildUrl('/api/knowledge').toString())
    if (!resp.ok) throw new Error(`timelines fetch failed: ${resp.status}`)
    const data = await resp.json()
    return {
      items: (data.entries ?? []).map(mapKnowledgeEntryToTimeline),
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
    if (params.from != null) url.searchParams.set('from', String(params.from))
    if (params.to != null) url.searchParams.set('to', String(params.to))
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

  return useCallback(async (limit = 20): Promise<{ created_count: number; skipped_count: number; memories: TimelineItem[] }> => {
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

  return useCallback(async (id: string): Promise<TimelineItem> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/memories/${encodeURIComponent(id)}/ignore`, { method: 'POST' })
    if (!resp.ok) throw new Error(`ignore bake memory failed: ${resp.status}`)
    return mapBakeMemory(await resp.json())
  }, [apiBaseUrl])
}

export function usePromoteBakeMemoryToTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/memories/${encodeURIComponent(id)}/promote-design`, { method: 'POST' })
    if (!resp.ok) throw new Error(`promote bake memory to design failed: ${resp.status}`)
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
    const url = new URL(`${apiBaseUrl}/api/bake/documents`)
    if (params.q) url.searchParams.set('q', params.q)
    if (params.bucket) url.searchParams.set('bucket', params.bucket)
    if (params.from != null) url.searchParams.set('from', String(params.from))
    if (params.to != null) url.searchParams.set('to', String(params.to))
    if (params.limit != null) url.searchParams.set('limit', String(params.limit))
    if (params.offset != null) url.searchParams.set('offset', String(params.offset))

    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`bake documents fetch failed: ${resp.status}`)
    const data = await resp.json()
    return {
      items: (data.items ?? data.templates ?? []).map(mapBakeTemplate),
      total: data.total ?? 0,
      limit: data.limit ?? params.limit ?? 20,
      offset: data.offset ?? params.offset ?? 0,
    }
  }, [apiBaseUrl])
}

export function useFetchBakeTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/documents/${encodeURIComponent(id)}`)
    if (!resp.ok) throw new Error(`bake document fetch failed: ${resp.status}`)
    return mapBakeTemplate(await resp.json())
  }, [apiBaseUrl])
}

export function useCreateBakeTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (template: ArticleTemplate): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeBakeTemplate(template)),
    })
    if (!resp.ok) throw new Error(`create bake document failed: ${resp.status}`)
    return mapBakeTemplate(await resp.json())
  }, [apiBaseUrl])
}

export function useUpdateBakeTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (template: ArticleTemplate): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/documents/${encodeURIComponent(template.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeBakeTemplate(template)),
    })
    if (!resp.ok) throw new Error(`update bake document failed: ${resp.status}`)
    return mapBakeTemplate(await resp.json())
  }, [apiBaseUrl])
}

export function useToggleBakeTemplateStatus() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<ArticleTemplate> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/documents/${encodeURIComponent(id)}/toggle-status`, { method: 'POST' })
    if (!resp.ok) throw new Error(`toggle bake document failed: ${resp.status}`)
    return mapBakeTemplate(await resp.json())
  }, [apiBaseUrl])
}

export function useDeleteBakeTemplate() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (id: string): Promise<void> => {
    const resp = await fetch(`${apiBaseUrl}/api/bake/documents/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!resp.ok) throw new Error(`delete bake document failed: ${resp.status}`)
  }, [apiBaseUrl])
}

export function useFetchBakeSops() {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)

  return useCallback(async (params: BakeListQueryParams = {}): Promise<PaginatedBakeResponse<SopCandidate>> => {
    const url = new URL(`${apiBaseUrl}/api/bake/sops`)
    if (params.q) url.searchParams.set('q', params.q)
    if (params.bucket) url.searchParams.set('bucket', params.bucket)
    if (params.from != null) url.searchParams.set('from', String(params.from))
    if (params.to != null) url.searchParams.set('to', String(params.to))
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

function mapKnowledgeEntryToTimeline(item: any): TimelineItem {
  return {
    id: String(item.id),
    title: item.summary ?? '',
    summary: item.overview ?? item.summary,
    details: item.details ?? undefined,
    sourceCaptureId: item.capture_id != null ? String(item.capture_id) : '',
    weight: item.importance ?? 3,
    openCount: item.occurrence_count ?? 0,
    dwellSeconds: 0,
    hasEditAction: false,
    knowledgeRefCount: 0,
    status: 'confirmed' as const,
    tags: [],
    createdAt: item.created_at ?? '',
    createdAtMs: item.created_at_ms ?? 0,
    captureIds: item.capture_ids ?? [],
    // 后端 KnowledgeEntry 通过 #[serde(rename = "keyTimestamps")] 序列化为驼峰，
    // 这里优先读驼峰键，兼容历史 snake_case 以防回退。
    keyTimestamps: item.keyTimestamps ?? item.key_timestamps ?? undefined,
  }
}

function mapBakeMemory(item: any): TimelineItem {
  return {
    id: String(item.id),
    title: item.title,
    url: item.url,
    sourceCaptureId: item.source_capture_id ?? '',
    sourceTimelineId: item.source_timeline_id ?? item.source_knowledge_id ?? undefined,
    details: item.details ?? undefined,
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
    captureIds: item.capture_ids ?? [],
    keyTimestamps: item.keyTimestamps ?? undefined,
  }
}

function mapBakeKnowledge(item: any): BakeKnowledgeItem {
  const details = parseMaybeJsonObject(item.details)
  const sourceCaptureIds = Array.isArray(item.source_capture_ids)
    ? item.source_capture_ids.map(String)
    : Array.isArray(details?.source_capture_ids)
      ? details.source_capture_ids.map(String)
      : []
  const captureId = String(item.capture_id)
  if (captureId && !sourceCaptureIds.includes(captureId)) {
    sourceCaptureIds.unshift(captureId)
  }

  return {
    id: String(item.id),
    captureId,
    sourceCaptureIds,
    sourceTimelineId: item.source_timeline_id != null ? String(item.source_timeline_id) : String(item.id),
    summary: item.summary,
    overview: item.overview,
    details: item.details,
    detailedContent: item.detailed_content,
    entities: item.entities ?? [],
    category: item.category,
    importance: item.importance ?? 0,
    occurrenceCount: item.occurrence_count ?? 0,
    observedAt: item.observed_at,
    status: item.status ?? '',
    reviewStatus: item.review_status ?? item.status ?? '',
    matchScore: item.match_score ?? undefined,
    matchLevel: item.match_level ?? undefined,
    createdAt: item.created_at ?? '',
    createdAtMs: item.created_at_ms ?? 0,
    updatedAt: item.updated_at ?? '',
    updatedAtMs: item.updated_at_ms ?? 0,
  }
}

function parseMaybeJsonObject(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
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
    screenshotSource: item.screenshot_source,
    url: item.url,
    webpageTitle: item.webpage_title,
    isSensitive: item.is_sensitive ?? false,
    piiScrubbed: item.pii_scrubbed ?? false,
    bestText: item.best_text,
    summary: item.summary,
    linkedTimelineId: item.linked_timeline_id,
    linkedTimelineSummary: item.linked_timeline_summary,
  }
}

function mapBakeTemplate(item: any): ArticleTemplate {
  return {
    id: String(item.id),
    title: item.title,
    docType: item.doc_type,
    status: item.status,
    tags: item.tags ?? [],
    applicableTasks: item.applicable_tasks ?? [],
    sourceMemoryIds: item.source_memory_ids ?? [],
    sourceCaptureIds: item.source_capture_ids ?? [],
    sourceEpisodeIds: item.source_episode_ids ?? [],
    linkedKnowledgeIds: item.linked_knowledge_ids ?? [],
    sections: item.sections ?? [],
    stylePhrases: item.style_phrases ?? [],
    replacementRules: item.replacement_rules ?? [],
    summary: item.summary,
    fullContent: item.full_content,
    sourceUrl: item.source_url,
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
    title: template.title,
    doc_type: template.docType,
    status: template.status,
    tags: template.tags,
    applicable_tasks: template.applicableTasks,
    source_memory_ids: template.sourceMemoryIds,
    source_capture_ids: template.sourceCaptureIds,
    source_episode_ids: template.sourceEpisodeIds,
    linked_knowledge_ids: template.linkedKnowledgeIds,
    sections: template.sections,
    style_phrases: template.stylePhrases,
    replacement_rules: template.replacementRules,
    summary: template.summary ?? null,
    full_content: template.fullContent ?? null,
    source_url: template.sourceUrl ?? null,
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
    sourceTimelineId: item.source_timeline_id != null ? String(item.source_timeline_id) : String(item.id),
    sourceTitle: item.source_title,
    triggerKeywords: item.trigger_keywords ?? [],
    confidence: item.confidence,
    extractedProblem: item.extracted_problem,
    detailedContent: item.detailed_content,
    steps: item.steps ?? [],
    linkedKnowledgeIds: item.linked_knowledge_ids ?? [],
    linkedKnowledgeSummaries: item.linked_knowledge_summaries ?? [],
    status: item.status,
    createdAt: item.created_at ?? '',
    createdAtMs: item.created_at_ms ?? 0,
    updatedAt: item.updated_at ?? '',
    updatedAtMs: item.updated_at_ms ?? 0,
  }
}
