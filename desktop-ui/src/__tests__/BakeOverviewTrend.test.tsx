import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import BakeOverviewTab from '../components/bake/BakeOverviewTab'
import type { BakeInventoryTrendBucket, BakeOverview } from '../types'

const DAY_MS = 86_400_000

const createBucket = (day: number, memoryCount: number): BakeInventoryTrendBucket => {
  const startTs = new Date(2026, 5, day).getTime()
  return {
    label: `2026-06-${String(day).padStart(2, '0')}`,
    startTs,
    endTs: startTs + DAY_MS - 1,
    memoryCount,
    knowledgeCount: day % 3,
    templateCount: day % 2,
    sopCount: day % 4,
  }
}

const overview: BakeOverview = {
  captureCount: 0,
  memoryCount: 12,
  knowledgeCount: 4,
  templateCount: 3,
  sopCount: 2,
  pendingCandidates: 0,
  recentActivities: [],
  inventoryTrend: Array.from({ length: 12 }, (_, index) => createBucket(index + 1, index + 1)),
}

const noop = vi.fn()

describe('BakeOverviewTab 趋势图', () => {
  it('提供时间范围控件并使用紧凑横轴日期', () => {
    render(<BakeOverviewTab overview={overview} onOpenTab={noop} onOpenRepository={noop} />)

    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '7天' })).toBeInTheDocument()
    expect(screen.getByText('06/01')).toBeInTheDocument()
    expect(screen.queryByText('2026-06-01')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '7天' }))

    expect(screen.getByRole('button', { name: '7天' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('鼠标悬浮趋势图时显示当前数据桶详情', () => {
    const { container } = render(<BakeOverviewTab overview={overview} onOpenTab={noop} onOpenRepository={noop} />)
    const chart = container.querySelector('.bake-trend-chart')
    expect(chart).not.toBeNull()
    vi.spyOn(chart as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 720,
      height: 248,
      right: 720,
      bottom: 248,
      toJSON: () => ({}),
    })

    fireEvent.mouseMove(chart as HTMLDivElement, { clientX: 720 })

    expect(screen.getByText('2026-06-12')).toBeInTheDocument()
    expect(screen.getByText('合计 12')).toBeInTheDocument()

    fireEvent.mouseMove(chart as HTMLDivElement, { clientX: 0 })

    expect(screen.getByText('2026-06-01')).toBeInTheDocument()
    expect(screen.getByText('合计 4')).toBeInTheDocument()
  })
})
