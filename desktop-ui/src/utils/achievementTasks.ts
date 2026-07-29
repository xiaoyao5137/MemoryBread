import type { AchievementAward, RewardTask } from '../types'
import { claimRewardTask, fetchRewardTasks, notifyAchievementsChanged } from './authApi'
import { fetchWorkProfileRange, type WorkAchievementMetrics } from './workProfile'

const METRIC_FIELDS: Partial<Record<string, keyof WorkAchievementMetrics>> = {
  longest_work_session_minutes: 'longest_work_session_minutes',
  max_overnight_work_minutes: 'max_overnight_work_minutes',
}

const isoWeekKey = (date: Date) => {
  const normalized = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const weekday = normalized.getUTCDay() || 7
  normalized.setUTCDate(normalized.getUTCDate() + 4 - weekday)
  const weekYear = normalized.getUTCFullYear()
  const yearStart = new Date(Date.UTC(weekYear, 0, 1))
  const week = Math.ceil((((normalized.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}

export const getCurrentWeeklyRewardPeriod = (now = new Date()) => {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return {
    from: start.getTime(),
    to: end.getTime(),
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
    includeAchievementMetrics: true,
    periodKey: isoWeekKey(start),
  }
}

const observedValueForTask = (
  task: RewardTask,
  metrics: WorkAchievementMetrics,
): number | null => {
  const metricField = METRIC_FIELDS[task.metric_key]
  if (!metricField || task.period !== 'weekly' || task.metric_unit !== 'minute') return null
  const observedValue = metrics[metricField]
  return Number.isFinite(observedValue) ? observedValue : null
}

interface SyncAchievementTasksOptions {
  adminApiBaseUrl: string
  apiBaseUrl: string
  authToken: string
  now?: Date
  signal?: AbortSignal
}

/**
 * 用本地工作聚合自动领取已达标卡片。
 *
 * 只向账户服务提交任务 ID、周期和分钟数，不提交采集明细或工作内容。
 */
export const syncEligibleAchievementTasks = async ({
  adminApiBaseUrl,
  apiBaseUrl,
  authToken,
  now = new Date(),
  signal,
}: SyncAchievementTasksOptions): Promise<AchievementAward[]> => {
  const period = getCurrentWeeklyRewardPeriod(now)
  const [tasks, workProfile] = await Promise.all([
    fetchRewardTasks(adminApiBaseUrl, authToken, signal),
    fetchWorkProfileRange(apiBaseUrl, period, signal),
  ])
  const metrics = workProfile.achievement_metrics
  if (!metrics) return []

  // 每轮检测使用新的幂等键，避免服务端重放历史成功响应时再次触发庆祝弹窗。
  const syncAttemptId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  const awardsByBadgeId = new Map<string, AchievementAward>()
  for (const task of tasks) {
    const observedValue = observedValueForTask(task, metrics)
    const threshold = Number(task.threshold)
    if (observedValue == null || !Number.isFinite(threshold) || observedValue < threshold) continue

    const result = await claimRewardTask(
      adminApiBaseUrl,
      authToken,
      task.id,
      period.periodKey,
      observedValue,
      `auto_${syncAttemptId}_${task.id}`.slice(0, 80),
      signal,
    )
    if (!result) continue

    const previous = awardsByBadgeId.get(result.badge.id)
    awardsByBadgeId.set(result.badge.id, {
      badge: result.badge,
      badge_quantity: (previous?.badge_quantity ?? 0) + result.badge_quantity,
      total_badge_quantity: Math.max(
        previous?.total_badge_quantity ?? 0,
        result.total_badge_quantity,
      ),
    })
  }
  const awards = Array.from(awardsByBadgeId.values())
  if (awards.length > 0) notifyAchievementsChanged()
  return awards
}
