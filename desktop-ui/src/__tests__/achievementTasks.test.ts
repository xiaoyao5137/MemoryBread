import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACHIEVEMENTS_CHANGED_KEY } from '../utils/authApi'
import { getCurrentWeeklyRewardPeriod, syncEligibleAchievementTasks } from '../utils/achievementTasks'

afterEach(() => {
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const task = (id: string, taskKey: string, metricKey: string, threshold: string) => ({
  id,
  task_key: taskKey,
  title: taskKey,
  description: taskKey,
  status: 'active',
  approval_status: 'approved',
  period: 'weekly',
  metric_key: metricKey,
  threshold,
  metric_unit: 'minute',
  reward: {
    badge: {
      id: `${id}-badge`,
      badge_key: taskKey,
      name: taskKey,
      tagline: taskKey,
      description: taskKey,
      icon_key: 'moon',
      palette_key: 'midnight',
      rarity: 'common',
    },
    badge_quantity: 1,
    credit: '40.0000',
  },
})

const workProfile = (withMetrics = true) => ({
  range_start: 1,
  range_end: 2,
  idle_gap_cap_minutes: 5,
  total_minutes: 400,
  active_days: 1,
  current_streak: 1,
  longest_streak: 1,
  longest_day_minutes: 400,
  achievement_metrics: withMetrics ? {
    longest_work_session_minutes: 241,
    max_overnight_work_minutes: 360,
    interruption_gap_minutes: 5,
    overnight_start_hour: 0,
    overnight_end_hour: 6,
  } : undefined,
  today: {
    date: '2026-07-20',
    total_minutes: 400,
    capture_count: 80,
    first_capture_at: 1,
    last_capture_at: 2,
    apps: [],
    mood: {
      inferred: false,
      mood: null,
      expression_count: 0,
      source_apps: [],
    },
  },
  days: [],
})

describe('achievement task sync', () => {
  it('uses a local Monday boundary and ISO week key', () => {
    const period = getCurrentWeeklyRewardPeriod(new Date(2026, 0, 1, 12))
    const start = new Date(period.from)
    const end = new Date(period.to)

    expect(period.periodKey).toBe('2026-W01')
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getDay()])
      .toEqual([2025, 11, 29, 1])
    expect(end.getTime() - start.getTime()).toBe(7 * 86_400_000)
  })

  it('claims each supported task whose local aggregate reaches the threshold', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/tasks')) {
        return jsonResponse({ data: [
          task('overnight', 'weekly_overnight_writer', 'max_overnight_work_minutes', '360'),
          task('session', 'weekly_uninterrupted_four_hours', 'longest_work_session_minutes', '240'),
          task('unsupported', 'weekly_code_elite', 'coding_minutes', '1'),
        ] })
      }
      if (url.includes('/api/work-profile')) return jsonResponse(workProfile())
      if (url.includes('/claims')) {
        const isOvernight = url.includes('overnight')
        return jsonResponse({ data: {
          task_id: isOvernight ? 'overnight' : 'session',
          period_key: '2026-W30',
          observed_value: isOvernight ? '360' : '241',
          badge: {
            id: isOvernight ? 'overnight-badge' : 'session-badge',
            badge_key: isOvernight ? 'overnight_writer' : 'uninterrupted_four_hours',
            name: isOvernight ? '通宵赶稿' : '憋尿达人',
            tagline: '',
            description: '',
            icon_key: isOvernight ? 'moon' : 'focus',
            palette_key: isOvernight ? 'midnight' : 'honey',
            rarity: 'common',
          },
          badge_quantity: 1,
          total_badge_quantity: 1,
          credit_granted: '40.0000',
        } })
      }
      throw new Error(`unexpected request: ${url} ${init?.method || 'GET'}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const achievementsChanged = vi.fn()
    window.addEventListener(ACHIEVEMENTS_CHANGED_KEY, achievementsChanged)

    const claimed = await syncEligibleAchievementTasks({
      adminApiBaseUrl: 'http://127.0.0.1:8080',
      apiBaseUrl: 'http://127.0.0.1:7070',
      authToken: 'mbs_token',
      now: new Date(2026, 6, 21, 12),
    })

    expect(claimed.map((badge) => badge.name)).toEqual(['通宵赶稿', '憋尿达人'])
    expect(achievementsChanged).toHaveBeenCalledTimes(1)
    window.removeEventListener(ACHIEVEMENTS_CHANGED_KEY, achievementsChanged)
    const workProfileCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/work-profile'))
    expect(String(workProfileCall?.[0])).toContain('include_achievement_metrics=true')
    const claimCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/claims'))
    expect(claimCalls).toHaveLength(2)
    expect(JSON.parse(String(claimCalls[0][1]?.body))).toMatchObject({
      period_key: '2026-W30',
      observed_value: '360',
    })
    expect(JSON.parse(String(claimCalls[1][1]?.body))).toMatchObject({
      period_key: '2026-W30',
      observed_value: '241',
    })
  })

  it('keeps compatibility with a core process that has no achievement metrics', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/tasks')) {
        return jsonResponse({ data: [
          task('overnight', 'weekly_overnight_writer', 'max_overnight_work_minutes', '360'),
        ] })
      }
      return jsonResponse(workProfile(false))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(syncEligibleAchievementTasks({
      adminApiBaseUrl: 'http://127.0.0.1:8080',
      apiBaseUrl: 'http://127.0.0.1:7070',
      authToken: 'mbs_token',
    })).resolves.toEqual([])
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/claims'))).toBe(false)
  })

  it('does not celebrate an achievement that was already claimed for the period', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/tasks')) {
        return jsonResponse({ data: [
          task('overnight', 'weekly_overnight_writer', 'max_overnight_work_minutes', '360'),
        ] })
      }
      if (url.includes('/api/work-profile')) return jsonResponse(workProfile())
      if (url.includes('/claims')) {
        return jsonResponse({
          error: {
            code: 'TASK_ALREADY_CLAIMED',
            message: 'task was already claimed for this period',
          },
        }, 409)
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const achievementsChanged = vi.fn()
    window.addEventListener(ACHIEVEMENTS_CHANGED_KEY, achievementsChanged)

    await expect(syncEligibleAchievementTasks({
      adminApiBaseUrl: 'http://127.0.0.1:8080',
      apiBaseUrl: 'http://127.0.0.1:7070',
      authToken: 'mbs_token',
      now: new Date(2026, 6, 21, 12),
    })).resolves.toEqual([])

    expect(achievementsChanged).not.toHaveBeenCalled()
    window.removeEventListener(ACHIEVEMENTS_CHANGED_KEY, achievementsChanged)
  })
})
