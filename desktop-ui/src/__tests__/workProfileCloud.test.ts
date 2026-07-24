import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { getWorkProfileRange, toLocalDateKey, type WorkProfileSummary } from '../utils/workProfile'
import {
  buildSyncWorkProfileRequest,
  mergeWorkProfiles,
  synchronizeWorkProfile,
} from '../utils/workProfileCloud'

const profile = (
  days: WorkProfileSummary['days'],
  todayOverrides: Partial<WorkProfileSummary['today']> = {},
): WorkProfileSummary => {
  const range = getWorkProfileRange()
  const today = toLocalDateKey(new Date())
  const todayDay = days.find(day => day.date === today)
  return {
    range_start: range.from,
    range_end: range.to,
    idle_gap_cap_minutes: 5,
    total_minutes: days.reduce((sum, day) => sum + day.minutes, 0),
    active_days: days.length,
    current_streak: todayDay ? 1 : 0,
    longest_streak: days.length > 0 ? 1 : 0,
    longest_day_minutes: days.reduce((max, day) => Math.max(max, day.minutes), 0),
    today: {
      date: today,
      total_minutes: todayDay?.minutes ?? 0,
      capture_count: todayDay?.capture_count ?? 0,
      first_capture_at: null,
      last_capture_at: null,
      apps: [],
      mood: {
        inferred: false,
        mood: null,
        expression_count: 0,
        source_apps: [],
      },
      ...todayOverrides,
    },
    days,
  }
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState({ serviceEnvironment: 'production' })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('work profile cloud sync', () => {
  it('合并云端与本机同一天记录时取较新汇总，不重复累加', () => {
    const today = toLocalDateKey(new Date())
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = toLocalDateKey(yesterdayDate)
    const local = profile([{ date: today, minutes: 120, capture_count: 24 }], {
      apps: [{ name: 'Code', minutes: 90, capture_count: 18 }],
      mood: {
        inferred: true,
        mood: 'focused',
        expression_count: 3,
        source_apps: ['Slack'],
      },
    })
    const cloud = profile([
      { date: yesterday, minutes: 50, capture_count: 10 },
      { date: today, minutes: 120, capture_count: 24 },
    ], {
      apps: [{ name: 'Code', minutes: 90, capture_count: 18 }],
      mood: {
        inferred: true,
        mood: 'energized',
        expression_count: 5,
        source_apps: ['飞书'],
      },
    })

    const merged = mergeWorkProfiles(local, cloud)

    expect(merged.days).toEqual([
      { date: yesterday, minutes: 50, capture_count: 10 },
      { date: today, minutes: 120, capture_count: 24 },
    ])
    expect(merged.total_minutes).toBe(170)
    expect(merged.today.apps).toEqual([{ name: 'Code', minutes: 90, capture_count: 18 }])
    expect(merged.today.mood.mood).toBe('energized')
  })

  it('复用稳定设备标识并生成单调递增同步版本', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const today = toLocalDateKey(new Date())
    const local = profile([{ date: today, minutes: 30, capture_count: 6 }], {
      apps: [{ name: 'Code', minutes: 30, capture_count: 6 }],
      mood: {
        inferred: true,
        mood: 'focused',
        expression_count: 2,
        source_apps: ['Slack'],
      },
    })

    const first = buildSyncWorkProfileRequest(local)
    const second = buildSyncWorkProfileRequest(local)

    expect(second.source_device_id).toBe(first.source_device_id)
    expect(second.sync_revision).toBe(first.sync_revision + 1)
    expect(first.days[0]).toMatchObject({
      date: today,
      minutes: 30,
      capture_count: 6,
      mood: { mood: 'focused', expression_count: 2 },
    })
  })

  it('新机器本机为空时，登录同步会恢复云端历史和今日数据', async () => {
    const range = getWorkProfileRange()
    const today = toLocalDateKey(new Date())
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = toLocalDateKey(yesterdayDate)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/work-profile')) {
        return new Response(JSON.stringify(profile([])), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        data: {
          applied: true,
          profile: {
            range_start_date: toLocalDateKey(new Date(range.from)),
            range_end_date: today,
            synced_at: new Date().toISOString(),
            days: [
              {
                date: yesterday,
                minutes: 80,
                capture_count: 16,
                first_capture_at: null,
                last_capture_at: null,
                apps: [],
                mood: null,
              },
              {
                date: today,
                minutes: 20,
                capture_count: 4,
                first_capture_at: Date.now() - 60_000,
                last_capture_at: Date.now(),
                apps: [{ name: 'Code', minutes: 20, capture_count: 4 }],
                mood: {
                  inferred: true,
                  mood: 'focused',
                  expression_count: 2,
                  source_apps: ['Slack'],
                },
              },
            ],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const restored = await synchronizeWorkProfile({
      apiBaseUrl: 'http://127.0.0.1:7070',
      adminApiBaseUrl: 'http://127.0.0.1:8080',
      authToken: 'mbs_token',
      userId: 'user-1',
    })

    expect(restored.total_minutes).toBe(100)
    expect(restored.days).toHaveLength(2)
    expect(restored.today.mood.mood).toBe('focused')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/work-profile',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'X-MemoryBread-Environment': 'production',
          Authorization: 'Bearer mbs_token',
        }),
      }),
    )
  })

  it('首次上传完整本机日期，后续未变化周期只拉取而不重写每日数据', async () => {
    const today = toLocalDateKey(new Date())
    const local = profile([{ date: today, minutes: 30, capture_count: 6 }], {
      apps: [{ name: 'Code', minutes: 30, capture_count: 6 }],
      mood: {
        inferred: true,
        mood: 'focused',
        expression_count: 2,
        source_apps: ['Slack'],
      },
    })
    const uploadedBodies: Array<{ days: unknown[] }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/work-profile')) {
        return new Response(JSON.stringify(local), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      uploadedBodies.push(JSON.parse(String(init?.body)) as { days: unknown[] })
      return new Response(JSON.stringify({
        data: {
          applied: true,
          profile: {
            range_start_date: today,
            range_end_date: today,
            synced_at: new Date().toISOString(),
            days: [{
              date: today,
              minutes: 30,
              capture_count: 6,
              first_capture_at: null,
              last_capture_at: null,
              apps: [{ name: 'Code', minutes: 30, capture_count: 6 }],
              mood: local.today.mood,
            }],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const options = {
      apiBaseUrl: 'http://127.0.0.1:7070',
      adminApiBaseUrl: 'http://127.0.0.1:8080',
      authToken: 'mbs_token',
      userId: 'user-incremental',
    }

    await synchronizeWorkProfile(options)
    await synchronizeWorkProfile(options)

    expect(uploadedBodies[0].days).toHaveLength(1)
    expect(uploadedBodies[1].days).toHaveLength(0)
  })
})
