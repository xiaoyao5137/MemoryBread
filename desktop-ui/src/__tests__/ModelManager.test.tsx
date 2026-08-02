import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModelManager from '../components/ModelManager'
import { useAppStore } from '../store/useAppStore'

const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
}) as Response

beforeEach(() => {
  window.localStorage?.clear()
  useAppStore.getState().reset()
  useAppStore.setState({
    authToken: null,
    currentUser: null,
    cloudBalance: null,
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/models')) {
      return response({
        status: 'ok',
        models: [{
          id: 'mbem-v1-local',
          name: 'MBEM v1.0',
          category: 'llm',
          provider: 'ollama',
          size_gb: 3.4,
          description: '分析模型',
          status: 'active',
          is_active: true,
          is_default: true,
          requires_api_key: false,
          recommended: true,
        }],
      })
    }
    if (url.endsWith('/api/ollama/setup-status')) {
      return response({
        status: 'ok',
        detail: {
          ollama_installed: true,
          ollama_running: true,
          version_compatible: true,
        },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('模型管理', () => {
  it('采集分析模型只展示一个使用中状态', async () => {
    render(<ModelManager />)

    await waitFor(() => {
      expect(screen.getAllByText('使用中')).toHaveLength(1)
    })
  })

  it('本地创作模型展示容量并提供体验入口', async () => {
    render(<ModelManager />)
    await screen.findAllByText('MBEM v1.0')
    fireEvent.click(screen.getByRole('button', { name: '创作模型' }))

    expect(screen.getByText('3.4GB')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '体验' }))

    expect(screen.getByText('体验 MBEM v1.0')).toBeInTheDocument()
  })
})
