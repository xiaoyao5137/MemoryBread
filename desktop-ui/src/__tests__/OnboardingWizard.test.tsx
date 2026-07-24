import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OnboardingWizard from '../components/OnboardingWizard'
import { useAppStore } from '../store/useAppStore'
import type { ModelEntry } from '../types'

const hardware = {
  memory_gb: 16,
  cpu_cores: 8,
  disk_free_gb: 120,
  has_gpu: true,
}

const model = (
  id: 'mbem-v1-local' | 'bge-small-zh',
  category: 'llm' | 'embedding',
  status: ModelEntry['status'],
): ModelEntry => ({
  id,
  name: id === 'mbem-v1-local' ? 'MBEM v1.0' : 'BGE Small',
  category,
  provider: 'ollama',
  size_gb: id === 'mbem-v1-local' ? 2.3 : 0.05,
  description: 'test model',
  status,
  is_active: status === 'active',
  is_default: true,
  requires_api_key: false,
  recommended: true,
})

const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
}) as Response

const flushPromises = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  window.localStorage?.clear()
  useAppStore.getState().reset()
  useAppStore.setState({ hasCompletedSetup: false, setupSkipped: false, windowMode: 'rag' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('首次安装初始化引导', () => {
  it('DMG 冷启动时本地服务尚未就绪会自动重试检测', async () => {
    vi.useFakeTimers()
    let setupCalls = 0
    let modelCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/models/hardware')) {
        return response({ status: 'ok', hardware, recommendation: { tier: 'high', reason: '配置充足' } })
      }
      if (url.endsWith('/api/ollama/setup-status')) {
        setupCalls += 1
        if (setupCalls === 1) throw new Error('sidecar is starting')
        return response({ status: 'ok', detail: { ollama_installed: false, ollama_running: false } })
      }
      if (url.includes('/api/models?category=llm')) {
        modelCalls += 1
        if (modelCalls === 1) throw new Error('model api is starting')
        return response({ status: 'ok', models: [model('mbem-v1-local', 'llm', 'not_installed')] })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<OnboardingWizard />)
    await flushPromises()
    expect(setupCalls).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '开始配置' }))
    await flushPromises()
    expect(modelCalls).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

    expect(setupCalls).toBeGreaterThanOrEqual(3)
    expect(modelCalls).toBe(2)
    expect(screen.getByRole('radio', { name: /MBEM v1\.0/ })).toBeInTheDocument()
  })

  it('没有 Homebrew 和本地运行环境时提供官方下载安装入口', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/models/hardware')) {
        return response({ status: 'ok', hardware, recommendation: { tier: 'high', reason: '配置充足' } })
      }
      if (url.endsWith('/api/ollama/setup-status')) {
        return response({
          status: 'ok',
          detail: {
            ollama_installed: false,
            ollama_running: false,
            brew_available: false,
            can_auto_install: false,
            version_compatible: true,
            minimum_macos_major: 14,
            official_download_url: 'https://ollama.com/download/mac',
          },
        })
      }
      if (url.includes('/api/models?category=llm')) {
        return response({ status: 'ok', models: [model('mbem-v1-local', 'llm', 'not_installed')] })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<OnboardingWizard />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: '开始配置' }))
    await flushPromises()

    expect(screen.getByText('本地运行环境尚未就绪')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开官方下载页' }))

    expect(open).toHaveBeenCalledWith(
      'https://ollama.com/download/mac',
      '_blank',
      'noopener,noreferrer',
    )
    expect(screen.getByText(/返回这里点击“重新检测”/)).toBeInTheDocument()
  })

  it('有 Homebrew 时可自动安装并启动本地运行环境', async () => {
    let running = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/models/hardware')) {
        return response({ status: 'ok', hardware, recommendation: { tier: 'high', reason: '配置充足' } })
      }
      if (url.endsWith('/api/ollama/setup-status')) {
        return response({
          status: 'ok',
          detail: {
            ollama_installed: running,
            ollama_running: running,
            brew_available: true,
            can_auto_install: true,
            version_compatible: true,
          },
        })
      }
      if (url.includes('/api/models?category=llm')) {
        return response({ status: 'ok', models: [model('mbem-v1-local', 'llm', 'not_installed')] })
      }
      if (url.endsWith('/api/ollama/install') && init?.method === 'POST') {
        return response({ status: 'ok' })
      }
      if (url.endsWith('/api/ollama/start') && init?.method === 'POST') {
        running = true
        return response({ status: 'ok' })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OnboardingWizard />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: '开始配置' }))
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: '自动安装并启动' }))
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7071/api/ollama/install',
      { method: 'POST' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7071/api/ollama/start',
      { method: 'POST' },
    )
    expect(screen.getByText('本地运行环境已就绪')).toBeInTheDocument()
  })

  it('阻止跳过未安装的文本和向量模型，并在两者下载启用后完成配置', async () => {
    vi.useFakeTimers()
    let llmReady = false
    let embeddingReady = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method || 'GET'
      if (url.endsWith('/api/models/hardware')) {
        return response({ status: 'ok', hardware, recommendation: { tier: 'high', reason: '配置充足' } })
      }
      if (url.endsWith('/api/ollama/setup-status')) {
        return response({
          status: 'ok',
          detail: {
            ollama_installed: true,
            ollama_running: true,
            can_auto_install: true,
            version_compatible: true,
          },
        })
      }
      if (url.includes('/api/models?category=llm')) {
        return response({ status: 'ok', models: [model('mbem-v1-local', 'llm', llmReady ? 'active' : 'not_installed')] })
      }
      if (url.includes('/api/models?category=embedding')) {
        return response({ status: 'ok', models: [model('bge-small-zh', 'embedding', embeddingReady ? 'active' : 'not_installed')] })
      }
      if (url.endsWith('/api/models/mbem-v1-local/download') && method === 'POST') {
        return response({ status: 'ok' })
      }
      if (url.endsWith('/api/models/mbem-v1-local/status')) {
        llmReady = true
        return response({ status: 'active', download_progress: 100 })
      }
      if (url.endsWith('/api/models/mbem-v1-local/activate') && method === 'POST') {
        return response({ status: 'ok' })
      }
      if (url.endsWith('/api/models/bge-small-zh/download') && method === 'POST') {
        return response({ status: 'ok' })
      }
      if (url.endsWith('/api/models/bge-small-zh/status')) {
        embeddingReady = true
        return response({ status: 'active', download_progress: 100 })
      }
      if (url.endsWith('/api/models/bge-small-zh/activate') && method === 'POST') {
        return response({ status: 'ok' })
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OnboardingWizard />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: '开始配置' }))
    await flushPromises()
    fireEvent.click(screen.getByRole('radio', { name: /MBEM v1\.0/ }))

    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    expect(screen.getByText('完成模型下载后才能进入下一步。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /下载 MBEM v1\.0/ }))
    await flushPromises()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await flushPromises()
    fireEvent.click(screen.getByRole('radio', { name: /本地语义索引/ }))

    expect(screen.getByRole('button', { name: '完成配置' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /下载 本地语义索引/ }))
    await flushPromises()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(screen.getByRole('button', { name: '完成配置' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '完成配置' }))
    await flushPromises()

    expect(useAppStore.getState().hasCompletedSetup).toBe(true)
    expect(window.localStorage?.getItem('memory-bread_setup_done')).toBe('true')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7071/api/models/mbem-v1-local/activate',
      { method: 'POST' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7071/api/models/bge-small-zh/activate',
      { method: 'POST' },
    )
  })

  it('下载失败时结束进度轮询并保留在当前步骤供重试', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/models/hardware')) {
        return response({ status: 'ok', hardware, recommendation: { tier: 'high', reason: '配置充足' } })
      }
      if (url.endsWith('/api/ollama/setup-status')) {
        return response({ status: 'ok', detail: { ollama_installed: true, ollama_running: true, version_compatible: true } })
      }
      if (url.includes('/api/models?category=llm')) {
        return response({ status: 'ok', models: [model('mbem-v1-local', 'llm', 'not_installed')] })
      }
      if (url.endsWith('/api/models/mbem-v1-local/download') && init?.method === 'POST') {
        return response({ status: 'ok' })
      }
      if (url.endsWith('/api/models/mbem-v1-local/status')) {
        return response({ status: 'error', error: '下载失败，请检查网络和本地运行环境' })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<OnboardingWizard />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: '开始配置' }))
    await flushPromises()
    fireEvent.click(screen.getByRole('radio', { name: /MBEM v1\.0/ }))
    fireEvent.click(screen.getByRole('button', { name: /下载 MBEM v1\.0/ }))
    await flushPromises()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(screen.getByRole('alert')).toHaveTextContent('下载失败，请检查网络和本地运行环境')
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    expect(screen.queryByText(/正在下载/)).not.toBeInTheDocument()
  })

  it('模型启用接口失败时不会越过当前步骤', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/models/hardware')) {
        return response({ status: 'ok', hardware, recommendation: { tier: 'high', reason: '配置充足' } })
      }
      if (url.endsWith('/api/ollama/setup-status')) {
        return response({ status: 'ok', detail: { ollama_installed: true, ollama_running: true, version_compatible: true } })
      }
      if (url.includes('/api/models?category=llm')) {
        return response({ status: 'ok', models: [model('mbem-v1-local', 'llm', 'active')] })
      }
      if (url.endsWith('/api/models/mbem-v1-local/activate') && init?.method === 'POST') {
        return response({ status: 'error', message: '模型启用失败' }, false)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<OnboardingWizard />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: '开始配置' }))
    await flushPromises()
    fireEvent.click(screen.getByRole('radio', { name: /MBEM v1\.0/ }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await flushPromises()

    expect(screen.getByText('选择本地分析模型')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('模型启用失败')
  })

  it('明确跳过时保存标记并退出初始化引导', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/models/hardware')) {
        return response({ status: 'ok', hardware, recommendation: { tier: 'high', reason: '配置充足' } })
      }
      if (url.endsWith('/api/ollama/setup-status')) {
        return response({ status: 'ok', detail: { ollama_installed: false, ollama_running: false } })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<OnboardingWizard />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: '跳过，稍后配置' }))

    expect(useAppStore.getState().setupSkipped).toBe(true)
    expect(window.localStorage?.getItem('memory-bread_setup_skipped')).toBe('true')
    expect(useAppStore.getState().windowMode).toBe('rag')
  })
})
