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

export type ConfigCheckStatus = 'ok' | 'warning' | 'failed' | 'unsupported'

export interface ConfigCheckItem {
  id: string
  name: string
  description: string
  status: ConfigCheckStatus
  message: string
  details: string[]
  can_install: boolean
  can_delete: boolean
}

export interface ConfigCheckActionResult {
  id: string
  action: 'verify' | 'install' | 'delete' | string
  status: ConfigCheckStatus
  message: string
  details: string[]
}

export interface RagQueryResponse {
  answer:   string
  contexts: RagContext[]
  model:    string
  done_reason?: string | null
  output_truncated?: boolean
}

export interface RagContext {
  capture_id: number
  doc_key?:    string | null
  text:       string
  score:      number
  source:     'fts5' | 'vector' | 'merged' | string
  source_type?: string | null
  knowledge_id?: number | null
  artifact_id?: number | null
  document_id?: number | null
  app_name?:  string | null
  win_title?: string | null
  url?: string | null
  source_url?: string | null
  title?: string | null
  doc_type?: string | null
  time?:      number | string | null
  observed_at?: number | string | null
  event_time_start?: number | string | null
  event_time_end?: number | string | null
  start_time?: number | string | null
  end_time?: number | string | null
  summary?: string | null
  overview?: string | null
  category?: string | null
  activity_type?: string | null
  content_origin?: string | null
  history_view?: boolean | null
  evidence_strength?: string | null
  importance?: number | null
  source_timeline_ids?: string[] | null
  linked_knowledge_ids?: string[] | null
  screenshot_path?: string | null
  screenshot_width?: number | null
  screenshot_height?: number | null
}

export interface RagHistoryItem {
  id: number
  ts: number
  query: string
  answer: string
  contexts: RagContext[]
  context_count: number
  latency_ms: number | null
  model?: string | null
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

export type WindowMode = 'buddy' | 'rag' | 'creation' | 'knowledge' | 'models' | 'privacy' | 'settings' | 'debug' | 'tasks' | 'monitor' | 'bake' | 'profile' | 'account'

export type ServiceEnvironment = 'production' | 'staging'

export type AccountType = 'user' | 'platform_admin'

export interface CloudUser {
  id: string
  display_name?: string | null
  username?: string | null
  name?: string | null
  nickname?: string | null
  email?: string | null
  phone?: string | null
  status: string
  roles: string[]
  locale: string
  timezone: string
  created_at: string
  subscription_plan?: string | null
  plan_name?: string | null
  membership_plan?: string | null
}

export interface AuthSession {
  access_token: string
  expires_at: string
  user: CloudUser
}

export interface CloudBalance {
  available: string
  reserved: string
  currency: string
  as_of: string
}

export interface CloudSubscription {
  id: string
  status: string
  starts_at?: string
  ends_at?: string
  plan_key: string
  name: string
  permission_summary?: string[]
}

export interface CloudDevice {
  id: string
  name: string
  platform: string
  client_version: string
  last_seen_at: string
  revoked_at?: string | null
}

export interface UpsertCloudDeviceRequest {
  device_id?: string
  name: string
  platform: string
  client_version: string
  public_key_base64: string
}

export interface CloudSnapshot {
  id: string
  device_id: string
  encrypted_size: number
  status: string
  committed_at?: string | null
}

export interface CompleteCloudSnapshotRequest {
  device_id: string
  encrypted_size: number
  oss_object_key: string
  checksum_sha256?: string | null
  format_version: number
  schema_version: number
  encryption_version: number
}

export type BakeTab = 'overview' | 'templates' | 'knowledge' | 'sop'

export type BakeBucket = 'extracted' | 'pending'

export type RepositoryTab = 'memory' | 'capture'

export interface BakeOverview {
  captureCount: number
  memoryCount: number
  knowledgeCount: number
  templateCount: number
  sopCount: number
  pendingCandidates: number
  recentActivities: string[]
  inventoryTrend: BakeInventoryTrendBucket[]
}

export interface BakeInventoryTrendBucket {
  label: string
  startTs: number
  endTs: number
  memoryCount: number
  knowledgeCount: number
  templateCount: number
  sopCount: number
}

export interface TimelineItem {
  id: string
  title: string
  url?: string
  sourceCaptureId?: string
  sourceTimelineId?: string
  details?: string
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
  captureIds?: number[]
  keyTimestamps?: Array<{
    capture_ids: number[]
    start_ts: number
    end_ts: number
    summary: string
  }>
}

export interface BakeKnowledgeItem {
  id: string
  captureId: string
  sourceCaptureIds: string[]
  sourceTimelineId?: string
  summary: string
  overview?: string
  details?: string
  detailedContent?: string
  entities: string[]
  category: string
  importance: number
  occurrenceCount: number
  observedAt?: number
  status: string
  reviewStatus: string
  matchScore?: number
  matchLevel?: string
  createdAt: string
  createdAtMs: number
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
  screenshotSource?: string | null
  url?: string | null
  webpageTitle?: string | null
  isSensitive: boolean
  piiScrubbed: boolean
  bestText?: string | null
  summary?: string | null
  linkedTimelineId?: string | null
  linkedTimelineSummary?: string | null
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
  title: string
  docType: string
  status: 'draft' | 'auto_generated' | 'pending_review' | 'enabled' | 'disabled'
  tags: string[]
  applicableTasks: Array<'qa' | 'creation' | 'work_tip'>
  sourceMemoryIds: string[]
  sourceCaptureIds: string[]
  sourceEpisodeIds: string[]
  linkedKnowledgeIds: string[]
  sections: TemplateSection[]
  stylePhrases: string[]
  replacementRules: ReplacementRule[]
  summary?: string
  fullContent?: string
  sourceUrl?: string
  diagramCode?: string
  imageAssets?: string[]
  promptHint?: string
  usageCount: number
  reviewStatus: string
  matchScore?: number
  matchLevel?: string
  createdAt?: string
  createdAtMs?: number
  updatedAt?: string
}

export interface WritingStyleConfig {
  preferredPhrases: string[]
  replacementRules: ReplacementRule[]
  styleSamples: string[]
  applyToCreation: boolean
  applyToTemplateEditing: boolean
}

export interface LinkedKnowledgeSummary {
  id: string
  summary: string
}

export interface SopCandidate {
  id: string
  sourceCaptureId: string
  sourceTimelineId?: string
  sourceTitle?: string
  triggerKeywords: string[]
  confidence: 'low' | 'medium' | 'high'
  extractedProblem?: string
  detailedContent?: string
  steps: string[]
  linkedKnowledgeIds: string[]
  linkedKnowledgeSummaries: LinkedKnowledgeSummary[]
  status: 'candidate' | 'confirmed' | 'auto_created' | 'ignored'
  createdAt?: string
  createdAtMs?: number
  updatedAt?: string
  updatedAtMs?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 监控模块
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitorOverview {
  db_size_bytes: number
  capture_total_count: number
  service_health: ServiceHealth
  token_usage: {
    total_period:  number
    total_today:   number
    by_model:      { model: string; total: number; prompt: number; completion: number; calls: number }[]
    by_caller:     { caller: string; total: number; calls: number }[]
    trend:         { ts: number; date: string; tokens: number; calls: number }[]
    trend_by_model:{ model: string; total: number; calls: number; trend: { ts: number; date: string; tokens: number; calls: number }[] }[]
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
    extracting: { id: number; ts: number; app_name: string; win_title: string; group_started_at_ms: number }[]
    last_extraction_at_ms: number | null
    extractor_status: 'running' | 'waiting' | 'idle' | 'stalled'
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

export interface ServiceHealth {
  status: 'ok' | 'degraded' | 'down' | string
  mode: string
  full_dispatch_ready: boolean
  background_processor_running: boolean
  critical_checks_passed: boolean
  embedding_ok: boolean
  issues: string[]
  updated_at_ms: number | null
}

export interface ExtractionLive {
  extractor_status: 'running' | 'waiting' | 'idle' | 'stalled'
  service_health?: ServiceHealth
  extracting:       { id: number; ts: number; app_name: string; win_title: string; group_started_at_ms: number }[]
  last_extraction_at_ms: number | null
  pending_extraction_count: number
  recent:           { id: number; ts: number; summary: string; category: string; importance: number; app_name: string; win_title: string }[]
  server_now_ms:    number
}

// ─── 提炼流水线 DAG ───────────────────────────────────────────────────────────

export type DagStageKey = 'capture' | 'timeline' | 'knowledge' | 'sop' | 'document'

export interface DagItem {
  kind:           string  // 'capture' | 'timeline' | 'bake_knowledge' | 'bake_sop' | 'document'
  id:             number
  ts:             number
  title:          string
  subtitle:       string | null
  started_at_ms:  number | null
}

export interface DagStage {
  key:               DagStageKey
  label:             string
  in_progress_label: string
  pending_label:     string
  in_progress_count: number
  pending_count:     number
  completed_today:   number
  in_progress_items: DagItem[]
  pending_items:     DagItem[]
}

export interface PipelineDagResponse {
  server_now_ms:     number
  extractor_status:  'running' | 'waiting' | 'idle' | 'stalled'
  /// 兼容旧 UI：第一个 running bake run（如有）
  running_bake_run:  { id: number; trigger_reason: string; started_at: number; candidate_count: number } | null
  /// 所有正在运行的 bake run 列表
  running_bake_runs: { id: number; trigger_reason: string; started_at: number; candidate_count: number }[]
  /// bake watermark 距离最老一条排队候选的 ms 间隔；0 表示已追上
  bake_watermark_lag_ms: number
  stages:            DagStage[]
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
  | 'google' | 'kling'

export type ModelCategory = 'llm' | 'embedding' | 'ocr' | 'asr' | 'vlm' | 'image' | 'inference_engine'
export type ModelStatus = 'not_installed' | 'downloading' | 'installed' | 'active' | 'loading' | 'error'

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
  error?:           string
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

// ─────────────────────────────────────────────────────────────────────────────
// 隐私保护模块
// ─────────────────────────────────────────────────────────────────────────────

export interface AppBlacklistRecord {
  id: number
  bundle_id: string
  app_name: string
  enabled: boolean
  reason: string | null
  created_at: string
  updated_at: string
  week_blocked?: number
}

export interface PrivacyFilterRecord {
  id: number
  filter_type: "chat" | "pii" | "policy"
  filter_name: string
  enabled: boolean
  config_json: string | null
  updated_at: string
  week_blocked?: number
}
