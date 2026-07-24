import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { useAppStore } from '../store/useAppStore'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}))

vi.mock('../components/RagPanel.v2', () => ({
  default: () => <section data-testid="rag-panel" />,
}))

vi.mock('../components/BakePanel', () => ({
  default: () => <section data-testid="bake-panel" />,
}))

vi.mock('../components/RepositoryPanel', () => ({
  default: () => <section data-testid="repository-panel" />,
}))

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.getState().setHasCompletedSetup(true)
  useAppStore.getState().clearAuthSession()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
})

describe('App auth entry', () => {
  it('全新安装没有完成或跳过标记时显示首次配置引导', async () => {
    useAppStore.setState({ hasCompletedSetup: false, setupSkipped: false })

    render(<App />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('欢迎使用记忆面包')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始配置' })).toBeInTheDocument()
  })

  it('未登录也直接进入主界面，并在侧栏显示未登录入口', async () => {
    render(<App />)

    expect(screen.getByTestId('floating-buddy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '未登录，打开登录' })).toBeInTheDocument()
    expect(screen.queryByTestId('auth-panel')).not.toBeInTheDocument()
  })

  it('已有登录会话启动后会自动同步工作投入与工作心情', async () => {
    const user = {
      id: '018f0000-0000-7000-8000-000000000008',
      username: '同步测试用户',
      email: 'sync@memorybread.local',
      status: 'active',
      roles: ['user'],
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      created_at: new Date().toISOString(),
    }
    useAppStore.getState().setAuthSession({
      access_token: 'mbs_sync_token',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      user,
    })
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const date = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-')
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/auth/me')) {
        return { ok: true, json: async () => ({ data: user }) }
      }
      if (url.endsWith('/v1/console/summary')) {
        return { ok: true, json: async () => ({ data: {} }) }
      }
      if (url.includes('/api/work-profile')) {
        return {
          ok: true,
          json: async () => ({
            range_start: today.getTime() - 370 * 86400_000,
            range_end: today.getTime() + 86400_000,
            idle_gap_cap_minutes: 5,
            total_minutes: 30,
            active_days: 1,
            current_streak: 1,
            longest_streak: 1,
            longest_day_minutes: 30,
            today: {
              date,
              total_minutes: 30,
              capture_count: 6,
              first_capture_at: today.getTime() + 9 * 3600_000,
              last_capture_at: today.getTime() + 9.5 * 3600_000,
              apps: [{ name: 'Code', minutes: 30, capture_count: 6 }],
              mood: {
                inferred: true,
                mood: 'focused',
                expression_count: 2,
                source_apps: ['Slack'],
              },
            },
            days: [{ date, minutes: 30, capture_count: 6 }],
          }),
        }
      }
      if (url.endsWith('/v1/work-profile') && init?.method === 'PUT') {
        return {
          ok: true,
          json: async () => ({
            data: {
              applied: true,
              profile: {
                range_start_date: date,
                range_end_date: date,
                synced_at: new Date().toISOString(),
                days: [{
                  date,
                  minutes: 30,
                  capture_count: 6,
                  first_capture_at: today.getTime() + 9 * 3600_000,
                  last_capture_at: today.getTime() + 9.5 * 3600_000,
                  apps: [{ name: 'Code', minutes: 30, capture_count: 6 }],
                  mood: {
                    inferred: true,
                    mood: 'focused',
                    expression_count: 2,
                    source_apps: ['Slack'],
                  },
                }],
              },
            },
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/v1/work-profile',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
  })

  it('打开具体 RAG 引用时才生成返回栈', () => {
    render(<App />)

    act(() => {
      window.dispatchEvent(new CustomEvent('view-rag-reference', {
        detail: { type: 'document', documentId: '42' },
      }))
    })

    expect(screen.getByTestId('bake-panel')).toBeInTheDocument()
    expect(useAppStore.getState().bakeNavigationStack).toEqual([{ windowMode: 'rag' }])
  })

  it('无具体目标的引用跳转会清除旧返回栈', () => {
    useAppStore.getState().pushBakeNavigationTarget({ windowMode: 'creation' })
    render(<App />)

    act(() => {
      window.dispatchEvent(new CustomEvent('view-rag-reference', {
        detail: { type: 'document' },
      }))
    })

    expect(screen.getByTestId('bake-panel')).toBeInTheDocument()
    expect(useAppStore.getState().bakeNavigationStack).toHaveLength(0)
    expect(useAppStore.getState().captureBackTarget).toBeNull()
  })
})
