import type {
  AchievementProfile,
  AchievementSurface,
  AuthSession,
  CloudBalance,
  CloudDevice,
  CloudSnapshot,
  CloudSubscription,
  CloudUser,
  CompleteCloudSnapshotRequest,
  RewardTask,
  TaskClaimResult,
  UpsertCloudDeviceRequest,
} from '../types'
import { serviceEnvironmentHeaders } from '../store/useAppStore'

export const ACHIEVEMENTS_CHANGED_KEY = 'memorybread.achievements.changed'

export const notifyAchievementsChanged = (): void => {
  try {
    localStorage.setItem(ACHIEVEMENTS_CHANGED_KEY, String(Date.now()))
  } catch {
    // 同窗口事件仍可刷新；跨窗口广播属于尽力通知。
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ACHIEVEMENTS_CHANGED_KEY))
  }
}

function normalizeAuthFetchError(error: unknown, adminApiBaseUrl: string): Error {
  if (error instanceof TypeError) {
    return new Error(`账户服务暂时无法连接，请稍后重试或检查账户连接地址：${adminApiBaseUrl}`)
  }
  if (error instanceof Error) return error
  return new Error('登录失败，请检查网络或账户信息')
}

function authErrorMessage(
  payload: { error?: { code?: string; message?: string } } | null,
  fallback: string,
): string {
  if (payload?.error?.code === 'DATABASE_NOT_CONFIGURED') {
    return '账户服务暂时未就绪，请稍后重试。'
  }
  return payload?.error?.message || fallback
}

export async function authenticateWithPassword(
  adminApiBaseUrl: string,
  mode: 'login' | 'register',
  email: string,
  password: string,
  username?: string,
  nickname?: string,
  companyName?: string,
): Promise<AuthSession> {
  const response = await fetch(`${adminApiBaseUrl}/v1/auth/${mode}`, {
    method: 'POST',
    headers: { ...serviceEnvironmentHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      username: mode === 'register' ? username?.trim() || undefined : undefined,
      nickname: mode === 'register' ? nickname?.trim() || undefined : undefined,
      company_name: mode === 'register' ? companyName?.trim() || undefined : undefined,
    }),
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `auth failed: ${response.status}`))
  }
  return payload.data as AuthSession
}

export async function sendPhoneVerificationCode(
  adminApiBaseUrl: string,
  phone: string,
): Promise<{ retry_after_seconds: number; expires_in_seconds: number }> {
  const response = await fetch(`${adminApiBaseUrl}/v1/auth/phone/send-code`, {
    method: 'POST',
    headers: { ...serviceEnvironmentHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `send phone code failed: ${response.status}`))
  }
  return payload.data
}

export async function authenticateWithPhoneCode(
  adminApiBaseUrl: string,
  phone: string,
  code: string,
  username?: string,
  nickname?: string,
  companyName?: string,
): Promise<AuthSession> {
  const response = await fetch(`${adminApiBaseUrl}/v1/auth/phone/verify`, {
    method: 'POST',
    headers: { ...serviceEnvironmentHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      code,
      username: username?.trim() || undefined,
      nickname: nickname?.trim() || undefined,
      company_name: companyName?.trim() || undefined,
    }),
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `phone auth failed: ${response.status}`))
  }
  return payload.data as AuthSession
}

export async function updateUserProfile(
  adminApiBaseUrl: string,
  token: string,
  nickname: string,
  companyName?: string,
): Promise<CloudUser> {
  const response = await fetch(`${adminApiBaseUrl}/v1/auth/profile`, {
    method: 'PUT',
    headers: {
      ...serviceEnvironmentHeaders(),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      nickname: nickname.trim(),
      company_name: companyName?.trim() || undefined,
    }),
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      throw new Error('账户服务版本较旧，请更新或重启账户服务后重试。')
    }
    throw new Error(authErrorMessage(payload, `profile update failed: ${response.status}`))
  }
  return payload.data as CloudUser
}

export async function fetchCurrentUser(adminApiBaseUrl: string, token: string): Promise<CloudUser> {
  const response = await fetch(`${adminApiBaseUrl}/v1/auth/me`, {
    headers: { ...serviceEnvironmentHeaders(), Authorization: `Bearer ${token}` },
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `auth session invalid: ${response.status}`))
  }
  return payload.data as CloudUser
}

export async function fetchBillingBalance(
  adminApiBaseUrl: string,
  token: string,
): Promise<CloudBalance> {
  const response = await fetch(`${adminApiBaseUrl}/v1/billing/balance`, {
    headers: { ...serviceEnvironmentHeaders(), Authorization: `Bearer ${token}` },
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `balance fetch failed: ${response.status}`))
  }
  return payload.data as CloudBalance
}

export interface CloudConsoleSummary {
  balance?: CloudBalance
  current_subscription?: CloudSubscription | null
}

export async function fetchConsoleSummary(
  adminApiBaseUrl: string,
  token: string,
): Promise<CloudConsoleSummary> {
  const response = await fetch(`${adminApiBaseUrl}/v1/console/summary`, {
    headers: { ...serviceEnvironmentHeaders(), Authorization: `Bearer ${token}` },
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `console summary fetch failed: ${response.status}`))
  }
  return payload.data as CloudConsoleSummary
}

export async function logoutSession(adminApiBaseUrl: string, token: string): Promise<void> {
  await fetch(`${adminApiBaseUrl}/v1/auth/logout`, {
    method: 'POST',
    headers: { ...serviceEnvironmentHeaders(), Authorization: `Bearer ${token}` },
  }).catch(() => undefined)
}

export async function upsertCloudDevice(
  adminApiBaseUrl: string,
  token: string,
  device: UpsertCloudDeviceRequest,
): Promise<CloudDevice> {
  const response = await fetch(`${adminApiBaseUrl}/v1/devices`, {
    method: 'POST',
    headers: {
      ...serviceEnvironmentHeaders(),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(device),
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `device sync failed: ${response.status}`))
  }
  return payload.data as CloudDevice
}

export async function fetchCloudDevices(
  adminApiBaseUrl: string,
  token: string,
): Promise<CloudDevice[]> {
  const response = await fetch(`${adminApiBaseUrl}/v1/devices`, {
    headers: { ...serviceEnvironmentHeaders(), Authorization: `Bearer ${token}` },
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `devices fetch failed: ${response.status}`))
  }
  return payload.data as CloudDevice[]
}

export async function completeCloudSnapshotUpload(
  adminApiBaseUrl: string,
  token: string,
  snapshot: CompleteCloudSnapshotRequest,
): Promise<CloudSnapshot> {
  const response = await fetch(`${adminApiBaseUrl}/v1/snapshots`, {
    method: 'POST',
    headers: {
      ...serviceEnvironmentHeaders(),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(snapshot),
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `snapshot sync failed: ${response.status}`))
  }
  return payload.data as CloudSnapshot
}

export async function fetchCloudSnapshots(
  adminApiBaseUrl: string,
  token: string,
): Promise<CloudSnapshot[]> {
  const response = await fetch(`${adminApiBaseUrl}/v1/snapshots`, {
    headers: { ...serviceEnvironmentHeaders(), Authorization: `Bearer ${token}` },
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `snapshots fetch failed: ${response.status}`))
  }
  return payload.data as CloudSnapshot[]
}

export async function fetchAchievementProfile(
  adminApiBaseUrl: string,
  token: string,
): Promise<AchievementProfile> {
  const response = await fetch(`${adminApiBaseUrl}/v1/achievements`, {
    headers: { ...serviceEnvironmentHeaders(), Authorization: `Bearer ${token}` },
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `achievements fetch failed: ${response.status}`))
  }
  const data = (payload?.data || {}) as Partial<AchievementProfile>
  return {
    badges: Array.isArray(data.badges) ? data.badges : [],
    equipped: data.equipped || {},
  }
}

export async function fetchRewardTasks(
  adminApiBaseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<RewardTask[]> {
  const response = await fetch(`${adminApiBaseUrl}/v1/tasks`, {
    headers: { ...serviceEnvironmentHeaders(), Authorization: `Bearer ${token}` },
    signal,
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `tasks fetch failed: ${response.status}`))
  }
  return Array.isArray(payload?.data) ? payload.data as RewardTask[] : []
}

export async function claimRewardTask(
  adminApiBaseUrl: string,
  token: string,
  taskId: string,
  periodKey: string,
  observedValue: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<TaskClaimResult | null> {
  const response = await fetch(`${adminApiBaseUrl}/v1/tasks/${encodeURIComponent(taskId)}/claims`, {
    method: 'POST',
    headers: {
      ...serviceEnvironmentHeaders(),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      period_key: periodKey,
      observed_value: String(Math.max(0, Math.floor(observedValue))),
      idempotency_key: idempotencyKey,
    }),
    signal,
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    if (payload?.error?.code === 'TASK_ALREADY_CLAIMED') return null
    throw new Error(authErrorMessage(payload, `task claim failed: ${response.status}`))
  }
  return payload?.data as TaskClaimResult
}

export async function equipAchievementBadge(
  adminApiBaseUrl: string,
  token: string,
  surface: AchievementSurface,
  badgeId: string | null,
): Promise<AchievementProfile> {
  const response = await fetch(`${adminApiBaseUrl}/v1/achievements/equipped`, {
    method: 'PUT',
    headers: {
      ...serviceEnvironmentHeaders(),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ surface, badge_id: badgeId }),
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `badge equip failed: ${response.status}`))
  }
  notifyAchievementsChanged()
  const data = (payload?.data || {}) as Partial<AchievementProfile>
  return {
    badges: Array.isArray(data.badges) ? data.badges : [],
    equipped: data.equipped || {},
  }
}
