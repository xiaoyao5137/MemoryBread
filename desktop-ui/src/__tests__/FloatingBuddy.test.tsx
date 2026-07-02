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

  it('收藏菜单排在第二位，采集排在第三位', () => {
    render(<FloatingBuddy />)
    const buttonTestIds = screen.getAllByRole('button').map(button => button.getAttribute('data-testid'))
    expect(buttonTestIds.indexOf('knowledge-btn')).toBe(buttonTestIds.indexOf('bake-btn') + 1)
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
