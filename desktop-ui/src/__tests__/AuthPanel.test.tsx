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

  it('用户详情显示中文运行模式和可用 Credit，并隐藏未开放的钱包操作与字段', async () => {
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
    render(<AuthPanel />)

    expect(screen.getByText('烘焙师土豆')).toBeInTheDocument()
    expect(screen.queryByText('土豆账户')).not.toBeInTheDocument()
    expect(screen.getByText('运行模式')).toBeInTheDocument()
    expect(await screen.findAllByText('增强模式')).not.toHaveLength(0)
    expect(screen.queryByText('会员套餐')).not.toBeInTheDocument()
    expect(await screen.findByText('120.0000')).toBeInTheDocument()
    expect(screen.queryByText('冻结 Credit')).not.toBeInTheDocument()
    expect(screen.queryByText('币种')).not.toBeInTheDocument()
    expect(screen.queryByText('更新时间')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '充值' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument()
  })

  it('在标签卡片页展示数量与 Credit，并支持佩戴到个人头像', async () => {
    useAppStore.getState().setAuthSession({
      access_token: 'mbs_test_token',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      user: {
        id: '018f0000-0000-7000-8000-000000000004',
        username: '代码师傅',
        email: 'coder@memorybread.local',
        status: 'active',
        roles: ['user'],
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        created_at: new Date().toISOString(),
      },
    })
    const badge = {
      id: 'badge-code-elite',
      badge_key: 'code_elite',
      name: '代码精英',
      tagline: '键盘上的耐力赛冠军',
      description: '一周内累计完成超过 50 小时的代码编写工作。',
      icon_key: 'code',
      palette_key: 'cobalt',
      rarity: 'epic',
    }
    const profile = {
      badges: [{
        badge,
        quantity: 3,
        total_credit_earned: '180.0000',
        first_earned_at: '2026-06-01T00:00:00Z',
        last_earned_at: '2026-07-18T00:00:00Z',
      }],
      equipped: {},
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/console/summary')) {
        return { ok: true, json: async () => ({ data: {} }) }
      }
      if (url.endsWith('/v1/achievements/equipped') && init?.method === 'PUT') {
        return { ok: true, json: async () => ({ data: { ...profile, equipped: { profile_avatar: badge } } }) }
      }
      return { ok: true, json: async () => ({ data: profile }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<AuthPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '标签卡片' }))

    expect(await screen.findByText('代码精英')).toBeInTheDocument()
    expect(screen.getByText('×3')).toBeInTheDocument()
    expect(screen.getByText(/累计奖励/)).toHaveTextContent('180 Credit')

    fireEvent.click(screen.getByRole('button', { name: '佩戴到头像' }))
    expect(await screen.findByText('已将「代码精英」佩戴到个人头像。')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/achievements/equipped',
      expect.objectContaining({ method: 'PUT' }),
    )
  })
})
