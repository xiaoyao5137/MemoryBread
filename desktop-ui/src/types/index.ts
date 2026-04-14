// ─────────────────────────────────────────────────────────────────────────────
// 共享类型定义（与 core-engine REST API 对齐）
// ─────────────────────────────────────────────────────────────────────────────

export interface CaptureRecord {
  id:             number
  ts:             number
  app_name:       string | null
  app_bundle_id:  string | null
  win_title:      string | null
  event_type:     string
  ax_text:        string | null
  ax_focused_role?: string | null
  ax_focused_id?: string | null
  ocr_text:       string | null
  input_text:     string | null
  audio_text:     string | null
  is_sensitive:   boolean
  pii_scrubbed:   boolean
  screenshot_path:string | null
  knowledge?:     {
    id:               number
    summary:          string
    overview?:        string  // 概述
    details?:         string  // 明细
    entities:         string[]
    category:         string
    importance:       number
    occurrence_count?: number  // 出现次数
  } | null
}

export interface PreferenceRecord {
  id:         number
  key:        string
  value:      string
  source:     string
  confidence: number
  updated_at: number
}

export interface RagQueryResponse {
  answer:   string
  contexts: RagContext[]
  model:    string
}

export interface RagContext {
  capture_id: number
  text:       string
  score:      number
  source:     'fts5' | 'vector' | 'merged'
  app_name?:  string | null
}

export interface DebugLogFile {
  key: string
  label: string
  exists: boolean
  size_bytes: number
  modified_at: number | null
}

export interface DebugLogContent {
  key: string
  label: string
  content: string
  truncated: boolean
  total_size_bytes: number
  returned_bytes: number
  modified_at: number | null
}

export interface ActionCommand {
  type:        'click' | 'right_click' | 'double_click' | 'move_to' | 'type_text' | 'hotkey' | 'key_press' | 'scroll' | 'wait' | 'sequence'
  x?:          number
  y?:          number
  text?:       string
  keys?:       string[]
  key?:        string
  delta_y?:    number
  ms?:         number
  steps?:      ActionCommand[]
  description?:string
}

export interface ActionResult {
  success:     boolean
  message:     string
  action_id:   string
}

export type WindowMode = 'buddy' | 'rag' | 'knowledge' | 'models' | 'settings' | 'debug' | 'tasks' | 'monitor' | 'bake'

export type BakeTab = 'overview' | 'templates' | 'memories' | 'knowledge' | 'sop' | 'style'

export type BakeBucket = 'extracted' | 'pending'

export type RepositoryTab = 'memory' | 'capture'

export interface BakeOverview {
  captureCount: number
  memoryCount: number
  knowledgeCount: number
  templateCount: number
  pendingCandidates: number
  recentActivities: string[]
}

export interface EpisodicMemoryItem {
  id: string
  title: string
  url?: string
  sourceCaptureId?: string
  sourceKnowledgeId?: string
  summary?: string
  weight: number
  openCount: number
  dwellSeconds: number
  hasEditAction: boolean
  knowledgeRefCount: number
  status: 'candidate' | 'confirmed' | 'ignored' | 'templated'
  suggestedAction?: 'template' | 'knowledge' | 'sop'
  tags: string[]
  lastVisitedAt?: string
  createdAt: string
  createdAtMs: number
  knowledgeMatchScore?: number
  knowledgeMatchLevel?: string
  templateMatchScore?: number
  templateMatchLevel?: string
  sopMatchScore?: number
  sopMatchLevel?: string
}

export interface BakeKnowledgeItem {
  id: string
  captureId: string
  summary: string
  overview?: string
  details?: string
  entities: string[]
  category: string
  importance: number
  occurrenceCount: number
  observedAt?: number
  status: string
  reviewStatus: string
  matchScore?: number
  matchLevel?: string
  updatedAt: string
  updatedAtMs: number
}

export interface BakeCaptureItem {
  id: string
  ts: number
  appName?: string | null
  appBundleId?: string | null
  winTitle?: string | null
  eventType: string
  semanticTypeLabel: string
  rawTypeLabel: string
  axText?: string | null
  axFocusedRole?: string | null
  axFocusedId?: string | null
  ocrText?: string | null
  inputText?: string | null
  audioText?: string | null
  screenshotPath?: string | null
  isSensitive: boolean
  piiScrubbed: boolean
  bestText?: string | null
  summary?: string | null
  linkedKnowledgeId?: string | null
  linkedKnowledgeSummary?: string | null
}

export interface PaginatedBakeResponse<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export interface TemplateSection {
  title: string
  keywords: string[]
  notes?: string
}

export interface ReplacementRule {
  from: string
  to: string
}

export interface ArticleTemplate {
  id: string
  name: string
  category: string
  status: 'draft' | 'auto_generated' | 'pending_review' | 'enabled' | 'disabled'
  tags: string[]
  applicableTasks: Array<'qa' | 'creation' | 'work_tip'>
  sourceMemoryIds: string[]
  linkedKnowledgeIds: string[]
  structureSections: TemplateSection[]
  stylePhrases: string[]
  replacementRules: ReplacementRule[]
  diagramCode?: string
  imageAssets?: string[]
  promptHint?: string
  usageCount: number
  reviewStatus: string
  matchScore?: number
  matchLevel?: string
  updatedAt?: string
}

export interface WritingStyleConfig {
  preferredPhrases: string[]
  replacementRules: ReplacementRule[]
  styleSamples: string[]
  applyToCreation: boolean
  applyToTemplateEditing: boolean
}

export interface SopCandidate {
  id: string
  sourceCaptureId: string
  sourceTitle?: string
  triggerKeywords: string[]
  confidence: 'low' | 'medium' | 'high'
  extractedProblem?: string
  steps: string[]
  linkedKnowledgeIds: string[]
  status: 'candidate' | 'confirmed' | 'ignored'
}

// ─────────────────────────────────────────────────────────────────────────────
// 监控模块
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitorOverview {
  db_size_bytes: number
  capture_total_count: number
  token_usage: {
    total_period:  number
    total_today:   number
    by_model:      { model: string; total: number; calls: number }[]
    by_caller:     { caller: string; total: number; calls: number }[]
    trend:         { ts: number; date: string; tokens: number; calls: number }[]
  }
  capture_flow: {
    today_count:              number
    period_count:             number
    eligible_count:           number
    vectorized_count:         number
    vectorization_rate:       number
    knowledge_generated_count:number
    knowledge_generation_rate:number
    knowledge_linked_count:   number
    knowledge_rate:           number
    by_hour:                  { hour: number; count: number }[]
    by_app:                   { app: string; count: number }[]
    recent:                   { id: number; ts: number; app_name: string; win_title: string }[]
  }
  knowledge_flow: {
    today_count: number
    period_count: number
    pending_extraction_count: number
    by_time: { ts: number; count: number }[]
    recent: { id: number; ts: number; summary: string; category: string; importance: number; app_name: string; win_title: string }[]
  }
  rag_sessions: {
    today_count:    number
    period_count:   number
    avg_latency_ms: number
    recent:         { id: number; ts: number; query: string; latency_ms: number | null; context_count: number }[]
  }
  task_executions: {
    total:        number
    success:      number
    failed:       number
    success_rate: number
    recent:       { id: number; task_name: string; status: string; started_at: number; latency_ms: number | null; knowledge_count: number | null }[]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 定时任务
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  id:               number
  name:             string
  user_instruction: string
  cron_expression:  string
  enabled:          boolean
  template_id:      string | null
  run_count:        number
  last_run_at:      number | null
  last_run_status:  string | null
  next_run_at:      number | null
  created_at:       number
  updated_at:       number
}

export interface TaskExecution {
  id:              number
  task_id:         number
  started_at:      number
  completed_at:    number | null
  status:          'running' | 'success' | 'failed'
  knowledge_count: number | null
  token_used:      number | null
  result_text:     string | null
  error_message:   string | null
  latency_ms:      number | null
}

export interface TaskTemplate {
  id:               string
  name:             string
  cron:             string
  category:         string
  user_instruction: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 模型管理
// ─────────────────────────────────────────────────────────────────────────────

export type ModelProvider =
  | 'ollama' | 'huggingface'
  | 'openai' | 'anthropic'
  | 'tongyi' | 'doubao' | 'deepseek' | 'kimi'

export type ModelCategory = 'llm' | 'embedding' | 'ocr' | 'asr' | 'vlm'
export type ModelStatus = 'not_installed' | 'downloading' | 'installed' | 'active' | 'error'

export interface ApiKeyField {
  key:         string
  label:       string
  placeholder: string
  required:    boolean
  secret:      boolean
}

export interface ModelEntry {
  id:               string
  name:             string
  category:         ModelCategory
  provider:         ModelProvider
  size_gb:          number
  description:      string
  status:           ModelStatus
  download_progress?: number
  is_active:        boolean
  is_default:       boolean
  requires_api_key: boolean
  api_key_fields?:  ApiKeyField[]
  recommended?:     boolean
  recommend_reason?: string
  tags?:            string[]
}

export interface HardwareInfo {
  memory_gb:      number
  cpu_cores:      number
  disk_free_gb:   number
  has_gpu:        boolean
  gpu_memory_gb?: number
}

export interface ActiveModels {
  llm?:       ModelEntry
  embedding?: ModelEntry
}


export interface NamedMetricSeries {
  key: string
  label: string
  points: { ts: number; value: number }[]
  process_names?: string[]
  coverage_status?: string | null
  coverage_note?: string | null
}

export interface ModelRuntimeBreakdownItem {
  key: string
  label: string
  cpu_percent: number
  mem_process_mb: number
  process_count: number
  coverage_status?: string | null
  coverage_note?: string | null
}

export interface SystemResources {
  db_size_bytes: number
  trends: {
    system_cpu: { ts: number; value: number }[]
    system_mem: { ts: number; value: number }[]
    suite_cpu: { ts: number; value: number }[]
    suite_mem: { ts: number; value: number }[]
    model_cpu: { ts: number; value: number }[]
    model_mem: { ts: number; value: number }[]
    model_cpu_series: NamedMetricSeries[]
    model_mem_series: NamedMetricSeries[]
    model_estimated_mem_series: NamedMetricSeries[]
  }
  gpu_trend?: { ts: number; value: number }[]
  model_gpu_trend?: { ts: number; value: number }[]
  disk_trend: { ts: number; read_mb: number; write_mb: number }[]
  knowledge_events?: { ts: number; count: number }[]
  model_runtime_breakdown: ModelRuntimeBreakdownItem[]
  model_events: {
    ts: number
    event_type: string
    model_type: string
    model_name: string
    duration_ms: number | null
    memory_mb: number | null
    mem_before_mb: number | null
    mem_after_mb: number | null
    error_msg: string | null
  }[]
  latest: {
    system: {
      cpu_total: number
      mem_total_mb: number
      mem_used_mb: number
      mem_percent: number
      gpu_percent?: number | null
      gpu_name?: string | null
      gpu_total_label?: string | null
    } | null
    suite: {
      cpu_percent: number
      mem_process_mb: number
      process_count: number
      process_names?: string[]
      coverage_status?: string | null
      coverage_note?: string | null
    } | null
    model: {
      cpu_percent: number
      mem_process_mb: number
      process_count: number
      process_names?: string[]
      coverage_status?: string | null
      coverage_note?: string | null
    } | null
  }
}
