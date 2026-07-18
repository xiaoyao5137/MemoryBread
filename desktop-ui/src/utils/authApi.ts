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
  UpsertCloudDeviceRequest,
} from '../types'

export const ACHIEVEMENTS_CHANGED_KEY = 'memorybread.achievements.changed'

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
): Promise<AuthSession> {
  const response = await fetch(`${adminApiBaseUrl}/v1/auth/${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      username: mode === 'register' ? username?.trim() || undefined : undefined,
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
    headers: { 'Content-Type': 'application/json' },
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
): Promise<AuthSession> {
  const response = await fetch(`${adminApiBaseUrl}/v1/auth/phone/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, username: username?.trim() || undefined }),
  }).catch((error) => {
    throw normalizeAuthFetchError(error, adminApiBaseUrl)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(authErrorMessage(payload, `phone auth failed: ${response.status}`))
  }
  return payload.data as AuthSession
}

export async function fetchCurrentUser(adminApiBaseUrl: string, token: string): Promise<CloudUser> {
  const response = await fetch(`${adminApiBaseUrl}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
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
    headers: { Authorization: `Bearer ${token}` },
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
    headers: { Authorization: `Bearer ${token}` },
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
    headers: { Authorization: `Bearer ${token}` },
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
    headers: { Authorization: `Bearer ${token}` },
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
    headers: { Authorization: `Bearer ${token}` },
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
    headers: { Authorization: `Bearer ${token}` },
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

export async function equipAchievementBadge(
  adminApiBaseUrl: string,
  token: string,
  surface: AchievementSurface,
  badgeId: string | null,
): Promise<AchievementProfile> {
  const response = await fetch(`${adminApiBaseUrl}/v1/achievements/equipped`, {
    method: 'PUT',
    headers: {
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
  try {
    localStorage.setItem(ACHIEVEMENTS_CHANGED_KEY, String(Date.now()))
  } catch {
    // 同窗口状态由返回值更新；跨窗口广播属于尽力通知。
  }
  const data = (payload?.data || {}) as Partial<AchievementProfile>
  return {
    badges: Array.isArray(data.badges) ? data.badges : [],
    equipped: data.equipped || {},
  }
}
