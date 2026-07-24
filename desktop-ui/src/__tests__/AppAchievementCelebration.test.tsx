import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { useAppStore } from '../store/useAppStore'

const mocks = vi.hoisted(() => ({
  fetchConsoleSummary: vi.fn(),
  fetchCurrentUser: vi.fn(),
  syncEligibleAchievementTasks: vi.fn(),
  synchronizeWorkProfile: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}))

vi.mock('../utils/authApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/authApi')>()),
  fetchConsoleSummary: mocks.fetchConsoleSummary,
  fetchCurrentUser: mocks.fetchCurrentUser,
}))

vi.mock('../utils/achievementTasks', () => ({
  syncEligibleAchievementTasks: mocks.syncEligibleAchievementTasks,
}))

vi.mock('../utils/workProfileCloud', () => ({
  synchronizeWorkProfile: mocks.synchronizeWorkProfile,
}))

vi.mock('../components/RagPanel.v2', () => ({
  default: () => <section data-testid="rag-panel" />,
}))

vi.mock('../components/AuthPanel', () => ({
  default: ({
    highlightedAchievementKeys = [],
    initialProfileSection,
  }: {
    highlightedAchievementKeys?: string[]
    initialProfileSection?: string
  }) => (
    <section data-testid="auth-panel-target">
      {initialProfileSection || 'personal'}:{highlightedAchievementKeys.join(',')}
    </section>
  ),
}))

vi.mock('../components/SystemFloatingAssist', () => ({
  default: () => <section data-testid="floating-assist" />,
}))

const user = {
  id: 'user-celebration',
  username: '小麦',
  status: 'active',
  roles: ['user'],
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  created_at: '2026-07-21T00:00:00Z',
}

const overnightBadge = {
  id: 'badge-overnight',
  badge_key: 'overnight_writer',
  name: '通宵赶稿',
  tagline: '月落前还在落笔',
  description: '一个自然周内，曾在某个本地夜晚从 0 点到 6 点保持连续有效工作。',
  icon_key: 'moon',
  palette_key: 'midnight',
  rarity: 'rare' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.getState().reset()
  useAppStore.getState().setHasCompletedSetup(true)
  useAppStore.getState().setAuthSession({
    access_token: 'mbs_celebration_token',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    user,
  })
  mocks.fetchCurrentUser.mockResolvedValue(user)
  mocks.fetchConsoleSummary.mockResolvedValue({})
  mocks.synchronizeWorkProfile.mockResolvedValue(null)
  mocks.syncEligibleAchievementTasks.mockResolvedValue([overnightBadge])
})

describe('App achievement celebration', () => {
  it('celebrates on the main panel and opens the highlighted card collection', async () => {
    render(<App />)

    expect(screen.getByTestId('rag-panel')).toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: '卡片已经烘焙完成' })).toBeInTheDocument()
    expect(mocks.syncEligibleAchievementTasks).toHaveBeenCalledWith(expect.objectContaining({
      authToken: 'mbs_celebration_token',
    }))

    fireEvent.click(screen.getByRole('button', { name: '去查收' }))

    await waitFor(() => {
      expect(useAppStore.getState().windowMode).toBe('account')
      expect(screen.getByTestId('auth-panel-target')).toHaveTextContent('achievements:overnight_writer')
    })
    expect(screen.queryByTestId('achievement-celebration')).not.toBeInTheDocument()
  })
})
