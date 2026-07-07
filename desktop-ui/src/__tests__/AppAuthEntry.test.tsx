import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import App from '../App'
import { useAppStore } from '../store/useAppStore'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}))

vi.mock('../components/RagPanel.v2', () => ({
  default: () => <section data-testid="rag-panel" />,
}))

vi.mock('../components/BakePanel', () => ({
  default: () => <section data-testid="bake-panel" />,
}))

vi.mock('../components/RepositoryPanel', () => ({
  default: () => <section data-testid="repository-panel" />,
}))

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.getState().setHasCompletedSetup(true)
  useAppStore.getState().clearAuthSession()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
})

describe('App auth entry', () => {
  it('未登录也直接进入主界面，并在侧栏显示未登录入口', async () => {
    render(<App />)

    expect(screen.getByTestId('floating-buddy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '未登录，打开登录' })).toBeInTheDocument()
    expect(screen.queryByTestId('auth-panel')).not.toBeInTheDocument()
  })

  it('打开具体 RAG 引用时才生成返回栈', () => {
    render(<App />)

    act(() => {
      window.dispatchEvent(new CustomEvent('view-rag-reference', {
        detail: { type: 'document', documentId: '42' },
      }))
    })

    expect(screen.getByTestId('bake-panel')).toBeInTheDocument()
    expect(useAppStore.getState().bakeNavigationStack).toEqual([{ windowMode: 'rag' }])
  })

  it('无具体目标的引用跳转会清除旧返回栈', () => {
    useAppStore.getState().pushBakeNavigationTarget({ windowMode: 'creation' })
    render(<App />)

    act(() => {
      window.dispatchEvent(new CustomEvent('view-rag-reference', {
        detail: { type: 'document' },
      }))
    })

    expect(screen.getByTestId('bake-panel')).toBeInTheDocument()
    expect(useAppStore.getState().bakeNavigationStack).toHaveLength(0)
    expect(useAppStore.getState().captureBackTarget).toBeNull()
  })
})
