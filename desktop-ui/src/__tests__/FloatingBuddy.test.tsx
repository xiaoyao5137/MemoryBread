import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import FloatingBuddy from '../components/FloatingBuddy'
import BakeTabs from '../components/bake/BakeTabs'
import { useAppStore } from '../store/useAppStore'

beforeEach(() => {
  useAppStore.getState().reset()
})

describe('FloatingBuddy', () => {
  it('渲染主菜单按钮', () => {
    render(<FloatingBuddy />)
    expect(screen.getByTestId('buddy-avatar')).toBeInTheDocument()
    expect(screen.getByTestId('settings-btn')).toBeInTheDocument()
  })

  it('点击菜单按钮会切换到对应模式', () => {
    render(<FloatingBuddy />)
    fireEvent.click(screen.getByTestId('settings-btn'))
    expect(useAppStore.getState().windowMode).toBe('settings')
  })

  it('普通菜单导航会清除关联返回栈', () => {
    useAppStore.getState().pushBakeNavigationTarget({ windowMode: 'rag' })

    render(<FloatingBuddy />)
    fireEvent.click(screen.getByTestId('settings-btn'))

    expect(useAppStore.getState().bakeNavigationStack).toHaveLength(0)
    expect(useAppStore.getState().captureBackTarget).toBeNull()
  })

  it('记忆菜单排在第二位，采集排在第三位', () => {
    render(<FloatingBuddy />)
    const buttonTestIds = screen.getAllByRole('button').map(button => button.getAttribute('data-testid'))
    expect(buttonTestIds.indexOf('knowledge-btn')).toBe(buttonTestIds.indexOf('bake-btn') + 1)
    expect(screen.getByText('记忆')).toBeInTheDocument()
  })

  it('平台管理员可以切换测试和正式环境并持久化', () => {
    useAppStore.getState().setAccountType('platform_admin')
    render(<FloatingBuddy />)

    expect(screen.getByLabelText('服务环境切换')).toBeInTheDocument()
    expect(useAppStore.getState().serviceEnvironment).toBe('production')

    fireEvent.click(screen.getByRole('button', { name: '测试' }))

    expect(useAppStore.getState().serviceEnvironment).toBe('staging')
    expect(screen.getByRole('button', { name: '测试' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('账号入口显示用户名和会员套餐', () => {
    useAppStore.getState().setAuthSession({
      access_token: 'mbs_test_token',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      user: {
        id: '018f0000-0000-7000-8000-000000000002',
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
    useAppStore.getState().setCloudSubscription({
      id: 'sub_001',
      status: 'active',
      plan_key: 'gold',
      name: '黄金',
    })

    render(<FloatingBuddy />)

    expect(screen.getByText('烘焙师土豆')).toBeInTheDocument()
    expect(screen.queryByText('土豆账户')).not.toBeInTheDocument()
    expect(screen.getByText('Plus')).toBeInTheDocument()
    expect(screen.queryByText('云账户已连接')).not.toBeInTheDocument()
  })
})

describe('BakeTabs', () => {
  it('按要求渲染新的标签顺序和文案', () => {
    const onChange = vi.fn()
    render(<BakeTabs current="overview" onChange={onChange} />)

    const tabs = screen.getAllByRole('button').map(button => button.textContent)
    expect(tabs).toEqual(['总览', '文档', '知识', '操作'])
    expect(screen.queryByText('高价值文档')).not.toBeInTheDocument()
  })
})
