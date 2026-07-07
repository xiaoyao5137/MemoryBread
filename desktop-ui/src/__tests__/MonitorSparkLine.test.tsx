import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SparkLine } from '../components/MonitorPanel'

describe('MonitorPanel SparkLine', () => {
  it('鼠标在 SVG 上移动时按当前位置切换 hover 时间点', () => {
    const { container } = render(
      <SparkLine
        data={[
          { ts: 1_000, value: 1 },
          { ts: 2_000, value: 9 },
        ]}
        detailFormatter={(point) => `${point.ts}:${point.value}`}
      />,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    vi.spyOn(svg as SVGSVGElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 200,
      height: 40,
      right: 200,
      bottom: 40,
      toJSON: () => ({}),
    })

    fireEvent.mouseMove(svg as SVGSVGElement, { clientX: 0 })
    expect(screen.getByText('1000:1')).toBeInTheDocument()

    fireEvent.mouseMove(svg as SVGSVGElement, { clientX: 200 })
    expect(screen.getByText('2000:9')).toBeInTheDocument()
  })
})
