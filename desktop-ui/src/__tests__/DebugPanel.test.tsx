import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import DebugPanel from '../components/DebugPanel'
import { useAppStore } from '../store/useAppStore'

const mockFetchDebugLogFiles = vi.fn()
const mockFetchDebugLogContent = vi.fn()

vi.mock('../hooks/useApi', () => ({
  useFetchDebugLogFiles: () => mockFetchDebugLogFiles,
  useFetchDebugLogContent: () => mockFetchDebugLogContent,
}))

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.getState().setWindowMode('debug')
  vi.clearAllMocks()

  mockFetchDebugLogFiles.mockResolvedValue([
    {
      key: 'core',
      label: 'core.log · Core Engine',
      exists: true,
      size_bytes: 2048,
      modified_at: 1710000000000,
    },
    {
      key: 'ui',
      label: 'ui.log · Desktop UI',
      exists: false,
      size_bytes: 0,
      modified_at: null,
    },
  ])

  mockFetchDebugLogContent.mockImplementation(async (key: string) => ({
    key,
    label: key === 'core' ? 'core.log · Core Engine' : 'unknown',
    content: key === 'core' ? 'core log line 1\ncore log line 2' : '',
    truncated: key === 'core',
    total_size_bytes: 4096,
    returned_bytes: 1024,
    modified_at: 1710000000000,
  }))

  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    if (input.includes('/api/captures')) {
      return {
        ok: true,
        json: async () => ({ captures: [] }),
      }
    }
    if (input.includes('/api/vector/status')) {
      return {
        ok: true,
        json: async () => ({ items: [] }),
      }
    }
    if (input.includes('/api/stats')) {
      return {
        ok: true,
        json: async () => ({
          total_captures: 10,
          total_vectorized: 6,
          db_size_mb: 12.5,
          last_capture_ts: 1710000000000,
        }),
      }
    }
    if (input.includes('/api/debug/clear-extraction-queue') && init?.method === 'POST') {
      return {
        ok: true,
        json: async () => ({ cleared: 3 }),
      }
    }
    throw new Error(`unexpected fetch: ${input}`)
  }))
})

describe('DebugPanel', () => {
  it('渲染关键排查日志区块并默认加载首个日志', async () => {
    render(<DebugPanel />)

    expect(screen.getByText('关键排查日志')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('core.log · Core Engine')).toBeInTheDocument()
    expect(await screen.findByText(/core log line 1/)).toBeInTheDocument()
    expect(screen.getByText(/当前仅显示最新/)).toBeInTheDocument()
  })

  it('切换到不存在的日志时显示空态提示', async () => {
    mockFetchDebugLogContent.mockImplementation(async (key: string) => {
      if (key === 'core') {
        return {
          key,
          label: 'core.log · Core Engine',
          content: 'core log line 1\ncore log line 2',
          truncated: true,
          total_size_bytes: 4096,
          returned_bytes: 1024,
          modified_at: 1710000000000,
        }
      }

      throw new Error(`should not fetch missing log: ${key}`)
    })

    render(<DebugPanel />)

    expect(await screen.findByText(/core log line 1/)).toBeInTheDocument()

    const logSelect = await screen.findByDisplayValue('core.log · Core Engine')
    fireEvent.change(logSelect, {
      target: { value: 'ui' },
    })

    expect(await screen.findByText(/当前日志文件尚未生成/)).toBeInTheDocument()
    expect(screen.queryByText(/core log line 1/)).not.toBeInTheDocument()
    expect(mockFetchDebugLogContent).toHaveBeenCalledTimes(1)
  })
})
