import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Settings from '../components/Settings'
import { useAppStore } from '../store/useAppStore'

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.setState({
    debugModeEnabled: false,
    localDebugModeEnabled: false,
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ preferences: [], items: [] }),
  })))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Settings debug mode visibility', () => {
  it('普通启动时展示调试模式和开发者工具入口', async () => {
    render(<Settings />)

    expect(screen.getByTestId('settings-debug-section')).toBeInTheDocument()
    expect(screen.getByTestId('open-debug-btn')).toBeInTheDocument()
    expect(screen.getByTestId('debug-mode-toggle')).not.toBeChecked()
    expect(screen.queryByTestId('settings-api-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-debug-mode-toggle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('open-debug-btn'))
    expect(useAppStore.getState().windowMode).toBe('debug')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('普通账号开启调试模式后仍隐藏本机服务配置', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByTestId('debug-mode-toggle'))

    await waitFor(() => expect(screen.getByTestId('debug-mode-toggle')).toBeChecked())
    expect(screen.queryByTestId('settings-api-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('local-debug-mode-toggle')).toBeInTheDocument()
    expect(useAppStore.getState().debugModeEnabled).toBe(true)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('测试账号开启调试模式后显示本机服务配置', async () => {
    useAppStore.setState({
      currentUser: {
        id: '01900000-0000-7000-8000-000000000001',
        status: 'active',
        roles: ['user'],
        feature_flags: ['local_service_settings'],
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        created_at: '2026-07-18T00:00:00Z',
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByTestId('debug-mode-toggle'))

    await waitFor(() => expect(screen.getByTestId('debug-mode-toggle')).toBeChecked())
    expect(screen.getByTestId('settings-api-section')).toBeInTheDocument()
    expect(screen.getByTestId('api-url-input')).toBeInTheDocument()
    expect(screen.getByTestId('local-debug-mode-toggle')).toBeInTheDocument()
    expect(useAppStore.getState().debugModeEnabled).toBe(true)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })
})
