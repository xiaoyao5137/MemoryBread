import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import Settings from '../components/Settings'
import { useAppStore } from '../store/useAppStore'

beforeEach(() => {
  useAppStore.getState().reset()
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ preferences: [], items: [] }),
  })))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Settings debug mode visibility', () => {
  it('普通启动时隐藏本机服务配置和开发者工具', async () => {
    render(<Settings />)

    expect(screen.queryByTestId('settings-api-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-debug-section')).not.toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('调试模式下显示本机服务配置和开发者工具', async () => {
    useAppStore.setState({ debugModeEnabled: true })

    render(<Settings />)

    expect(screen.getByTestId('settings-api-section')).toBeInTheDocument()
    expect(screen.getByTestId('api-url-input')).toBeInTheDocument()
    expect(screen.getByTestId('settings-debug-section')).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })
})
