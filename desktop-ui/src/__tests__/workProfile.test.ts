import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWorkProfile, fetchWorkProfileDay } from '../utils/workProfile'

afterEach(() => {
  vi.unstubAllGlobals()
})

const legacyProfile = {
  range_start: 1,
  range_end: 2,
  idle_gap_cap_minutes: 5,
  total_minutes: 125,
  active_days: 2,
  current_streak: 1,
  longest_streak: 2,
  longest_day_minutes: 80,
  today: {
    date: '2026-07-18',
    total_minutes: 45,
    capture_count: 6,
    first_capture_at: 1,
    last_capture_at: 2,
    apps: [{ name: 'Code', minutes: 45, capture_count: 6 }],
  },
  days: [{ date: '2026-07-18', minutes: 45, capture_count: 6 }],
}

describe('fetchWorkProfile', () => {
  it('兼容尚未返回工作心情的旧核心进程', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => legacyProfile,
    }))

    const result = await fetchWorkProfile('http://127.0.0.1:18080')

    expect(result.today.total_minutes).toBe(45)
    expect(result.today.apps).toEqual(legacyProfile.today.apps)
    expect(result.today.mood).toEqual({
      inferred: false,
      mood: null,
      expression_count: 0,
      source_apps: [],
    })
  })

  it('核心工作记录结构缺失时仍然报告格式错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ today: { apps: [] } }),
    }))

    await expect(fetchWorkProfile('http://127.0.0.1:18080'))
      .rejects.toThrow('工作画像数据格式不完整')
  })

  it('清理旧核心误计入的 loginwindow 时长和记录数', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...legacyProfile,
        total_minutes: 967,
        today: {
          ...legacyProfile.today,
          total_minutes: 967,
          capture_count: 1141,
          active_period_count: 1,
          first_capture_at: 10,
          last_capture_at: 20,
          apps: [
            { name: 'Code', minutes: 756, capture_count: 1070 },
            { name: 'loginwindow', minutes: 211, capture_count: 71 },
          ],
        },
        days: [{
          date: '2026-07-18',
          minutes: 967,
          capture_count: 1141,
          first_capture_at: 10,
          last_capture_at: 20,
          apps: [
            { name: 'Code', minutes: 756, capture_count: 1070 },
            { name: 'loginwindow', minutes: 211, capture_count: 71 },
          ],
        }],
      }),
    }))

    const result = await fetchWorkProfile('http://127.0.0.1:18080')

    expect(result.total_minutes).toBe(756)
    expect(result.today.total_minutes).toBe(756)
    expect(result.today.capture_count).toBe(1070)
    expect(result.today.apps).toEqual([{ name: 'Code', minutes: 756, capture_count: 1070 }])
    expect(result.today.first_capture_at).toBeNull()
    expect(result.today.last_capture_at).toBeNull()
  })

  it('按日期读取历史工作时请求日级明细', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...legacyProfile,
        days: [{
          date: '2026-07-18',
          minutes: 45,
          capture_count: 6,
          first_capture_at: 1,
          last_capture_at: 2,
          apps: [{ name: 'Code', minutes: 45, capture_count: 6 }],
        }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const day = await fetchWorkProfileDay('http://127.0.0.1:18080', '2026-07-18')

    expect(day.apps).toEqual([{ name: 'Code', minutes: 45, capture_count: 6 }])
    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(requestedUrl.searchParams.get('include_day_details')).toBe('true')
    expect(Number(requestedUrl.searchParams.get('to')))
      .toBeGreaterThan(Number(requestedUrl.searchParams.get('from')))
  })
})
