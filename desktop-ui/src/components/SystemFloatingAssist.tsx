import React, { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import ReactMarkdown from 'react-markdown'
import { Clipboard, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { runRagQueryJob } from '../hooks/useApi'
import { useAppStore } from '../store/useAppStore'
import type { RagContext } from '../types'
import './SystemFloatingAssist.css'

type AssistPhase = 'idle' | 'capturing' | 'answering' | 'done' | 'error'

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
  const [progress, setProgress] = useState(0)
  const revealTimerRef = useRef<number | null>(null)
  const clickTimerRef = useRef<number | null>(null)
  const progressTimerRef = useRef<number | null>(null)
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
  const canvasHeight = phase === 'done'
    ? Math.min(560, Math.max(342, 252 + Math.ceil(answer.length / 2.4) + Math.min(references.length, 3) * 42))
    : phase === 'error'
      ? 292
      : phase === 'idle'
        ? 132
        : screenshot
          ? 336
          : 252
  useEffect(() => {
    document.documentElement.classList.add('floating-assist-html')
    document.body.classList.add('floating-assist-body')
    let cleanup: (() => void) | null = null
    const stopGlobalDrag = () => stopDrag()
    window.addEventListener('pointerup', stopGlobalDrag)
    window.addEventListener('mouseup', stopGlobalDrag)
    window.addEventListener('blur', stopGlobalDrag)
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
      setCanvasOpen(false)
      setPreviewOpen(false)
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
      window.removeEventListener('blur', stopGlobalDrag)
      cleanup?.()
    }
  }, [])

  useEffect(() => {
    const width = previewOpen ? 720 : hasCanvas ? 392 : 42
    const height = previewOpen ? 540 : hasCanvas ? 50 + canvasHeight : 42
    invoke('set_floating_assist_size', { width, height }).catch(() => {})
  }, [canvasHeight, hasCanvas, previewOpen])

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

  const runAssist = async () => {
    if (suppressClickRef.current) return
    if (phase === 'capturing' || phase === 'answering') return
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
      const result = await runRagQueryJob(apiBaseUrl, creationModelConfigs, buildFloatingAssistQuery(text), 5, {
        source: 'floating_assist',
        screenshot_path: ocr.screenshot_path,
        screenshot_width: ocr.width,
        screenshot_height: ocr.height,
        ocr_text: text,
      })
      setReferences(result.contexts ?? [])
      stopProgress()
      setProgress(100)
      setPhase('done')
      revealAnswer(result.answer?.trim() || '本次没有生成咨询输出，请重试。')
    } catch (err) {
      stopProgress()
      setRevealing(false)
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
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

  const handleBallClick = () => {
    if (suppressClickRef.current) return
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current)
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      toggleCanvas()
    }, 220)
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
    invoke('open_floating_assist_reference', {
      detail: {
        type: item.knowledge_id ? 'knowledge' : sourceType,
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
    <div className={`system-floating-assist ${hasCanvas ? 'system-floating-assist--open' : ''}`}>
      <div className="system-floating-assist__dock">
        <button
          className={`system-floating-assist__ball system-floating-assist__ball--${phase}`}
          type="button"
          onClick={handleBallClick}
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
              <button
                className="system-floating-assist__small-btn"
                type="button"
                onClick={runAssist}
                disabled={phase === 'capturing' || phase === 'answering'}
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
                <button
                  className="system-floating-assist__screenshot"
                  type="button"
                  onClick={() => setPreviewOpen(true)}
                  aria-label="查看本次截屏"
                  title="查看本次截屏"
                >
                  <img src={screenshotSrc} alt="本次截屏缩略图" />
                </button>
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
