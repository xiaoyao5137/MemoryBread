/**
 * RagPanel 组件测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import RagPanel from '../components/RagPanel'
import { useAppStore } from '../store/useAppStore'

vi.mock('../hooks/useApi', () => ({
  useRagQuery: () => {
    return vi.fn().mockImplementation(async (_query: string) => {
      const result = {
        answer: '这是测试回答',
        contexts: [
          { capture_id: 1, text: '会议记录内容', score: 0.9, source: 'fts5' as const, app_name: '飞书' },
        ],
        model: 'mock',
      }
      useAppStore.getState().setRagResult(result.answer, result.contexts)
      return result
    })
  },
  useFetchPreferences: () => vi.fn().mockResolvedValue([]),
  useUpdatePreference: () => vi.fn().mockResolvedValue({}),
  useHealthCheck: () => vi.fn().mockResolvedValue({ status: 'ok', version: '0.1.0' }),
  useFetchCaptures: () => vi.fn().mockResolvedValue({ total: 0, captures: [] }),
  useExecuteAction: () => vi.fn().mockResolvedValue({ success: true, message: 'ok', action_id: '1' }),
}))

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.getState().setWindowMode('rag')
})

describe('RagPanel 渲染', () => {
  it('渲染面板', () => {
    render(<RagPanel />)
    expect(screen.getByTestId('rag-panel')).toBeInTheDocument()
  })

  it('渲染输入框', () => {
    render(<RagPanel />)
    expect(screen.getByTestId('rag-panel-input')).toBeInTheDocument()
  })

  it('渲染发送按钮', () => {
    render(<RagPanel />)
    expect(screen.getByTestId('rag-panel-submit')).toBeInTheDocument()
  })

  it('初始状态显示空状态提示', () => {
    render(<RagPanel />)
    expect(screen.getByTestId('rag-panel-empty')).toBeInTheDocument()
  })

  it('初始状态发送按钮禁用（输入为空）', () => {
    render(<RagPanel />)
    expect(screen.getByTestId('rag-panel-submit')).toBeDisabled()
  })

  it('不再渲染关闭按钮', () => {
    render(<RagPanel />)
    expect(screen.queryByTestId('rag-panel-close')).not.toBeInTheDocument()
  })
})

describe('RagPanel 输入交互', () => {
  it('输入内容后发送按钮启用', () => {
    render(<RagPanel />)
    fireEvent.change(screen.getByTestId('rag-panel-input'), { target: { value: '今日工作内容' } })
    expect(screen.getByTestId('rag-panel-submit')).not.toBeDisabled()
  })

  it('查询成功后显示回答', async () => {
    render(<RagPanel />)
    await act(async () => {
      fireEvent.change(screen.getByTestId('rag-panel-input'), { target: { value: '飞书会议记录' } })
      fireEvent.submit(screen.getByTestId('rag-panel-form'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('rag-panel-answer')).toHaveTextContent('这是测试回答')
    })
  })

  it('查询成功后显示上下文列表', async () => {
    render(<RagPanel />)
    await act(async () => {
      fireEvent.change(screen.getByTestId('rag-panel-input'), { target: { value: '工作' } })
      fireEvent.submit(screen.getByTestId('rag-panel-form'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('rag-panel-contexts')).toBeInTheDocument()
      expect(screen.getByTestId('context-item-0')).toBeInTheDocument()
    })
  })

  it('上下文包含文本内容', async () => {
    render(<RagPanel />)
    await act(async () => {
      fireEvent.change(screen.getByTestId('rag-panel-input'), { target: { value: '记录' } })
      fireEvent.submit(screen.getByTestId('rag-panel-form'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('context-item-0')).toHaveTextContent('会议记录内容')
    })
  })
})

describe('RagPanel 错误状态', () => {
  it('显示错误信息', () => {
    useAppStore.getState().setRagError('网络连接失败')
    render(<RagPanel />)
    expect(screen.getByTestId('rag-panel-error')).toHaveTextContent('网络连接失败')
  })

  it('有回答时不显示空状态', () => {
    useAppStore.getState().setRagResult('已有回答', [])
    render(<RagPanel />)
    expect(screen.queryByTestId('rag-panel-empty')).not.toBeInTheDocument()
  })
})
