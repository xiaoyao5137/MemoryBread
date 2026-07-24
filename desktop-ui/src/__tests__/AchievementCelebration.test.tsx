import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AchievementCelebration from '../components/AchievementCelebration'

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

describe('AchievementCelebration', () => {
  it('announces the earned card and guides the user to collect it', async () => {
    const onDismiss = vi.fn()
    const onViewCards = vi.fn()
    render(
      <AchievementCelebration
        badges={[overnightBadge]}
        onDismiss={onDismiss}
        onViewCards={onViewCards}
      />,
    )

    expect(screen.getByRole('dialog', { name: '卡片已经烘焙完成' })).toBeInTheDocument()
    expect(screen.getByText('通宵赶稿')).toBeInTheDocument()
    const viewButton = screen.getByRole('button', { name: '去查收' })
    await waitFor(() => expect(viewButton).toHaveFocus())

    fireEvent.click(viewButton)
    expect(onViewCards).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('can be dismissed with Escape without navigating', () => {
    const onDismiss = vi.fn()
    const onViewCards = vi.fn()
    render(
      <AchievementCelebration
        badges={[overnightBadge]}
        onDismiss={onDismiss}
        onViewCards={onViewCards}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onViewCards).not.toHaveBeenCalled()
  })
})
