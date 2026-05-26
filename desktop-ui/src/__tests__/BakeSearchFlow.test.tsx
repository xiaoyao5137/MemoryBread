import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import RepositoryPanel from '../components/RepositoryPanel'
import BakePanel from '../components/BakePanel'
import { useAppStore } from '../store/useAppStore'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const overviewResponse = {
  capture_count: 0,
  memory_count: 0,
  knowledge_count: 0,
  template_count: 0,
  pending_candidates: 0,
  recent_activities: [],
}

const styleConfigResponse = {
  preferredPhrases: [],
  replacementRules: [],
  styleSamples: [],
  applyToCreation: true,
  applyToTemplateEditing: true,
}

describe('显式搜索交互', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  })

  it('BakePanel 知识搜索只有点击搜索后才发起带关键词请求', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/models')) return jsonResponse({ ollama: true, llm: true, embedding: true })
      if (url.includes('/api/bake/overview')) return jsonResponse(overviewResponse)
      if (url.includes('/api/bake/knowledge')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({ bakeTab: 'knowledge' })

    render(<BakePanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/knowledge?limit=20&offset=0')
    })

    const callsBeforeTyping = fetchMock.mock.calls.length
    fireEvent.change(screen.getByPlaceholderText('搜索知识摘要、概述、详情或分类'), { target: { value: '芝士' } })

    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeTyping)

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/knowledge?q=%E8%8A%9D%E5%A3%AB&limit=20&offset=0')
    })
  })

  it('BakePanel 知识页在没有 bake knowledge 时显示明确空态', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/models')) return jsonResponse({ ollama: true, llm: true, embedding: true })
      if (url.includes('/api/bake/overview')) return jsonResponse(overviewResponse)
      if (url.includes('/api/bake/knowledge')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({ bakeTab: 'knowledge' })

    render(<BakePanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/knowledge?limit=20&offset=0')
    })

    expect(screen.getByText('当前还没有知识条目。')).toBeInTheDocument()
  })

  it('RepositoryPanel 展示采集标题以及情节记忆创建时间', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/bake/memories')) {
        return jsonResponse({
          memories: [{
            id: 1,
            title: '周报情节记忆',
            summary: '整理周报提纲',
            source_capture_id: '42',
            weight: 6,
            open_count: 2,
            dwell_seconds: 30,
            has_edit_action: true,
            knowledge_ref_count: 3,
            status: 'candidate',
            suggested_action: 'template',
            tags: ['周报'],
            created_at: '2026-04-11 09:30',
            created_at_ms: 0,
          }],
          total: 1,
          limit: 20,
          offset: 0,
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({ repositoryTab: 'memory' })

    render(<RepositoryPanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/memories?limit=20&offset=0')
    })

    expect(screen.getByText('采集')).toBeInTheDocument()
    expect(screen.getAllByText('创建于 2026-04-11 09:30').length).toBeGreaterThan(1)
  })

  it('RepositoryPanel 情节记忆搜索只有点击搜索后才发起带筛选请求', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/bake/memories')) return jsonResponse({ memories: [], total: 0, limit: 20, offset: 0 })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({ repositoryTab: 'memory' })

    render(<RepositoryPanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/memories?limit=20&offset=0')
    })

    const callsBeforeTyping = fetchMock.mock.calls.length
    fireEvent.change(screen.getByPlaceholderText('搜索时间线标题、摘要或详情'), { target: { value: '周报' } })
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-04-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-04-11' } })

    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeTyping)

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/memories?q=%E5%91%A8%E6%8A%A5&from=1774972800000&to=1775923199999&limit=20&offset=0')
    })
  })

  it('RepositoryPanel 记忆片段清除筛选会恢复默认请求并清掉来源范围', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/bake/captures')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({
      repositoryTab: 'capture',
      repositoryCaptureSourceCaptureId: '123',
    })

    render(<RepositoryPanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/captures?source_capture_id=123&limit=20&offset=0')
    })
    expect(screen.getByText('仅看来源片段 #123')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('搜索标题、正文或 OCR'), { target: { value: '设计稿' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/captures?q=%E8%AE%BE%E8%AE%A1%E7%A8%BF&source_capture_id=123&limit=20&offset=0')
    })

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/captures?limit=20&offset=0')
    })
    expect(useAppStore.getState().repositoryCaptureSourceCaptureId).toBeNull()
  })

  it('RepositoryPanel 从时间线点击采集记录会限定到对应采集片段', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/bake/memories')) {
        return jsonResponse({
          memories: [{
            id: 1,
            title: '周报情节记忆',
            summary: '整理周报提纲',
            source_capture_id: '41',
            weight: 6,
            open_count: 2,
            dwell_seconds: 30,
            has_edit_action: true,
            knowledge_ref_count: 3,
            status: 'candidate',
            suggested_action: 'template',
            tags: ['周报'],
            created_at: '2026-04-11 09:30',
            created_at_ms: 0,
            capture_ids: [41, 42],
          }],
          total: 1,
          limit: 20,
          offset: 0,
        })
      }
      if (url === 'http://localhost:7070/captures?limit=500&ids=41%2C42') {
        return jsonResponse({
          total: 2,
          captures: [
            { id: 41, ts: 1710000000000, app_name: 'Chrome', win_title: '旧页面', ax_text: '旧片段' },
            { id: 42, ts: 1710000001000, app_name: 'Chrome', win_title: '目标页面', ax_text: '目标片段' },
          ],
        })
      }
      if (url === 'http://localhost:7070/api/bake/captures/42') {
        return jsonResponse({
          id: 42,
          ts: 1710000001000,
          app_name: 'Chrome',
          win_title: '目标页面',
          event_type: 'manual',
          ax_text: '目标片段',
          is_sensitive: false,
          pii_scrubbed: false,
        })
      }
      if (url.includes('/api/bake/captures')) {
        return jsonResponse({
          items: [{
            id: 42,
            ts: 1710000001000,
            app_name: 'Chrome',
            win_title: '目标页面',
            event_type: 'manual',
            ax_text: '目标片段',
            is_sensitive: false,
            pii_scrubbed: false,
          }],
          total: 1,
          limit: 20,
          offset: 0,
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({ repositoryTab: 'memory' })

    render(<RepositoryPanel />)

    await waitFor(() => {
      expect(screen.getByText('#42')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('#42'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/captures?source_capture_id=42&limit=20&offset=0')
    })
    expect(useAppStore.getState().repositoryCaptureSourceCaptureId).toBe('42')
    expect(useAppStore.getState().selectedCaptureId).toBe('42')
  })
})
