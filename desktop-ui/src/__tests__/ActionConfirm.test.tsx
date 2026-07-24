/**
 * ActionConfirm 组件测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ActionConfirm from '../components/ActionConfirm'
import { useAppStore } from '../store/useAppStore'
import type { ActionCommand } from '../types'

beforeEach(() => {
  useAppStore.getState().reset()
  vi.clearAllTimers()
})

const mockAction: ActionCommand = {
  type:        'click',
  x:           100,
  y:           200,
  description: '点击"确认"按钮',
}

describe('ActionConfirm 渲染', () => {
  it('无 pendingAction 时不渲染', () => {
    render(<ActionConfirm autoCancel={0} />)
    expect(screen.queryByTestId('action-confirm-overlay')).not.toBeInTheDocument()
  })

  it('有 pendingAction 时渲染弹窗', () => {
    useAppStore.getState().setPendingAction(mockAction)
    render(<ActionConfirm autoCancel={0} />)
    expect(screen.getByTestId('action-confirm-overlay')).toBeInTheDocument()
  })

  it('显示动作描述', () => {
    useAppStore.getState().setPendingAction(mockAction)
    render(<ActionConfirm autoCancel={0} />)
    expect(screen.getByTestId('action-confirm-action')).toHaveTextContent('点击"确认"按钮')
  })

  it('显示警告文字', () => {
    useAppStore.getState().setPendingAction(mockAction)
    render(<ActionConfirm autoCancel={0} />)
    expect(screen.getByTestId('action-confirm-warning')).toBeInTheDocument()
  })

  it('显示确认和取消按钮', () => {
    useAppStore.getState().setPendingAction(mockAction)
    render(<ActionConfirm autoCancel={0} />)
    expect(screen.getByTestId('action-confirm-btn')).toBeInTheDocument()
    expect(screen.getByTestId('action-cancel-btn')).toBeInTheDocument()
  })
})

describe('ActionConfirm 交互', () => {
  it('点击取消清空 pendingAction', () => {
    useAppStore.getState().setPendingAction(mockAction)
    render(<ActionConfirm autoCancel={0} />)
    fireEvent.click(screen.getByTestId('action-cancel-btn'))
    expect(useAppStore.getState().pendingAction).toBeNull()
  })

  it('点击确认调用 onConfirm 回调', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    useAppStore.getState().setPendingAction(mockAction)
    render(<ActionConfirm onConfirm={onConfirm} autoCancel={0} />)
    fireEvent.click(screen.getByTestId('action-confirm-btn'))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(mockAction)
    })
  })

  it('点击确认后 actionConfirmed=true', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    useAppStore.getState().setPendingAction(mockAction)
    render(<ActionConfirm onConfirm={onConfirm} autoCancel={0} />)
    fireEvent.click(screen.getByTestId('action-confirm-btn'))
    await waitFor(() => {
      expect(useAppStore.getState().actionConfirmed).toBe(true)
    })
  })

  it('取消后弹窗消失', async () => {
    useAppStore.getState().setPendingAction(mockAction)
    const { rerender } = render(<ActionConfirm autoCancel={0} />)
    fireEvent.click(screen.getByTestId('action-cancel-btn'))

    // 重新渲染以反映 store 更新
    rerender(<ActionConfirm autoCancel={0} />)
    await waitFor(() => {
      expect(screen.queryByTestId('action-confirm-overlay')).not.toBeInTheDocument()
    })
  })
})

describe('ActionConfirm 无 description 时', () => {
  it('回退显示 action type', () => {
    const action: ActionCommand = { type: 'hotkey', keys: ['ctrl', 'c'] }
    useAppStore.getState().setPendingAction(action)
    render(<ActionConfirm autoCancel={0} />)
    expect(screen.getByTestId('action-confirm-action')).toHaveTextContent('使用快捷键')
  })
})
