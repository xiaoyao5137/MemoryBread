import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import AccountProfile from '../components/AccountProfile'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AccountProfile achievements', () => {
  it('shows the cloud badge inventory without waiting for local metric sync', async () => {
    const onInitialSectionHandled = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/v1/achievements')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              badges: [{
                badge: {
                  id: 'badge-1',
                  badge_key: 'overnight_writer',
                  name: '通宵赶稿',
                  tagline: '月落前还在落笔',
                  description: '一个自然周内，曾在某个本地夜晚从 0 点到 6 点保持连续有效工作。',
                  icon_key: 'moon',
                  palette_key: 'midnight',
                  rarity: 'rare',
                },
                quantity: 1,
                total_credit_earned: '60.0000',
                first_earned_at: '2026-07-21T00:00:00Z',
                last_earned_at: '2026-07-21T00:00:00Z',
              }],
              equipped: {},
            },
          }),
        }
      }
      if (url.endsWith('/v1/tasks')) {
        return { ok: true, json: async () => ({ data: [] }) }
      }
      if (url.includes('/api/work-profile')) {
        return new Promise(() => undefined)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<AccountProfile
      accountLabel="普通账户"
      adminApiBaseUrl="http://127.0.0.1:8080"
      apiBaseUrl="http://127.0.0.1:7070"
      authToken="mbs_token"
      balanceError={null}
      cloudBalance={null}
      highlightedAchievementKeys={['overnight_writer']}
      initialSection="achievements"
      onInitialSectionHandled={onInitialSectionHandled}
      onLogout={vi.fn()}
      onUserChange={vi.fn()}
      runModeLabel="本地模式"
      user={{
        id: 'user-1',
        username: '小麦',
        status: 'active',
        roles: ['user'],
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        created_at: '2026-07-21T00:00:00Z',
      }}
    />)

    expect(screen.getByRole('tab', { name: '标签卡片' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('通宵赶稿')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: '通宵赶稿，刚刚获得' })).toBeInTheDocument()
    expect(screen.getByText('刚刚获得')).toBeInTheDocument()
    expect(onInitialSectionHandled).toHaveBeenCalledTimes(1)
    expect(screen.getByText('这是一枚通宵纪念卡。完成赶稿后，请尽快补充睡眠。')).toBeInTheDocument()
  })
})
