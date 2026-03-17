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

export type WindowMode = 'buddy' | 'rag' | 'knowledge' | 'models' | 'settings' | 'debug' | 'tasks' | 'monitor'

// ─────────────────────────────────────────────────────────────────────────────
// 监控模块
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitorOverview {
  token_usage: {
    total_period:  number
    total_today:   number
    by_model:      { model: string; total: number; calls: number }[]
    by_caller:     { caller: string; total: number; calls: number }[]
    trend:         { date: string; tokens: number; calls: number }[]
  }
  capture_flow: {
    today_count:    number
    period_count:   number
    knowledge_rate: number
    by_hour:        { hour: number; count: number }[]
    by_app:         { app: string; count: number }[]
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
// 系统资源监控
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemResources {
  cpu_trend:    { ts: number; value: number }[]
  mem_trend:    { ts: number; value: number }[]
  disk_trend:   { ts: number; read_mb: number; write_mb: number }[]
  model_events: {
    ts:            number
    event_type:    string
    model_type:    string
    model_name:    string
    duration_ms:   number | null
    memory_mb:     number | null
    mem_before_mb: number | null
    mem_after_mb:  number | null
    error_msg:     string | null
  }[]
  latest: {
    cpu_total:      number
    cpu_process:    number
    mem_total_mb:   number
    mem_used_mb:    number
    mem_percent:    number
    mem_process_mb: number
  } | null
}
