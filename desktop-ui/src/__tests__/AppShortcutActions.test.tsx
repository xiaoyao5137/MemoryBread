import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import App from '../App'
import { useAppStore } from '../store/useAppStore'
import type { ShortcutAction } from '../utils/interactionSettings'

const shortcutRuntime = vi.hoisted(() => ({
  handler: null as null | ((action: ShortcutAction) => void | Promise<void>),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}))

vi.mock('../utils/interactionSettings', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/interactionSettings')>()
  return {
    ...actual,
    startGlobalShortcutRuntime: vi.fn((handler: (action: ShortcutAction) => void | Promise<void>) => {
      shortcutRuntime.handler = handler
      return vi.fn()
    }),
  }
})

vi.mock('../components/FloatingBuddy', () => ({ default: () => <aside /> }))
vi.mock('../components/RagPanel.v2', () => ({ default: () => <section data-testid="rag-panel" /> }))
vi.mock('../components/CreationPanel', () => ({ default: () => <section data-testid="creation-panel" /> }))
vi.mock('../components/ActionConfirm', () => ({ default: () => null }))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.getState().setHasCompletedSetup(true)
  shortcutRuntime.handler = null
  mockedInvoke.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
})

describe('App global shortcut actions', () => {
  it('打开目标页面并把当屏识别交给悬浮球原生动作队列', async () => {
    render(<App />)
    expect(shortcutRuntime.handler).not.toBeNull()

    await act(async () => {
      await shortcutRuntime.handler?.('open_creation')
    })
    expect(useAppStore.getState().windowMode).toBe('creation')
    expect(mockedInvoke).toHaveBeenCalledWith('show_main_panel_from_floating_assist')

    await act(async () => {
      await shortcutRuntime.handler?.('open_consult')
    })
    expect(useAppStore.getState().windowMode).toBe('rag')

    await act(async () => {
      await shortcutRuntime.handler?.('recognize_screen_task')
    })
    expect(mockedInvoke).toHaveBeenCalledWith('trigger_floating_assist_action', {
      action: 'recognize_screen_task',
    })
  })
})
