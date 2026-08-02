import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useImeCompositionGuard } from '../hooks/useImeCompositionGuard'

const GuardHarness = ({ onSubmit }: { onSubmit: () => void }) => {
  const imeGuard = useImeCompositionGuard<HTMLInputElement>()

  return (
    <form
      aria-label="测试表单"
      onSubmit={(event) => {
        event.preventDefault()
        if (!imeGuard.shouldBlockSubmit()) onSubmit()
      }}
    >
      <input
        aria-label="测试输入框"
        onCompositionStart={imeGuard.onCompositionStart}
        onCompositionEnd={imeGuard.onCompositionEnd}
        onBlur={imeGuard.onBlur}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter'
            && !event.shiftKey
            && !imeGuard.isImeEvent(event)
          ) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
    </form>
  )
}

describe('useImeCompositionGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('组合输入期间按 Enter 只确认输入法，不触发动作或取消默认行为', () => {
    const onSubmit = vi.fn()
    render(<GuardHarness onSubmit={onSubmit} />)
    const input = screen.getByLabelText('测试输入框')

    fireEvent.compositionStart(input)
    const defaultAllowed = fireEvent.keyDown(input, {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
    })

    expect(defaultAllowed).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('兼容 WebKit 先 compositionend 后 Enter keydown 的事件顺序', () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const onSubmit = vi.fn()
    render(<GuardHarness onSubmit={onSubmit} />)
    const input = screen.getByLabelText('测试输入框')

    fireEvent.compositionStart(input)
    fireEvent.compositionEnd(input, { data: '你好' })
    const defaultAllowed = fireEvent.keyDown(input, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      isComposing: false,
    })

    expect(defaultAllowed).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()

    now += 51
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })).toBe(false)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('阻止输入法 Enter 引起的后续隐式表单提交', () => {
    const onSubmit = vi.fn()
    render(<GuardHarness onSubmit={onSubmit} />)
    const input = screen.getByLabelText('测试输入框')
    const form = screen.getByRole('form', { name: '测试表单' })

    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
    })
    fireEvent.submit(form)

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('保留 Shift+Enter，并在失焦后允许正常 Enter', () => {
    const onSubmit = vi.fn()
    render(<GuardHarness onSubmit={onSubmit} />)
    const input = screen.getByLabelText('测试输入框')

    expect(fireEvent.keyDown(input, {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
    })).toBe(true)

    fireEvent.compositionStart(input)
    fireEvent.compositionEnd(input)
    fireEvent.blur(input)
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })).toBe(false)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
