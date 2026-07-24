import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWorkProfile } from '../utils/workProfile'

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
})
