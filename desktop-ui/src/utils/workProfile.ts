export interface WorkProfileDay {
  date: string
  minutes: number
  capture_count: number
}

export interface WorkProfileApp {
  name: string
  minutes: number
  capture_count: number
}

export type InferredWorkMood = 'energized' | 'focused' | 'steady' | 'tired' | 'overloaded'

export interface WorkAchievementMetrics {
  longest_work_session_minutes: number
  max_overnight_work_minutes: number
  interruption_gap_minutes: number
  overnight_start_hour: number
  overnight_end_hour: number
}

export interface WorkProfileSummary {
  range_start: number
  range_end: number
  idle_gap_cap_minutes: number
  total_minutes: number
  active_days: number
  current_streak: number
  longest_streak: number
  longest_day_minutes: number
  achievement_metrics?: WorkAchievementMetrics
  today: {
    date: string
    total_minutes: number
    capture_count: number
    first_capture_at: number | null
    last_capture_at: number | null
    apps: WorkProfileApp[]
    mood: {
      inferred: boolean
      mood: InferredWorkMood | null
      expression_count: number
      source_apps: string[]
    }
  }
  days: WorkProfileDay[]
}

const padDatePart = (value: number) => String(value).padStart(2, '0')

export const toLocalDateKey = (date: Date) => (
  `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`
)

export const getWorkProfileRange = (now = new Date()) => {
  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)

  const start = new Date(end)
  start.setDate(start.getDate() - 371)

  return {
    from: start.getTime(),
    to: end.getTime(),
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
  }
}

export interface WorkProfileRange {
  from: number
  to: number
  timezoneOffsetMinutes: number
  includeAchievementMetrics?: boolean
}

const normalizeWorkProfile = (payload: Partial<WorkProfileSummary>): WorkProfileSummary => {
  if (
    !payload.today
    || !Array.isArray(payload.days)
    || !Array.isArray(payload.today.apps)
  ) {
    throw new Error('工作画像数据格式不完整')
  }

  // 桌面界面可能先于常驻核心进程完成热更新。旧核心尚未返回 mood 时，
  // 只将心情降级为空态，仍然保留有效的工作时长、分布和热力图数据。
  const receivedMood = payload.today.mood
  const mood = receivedMood && Array.isArray(receivedMood.source_apps)
    ? {
        inferred: receivedMood.inferred === true,
        mood: receivedMood.mood && [
          'energized',
          'focused',
          'steady',
          'tired',
          'overloaded',
        ].includes(receivedMood.mood)
          ? receivedMood.mood
          : null,
        expression_count: Number.isFinite(receivedMood.expression_count)
          ? receivedMood.expression_count
          : 0,
        source_apps: receivedMood.source_apps.filter(
          (app): app is string => typeof app === 'string',
        ),
      }
    : {
        inferred: false,
        mood: null,
        expression_count: 0,
        source_apps: [],
      }

  const receivedMetrics = payload.achievement_metrics
  const achievementMetrics = receivedMetrics
    && Number.isFinite(receivedMetrics.longest_work_session_minutes)
    && Number.isFinite(receivedMetrics.max_overnight_work_minutes)
    ? receivedMetrics
    : undefined

  return {
    ...payload,
    achievement_metrics: achievementMetrics,
    today: {
      ...payload.today,
      mood,
    },
  } as WorkProfileSummary
}

export const fetchWorkProfileRange = async (
  apiBaseUrl: string,
  range: WorkProfileRange,
  signal?: AbortSignal,
): Promise<WorkProfileSummary> => {
  const url = new URL(`${apiBaseUrl.replace(/\/$/, '')}/api/work-profile`)
  url.searchParams.set('from', String(range.from))
  url.searchParams.set('to', String(range.to))
  url.searchParams.set('timezone_offset_minutes', String(range.timezoneOffsetMinutes))
  if (range.includeAchievementMetrics) {
    url.searchParams.set('include_achievement_metrics', 'true')
  }

  const response = await fetch(url.toString(), { signal })
  if (!response.ok) {
    throw new Error(`工作画像读取失败 (${response.status})`)
  }
  return normalizeWorkProfile(await response.json() as Partial<WorkProfileSummary>)
}

export const fetchWorkProfile = async (
  apiBaseUrl: string,
  signal?: AbortSignal,
): Promise<WorkProfileSummary> => {
  return fetchWorkProfileRange(apiBaseUrl, getWorkProfileRange(), signal)
}
