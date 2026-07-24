import { serviceEnvironmentHeaders, useAppStore } from '../store/useAppStore'
import {
  fetchWorkProfile,
  getWorkProfileRange,
  toLocalDateKey,
  type InferredWorkMood,
  type WorkProfileApp,
  type WorkProfileDay,
  type WorkProfileSummary,
} from './workProfile'

export const WORK_PROFILE_SYNCED_EVENT = 'memorybread:work-profile-synced'

const SOURCE_DEVICE_ID_KEY = 'memory-bread_work_profile_source_device_id'
const SYNC_REVISION_KEY = 'memory-bread_work_profile_sync_revision'
const CACHE_KEY_PREFIX = 'memory-bread_work_profile_cloud_cache'
const UPLOADED_DAYS_KEY_PREFIX = 'memory-bread_work_profile_uploaded_days'
const DAY_MS = 86_400_000

interface CloudWorkProfileDay {
  date: string
  minutes: number
  capture_count: number
  first_capture_at: number | null
  last_capture_at: number | null
  apps: WorkProfileApp[]
  mood: WorkProfileSummary['today']['mood'] | null
}

interface CloudWorkProfile {
  range_start_date: string
  range_end_date: string
  synced_at: string
  days: CloudWorkProfileDay[]
}

interface SyncWorkProfileOptions {
  apiBaseUrl: string
  adminApiBaseUrl: string
  authToken: string
  userId: string
}

interface SyncWorkProfileEventDetail {
  userId: string
  profile: WorkProfileSummary
}

const activeSyncs = new Map<string, Promise<WorkProfileSummary>>()

const randomUuid = () => {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const getOrCreateSourceDeviceId = () => {
  const existing = localStorage.getItem(SOURCE_DEVICE_ID_KEY)
  if (existing) return existing
  const created = randomUuid()
  localStorage.setItem(SOURCE_DEVICE_ID_KEY, created)
  return created
}

const nextSyncRevision = () => {
  const previous = Number(localStorage.getItem(SYNC_REVISION_KEY) || 0)
  const next = Math.max(Date.now(), Number.isSafeInteger(previous) ? previous + 1 : 1)
  localStorage.setItem(SYNC_REVISION_KEY, String(next))
  return next
}

const cacheKey = (userId: string) => (
  `${CACHE_KEY_PREFIX}:${useAppStore.getState().serviceEnvironment}:${userId}`
)

export const loadCachedWorkProfile = (userId: string): WorkProfileSummary | null => {
  try {
    const raw = localStorage.getItem(cacheKey(userId))
    if (!raw) return null
    const profile = JSON.parse(raw) as WorkProfileSummary
    if (!profile.today || !Array.isArray(profile.days) || !Array.isArray(profile.today.apps)) {
      return null
    }
    return profile
  } catch {
    return null
  }
}

const cacheWorkProfile = (userId: string, profile: WorkProfileSummary) => {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(profile))
  } catch {
    // 缓存只用于离线展示；写入失败不影响本机数据和云端同步。
  }
}

const uploadedDaysKey = (userId: string, sourceDeviceId: string) => (
  `${UPLOADED_DAYS_KEY_PREFIX}:${useAppStore.getState().serviceEnvironment}:${userId}:${sourceDeviceId}`
)

const incrementalSyncRequest = (
  userId: string,
  request: ReturnType<typeof buildSyncWorkProfileRequest>,
) => {
  const fingerprints = Object.fromEntries(
    request.days.map(day => [day.date, JSON.stringify(day)]),
  )
  let uploaded: Record<string, string> = {}
  try {
    const parsed = JSON.parse(
      localStorage.getItem(uploadedDaysKey(userId, request.source_device_id)) || '{}',
    ) as unknown
    uploaded = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {}
  } catch {
    uploaded = {}
  }
  return {
    request: {
      ...request,
      days: request.days.filter(day => uploaded[day.date] !== fingerprints[day.date]),
    },
    fingerprints,
  }
}

const rememberUploadedDays = (
  userId: string,
  sourceDeviceId: string,
  fingerprints: Record<string, string>,
) => {
  try {
    localStorage.setItem(
      uploadedDaysKey(userId, sourceDeviceId),
      JSON.stringify(fingerprints),
    )
  } catch {
    // 下次同步会安全地重传并由服务端唯一键判重。
  }
}

const rangeDateKeys = (profile?: WorkProfileSummary) => {
  const fallback = getWorkProfileRange()
  const from = profile && Number.isFinite(profile.range_start)
    ? profile.range_start
    : fallback.from
  const to = profile && Number.isFinite(profile.range_end) && profile.range_end > from
    ? profile.range_end
    : fallback.to
  return {
    from,
    to,
    startDate: toLocalDateKey(new Date(from)),
    endDate: toLocalDateKey(new Date(to - 1)),
  }
}

const dateIndex = (date: string) => {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return Number.NaN
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS)
}

const calculateStreaks = (days: WorkProfileDay[], today: string) => {
  const indexes = days
    .filter(day => day.minutes > 0 || day.capture_count > 0)
    .map(day => dateIndex(day.date))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  let longest = 0
  let running = 0
  let previous: number | null = null
  for (const index of indexes) {
    running = previous !== null && index === previous + 1 ? running + 1 : 1
    longest = Math.max(longest, running)
    previous = index
  }
  return {
    current: previous === dateIndex(today) ? running : 0,
    longest,
  }
}

const emptyMood = (): WorkProfileSummary['today']['mood'] => ({
  inferred: false,
  mood: null,
  expression_count: 0,
  source_apps: [],
})

const normalizeMood = (
  mood: WorkProfileSummary['today']['mood'] | null | undefined,
): WorkProfileSummary['today']['mood'] => {
  const validMoods: InferredWorkMood[] = [
    'energized',
    'focused',
    'steady',
    'tired',
    'overloaded',
  ]
  if (!mood || !Array.isArray(mood.source_apps)) return emptyMood()
  return {
    inferred: mood.inferred === true,
    mood: validMoods.includes(mood.mood as InferredWorkMood)
      ? mood.mood as InferredWorkMood
      : null,
    expression_count: Number.isFinite(mood.expression_count)
      ? Math.max(0, Math.round(mood.expression_count))
      : 0,
    source_apps: mood.source_apps.filter((app): app is string => typeof app === 'string'),
  }
}

const mergeApps = (left: WorkProfileApp[], right: WorkProfileApp[]) => {
  const apps = new Map<string, WorkProfileApp>()
  for (const app of [...left, ...right]) {
    if (!app || typeof app.name !== 'string') continue
    const key = app.name.trim().toLocaleLowerCase()
    if (!key) continue
    const current = apps.get(key)
    const normalized = {
      name: app.name.trim(),
      minutes: Math.max(0, Math.round(Number(app.minutes) || 0)),
      capture_count: Math.max(0, Math.round(Number(app.capture_count) || 0)),
    }
    if (!current) {
      apps.set(key, normalized)
      continue
    }
    current.minutes = Math.max(current.minutes, normalized.minutes)
    current.capture_count = Math.max(current.capture_count, normalized.capture_count)
  }
  return Array.from(apps.values())
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))
    .slice(0, 12)
}

const preferMood = (
  left: WorkProfileSummary['today']['mood'],
  right: WorkProfileSummary['today']['mood'],
) => {
  const normalizedLeft = normalizeMood(left)
  const normalizedRight = normalizeMood(right)
  if (normalizedRight.expression_count > normalizedLeft.expression_count) return normalizedRight
  if (normalizedRight.expression_count < normalizedLeft.expression_count) return normalizedLeft
  return normalizedRight.inferred ? normalizedRight : normalizedLeft
}

const buildSummary = (
  days: WorkProfileDay[],
  todayDetails: Omit<WorkProfileSummary['today'], 'total_minutes' | 'capture_count'>,
  rangeStart: number,
  rangeEnd: number,
  achievementMetrics?: WorkProfileSummary['achievement_metrics'],
): WorkProfileSummary => {
  const orderedDays = days
    .filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date))
    .sort((left, right) => left.date.localeCompare(right.date))
  const todayDay = orderedDays.find(day => day.date === todayDetails.date)
  const streaks = calculateStreaks(orderedDays, todayDetails.date)
  return {
    range_start: rangeStart,
    range_end: rangeEnd,
    idle_gap_cap_minutes: 5,
    total_minutes: orderedDays.reduce((sum, day) => sum + day.minutes, 0),
    active_days: orderedDays.filter(day => day.minutes > 0 || day.capture_count > 0).length,
    current_streak: streaks.current,
    longest_streak: streaks.longest,
    longest_day_minutes: orderedDays.reduce((max, day) => Math.max(max, day.minutes), 0),
    achievement_metrics: achievementMetrics,
    today: {
      ...todayDetails,
      total_minutes: todayDay?.minutes ?? 0,
      capture_count: todayDay?.capture_count ?? 0,
    },
    days: orderedDays,
  }
}

const cloudToWorkProfile = (cloud: CloudWorkProfile): WorkProfileSummary => {
  if (!cloud || !Array.isArray(cloud.days)) throw new Error('云端工作画像数据格式不完整')
  const range = getWorkProfileRange()
  const todayDate = toLocalDateKey(new Date())
  const normalizedDays = cloud.days.map(day => ({
    date: day.date,
    minutes: Math.max(0, Math.round(Number(day.minutes) || 0)),
    capture_count: Math.max(0, Math.round(Number(day.capture_count) || 0)),
  }))
  const today = cloud.days.find(day => day.date === todayDate)
  return buildSummary(normalizedDays, {
    date: todayDate,
    first_capture_at: Number.isFinite(today?.first_capture_at) ? today!.first_capture_at : null,
    last_capture_at: Number.isFinite(today?.last_capture_at) ? today!.last_capture_at : null,
    apps: Array.isArray(today?.apps) ? mergeApps([], today!.apps) : [],
    mood: normalizeMood(today?.mood),
  }, range.from, range.to)
}

export const mergeWorkProfiles = (
  local: WorkProfileSummary,
  cloud: WorkProfileSummary,
): WorkProfileSummary => {
  const days = new Map<string, WorkProfileDay>()
  for (const day of [...cloud.days, ...local.days]) {
    const current = days.get(day.date)
    if (
      !current
      || day.minutes > current.minutes
      || (day.minutes === current.minutes && day.capture_count >= current.capture_count)
    ) {
      days.set(day.date, { ...day })
    }
  }
  const todayDate = toLocalDateKey(new Date())
  const localTodayDay = local.days.find(day => day.date === todayDate)
  const cloudTodayDay = cloud.days.find(day => day.date === todayDate)
  const preferLocalToday = Boolean(localTodayDay) && (
    !cloudTodayDay
    || localTodayDay!.minutes > cloudTodayDay.minutes
    || (
      localTodayDay!.minutes === cloudTodayDay.minutes
      && localTodayDay!.capture_count >= cloudTodayDay.capture_count
    )
  )
  const todayDetails = preferLocalToday ? local.today : cloud.today
  return buildSummary(Array.from(days.values()), {
    date: todayDate,
    first_capture_at: todayDetails.first_capture_at,
    last_capture_at: todayDetails.last_capture_at,
    apps: todayDetails.apps,
    mood: preferMood(cloud.today.mood, local.today.mood),
  }, Math.min(local.range_start, cloud.range_start), Math.max(local.range_end, cloud.range_end), local.achievement_metrics)
}

export const buildSyncWorkProfileRequest = (profile: WorkProfileSummary) => {
  const range = rangeDateKeys(profile)
  const days = profile.days.map(day => {
    const isToday = day.date === profile.today.date
    return {
      date: day.date,
      minutes: Math.max(0, Math.round(day.minutes)),
      capture_count: Math.max(0, Math.round(day.capture_count)),
      first_capture_at: isToday ? profile.today.first_capture_at : undefined,
      last_capture_at: isToday ? profile.today.last_capture_at : undefined,
      apps: isToday ? profile.today.apps : undefined,
      mood: isToday ? profile.today.mood : undefined,
    }
  })
  if (
    !days.some(day => day.date === profile.today.date)
    && (profile.today.capture_count > 0 || profile.today.mood.inferred)
  ) {
    days.push({
      date: profile.today.date,
      minutes: Math.max(0, Math.round(profile.today.total_minutes)),
      capture_count: Math.max(0, Math.round(profile.today.capture_count)),
      first_capture_at: profile.today.first_capture_at ?? undefined,
      last_capture_at: profile.today.last_capture_at ?? undefined,
      apps: profile.today.apps,
      mood: profile.today.mood,
    })
  }
  return {
    source_device_id: getOrCreateSourceDeviceId(),
    sync_revision: nextSyncRevision(),
    range_start_date: range.startDate,
    range_end_date: range.endDate,
    timezone_offset_minutes: -new Date().getTimezoneOffset(),
    days,
  }
}

const requestCloudProfile = async (
  adminApiBaseUrl: string,
  authToken: string,
  userId: string,
  local?: WorkProfileSummary,
) => {
  const baseUrl = adminApiBaseUrl.replace(/\/$/, '')
  const range = rangeDateKeys(local)
  const pending = local
    ? incrementalSyncRequest(userId, buildSyncWorkProfileRequest(local))
    : null
  const response = local
    ? await fetch(`${baseUrl}/v1/work-profile`, {
        method: 'PUT',
        headers: {
          ...serviceEnvironmentHeaders(),
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pending!.request),
      })
    : await fetch(`${baseUrl}/v1/work-profile?from=${range.startDate}&to=${range.endDate}`, {
        headers: {
          ...serviceEnvironmentHeaders(),
          Authorization: `Bearer ${authToken}`,
        },
      })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error?.message || `work profile sync failed: ${response.status}`)
  }
  const cloud = local ? payload?.data?.profile : payload?.data
  if (pending && payload?.data?.applied === true) {
    rememberUploadedDays(
      userId,
      pending.request.source_device_id,
      pending.fingerprints,
    )
  }
  return cloudToWorkProfile(cloud as CloudWorkProfile)
}

const notifyWorkProfileSynced = (userId: string, profile: WorkProfileSummary) => {
  window.dispatchEvent(new CustomEvent<SyncWorkProfileEventDetail>(WORK_PROFILE_SYNCED_EVENT, {
    detail: { userId, profile },
  }))
}

const runSync = async (options: SyncWorkProfileOptions): Promise<WorkProfileSummary> => {
  const cached = loadCachedWorkProfile(options.userId)
  let local: WorkProfileSummary | null = null
  let localError: unknown = null
  try {
    local = await fetchWorkProfile(options.apiBaseUrl)
  } catch (error) {
    localError = error
  }

  try {
    const cloud = await requestCloudProfile(
      options.adminApiBaseUrl,
      options.authToken,
      options.userId,
      local ?? undefined,
    )
    const profile = local ? mergeWorkProfiles(local, cloud) : cloud
    cacheWorkProfile(options.userId, profile)
    notifyWorkProfileSynced(options.userId, profile)
    return profile
  } catch (cloudError) {
    if (local) {
      const profile = cached ? mergeWorkProfiles(local, cached) : local
      notifyWorkProfileSynced(options.userId, profile)
      return profile
    }
    if (cached) {
      notifyWorkProfileSynced(options.userId, cached)
      return cached
    }
    throw localError ?? cloudError
  }
}

export const synchronizeWorkProfile = (
  options: SyncWorkProfileOptions,
): Promise<WorkProfileSummary> => {
  const key = [
    useAppStore.getState().serviceEnvironment,
    options.userId,
    options.apiBaseUrl,
    options.adminApiBaseUrl,
  ].join(':')
  const active = activeSyncs.get(key)
  if (active) return active
  const sync = runSync(options).finally(() => activeSyncs.delete(key))
  activeSyncs.set(key, sync)
  return sync
}

export type { SyncWorkProfileEventDetail }
