import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import CreationPanel from '../components/CreationPanel'
import { useAppStore } from '../store/useAppStore'

const historyResponse = (url: URL) => {
  const query = url.searchParams.get('q') || ''
  const offset = Number(url.searchParams.get('offset') || 0)
  const limit = Number(url.searchParams.get('limit') || 20)
  const searching = query === '年度规划'
  return {
    items: [{
      id: offset + 1,
      prompt: searching ? '年度规划创作' : '最近创作',
      generated_content: searching ? '年度规划正文' : '最近创作正文',
      doc_type: '方案',
      audience: '管理层',
      reference_count: 0,
      references_json: '[]',
      model: 'mbcd-plus-v1',
      latency_ms: 1800,
      created_at: 1_720_000_000_000 + offset,
      updated_at: 1_720_000_000_000 + offset,
    }],
    total: searching ? 23 : 52,
    limit,
    offset,
  }
}

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/creation/history') {
      return new Response(JSON.stringify(historyResponse(url)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 404 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('创作记录搜索与分页', () => {
  it('展示真实总数，并把搜索和分页参数传给服务端', async () => {
    render(<CreationPanel />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '创作记录 (52)' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '创作记录 (52)' }))

    fireEvent.change(screen.getByLabelText('搜索创作记录'), {
      target: { value: '年度规划' },
    })

    await waitFor(() => {
      expect(screen.getByText('年度规划创作')).toBeInTheDocument()
      expect(screen.getByText('找到 23 条')).toBeInTheDocument()
      expect(vi.mocked(fetch).mock.calls.some(([input]) => {
        const url = new URL(String(input))
        return url.searchParams.get('q') === '年度规划'
          && url.searchParams.get('offset') === '0'
          && url.searchParams.get('paged') === 'true'
      })).toBe(true)
    }, { timeout: 1500 })

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([input]) => {
        const url = new URL(String(input))
        return url.searchParams.get('q') === '年度规划'
          && url.searchParams.get('offset') === '20'
      })).toBe(true)
      expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument()
    })
  })
})
