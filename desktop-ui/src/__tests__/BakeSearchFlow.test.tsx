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
    expect(screen.queryByText('关键词：芝士')).not.toBeInTheDocument()
  })

  it('BakePanel 知识搜索无结果后不保留旧详情', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/models')) return jsonResponse({ ollama: true, llm: true, embedding: true })
      if (url.includes('/api/bake/overview')) return jsonResponse(overviewResponse)
      if (url.includes('/api/bake/knowledge?q=')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 })
      if (url.includes('/api/bake/knowledge')) return jsonResponse({
        items: [{
          id: 7,
          summary: '旧知识条目',
          overview: '旧知识详情',
          details: '',
          category: '文档',
          importance: 4,
          occurrence_count: 1,
          status: 'confirmed',
          review_status: 'confirmed',
          entities: [],
          created_at: '2026-04-11 09:30',
          created_at_ms: 0,
          updated_at: '2026-04-11 09:30',
          updated_at_ms: 0,
        }],
        total: 1,
        limit: 20,
        offset: 0,
      })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({ bakeTab: 'knowledge' })

    render(<BakePanel />)

    expect((await screen.findAllByText('旧知识条目')).length).toBeGreaterThan(0)

    fireEvent.change(screen.getByPlaceholderText('搜索知识摘要、概述、详情或分类'), { target: { value: '不存在' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    await waitFor(() => {
      expect(screen.getByText('当前筛选条件下没有可展示的知识条目。')).toBeInTheDocument()
    })
    expect(screen.queryByText('旧知识详情')).not.toBeInTheDocument()
    expect(screen.queryByText('关键词：不存在')).not.toBeInTheDocument()
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

  it('BakePanel 关联知识跳转只展示目标知识，清除后恢复列表', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/models')) return jsonResponse({ ollama: true, llm: true, embedding: true })
      if (url.includes('/api/bake/overview')) return jsonResponse(overviewResponse)
      if (url === 'http://localhost:7070/api/bake/knowledge/9') {
        return jsonResponse({
          id: 9,
          capture_id: 12,
          summary: '目标知识',
          overview: '目标详情',
          details: '',
          category: '文档',
          importance: 4,
          occurrence_count: 1,
          status: 'confirmed',
          review_status: 'confirmed',
          entities: [],
          updated_at: '2026-04-11 10:00:00',
          updated_at_ms: 1,
        })
      }
      if (url === 'http://localhost:7070/api/bake/knowledge?limit=20&offset=0') {
        return jsonResponse({
          items: [{
            id: 8,
            capture_id: 11,
            summary: '普通知识',
            overview: '普通详情',
            details: '',
            category: '文档',
            importance: 3,
            occurrence_count: 1,
            status: 'confirmed',
            review_status: 'confirmed',
            entities: [],
            updated_at: '2026-04-11 09:00:00',
            updated_at_ms: 1,
          }],
          total: 1,
          limit: 20,
          offset: 0,
        })
      }
      if (url.includes('/api/knowledge')) return jsonResponse({ entries: [], total: 0, limit: 1000, offset: 0 })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({
      bakeTab: 'knowledge',
      bakeKnowledgeFocusId: '9',
      selectedKnowledgeId: '9',
    })

    render(<BakePanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/knowledge/9')
    })
    expect(screen.getAllByText('目标知识').length).toBeGreaterThan(0)
    expect(screen.getByText('仅看知识 #9')).toBeInTheDocument()
    expect(screen.queryByText('普通知识')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '查看全部' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/bake/knowledge?limit=20&offset=0')
    })
    expect(useAppStore.getState().bakeKnowledgeFocusId).toBeNull()
  })

  it('RepositoryPanel 展示采集标题以及情节记忆创建时间', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/knowledge')) {
        return jsonResponse({
          entries: [{
            id: 1,
            summary: '周报情节记忆',
            overview: '整理周报提纲',
            capture_id: 42,
            importance: 6,
            occurrence_count: 3,
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
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/knowledge?limit=20&offset=0')
    })

    expect(screen.getByText('采集')).toBeInTheDocument()
    expect(screen.getAllByText('创建于 2026-04-11 09:30').length).toBeGreaterThan(1)
  })

  it('RepositoryPanel 情节记忆搜索只有点击搜索后才发起带筛选请求', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/knowledge')) return jsonResponse({ entries: [], total: 0, limit: 20, offset: 0 })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({ repositoryTab: 'memory' })

    render(<RepositoryPanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/knowledge?limit=20&offset=0')
    })

    const callsBeforeTyping = fetchMock.mock.calls.length
    fireEvent.change(screen.getByPlaceholderText('搜索时间线标题、摘要或详情'), { target: { value: '周报' } })
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-04-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-04-11' } })

    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeTyping)

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/knowledge?q=%E5%91%A8%E6%8A%A5&from=1774972800000&to=1775923199999&limit=20&offset=0')
    })
    expect(screen.queryByText('关键词：周报')).not.toBeInTheDocument()
  })

  it('RepositoryPanel 时间线搜索无结果后不保留旧详情', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/knowledge?q=')) return jsonResponse({ entries: [], total: 0, limit: 20, offset: 0 })
      if (url.includes('/api/knowledge')) return jsonResponse({
        entries: [{
          id: 1,
          summary: '旧时间线',
          overview: '旧时间线摘要',
          capture_id: 42,
          importance: 6,
          occurrence_count: 3,
          created_at: '2026-04-11 09:30',
          created_at_ms: 0,
        }],
        total: 1,
        limit: 20,
        offset: 0,
      })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({ repositoryTab: 'memory' })

    render(<RepositoryPanel />)

    expect((await screen.findAllByText('旧时间线')).length).toBeGreaterThan(0)

    fireEvent.change(screen.getByPlaceholderText('搜索时间线标题、摘要或详情'), { target: { value: '不存在' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    await waitFor(() => {
      expect(screen.getByText('当前筛选条件下没有可浏览的时间线。')).toBeInTheDocument()
    })
    expect(screen.queryByText('旧时间线摘要')).not.toBeInTheDocument()
    expect(screen.queryByText('关键词：不存在')).not.toBeInTheDocument()
  })

  it('RepositoryPanel 时间线跳转只展示目标时间线，清除后恢复列表', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:7070/api/knowledge/7') {
        return jsonResponse({
          id: 7,
          summary: '目标时间线',
          overview: '目标时间线摘要',
          capture_id: 71,
          importance: 5,
          occurrence_count: 1,
          created_at: '2026-04-11 10:00',
          created_at_ms: 1,
          capture_ids: [],
        })
      }
      if (url === 'http://localhost:7070/api/knowledge?limit=20&offset=0') {
        return jsonResponse({
          entries: [{
            id: 6,
            summary: '普通时间线',
            overview: '普通时间线摘要',
            capture_id: 61,
            importance: 3,
            occurrence_count: 1,
            created_at: '2026-04-11 09:00',
            created_at_ms: 1,
            capture_ids: [],
          }],
          total: 1,
          limit: 20,
          offset: 0,
        })
      }
      if (url.includes('/api/bake/documents') || url.includes('/api/bake/knowledge') || url.includes('/api/bake/sops')) {
        return jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    useAppStore.setState({
      repositoryTab: 'memory',
      repositoryMemoryFocusId: '7',
      selectedMemoryId: '7',
    })

    render(<RepositoryPanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/knowledge/7')
    })
    expect(screen.getAllByText('目标时间线').length).toBeGreaterThan(0)
    expect(screen.getByText('仅看时间线 #7')).toBeInTheDocument()
    expect(screen.queryByText('普通时间线')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '查看全部' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7070/api/knowledge?limit=20&offset=0')
    })
    expect(useAppStore.getState().repositoryMemoryFocusId).toBeNull()
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
    expect(screen.getByText('仅看来源 ID #123')).toBeInTheDocument()

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
      if (url.includes('/api/knowledge')) {
        return jsonResponse({
          entries: [{
            id: 1,
            summary: '周报情节记忆',
            overview: '整理周报提纲',
            capture_id: 41,
            importance: 6,
            occurrence_count: 3,
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
