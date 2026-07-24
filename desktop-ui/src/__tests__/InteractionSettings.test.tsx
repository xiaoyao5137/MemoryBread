import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import InteractionSettings from '../components/InteractionSettings'
import {
  INTERACTION_SETTINGS_KEY,
  readInteractionSettings,
} from '../utils/interactionSettings'

describe('InteractionSettings', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('展示默认快捷键和悬浮球动作', () => {
    render(<InteractionSettings />)

    expect(screen.getByRole('button', { name: '打开咨询页快捷键' })).toHaveTextContent(/Alt/)
    expect(screen.getByRole('combobox', { name: '单击悬浮球' })).toHaveValue('open_floating_consult')
    expect(screen.getByRole('combobox', { name: '双击悬浮球' })).toHaveValue('open_main_panel')
  })

  it('录制快捷键后立即保存', async () => {
    render(<InteractionSettings />)
    const recorder = screen.getByRole('button', { name: '打开咨询页快捷键' })

    fireEvent.click(recorder)
    expect(recorder).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(recorder, {
      key: 'q',
      code: 'KeyQ',
      ctrlKey: true,
      altKey: true,
    })

    await waitFor(() => {
      expect(readInteractionSettings().shortcuts.open_consult).toBe('CommandOrControl+Alt+Q')
    })
    expect(await screen.findByRole('status')).toHaveTextContent('快捷操作已保存并立即生效')
  })

  it('键盘聚焦时先用 Enter 进入录制，不会误改快捷键', () => {
    render(<InteractionSettings />)
    const recorder = screen.getByRole('button', { name: '打开咨询页快捷键' })

    fireEvent.keyDown(recorder, { key: 'Enter', code: 'Enter' })
    fireEvent.click(recorder)

    expect(recorder).toHaveAttribute('aria-pressed', 'true')
    expect(readInteractionSettings().shortcuts.open_consult).toBe('CommandOrControl+Alt+Space')
  })

  it('阻止两个动作使用相同快捷键', async () => {
    render(<InteractionSettings />)
    const recorder = screen.getByRole('button', { name: '打开咨询页快捷键' })

    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      altKey: true,
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('打开咨询页与打开创作页不能使用同一组快捷键')
    expect(readInteractionSettings().shortcuts.open_consult).not.toBe('CommandOrControl+Alt+C')
  })

  it('修改悬浮球动作并持久化', async () => {
    render(<InteractionSettings />)

    fireEvent.change(screen.getByRole('combobox', { name: '单击悬浮球' }), {
      target: { value: 'none' },
    })
    await waitFor(() => {
      expect(readInteractionSettings().floatingBall.singleClick).toBe('none')
    })
    fireEvent.change(screen.getByRole('combobox', { name: '双击悬浮球' }), {
      target: { value: 'recognize_screen_task' },
    })

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(INTERACTION_SETTINGS_KEY) || '{}')
      expect(saved.floatingBall).toEqual({
        singleClick: 'none',
        doubleClick: 'recognize_screen_task',
      })
    })
  })
})
