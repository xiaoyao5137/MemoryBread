import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AuthPanel from '../components/AuthPanel'
import { useAppStore } from '../store/useAppStore'

beforeEach(() => {
  useAppStore.getState().reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const fillPasswordLogin = () => {
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
    target: { value: 'admin@memorybread.local' },
  })
  fireEvent.change(screen.getByPlaceholderText('至少 8 个字符'), {
    target: { value: 'MemoryBread@2026!' },
  })
}

describe('AuthPanel', () => {
  it('普通启动时隐藏账户连接地址输入框', () => {
    render(<AuthPanel />)

    expect(screen.queryByLabelText('账户连接地址')).not.toBeInTheDocument()
  })

  it('调试模式下允许编辑账户连接地址', () => {
    useAppStore.setState({ debugModeEnabled: true })

    render(<AuthPanel />)

    const input = screen.getByLabelText('账户连接地址')
    expect(input).toHaveValue('http://127.0.0.1:8080')

    fireEvent.change(input, { target: { value: 'http://127.0.0.1:18080' } })
    expect(useAppStore.getState().adminApiBaseUrl).toBe('http://127.0.0.1:18080')
  })

  it('默认以未登录界面启动，并在登录后保存管理员会话', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          access_token: 'mbs_test_token',
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
          user: {
            id: '018f0000-0000-7000-8000-000000000001',
            email: 'admin@memorybread.local',
            status: 'active',
            roles: ['platform_admin'],
            locale: 'zh-CN',
            timezone: 'Asia/Shanghai',
            created_at: new Date().toISOString(),
          },
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<AuthPanel />)

    expect(screen.getByTestId('auth-panel')).toBeInTheDocument()
    expect(useAppStore.getState().authToken).toBeNull()

    fillPasswordLogin()
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => {
      expect(useAppStore.getState().authToken).toBe('mbs_test_token')
    })
    expect(useAppStore.getState().accountType).toBe('platform_admin')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/auth/login', expect.any(Object))
  })

  it('账户服务不可达时显示可操作的错误提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')))

    render(<AuthPanel />)
    fillPasswordLogin()
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('账户服务暂时无法连接')
    expect(screen.getByRole('alert')).toHaveTextContent('http://127.0.0.1:8080')
  })

  it('账户服务未就绪时提示稍后重试', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: {
          code: 'DATABASE_NOT_CONFIGURED',
          message: '账户服务尚未配置数据库',
        },
      }),
    }))

    render(<AuthPanel />)
    fillPasswordLogin()
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('账户服务暂时未就绪')
    expect(screen.getByRole('alert')).not.toHaveTextContent('mb-admin/.env')
  })

  it('用户详情显示套餐并可打开控制台充值', async () => {
    useAppStore.getState().setAuthSession({
      access_token: 'mbs_test_token',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      user: {
        id: '018f0000-0000-7000-8000-000000000003',
        username: '烘焙师土豆',
        display_name: '土豆账户',
        email: 'tudou@memorybread.local',
        status: 'active',
        roles: ['user'],
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        created_at: new Date().toISOString(),
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          balance: {
            available: '120.0000',
            reserved: '0.0000',
            currency: 'CREDIT',
            as_of: new Date().toISOString(),
          },
          current_subscription: {
            id: 'sub_001',
            status: 'active',
            plan_key: 'gold',
            name: '黄金',
          },
        },
      }),
    }))
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(<AuthPanel />)

    expect(screen.getByText('烘焙师土豆')).toBeInTheDocument()
    expect(screen.queryByText('土豆账户')).not.toBeInTheDocument()
    expect(await screen.findAllByText('Plus')).not.toHaveLength(0)
    expect(await screen.findByText('120.0000')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '充值' }))
    expect(openMock).toHaveBeenCalledWith('http://127.0.0.1:3000/console', '_blank', 'noopener,noreferrer')
  })
})
