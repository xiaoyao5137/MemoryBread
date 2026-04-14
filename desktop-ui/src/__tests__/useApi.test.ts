import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFetchBakeCaptures, useFetchBakeKnowledge, useFetchBakeMemories } from '../hooks/useApi'
import { useAppStore } from '../store/useAppStore'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

describe('useFetchBakeMemories', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('命中 memories 接口时不回退到 articles', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        memories: [{
          id: 1,
          title: '记忆 A',
          url: 'https://example.com/a',
          source_capture_id: 11,
          source_knowledge_id: 'k-1',
          summary: '摘要 A',
          weight: 3,
          open_count: 4,
          dwell_seconds: 8,
          has_edit_action: true,
          knowledge_ref_count: 2,
          status: 'active',
          suggested_action: 'knowledge',
          tags: ['tag-a'],
          last_visited_at: 123,
          created_at: '2026-04-11 10:00',
          created_at_ms: 1712800800000,
        }],
        total: 1,
        limit: 10,
        offset: 20,
      }))

    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFetchBakeMemories())
    const data = await result.current({ q: '设计', from: 100, to: 200, limit: 10, offset: 20 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:7070/api/bake/memories?q=%E8%AE%BE%E8%AE%A1&from=100&to=200&limit=10&offset=20',
    )
    expect(data.total).toBe(1)
    expect(data.limit).toBe(10)
    expect(data.offset).toBe(20)
    expect(data.items[0]).toMatchObject({
      id: '1',
      title: '记忆 A',
      sourceCaptureId: 11,
      sourceKnowledgeId: 'k-1',
      summary: '摘要 A',
      createdAt: '2026-04-11 10:00',
      createdAtMs: 1712800800000,
    })
  })

  it('memories 返回 404 时回退到 articles，并保留查询参数', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({
        articles: [{
          id: 2,
          title: '记忆 B',
          url: 'https://example.com/b',
          source_capture_id: 22,
          source_knowledge_id: 'k-2',
          summary: '摘要 B',
          weight: 5,
          open_count: 6,
          dwell_seconds: 10,
          has_edit_action: false,
          knowledge_ref_count: 1,
          status: 'active',
          suggested_action: 'template',
          tags: [],
          last_visited_at: 456,
          created_at: '2026-04-10 09:30',
          created_at_ms: 1712712600000,
        }],
        total: 1,
      }))

    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFetchBakeMemories())
    const data = await result.current({ q: '回退', from: 300, to: 400, limit: 5, offset: 15 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:7070/api/bake/memories?q=%E5%9B%9E%E9%80%80&from=300&to=400&limit=5&offset=15',
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:7070/api/bake/articles?q=%E5%9B%9E%E9%80%80&from=300&to=400&limit=5&offset=15',
    )
    expect(data.total).toBe(1)
    expect(data.limit).toBe(5)
    expect(data.offset).toBe(15)
    expect(data.items[0]).toMatchObject({
      id: '2',
      title: '记忆 B',
      sourceCaptureId: 22,
      sourceKnowledgeId: 'k-2',
      summary: '摘要 B',
      createdAt: '2026-04-10 09:30',
      createdAtMs: 1712712600000,
    })
  })

  it('memories 返回非 404 错误时直接抛错，不触发回退', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'server error' }, 500))

    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFetchBakeMemories())

    await expect(result.current({ limit: 10, offset: 0 })).rejects.toThrow('bake memories fetch failed: 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:7070/api/bake/memories?limit=10&offset=0',
    )
  })
})

describe('useFetchBakeKnowledge', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('仅请求 bake knowledge 列表并保留分页参数', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [{
        id: 9,
        capture_id: 12,
        summary: '已提炼知识',
        overview: '概述',
        details: '详情',
        entities: ['芝士'],
        category: 'bake_knowledge',
        importance: 4,
        occurrence_count: 2,
        observed_at: 123,
        updated_at: '2026-04-11 10:00:00',
        updated_at_ms: 456,
      }],
      total: 1,
      limit: 50,
      offset: 10,
    }))

    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFetchBakeKnowledge())
    const data = await result.current({ q: '芝士', limit: 50, offset: 10 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7070/api/bake/knowledge?q=%E8%8A%9D%E5%A3%AB&limit=50&offset=10',
    )
    expect(data.items[0]).toMatchObject({
      id: '9',
      captureId: '12',
      category: 'bake_knowledge',
      summary: '已提炼知识',
    })
    expect(data.total).toBe(1)
    expect(data.limit).toBe(50)
    expect(data.offset).toBe(10)
  })
})

describe('useFetchBakeCaptures', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('拼装关键词、日期和来源片段参数', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [{
        id: 7,
        ts: 1710000000000,
        app_name: 'Chrome',
        app_bundle_id: 'com.google.Chrome',
        win_title: '设计稿页面',
        event_type: 'manual',
        ax_text: 'AX',
        ocr_text: 'OCR',
        input_text: '输入',
        audio_text: null,
        screenshot_path: 'foo.jpg',
        is_sensitive: false,
        pii_scrubbed: false,
        best_text: '最佳文本',
        summary: '设计稿页面',
        linked_knowledge_id: null,
        linked_knowledge_summary: null,
      }],
      total: 1,
      limit: 20,
      offset: 0,
    }))

    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFetchBakeCaptures())
    const data = await result.current({ q: '设计稿', from: 100, to: 200, source_capture_id: 123, limit: 20, offset: 0 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7070/api/bake/captures?q=%E8%AE%BE%E8%AE%A1%E7%A8%BF&from=100&to=200&source_capture_id=123&limit=20&offset=0',
    )
    expect(data.items[0]).toMatchObject({
      id: '7',
      winTitle: '设计稿页面',
      summary: '设计稿页面',
    })
    expect(data.total).toBe(1)
  })
})
