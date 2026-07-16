import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import SystemFloatingAssist from '../components/SystemFloatingAssist'
import { useAppStore } from '../store/useAppStore'
import { runRagQueryJob } from '../hooks/useApi'
import {
  FLOATING_ASSIST_AUTO_TASK_KEY,
  FLOATING_ASSIST_ENABLED_KEY,
} from '../utils/floatingAssistAutoTask'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('../hooks/useApi', () => ({
  RAG_REFERENCE_LIMIT: 5,
  runGatewayRagQuery: vi.fn(),
  runRagQueryJob: vi.fn(),
}))

vi.mock('../utils/authApi', () => ({
  fetchBillingBalance: vi.fn().mockResolvedValue(null),
}))

const mockedInvoke = vi.mocked(invoke)
const mockedListen = vi.mocked(listen)
const mockedRunRagQueryJob = vi.mocked(runRagQueryJob)
const assistButton = () => screen.getByRole('button', { name: '识别当前屏幕并咨询记忆面包' })
const AUTO_TASK_SCAN_INITIAL_DELAY_MS = 10_000
const AUTO_TASK_SCAN_INTERVAL_MS = 120_000
const taskOcrResult = {
  text: '飞书\n老板：帮我修复登录验证码异常，明天下午前给结论',
  confidence: 0.92,
  screenshot_path: '/tmp/floating-task.jpg',
  width: 1440,
  height: 900,
  screenshot_source: 'window',
  app_bundle_id: 'com.bytedance.lark',
  app_name: '飞书',
  window_title: '项目群',
}
const anotherTaskOcrResult = {
  text: '飞书\n老板：帮我整理项目风险清单，本周内给一版',
  confidence: 0.93,
  screenshot_path: '/tmp/floating-task-another.jpg',
  width: 1440,
  height: 900,
  screenshot_source: 'window',
  app_bundle_id: 'com.bytedance.lark',
  app_name: '飞书',
  window_title: '项目群',
}
const documentTaskOcrResult = {
  text: 'Chrome\ndocs.corp.kuaishou.com/d/home/example\n所有改动已自动保存\nTODO\n- [ ] 修复登录验证码异常\n截止：明天下午前',
  confidence: 0.91,
  screenshot_path: '/tmp/floating-document-task.jpg',
  width: 1440,
  height: 900,
  screenshot_source: 'window',
  app_bundle_id: 'com.google.Chrome',
  app_name: 'Chrome',
  window_title: '项目文档',
}
const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
const captureOcrCalls = () =>
  mockedInvoke.mock.calls.filter(([command]) => command === 'capture_screen_ocr_for_floating_assist')
const completeNextAutoScan = async (scanDelayMs: number) => {
  await act(async () => {
    vi.advanceTimersByTime(scanDelayMs)
    await flushMicrotasks()
  })
  await act(async () => {
    vi.advanceTimersByTime(50)
    await flushMicrotasks()
  })
  await act(async () => {
    vi.advanceTimersByTime(900)
    await flushMicrotasks()
  })
  await act(async () => {
    vi.advanceTimersByTime(50)
    await flushMicrotasks()
  })
  await act(async () => {
    vi.advanceTimersByTime(50)
    await flushMicrotasks()
  })
  await act(async () => {
    vi.advanceTimersByTime(100)
    await flushMicrotasks()
  })
}
const returnDoneStateToIdle = async () => {
  await act(async () => {
    vi.advanceTimersByTime(5 * 60 * 1000)
    await flushMicrotasks()
  })
}
const closeDoneSurfaceAndReturnIdle = async () => {
  await act(async () => {
    fireEvent.click(assistButton())
    await flushMicrotasks()
  })
  await returnDoneStateToIdle()
}
const installMemoryLocalStorage = () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value))
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key)
    }),
    clear: vi.fn(() => {
      values.clear()
    }),
  }
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  })
  return storage
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => {
      callback(Date.now())
      return 1
    },
    configurable: true,
  })
  useAppStore.getState().reset()
  installMemoryLocalStorage()
  window.localStorage.clear()
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async (command: string) => {
    if (command === 'capture_screen_ocr_for_floating_assist') return taskOcrResult
    if (command === 'read_floating_assist_image_data_url') return ''
    return undefined
  })
  mockedListen.mockReset()
  mockedListen.mockResolvedValue(() => {})
  mockedRunRagQueryJob.mockReset()
  mockedRunRagQueryJob.mockResolvedValue({
    answer: '自动识别任务的咨询输出',
    contexts: [],
    output_truncated: false,
  } as any)
})

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  window.history.pushState({}, '', '/')
})

describe('SystemFloatingAssist', () => {
  it('闲置态渲染面包人角色且不再使用旧图片层', () => {
    const { container } = render(<SystemFloatingAssist />)
    const button = assistButton()

    expect(button).toHaveClass('system-floating-assist__ball--idle')
    expect(container.querySelector('.system-floating-assist__bread-person')).toBeInTheDocument()
    expect(container.querySelector('.system-floating-assist__bread-body')).toBeInTheDocument()
    expect(container.querySelector('.system-floating-assist__mascot-img')).not.toBeInTheDocument()
    expect(container.querySelector('.system-floating-assist__idle-snack')).not.toBeInTheDocument()
    expect(container.querySelector('.system-floating-assist__idle-eye')).not.toBeInTheDocument()
    expect(container.querySelector('.system-floating-assist__idle-shadow')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.system-floating-assist__bread-cheek')).toHaveLength(2)
  })

  it('鼠标进入和离开时切换悬停动画状态', () => {
    render(<SystemFloatingAssist />)
    const button = assistButton()

    fireEvent.pointerEnter(button)
    expect(button).toHaveClass('system-floating-assist__ball--native-hover')

    fireEvent.pointerLeave(button)
    expect(button).not.toHaveClass('system-floating-assist__ball--native-hover')
  })

  it('原生追踪区域进入和离开时切换悬停动画状态', async () => {
    render(<SystemFloatingAssist />)
    await act(async () => flushMicrotasks())
    const registration = mockedListen.mock.calls.find(
      ([eventName]) => eventName === 'floating-assist-native-hover-changed',
    )
    expect(registration).toBeDefined()

    const button = assistButton()
    act(() => registration?.[1]({ payload: true } as any))
    expect(button).toHaveClass('system-floating-assist__ball--native-hover')

    act(() => registration?.[1]({ payload: false } as any))
    expect(button).not.toHaveClass('system-floating-assist__ball--native-hover')
  })

  it('闲置动画按周期播放并在间隔期停止合成', () => {
    render(<SystemFloatingAssist />)
    const button = assistButton()

    expect(button).toHaveClass('system-floating-assist__ball--ambient-active')
    act(() => {
      vi.advanceTimersByTime(2_200)
    })
    expect(button).not.toHaveClass('system-floating-assist__ball--ambient-active')

    act(() => {
      vi.advanceTimersByTime(5_800)
    })
    expect(button).toHaveClass('system-floating-assist__ball--ambient-active')
  })

  it('完成态 5 分钟后自动切回闲置态', () => {
    window.history.pushState({}, '', '/?view=floating-assist&debugPhase=done')
    render(<SystemFloatingAssist />)

    expect(assistButton()).toHaveClass('system-floating-assist__ball--done')

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000)
    })

    expect(assistButton()).toHaveClass('system-floating-assist__ball--idle')
  })

  it('完成态点击展开后切回闲置态，并保留已生成输出', () => {
    window.history.pushState(
      {},
      '',
      '/?view=floating-assist&debugPhase=done&debugAnswer=%E5%B7%B2%E7%94%9F%E6%88%90%E7%9A%84%E5%92%A8%E8%AF%A2%E8%BE%93%E5%87%BA',
    )
    render(<SystemFloatingAssist />)

    const button = assistButton()
    expect(button).toHaveClass('system-floating-assist__ball--done')

    fireEvent.click(button)
    act(() => {
      vi.advanceTimersByTime(220)
    })

    expect(button).toHaveClass('system-floating-assist__ball--idle')
    expect(screen.getByText('咨询输出')).toBeInTheDocument()
    expect(screen.getByText('已生成的咨询输出')).toBeInTheDocument()
  })

  it('默认显示 5 条参考资料并支持展开和收起更多资料', async () => {
    mockedRunRagQueryJob.mockResolvedValue({
      answer: '已生成的咨询输出',
      contexts: Array.from({ length: 7 }, (_, index) => ({
        capture_id: index + 1,
        doc_key: `document:${index + 1}`,
        title: `参考资料 ${index + 1}`,
        text: `参考内容 ${index + 1}`,
        score: 1 - index / 10,
        source: 'document',
        source_type: 'document',
      })),
      output_truncated: false,
    } as any)

    render(<SystemFloatingAssist />)
    fireEvent.click(assistButton())
    act(() => {
      vi.advanceTimersByTime(220)
    })

    const textarea = screen.getByPlaceholderText('输入你的指令，直接向记忆面包咨询')
    fireEvent.change(textarea, { target: { value: '分析当前资料' } })
    await act(async () => {
      fireEvent.submit(textarea.closest('form')!)
      await flushMicrotasks()
    })
    await act(async () => {
      vi.advanceTimersByTime(900)
      await flushMicrotasks()
    })
    act(() => {
      vi.advanceTimersByTime(28)
    })

    expect(screen.getByText('参考资料 5')).toBeInTheDocument()
    expect(screen.queryByText('参考资料 6')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开更多（2）' }))
    expect(screen.getByText('参考资料 6')).toBeInTheDocument()
    expect(screen.getByText('参考资料 7')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByText('参考资料 6')).not.toBeInTheDocument()
  })

  it('自动识别任务开启后在面包人左上角显示 auto 标识', () => {
    render(<SystemFloatingAssist />)
    expect(screen.queryByText('auto')).not.toBeInTheDocument()

    cleanup()
    window.localStorage.setItem(FLOATING_ASSIST_ENABLED_KEY, 'true')
    window.localStorage.setItem(FLOATING_ASSIST_AUTO_TASK_KEY, 'true')
    render(<SystemFloatingAssist />)

    expect(screen.getByText('auto')).toBeInTheDocument()
  })

  it('自动识别命中任务后进入面包人接任务动画', async () => {
    window.localStorage.setItem(FLOATING_ASSIST_ENABLED_KEY, 'true')
    window.localStorage.setItem(FLOATING_ASSIST_AUTO_TASK_KEY, 'true')
    mockedRunRagQueryJob.mockImplementation(() => new Promise(() => {}) as any)

    render(<SystemFloatingAssist />)

    await act(async () => {
      vi.advanceTimersByTime(AUTO_TASK_SCAN_INITIAL_DELAY_MS)
      await flushMicrotasks()
    })

    expect(captureOcrCalls()).toHaveLength(1)
    expect(assistButton()).toHaveClass('system-floating-assist__ball--receiving')
  })

  it('自动识别只把疑似任务片段发送给 RAG', async () => {
    window.localStorage.setItem(FLOATING_ASSIST_ENABLED_KEY, 'true')
    window.localStorage.setItem(FLOATING_ASSIST_AUTO_TASK_KEY, 'true')
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === 'capture_screen_ocr_for_floating_assist') {
        return {
          ...taskOcrResult,
          text: '飞书\n闲聊：这个账号密码稍后私发\n老板：帮我修复登录验证码异常，明天下午前给结论',
        }
      }
      if (command === 'read_floating_assist_image_data_url') return ''
      return undefined
    })

    render(<SystemFloatingAssist />)

    await completeNextAutoScan(AUTO_TASK_SCAN_INITIAL_DELAY_MS)

    const sentQuery = mockedRunRagQueryJob.mock.calls[0]?.[2] as string
    expect(sentQuery).toContain('修复登录验证码异常')
    expect(sentQuery).not.toContain('账号密码')
  })

  it('自动识别忽略非 IM 文档页任务', async () => {
    window.localStorage.setItem(FLOATING_ASSIST_ENABLED_KEY, 'true')
    window.localStorage.setItem(FLOATING_ASSIST_AUTO_TASK_KEY, 'true')
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === 'capture_screen_ocr_for_floating_assist') return documentTaskOcrResult
      if (command === 'read_floating_assist_image_data_url') return ''
      return undefined
    })

    render(<SystemFloatingAssist />)

    await act(async () => {
      vi.advanceTimersByTime(AUTO_TASK_SCAN_INITIAL_DELAY_MS)
      await flushMicrotasks()
    })

    expect(captureOcrCalls()).toHaveLength(1)
    expect(mockedRunRagQueryJob).not.toHaveBeenCalled()
    expect(screen.queryByText('发现可能任务')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '咨询' })).not.toBeInTheDocument()
  })

  it('手动任务执行中时跳过自动识别的新任务', async () => {
    window.localStorage.setItem(FLOATING_ASSIST_ENABLED_KEY, 'true')
    window.localStorage.setItem(FLOATING_ASSIST_AUTO_TASK_KEY, 'true')
    render(<SystemFloatingAssist />)

    fireEvent.click(assistButton())
    act(() => {
      vi.advanceTimersByTime(220)
    })

    const textarea = screen.getByPlaceholderText('输入你的指令，直接向记忆面包咨询')
    fireEvent.change(textarea, { target: { value: '帮我写周报' } })
    await act(async () => {
      fireEvent.submit(textarea.closest('form')!)
      await flushMicrotasks()
    })

    expect(assistButton()).toHaveClass('system-floating-assist__ball--receiving')

    await act(async () => {
      vi.advanceTimersByTime(AUTO_TASK_SCAN_INITIAL_DELAY_MS)
      await flushMicrotasks()
    })

    expect(captureOcrCalls()).toHaveLength(0)
  })

  it('自动识别不会因为中间出现其他任务而重复生成同一个任务', async () => {
    window.localStorage.setItem(FLOATING_ASSIST_ENABLED_KEY, 'true')
    window.localStorage.setItem(FLOATING_ASSIST_AUTO_TASK_KEY, 'true')
    const ocrResults = [taskOcrResult, anotherTaskOcrResult, taskOcrResult]
    let captureIndex = 0
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === 'capture_screen_ocr_for_floating_assist') {
        return ocrResults[captureIndex++] ?? taskOcrResult
      }
      if (command === 'read_floating_assist_image_data_url') return ''
      return undefined
    })

    render(<SystemFloatingAssist />)

    await completeNextAutoScan(AUTO_TASK_SCAN_INITIAL_DELAY_MS)
    expect(mockedRunRagQueryJob).toHaveBeenCalledTimes(1)

    await closeDoneSurfaceAndReturnIdle()
    await completeNextAutoScan(AUTO_TASK_SCAN_INTERVAL_MS)
    expect(mockedRunRagQueryJob).toHaveBeenCalledTimes(2)

    await closeDoneSurfaceAndReturnIdle()
    await act(async () => {
      vi.advanceTimersByTime(AUTO_TASK_SCAN_INTERVAL_MS)
      await flushMicrotasks()
    })

    expect(captureOcrCalls()).toHaveLength(3)
    expect(mockedRunRagQueryJob).toHaveBeenCalledTimes(2)
  })
})
