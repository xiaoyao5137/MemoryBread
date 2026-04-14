/**
 * useAppStore 状态管理测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import type { ActionCommand } from '../types'

beforeEach(() => {
  useAppStore.getState().reset()
})

describe('windowMode', () => {
  it('初始状态为 rag', () => {
    expect(useAppStore.getState().windowMode).toBe('rag')
  })

  it('setWindowMode 切换到 rag', () => {
    useAppStore.getState().setWindowMode('rag')
    expect(useAppStore.getState().windowMode).toBe('rag')
  })

  it('setWindowMode 切换到 settings', () => {
    useAppStore.getState().setWindowMode('settings')
    expect(useAppStore.getState().windowMode).toBe('settings')
  })

  it('reset 恢复到 rag', () => {
    useAppStore.getState().setWindowMode('settings')
    useAppStore.getState().reset()
    expect(useAppStore.getState().windowMode).toBe('rag')
  })
})

describe('RAG 状态', () => {
  it('初始状态查询为空', () => {
    const state = useAppStore.getState()
    expect(state.ragQuery).toBe('')
    expect(state.ragAnswer).toBe('')
    expect(state.ragContexts).toEqual([])
    expect(state.ragLoading).toBe(false)
    expect(state.ragError).toBeNull()
  })

  it('setRagQuery 更新查询', () => {
    useAppStore.getState().setRagQuery('今日工作总结')
    expect(useAppStore.getState().ragQuery).toBe('今日工作总结')
  })

  it('setRagLoading 设置加载状态', () => {
    useAppStore.getState().setRagLoading(true)
    expect(useAppStore.getState().ragLoading).toBe(true)
  })

  it('setRagResult 更新结果并清除 loading/error', () => {
    useAppStore.getState().setRagLoading(true)
    useAppStore.getState().setRagError('旧错误')
    useAppStore.getState().setRagResult('LLM 回答', [
      { capture_id: 1, text: '工作记录', score: 0.9, source: 'fts5' },
    ])
    const state = useAppStore.getState()
    expect(state.ragAnswer).toBe('LLM 回答')
    expect(state.ragContexts).toHaveLength(1)
    expect(state.ragLoading).toBe(false)
    expect(state.ragError).toBeNull()
  })

  it('setRagError 设置错误并清除 loading', () => {
    useAppStore.getState().setRagLoading(true)
    useAppStore.getState().setRagError('网络错误')
    expect(useAppStore.getState().ragError).toBe('网络错误')
    expect(useAppStore.getState().ragLoading).toBe(false)
  })

  it('reset 清空所有 RAG 状态', () => {
    useAppStore.getState().setRagQuery('测试')
    useAppStore.getState().setRagResult('答案', [])
    useAppStore.getState().reset()
    const state = useAppStore.getState()
    expect(state.ragQuery).toBe('')
    expect(state.ragAnswer).toBe('')
    expect(state.ragContexts).toEqual([])
    expect(state.ragError).toBeNull()
    expect(state.windowMode).toBe('rag')
  })
})

describe('Action Confirm 状态', () => {
  const mockAction: ActionCommand = {
    type: 'click',
    x: 100,
    y: 200,
    description: '点击确认按钮',
  }

  it('初始状态 pendingAction 为 null', () => {
    expect(useAppStore.getState().pendingAction).toBeNull()
  })

  it('setPendingAction 设置待执行动作', () => {
    useAppStore.getState().setPendingAction(mockAction)
    expect(useAppStore.getState().pendingAction).toEqual(mockAction)
    expect(useAppStore.getState().actionConfirmed).toBe(false)
  })

  it('confirmAction 设置 actionConfirmed=true', () => {
    useAppStore.getState().setPendingAction(mockAction)
    useAppStore.getState().confirmAction()
    expect(useAppStore.getState().actionConfirmed).toBe(true)
  })

  it('cancelAction 清空 pendingAction', () => {
    useAppStore.getState().setPendingAction(mockAction)
    useAppStore.getState().cancelAction()
    expect(useAppStore.getState().pendingAction).toBeNull()
    expect(useAppStore.getState().actionConfirmed).toBe(false)
  })

  it('setPendingAction(null) 清空动作', () => {
    useAppStore.getState().setPendingAction(mockAction)
    useAppStore.getState().setPendingAction(null)
    expect(useAppStore.getState().pendingAction).toBeNull()
  })
})

describe('配置状态', () => {
  it('默认 apiBaseUrl', () => {
    expect(useAppStore.getState().apiBaseUrl).toBe('http://localhost:7070')
  })

  it('setApiBaseUrl 更新地址', () => {
    useAppStore.getState().setApiBaseUrl('http://localhost:8080')
    expect(useAppStore.getState().apiBaseUrl).toBe('http://localhost:8080')
  })

  it('setSidecarVersion 更新版本', () => {
    useAppStore.getState().setSidecarVersion('0.2.0')
    expect(useAppStore.getState().sidecarVersion).toBe('0.2.0')
  })
})
