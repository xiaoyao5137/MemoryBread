import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import ReactMarkdown from 'react-markdown'
import { Clipboard, EyeOff, Home, Loader2, MessageSquare, Paperclip, RefreshCw, Send, Sparkles, Square, Trash2, X } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { runRagQueryJob } from '../hooks/useApi'
import { useAppStore } from '../store/useAppStore'
import type { RagContext } from '../types'
import { buildAttachmentMetadata, buildAttachmentPrompt, filesToAttachments, formatAttachmentSize, type UserAttachment } from '../utils/attachments'
import './SystemFloatingAssist.css'

type AssistPhase = 'idle' | 'capturing' | 'answering' | 'done' | 'error'

const FLOATING_ASSIST_BALL_SIZE = 42
const FLOATING_ASSIST_CONTEXT_MENU_WIDTH = 214
const FLOATING_ASSIST_CONTEXT_MENU_HEIGHT = 210

interface FloatingAssistOcrResult {
  text: string
  confidence: number
  screenshot_path: string
  width: number
  height: number
}

interface FloatingAssistDragOrigin {
  offset_x: number
  offset_y: number
}

type MarkdownBlock =
  | { type: 'markdown'; content: string }
  | { type: 'table'; headers: string[]; alignments: Array<'left' | 'center' | 'right'>; rows: string[][] }

const splitFloatingAssistAnswer = (content: string) => {
  const understandingMatch = content.match(/^#{2,6}\s*用户问题理解\s*[:：]?\s*$/im)
  if (!understandingMatch || understandingMatch.index == null) {
    return { userQuestionUnderstanding: '', responseContent: content.trim() }
  }

  const beforeUnderstanding = content.slice(0, understandingMatch.index).trim()
  const understandingStart = understandingMatch.index + understandingMatch[0].length
  const afterUnderstanding = content.slice(understandingStart)
  const nextHeadingMatch = afterUnderstanding.match(/\n#{2,6}\s+/)
  const understandingEnd = nextHeadingMatch?.index ?? afterUnderstanding.length
  const userQuestionUnderstanding = afterUnderstanding.slice(0, understandingEnd).trim()
  const restAfterUnderstanding = afterUnderstanding.slice(understandingEnd).replace(/^\n#{2,6}\s*回答\s*[:：]?\s*/i, '').trim()
  const responseContent = [beforeUnderstanding, restAfterUnderstanding].filter(Boolean).join('\n\n').trim()

  return { userQuestionUnderstanding, responseContent }
}

const splitTableRow = (line: string) => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  let escaped = false
  for (const char of trimmed) {
    if (char === '|' && !escaped) {
      cells.push(cell.replace(/\\\|/g, '|').trim())
      cell = ''
    } else {
      cell += char
    }
    escaped = char === '\\' && !escaped
  }
  cells.push(cell.replace(/\\\|/g, '|').trim())
  return cells
}

const isTableSeparator = (line: string) => {
  const cells = splitTableRow(line)
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

const isPotentialTableRow = (line: string) => {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && splitTableRow(trimmed).length > 1
}

const tableAlignments = (separatorLine: string): Array<'left' | 'center' | 'right'> =>
  splitTableRow(separatorLine).map(cell => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
    if (cell.endsWith(':')) return 'right'
    return 'left'
  })

const parseMarkdownBlocks = (content: string): MarkdownBlock[] => {
  const lines = content.split('\n')
  const blocks: MarkdownBlock[] = []
  let markdownBuffer: string[] = []
  let index = 0

  const flushMarkdown = () => {
    const markdown = markdownBuffer.join('\n').trim()
    if (markdown) blocks.push({ type: 'markdown', content: markdown })
    markdownBuffer = []
  }

  while (index < lines.length) {
    const current = lines[index]
    const next = lines[index + 1]
    if (isPotentialTableRow(current) && next && isTableSeparator(next)) {
      flushMarkdown()
      const headers = splitTableRow(current)
      const alignments = tableAlignments(next)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && isPotentialTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      blocks.push({ type: 'table', headers, alignments, rows })
      continue
    }

    markdownBuffer.push(current)
    index += 1
  }

  flushMarkdown()
  return blocks
}

const buildFloatingAssistQuery = (ocrText: string) => {
  const trimmed = ocrText.trim()
  return [
    '你是记忆面包的工作场景助手。下面是用户当前屏幕 OCR 内容。',
    '请先直接推断用户正在处理的问题，再给出可直接复制使用的答案、步骤或文本。',
    '如果屏幕里出现的是用户准备发送或询问的一句话，必须把这句话当作待回答的问题，不要改写成让用户去问别人的提问话术。',
    '对于“是什么样”“结果如何”“有没有结论”这类问题，必须直接回答结果和依据，不要输出追问模板。',
    '即使信息不足，也要基于可见内容和参考资料给出最可能的判断；不要追问用户，不要只要求用户补充信息。',
    '当前屏幕 OCR 是最高优先级；历史参考资料只能辅助，不得覆盖或替换当前屏幕内容。',
    '',
    '输出要求：',
    '- 先用一句话说明你判断出的用户需求。',
    '- 再给出可直接使用的结果或操作步骤。',
    '- 不要提及供应商模型、密钥、成本或内部实现。',
    '',
    `当前屏幕 OCR：\n${trimmed}`,
  ].join('\n')
}

const buildManualFloatingAssistQuery = (instruction: string, ocrText?: string) => {
  const trimmedInstruction = instruction.trim()
  const trimmedOcr = ocrText?.trim()
  return [
    '你是记忆面包的工作场景助手。用户在悬浮咨询面板中手工输入了一条指令。',
    '请优先回答这条手工指令；如果同时提供了当前屏幕 OCR 内容，请把它作为辅助上下文。',
    '不要提及供应商模型、密钥、成本或内部实现。',
    '',
    `用户手工指令：\n${trimmedInstruction}`,
    trimmedOcr ? `\n当前屏幕 OCR：\n${trimmedOcr}` : '',
  ].filter(Boolean).join('\n')
}

const SystemFloatingAssist: React.FC = () => {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)
  const creationModelConfigs = useAppStore((s) => s.creationModelConfigs)
  const [phase, setPhase] = useState<AssistPhase>('idle')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [screenshot, setScreenshot] = useState<FloatingAssistOcrResult | null>(null)
  const [screenshotSrc, setScreenshotSrc] = useState('')
  const [references, setReferences] = useState<RagContext[]>([])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [manualInstruction, setManualInstruction] = useState('')
  const [attachments, setAttachments] = useState<UserAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const revealTimerRef = useRef<number | null>(null)
  const clickTimerRef = useRef<number | null>(null)
  const progressTimerRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef({
    active: false,
    dragging: false,
    startX: 0,
    startY: 0,
    pointerId: -1,
    offsetX: 0,
    offsetY: 0,
    tickId: null as number | null,
  })
  const suppressClickRef = useRef(false)

  const statusText = useMemo(() => {
    if (phase === 'capturing') return `正在识别屏幕 ${progress}%`
    if (phase === 'answering') return `正在整理答案 ${progress}%`
    if (revealing) return '正在生成'
    if (phase === 'done') return '已生成'
    if (phase === 'error') return '需要处理'
    return '待咨询'
  }, [phase, progress, revealing])

  const stopProgress = () => {
    if (progressTimerRef.current != null) {
      window.clearInterval(progressTimerRef.current)
      progressTimerRef.current = null
    }
  }

  const startProgress = (from: number, to: number, durationMs: number) => {
    stopProgress()
    const startedAt = Date.now()
    setProgress(from)
    progressTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAt
      const ratio = Math.min(1, elapsed / durationMs)
      const eased = 1 - Math.pow(1 - ratio, 2)
      setProgress(Math.min(to, Math.round(from + (to - from) * eased)))
    }, 220)
  }

  const waitForPaint = () => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })

  const stopDrag = (releaseClick = true) => {
    const drag = dragRef.current
    const wasDragging = drag.dragging
    if (drag.tickId != null) {
      window.clearInterval(drag.tickId)
    }
    drag.active = false
    drag.dragging = false
    drag.pointerId = -1
    drag.tickId = null
    if (releaseClick && wasDragging) {
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 260)
    }
  }

  const hasCanvas = canvasOpen
  const busy = phase === 'capturing' || phase === 'answering'
  const collapseExpandedSurface = () => {
    setCanvasOpen(false)
    setContextMenuOpen(false)
    setPreviewOpen(false)
  }
  const canvasHeight = phase === 'done'
    ? Math.min(560, Math.max(420, 330 + Math.ceil(answer.length / 2.4) + Math.min(references.length, 3) * 42))
    : phase === 'error'
      ? 370
      : phase === 'idle'
        ? 220
        : screenshot
          ? 414
          : 330
  useEffect(() => {
    document.documentElement.classList.add('floating-assist-html')
    document.body.classList.add('floating-assist-body')
    let cleanup: (() => void) | null = null
    const stopGlobalDrag = () => stopDrag()
    const handleWindowBlur = () => {
      stopDrag()
      collapseExpandedSurface()
    }
    window.addEventListener('pointerup', stopGlobalDrag)
    window.addEventListener('mouseup', stopGlobalDrag)
    window.addEventListener('blur', handleWindowBlur)
    const closeContextMenu = () => setContextMenuOpen(false)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') collapseExpandedSurface()
    }
    window.addEventListener('click', closeContextMenu)
    window.addEventListener('keydown', handleKeyDown)
    void listen('floating-assist-reset', () => {
      if (revealTimerRef.current != null) {
        window.clearInterval(revealTimerRef.current)
        revealTimerRef.current = null
      }
      if (clickTimerRef.current != null) {
        window.clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      stopProgress()
      setProgress(0)
      stopDrag(false)
      suppressClickRef.current = false
      collapseExpandedSurface()
      setRevealing(false)
    }).then(dispose => {
      cleanup = dispose
    }).catch(() => {})
    return () => {
      document.documentElement.classList.remove('floating-assist-html')
      document.body.classList.remove('floating-assist-body')
      if (revealTimerRef.current != null) {
        window.clearInterval(revealTimerRef.current)
      }
      if (clickTimerRef.current != null) {
        window.clearTimeout(clickTimerRef.current)
      }
      stopProgress()
      stopDrag(false)
      window.removeEventListener('pointerup', stopGlobalDrag)
      window.removeEventListener('mouseup', stopGlobalDrag)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('click', closeContextMenu)
      window.removeEventListener('keydown', handleKeyDown)
      cleanup?.()
    }
  }, [])

  useEffect(() => {
    const width = previewOpen
      ? 720
      : hasCanvas
        ? 392
        : contextMenuOpen
          ? FLOATING_ASSIST_CONTEXT_MENU_WIDTH
          : FLOATING_ASSIST_BALL_SIZE
    const height = previewOpen
      ? 540
      : hasCanvas
        ? Math.max(50 + canvasHeight, contextMenuOpen ? FLOATING_ASSIST_CONTEXT_MENU_HEIGHT : FLOATING_ASSIST_BALL_SIZE)
        : contextMenuOpen
          ? FLOATING_ASSIST_CONTEXT_MENU_HEIGHT
          : FLOATING_ASSIST_BALL_SIZE
    invoke('set_floating_assist_size', { width, height }).catch(() => {})
  }, [canvasHeight, contextMenuOpen, hasCanvas, previewOpen])

  const revealAnswer = (content: string) => {
    if (revealTimerRef.current != null) {
      window.clearInterval(revealTimerRef.current)
    }
    setAnswer('')
    setRevealing(true)
    let cursor = 0
    revealTimerRef.current = window.setInterval(() => {
      cursor = Math.min(content.length, cursor + 18)
      setAnswer(content.slice(0, cursor))
      if (cursor >= content.length) {
        if (revealTimerRef.current != null) {
          window.clearInterval(revealTimerRef.current)
          revealTimerRef.current = null
        }
        setRevealing(false)
      }
    }, 28)
  }

  const clearAnswerReveal = () => {
    if (revealTimerRef.current != null) {
      window.clearInterval(revealTimerRef.current)
      revealTimerRef.current = null
    }
    setRevealing(false)
  }

  const clearCanvasContent = () => {
    abortRef.current?.abort()
    abortRef.current = null
    clearAnswerReveal()
    stopProgress()
    setPhase('idle')
    setProgress(0)
    setAnswer('')
    setError(null)
    setCopied(false)
    setScreenshot(null)
    setScreenshotSrc('')
    setReferences([])
    setPreviewOpen(false)
    setManualInstruction('')
    setAttachments([])
    setAttachmentError(null)
  }

  const stopAssist = () => {
    abortRef.current?.abort()
    abortRef.current = null
    clearAnswerReveal()
    stopProgress()
    setPhase(answer ? 'done' : 'idle')
    setProgress(0)
  }

  const addFiles = async (files: Iterable<File>) => {
    setAttachmentError(null)
    try {
      const next = await filesToAttachments(files, attachments.length)
      setAttachments(prev => [...prev, ...next])
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : '附件读取失败')
    }
  }

  const runAssist = async () => {
    if (suppressClickRef.current) return
    if (busy) return
    setContextMenuOpen(false)
    setCanvasOpen(true)
    if (revealTimerRef.current != null) {
      window.clearInterval(revealTimerRef.current)
      revealTimerRef.current = null
    }
    setRevealing(false)
    setCopied(false)
    setAnswer('')
    setError(null)
    setScreenshot(null)
    setScreenshotSrc('')
    setReferences([])
    setPreviewOpen(false)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      setPhase('capturing')
      startProgress(8, 34, 9000)
      await waitForPaint()
      const ocr = await invoke<FloatingAssistOcrResult>('capture_screen_ocr_for_floating_assist')
      const text = ocr.text.trim()
      setScreenshot(ocr)
      try {
        setScreenshotSrc(await invoke<string>('read_floating_assist_image_data_url', { path: ocr.screenshot_path }))
      } catch {
        setScreenshotSrc('')
      }
      if (!text) {
        throw new Error('这次截图没有识别到可用文字。请把目标窗口放到前台后再试。')
      }

      setPhase('answering')
      startProgress(35, 92, 60000)
      await waitForPaint()
      const attachmentPrompt = buildAttachmentPrompt(attachments)
      const query = buildFloatingAssistQuery(text)
      const queryWithAttachments = attachmentPrompt ? `${query}\n\n${attachmentPrompt}` : query
      const result = await runRagQueryJob(apiBaseUrl, creationModelConfigs, queryWithAttachments, 5, {
        source: 'floating_assist',
        screenshot_path: ocr.screenshot_path,
        screenshot_width: ocr.width,
        screenshot_height: ocr.height,
        ocr_text: text,
        attachments: buildAttachmentMetadata(attachments),
      }, false, controller.signal)
      setReferences(result.contexts ?? [])
      stopProgress()
      setProgress(100)
      setPhase('done')
      revealAnswer(result.answer?.trim() || '本次没有生成咨询输出，请重试。')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      stopProgress()
      setRevealing(false)
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const runManualAssist = async (event?: { preventDefault: () => void }) => {
    event?.preventDefault()
    const instruction = manualInstruction.trim()
    if (!instruction || busy) return
    setContextMenuOpen(false)
    setCanvasOpen(true)
    if (revealTimerRef.current != null) {
      window.clearInterval(revealTimerRef.current)
      revealTimerRef.current = null
    }
    setRevealing(false)
    setCopied(false)
    setAnswer('')
    setError(null)
    setReferences([])
    setPreviewOpen(false)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      setPhase('answering')
      startProgress(12, 92, 60000)
      await waitForPaint()
      const attachmentPrompt = buildAttachmentPrompt(attachments)
      const query = buildManualFloatingAssistQuery(instruction, screenshot?.text)
      const queryWithAttachments = attachmentPrompt ? `${query}\n\n${attachmentPrompt}` : query
      const result = await runRagQueryJob(
        apiBaseUrl,
        creationModelConfigs,
        queryWithAttachments,
        5,
        screenshot ? {
          source: 'floating_assist',
          screenshot_path: screenshot.screenshot_path,
          screenshot_width: screenshot.width,
          screenshot_height: screenshot.height,
          ocr_text: screenshot.text,
          manual_instruction: instruction,
          attachments: buildAttachmentMetadata(attachments),
        } : {
          source: 'floating_assist',
          manual_instruction: instruction,
          attachments: buildAttachmentMetadata(attachments),
        },
        false,
        controller.signal,
      )
      setReferences(result.contexts ?? [])
      stopProgress()
      setProgress(100)
      setPhase('done')
      setManualInstruction('')
      revealAnswer(result.answer?.trim() || '本次没有生成咨询输出，请重试。')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      stopProgress()
      setRevealing(false)
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const copyAnswer = async () => {
    if (!answer) return
    await navigator.clipboard.writeText(answer)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const toggleCanvas = () => {
    if (suppressClickRef.current) return
    setCanvasOpen(value => !value)
  }

  const handleOutsidePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      collapseExpandedSurface()
    }
  }

  const handleBallClick = () => {
    if (suppressClickRef.current) return
    setContextMenuOpen(false)
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current)
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      toggleCanvas()
    }, 220)
  }

  const handleBallContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (suppressClickRef.current) return
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    setContextMenuOpen(value => !value)
  }

  const openMainPanel = () => {
    setContextMenuOpen(false)
    invoke('set_floating_assist_size', {
      width: FLOATING_ASSIST_BALL_SIZE,
      height: FLOATING_ASSIST_BALL_SIZE,
    })
      .catch(() => {})
      .finally(() => {
        invoke('show_main_panel_from_floating_assist').catch(() => {})
      })
  }

  const handleManualWheel = useCallback((event: React.WheelEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
    if (el.scrollHeight <= el.clientHeight) return

    const scrollingUp = event.deltaY < 0
    const scrollingDown = event.deltaY > 0
    const canScrollUp = el.scrollTop > 0
    const canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight

    if ((scrollingUp && canScrollUp) || (scrollingDown && canScrollDown)) {
      event.preventDefault()
      event.stopPropagation()
      el.scrollTop += event.deltaY
    }
  }, [])

  const hideFloatingAssist = () => {
    setContextMenuOpen(false)
    invoke('set_floating_assist_visible', { enabled: false }).catch(() => {})
  }

  const handleBallDoubleClick = () => {
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    void runAssist()
  }

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      active: true,
      dragging: false,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      offsetX: 0,
      offsetY: 0,
      tickId: null,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // ignore
    }
  }

  const startManualDrag = async () => {
    const drag = dragRef.current
    if (!drag.active || drag.dragging) return
    drag.dragging = true
    drag.active = false
    suppressClickRef.current = true
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    try {
      const origin = await invoke<FloatingAssistDragOrigin>('begin_floating_assist_drag')
      if (!drag.dragging) return
      drag.offsetX = origin.offset_x
      drag.offsetY = origin.offset_y
      const tick = () => {
        invoke('update_floating_assist_drag', {
          offsetX: drag.offsetX,
          offsetY: drag.offsetY,
        }).catch((reason) => {
          console.warn('floating assist drag update failed', reason)
          stopDrag()
        })
      }
      tick()
      drag.tickId = window.setInterval(tick, 16)
    } catch (reason) {
      console.warn('floating assist drag start failed', reason)
      stopDrag()
    }
  }

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag.active || drag.dragging || event.pointerId !== drag.pointerId) return
    if ((event.buttons & 1) !== 1) {
      stopDrag(false)
      return
    }
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.dragging && Math.hypot(dx, dy) < 3) return

    void startManualDrag()
  }

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
    stopDrag()
  }

  const openReference = (item: RagContext) => {
    const sourceType = item.source_type || item.source || 'capture'
    const referenceType = ['document', 'bake_knowledge', 'operation', 'action'].includes(sourceType)
      ? sourceType
      : item.knowledge_id
        ? 'knowledge'
        : sourceType
    invoke('open_floating_assist_reference', {
      detail: {
        type: referenceType,
        captureId: item.capture_id,
        knowledgeId: item.knowledge_id,
        artifactId: item.artifact_id,
        documentId: item.document_id,
        docKey: item.doc_key,
      },
    }).catch(() => {})
  }

  const visibleReferences = references.filter(item => (item.source_type || item.source) !== 'floating_assist')
  const floatingAnswer = useMemo(() => splitFloatingAssistAnswer(answer), [answer])
  const displayedAnswer = floatingAnswer.responseContent || (floatingAnswer.userQuestionUnderstanding ? '' : answer)

  return (
    <div
      className={`system-floating-assist ${hasCanvas ? 'system-floating-assist--open' : ''} ${hasCanvas || contextMenuOpen ? 'system-floating-assist--dismissable' : ''}`}
      onPointerDown={handleOutsidePointerDown}
    >
      <div className="system-floating-assist__dock">
        <button
          className={`system-floating-assist__ball system-floating-assist__ball--${phase}`}
          type="button"
          onClick={handleBallClick}
          onContextMenu={handleBallContextMenu}
          onDoubleClick={handleBallDoubleClick}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label="识别当前屏幕并咨询记忆面包"
          title="识别当前屏幕并咨询记忆面包"
        >
          {phase === 'capturing' || phase === 'answering'
            ? <Loader2 size={20} className="system-floating-assist__spin" />
            : <Sparkles size={20} />}
        </button>
      </div>

      {contextMenuOpen && (
        <div className="system-floating-assist__context-menu" role="menu" onClick={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={openMainPanel}>
            <Home size={15} />
            <span>打开主面板</span>
          </button>
          <button type="button" role="menuitem" onClick={runAssist} disabled={busy}>
            <MessageSquare size={15} />
            <span>识别屏幕咨询</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setCanvasOpen(true); setContextMenuOpen(false) }}>
            <Sparkles size={15} />
            <span>展开咨询面板</span>
          </button>
          <button type="button" role="menuitem" onClick={hideFloatingAssist}>
            <EyeOff size={15} />
            <span>隐藏悬浮球</span>
          </button>
        </div>
      )}

      {hasCanvas && (
        <section className="system-floating-assist__canvas" aria-live="polite">
          <header className="system-floating-assist__canvas-head">
            <div>
              <span>工作场景咨询</span>
              <strong>{statusText}</strong>
            </div>
            <div className="system-floating-assist__canvas-actions">
              <button
                className="system-floating-assist__small-btn"
                type="button"
                onClick={copyAnswer}
                disabled={!answer}
              >
                <Clipboard size={14} />
                {copied ? '已复制' : '复制'}
              </button>
              {busy && (
                <button
                  className="system-floating-assist__small-btn system-floating-assist__small-btn--danger"
                  type="button"
                  onClick={stopAssist}
                >
                  <Square size={13} />
                  中止
                </button>
              )}
              <button
                className="system-floating-assist__small-btn"
                type="button"
                onClick={clearCanvasContent}
                disabled={busy}
              >
                <Trash2 size={14} />
                清空
              </button>
              <button
                className="system-floating-assist__small-btn"
                type="button"
                onClick={runAssist}
                disabled={busy}
              >
                <RefreshCw size={14} />
                重试
              </button>
            </div>
          </header>

          <div className="system-floating-assist__body">
            {screenshotSrc && (
              <div className="system-floating-assist__consult-screen">
                <div className="system-floating-assist__consult-title">用户咨询：</div>
                <div className="system-floating-assist__screenshot-wrap">
                  <button
                    className="system-floating-assist__screenshot"
                    type="button"
                    onClick={() => setPreviewOpen(true)}
                    aria-label="查看本次截屏"
                    title="查看本次截屏"
                  >
                    <img src={screenshotSrc} alt="本次截屏缩略图" />
                  </button>
                  <button
                    className="system-floating-assist__screenshot-remove"
                    type="button"
                    onClick={() => {
                      setScreenshot(null)
                      setScreenshotSrc('')
                      setPreviewOpen(false)
                    }}
                    aria-label="移除本次截屏"
                    title="移除本次截屏"
                    disabled={busy}
                  >
                    <X size={13} />
                  </button>
                </div>
                {floatingAnswer.userQuestionUnderstanding && (
                  <div className="system-floating-assist__question-understanding">
                    <MarkdownContent content={floatingAnswer.userQuestionUnderstanding} />
                  </div>
                )}
              </div>
            )}

            {(phase === 'capturing' || phase === 'answering') && (
              <div className="system-floating-assist__thinking">
                <div className="system-floating-assist__thinking-row">
                  <Loader2 size={18} className="system-floating-assist__spin" />
                  <span>{statusText}</span>
                </div>
                <div className="system-floating-assist__progress" aria-hidden="true">
                  <span style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            {phase === 'error' && (
              <div className="system-floating-assist__error">
                {error || '悬浮球处理失败，请稍后重试。'}
              </div>
            )}

            {phase === 'done' && displayedAnswer && (
              <div className="system-floating-assist__answer">
                <div className="system-floating-assist__output-title">咨询输出</div>
                <MarkdownContent content={displayedAnswer} />
              </div>
            )}
            {phase === 'idle' && (
              <div className="system-floating-assist__empty">
                <strong>暂无咨询内容</strong>
              </div>
            )}
          </div>

          <form className="system-floating-assist__manual" onSubmit={runManualAssist}>
            <div className="system-floating-assist__manual-main">
              <textarea
                value={manualInstruction}
                onChange={(event) => setManualInstruction(event.target.value)}
                onWheel={handleManualWheel}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files || [])
                  if (files.length) void addFiles(files)
                }}
                placeholder={screenshot ? '继续输入你的指令，结合当前界面内容咨询' : '输入你的指令，直接向记忆面包咨询'}
                rows={2}
                disabled={busy}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    void runManualAssist(event)
                  }
                }}
              />
              {attachments.length > 0 && (
                <div className="system-floating-assist__attachments">
                  {attachments.map(item => (
                    <span className="system-floating-assist__attachment" key={item.id}>
                      <Paperclip size={12} />
                      <span>{item.name}</span>
                      <small>{formatAttachmentSize(item.size)}</small>
                      <button
                        type="button"
                        onClick={() => setAttachments(prev => prev.filter(existing => existing.id !== item.id))}
                        disabled={busy}
                        aria-label={`移除 ${item.name}`}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {attachmentError && <div className="system-floating-assist__attachment-error">{attachmentError}</div>}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.md,.doc,.docx"
              style={{ display: 'none' }}
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files)
                event.currentTarget.value = ''
              }}
            />
            <button
              className="system-floating-assist__manual-attach"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              aria-label="上传附件"
              title="上传附件"
            >
              <Paperclip size={15} />
            </button>
            <button
              className="system-floating-assist__manual-submit"
              type="submit"
              disabled={busy || !manualInstruction.trim()}
              aria-label="发送手工咨询"
              title="发送手工咨询"
            >
              {busy ? <Loader2 size={15} className="system-floating-assist__spin" /> : <Send size={15} />}
            </button>
          </form>

          {phase === 'done' && visibleReferences.length > 0 && (
            <div className="system-floating-assist__refs">
              <div className="system-floating-assist__refs-title">参考资料</div>
              {visibleReferences.slice(0, 4).map((item, index) => (
                <button
                  className="system-floating-assist__ref"
                  type="button"
                  onClick={() => openReference(item)}
                  key={`${item.doc_key || item.capture_id}-${index}`}
                >
                  <span>R{index + 1}</span>
                  <strong>{referenceTitle(item)}</strong>
                </button>
              ))}
            </div>
          )}

        </section>
      )}

      {previewOpen && screenshotSrc && (
        <div className="system-floating-assist__preview" onClick={() => setPreviewOpen(false)}>
          <img src={screenshotSrc} alt="本次截屏预览" />
        </div>
      )}
    </div>
  )
}

const referenceTitle = (item: RagContext) =>
  item.title || item.overview || item.summary || item.win_title || item.app_name || item.text?.slice(0, 48) || '参考资料'

const MarkdownContent = ({ content }: { content: string }) => {
  const inlineComponents = {
    p: ({ children }: any) => <>{children}</>,
  }

  return (
    <>
      {parseMarkdownBlocks(content).map((block, index) => {
        if (block.type === 'markdown') {
          return <ReactMarkdown key={`markdown-${index}`}>{block.content}</ReactMarkdown>
        }

        return (
          <div className="system-floating-assist__table-wrap" key={`table-${index}`}>
            <table>
              <thead>
                <tr>
                  {block.headers.map((header, cellIndex) => (
                    <th key={cellIndex} style={{ textAlign: block.alignments[cellIndex] || 'left' }}>
                      <ReactMarkdown components={inlineComponents}>{header}</ReactMarkdown>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {block.headers.map((_, cellIndex) => (
                      <td key={cellIndex} style={{ textAlign: block.alignments[cellIndex] || 'left' }}>
                        <ReactMarkdown components={inlineComponents}>{row[cellIndex] || ''}</ReactMarkdown>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </>
  )
}

export default SystemFloatingAssist
