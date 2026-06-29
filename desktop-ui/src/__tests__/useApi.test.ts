import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  useFetchBakeCaptures,
  useFetchBakeKnowledge,
  useFetchBakeMemories,
  useFetchBakeSops,
  useFetchBakeTemplates,
} from '../hooks/useApi'
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

  it('请求 timelines 知识接口并保留查询参数', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        entries: [{
          id: 1,
          summary: '摘要 A',
          overview: '概览 A',
          details: '详情 A',
          capture_id: 11,
          importance: 3,
          occurrence_count: 2,
          created_at: '2026-04-11 10:00',
          created_at_ms: 1712800800000,
          capture_ids: [11, 12],
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
      'http://localhost:7070/api/knowledge?q=%E8%AE%BE%E8%AE%A1&from=100&to=200&limit=10&offset=20',
    )
    expect(data.total).toBe(1)
    expect(data.limit).toBe(10)
    expect(data.offset).toBe(20)
    expect(data.items[0]).toMatchObject({
      id: '1',
      title: '摘要 A',
      sourceCaptureId: '11',
      summary: '概览 A',
      createdAt: '2026-04-11 10:00',
      createdAtMs: 1712800800000,
      captureIds: [11, 12],
    })
  })

  it('知识接口返回错误时直接抛错', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'server error' }, 500))

    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFetchBakeMemories())

    await expect(result.current({ limit: 10, offset: 0 })).rejects.toThrow('timelines fetch failed: 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:7070/api/knowledge?limit=10&offset=0',
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

  it('仅请求 bake knowledge 列表并保留筛选和分页参数', async () => {
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
    const data = await result.current({ q: '芝士', from: 100, to: 200, limit: 50, offset: 10 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7070/api/bake/knowledge?q=%E8%8A%9D%E5%A3%AB&from=100&to=200&limit=50&offset=10',
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

describe('useFetchBakeTemplates', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('请求文档列表时保留关键词、日期和分页参数', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [{
        id: 3,
        title: '文档模板',
        doc_type: 'article',
        status: 'draft',
        tags: [],
        applicable_tasks: [],
        source_memory_ids: [],
        source_capture_ids: [],
        source_episode_ids: [],
        linked_knowledge_ids: [],
        sections: [],
        style_phrases: [],
        replacement_rules: [],
        usage_count: 0,
        review_status: 'draft',
        updated_at: '2026-04-11 10:00:00',
      }],
      total: 1,
      limit: 20,
      offset: 0,
    }))

    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFetchBakeTemplates())
    const data = await result.current({ q: '模板', from: 100, to: 200, limit: 20, offset: 0 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7070/api/bake/documents?q=%E6%A8%A1%E6%9D%BF&from=100&to=200&limit=20&offset=0',
    )
    expect(data.items[0]).toMatchObject({
      id: '3',
      title: '文档模板',
      docType: 'article',
    })
  })
})

describe('useFetchBakeSops', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('请求操作列表时保留关键词、日期和分页参数', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [{
        id: 5,
        source_capture_id: '',
        source_timeline_id: '5',
        trigger_keywords: ['导出'],
        confidence: 'medium',
        extracted_problem: '导出文档',
        detailed_content: '',
        steps: ['点击导出'],
        linked_knowledge_ids: [],
        linked_knowledge_summaries: [],
        status: 'confirmed',
        created_at: '2026-04-11 10:00:00',
        created_at_ms: 100,
        updated_at: '2026-04-11 10:00:00',
        updated_at_ms: 100,
      }],
      total: 1,
      limit: 20,
      offset: 0,
    }))

    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFetchBakeSops())
    const data = await result.current({ q: '导出', from: 100, to: 200, limit: 20, offset: 0 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7070/api/bake/sops?q=%E5%AF%BC%E5%87%BA&from=100&to=200&limit=20&offset=0',
    )
    expect(data.items[0]).toMatchObject({
      id: '5',
      extractedProblem: '导出文档',
    })
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
        linked_timeline_id: null,
        linked_timeline_summary: null,
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
