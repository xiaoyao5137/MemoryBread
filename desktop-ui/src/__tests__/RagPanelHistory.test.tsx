import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import RagPanel from '../components/RagPanel.v2'
import { useAppStore } from '../store/useAppStore'
import type { RagHistoryItem, RagHistoryPage } from '../types'

const mocks = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  ragQuery: vi.fn(),
}))

vi.mock('../hooks/useApi', () => ({
  useFetchRagHistory: () => mocks.fetchHistory,
  useRagQuery: () => mocks.ragQuery,
  useModelStatus: () => ({
    status: { llm: true, embedding: true, ollama: true },
    ready: true,
    loading: false,
  }),
}))

vi.mock('../utils/authApi', () => ({
  fetchBillingBalance: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const item = (id: number, query: string): RagHistoryItem => ({
  id,
  ts: 1_720_000_000_000 + id,
  query,
  answer: `${query}的回答`,
  contexts: [],
  context_count: 0,
  latency_ms: 1200,
  model: 'mbcd-std-v1',
})

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  mocks.fetchHistory.mockReset()
  mocks.fetchHistory.mockImplementation(async (
    params: { limit: number; offset: number; query: string },
  ): Promise<RagHistoryPage> => {
    const searching = params.query === '年度规划'
    return {
      items: [item(params.offset + 1, searching ? '年度规划方案' : '最近咨询')],
      total: searching ? 25 : 45,
      limit: params.limit,
      offset: params.offset,
    }
  })
})

describe('咨询记录搜索与分页', () => {
  it('展示真实总数，并按关键词和页码请求记录', async () => {
    render(<RagPanel />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '咨询记录 (45)' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '咨询记录 (45)' }))

    fireEvent.change(screen.getByLabelText('搜索咨询记录'), {
      target: { value: '年度规划' },
    })

    await waitFor(() => {
      expect(mocks.fetchHistory).toHaveBeenCalledWith(
        { limit: 20, offset: 0, query: '年度规划' },
        expect.any(AbortSignal),
      )
      expect(screen.getByText('年度规划方案')).toBeInTheDocument()
      expect(screen.getByText('找到 25 条')).toBeInTheDocument()
    }, { timeout: 1500 })

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))

    await waitFor(() => {
      expect(mocks.fetchHistory).toHaveBeenCalledWith(
        { limit: 20, offset: 20, query: '年度规划' },
        expect.any(AbortSignal),
      )
      expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument()
    })
  })
})
