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

  it('烤面包菜单排在第二位，醒发箱排在第三位', () => {
    render(<FloatingBuddy />)
    const buttons = screen.getAllByRole('button')
    expect(buttons[1]).toHaveAttribute('data-testid', 'bake-btn')
    expect(buttons[2]).toHaveAttribute('data-testid', 'knowledge-btn')
  })
})

describe('BakeTabs', () => {
  it('按要求渲染新的标签顺序和文案', () => {
    const onChange = vi.fn()
    render(<BakeTabs current="overview" onChange={onChange} />)

    const tabs = screen.getAllByRole('button').map(button => button.textContent)
    expect(tabs).toEqual(['总览', '情节记忆', '知识（芝士）', '文档模板（面包片）', '操作手册（火腿）', '写作自然感提升'])
    expect(screen.queryByText('高价值文档')).not.toBeInTheDocument()
  })
})
