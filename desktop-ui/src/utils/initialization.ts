export type InitializationStageStatus =
  | 'pending'
  | 'running'
  | 'skipped'
  | 'succeeded'
  | 'failed'

export interface InitializationStage {
  id: string
  label: string
  status: InitializationStageStatus
  progress: number
  detail: string
  error_code?: string | null
  duration_ms?: number | null
}

export interface InitializationCheck {
  id: string
  status: 'passed' | 'failed'
  duration_ms?: number | null
  error_code?: string | null
}

export interface InitializationStatus {
  schema_version: 'initialization.v1' | string
  run_id?: string | null
  mode: 'normal' | 'sandbox'
  state: 'not_started' | 'running' | 'completed' | 'failed' | 'interrupted' | string
  progress: number
  current_stage: string
  message: string
  suggestion?: string | null
  error_code?: string | null
  stages: InitializationStage[]
  quality_gate: {
    passed: boolean
    checks: InitializationCheck[]
  }
  smoke_tests: InitializationCheck[]
  can_retry: boolean
  can_report: boolean
  test_mode_enabled: boolean
  sandbox_isolation?: {
    enforced: boolean
    cold_start: boolean
    normal_runtime_hidden: boolean
    normal_models_hidden: boolean
    normal_database_hidden: boolean
  }
  started_at?: string | null
  finished_at?: string | null
}

interface InitializationEnvelope {
  status: 'ok' | 'error'
  initialization?: InitializationStatus
  error_code?: string
  message?: string
}

const SIDECAR = 'http://127.0.0.1:7071'

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.status === 'error') {
    const initializationRouteMissing = response.status === 404
    const error = new Error(
      initializationRouteMissing
        ? '本地初始化服务版本较旧，正在尝试自动加载最新服务；若未恢复，请重新启动记忆面包。'
        : data.message || `本地初始化服务返回 HTTP ${response.status}`,
    ) as Error & {
      code?: string
    }
    error.code = initializationRouteMissing
      ? 'INITIALIZATION_API_UNAVAILABLE'
      : data.error_code
    throw error
  }
  return data
}

export async function fetchInitializationStatus(): Promise<InitializationStatus> {
  const response = await fetch(`${SIDECAR}/api/initialization/status`)
  const data = await readJson(response) as InitializationEnvelope
  if (!data.initialization) throw new Error('本地初始化服务返回了无效状态')
  return data.initialization
}

export async function startInitialization(mode: 'normal' | 'sandbox'): Promise<InitializationStatus> {
  const response = await fetch(`${SIDECAR}/api/initialization/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  const data = await readJson(response) as InitializationEnvelope
  if (!data.initialization) throw new Error('本地初始化服务未返回任务状态')
  return data.initialization
}

export async function enableInitializationTestMode(): Promise<InitializationStatus> {
  const response = await fetch(`${SIDECAR}/api/initialization/test-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: 'ENABLE_INITIALIZATION_TEST_MODE' }),
  })
  const data = await readJson(response) as InitializationEnvelope
  if (!data.initialization) throw new Error('本地初始化服务未返回测试模式状态')
  return data.initialization
}

export async function disableInitializationTestMode(): Promise<InitializationStatus> {
  const response = await fetch(`${SIDECAR}/api/initialization/test-mode`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: 'DISABLE_INITIALIZATION_TEST_MODE' }),
  })
  const data = await readJson(response) as InitializationEnvelope
  if (!data.initialization) throw new Error('本地初始化服务未返回正式环境状态')
  return data.initialization
}

export async function fetchInitializationReport(): Promise<Record<string, unknown>> {
  const response = await fetch(`${SIDECAR}/api/initialization/report-bundle`)
  const data = await readJson(response)
  if (!data.report || typeof data.report !== 'object') {
    throw new Error('本地初始化服务未返回可上报信息')
  }
  return data.report
}

export function initializationIsReady(status: InitializationStatus): boolean {
  return status.mode === 'normal'
    && status.state === 'completed'
    && status.quality_gate.passed
    && !status.test_mode_enabled
}
