import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Copy, ExternalLink, FileText, Image, Loader2, Search, Sparkles } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { CreationReferenceItem, CreationReferencePreview } from '../store/useAppStore'

interface CreationPanelProps {
  className?: string
}

type ReferenceItem = CreationReferenceItem
type ReferencePreview = CreationReferencePreview
type MarkdownBlock =
  | { type: 'markdown'; content: string }
  | { type: 'table'; headers: string[]; alignments: Array<'left' | 'center' | 'right'>; rows: string[][] }

const defaultPrompt = '请生成一份“数据治理平台建设方案”，参考历史项目方案、知识库和操作手册，风格正式，包含总体架构、功能设计、实施计划和后续核验清单。'

const sanitizeGeneratedContent = (content: string) =>
  content.replace(/<a\s+(?:id|name)=["'][^"']+["']\s*>\s*<\/a>/gi, '')

const readApiErrorMessage = async (response: Response, fallback: string) => {
  try {
    const text = await response.text()
    if (!text.trim()) return fallback

    try {
      const data = JSON.parse(text)
      if (typeof data === 'string') return data
      if (data?.detail) return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
      if (data?.message) return data.message
      if (data?.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
    } catch {
      return text
    }

    return text
  } catch {
    return fallback
  }
}

const mapCreationHistory = (histories: any[]) => histories.map((h: any) => {
  const fullContent = sanitizeGeneratedContent(h.generated_content)
  return {
    prompt: h.prompt,
    timestamp: new Date(h.created_at).toLocaleString('zh-CN'),
    preview: fullContent.slice(0, 100) + (fullContent.length > 100 ? '...' : ''),
    fullContent
  }
})

const splitTableRow = (line: string) => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char === '|' && trimmed[index - 1] !== '\\') {
      cells.push(cell.replace(/\\\|/g, '|').trim())
      cell = ''
    } else {
      cell += char
    }
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

const CreationPanel: React.FC<CreationPanelProps> = ({ className = '' }) => {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)
  const draft = useAppStore((s) => s.creationDraft)
  const setCreationDraft = useAppStore((s) => s.setCreationDraft)
  const setWindowMode = useAppStore((s) => s.setWindowMode)
  const setBakeTab = useAppStore((s) => s.setBakeTab)
  const setSelectedTemplateId = useAppStore((s) => s.setSelectedTemplateId)
  const setBakeTemplateOffset = useAppStore((s) => s.setBakeTemplateOffset)
  const setBakeTemplateQuery = useAppStore((s) => s.setBakeTemplateQuery)
  const setBakeTemplateLimit = useAppStore((s) => s.setBakeTemplateLimit)
  const pushBakeNavigationTarget = useAppStore((s) => s.pushBakeNavigationTarget)

  const {
    prompt,
    docType,
    audience,
    generatedContent,
    inheritFormat,
    enableRag,
    enableWebSearch,
    enableImageGeneration,
    contentWeight,
    qualityWeight,
    completenessWeight,
    usageWeight,
    formatWeight,
    freshnessWeight,
    referencePreview,
  } = draft

  const setPrompt = (v: string) => setCreationDraft({ prompt: v })
  const setDocType = (v: string) => setCreationDraft({ docType: v })
  const setAudience = (v: string) => setCreationDraft({ audience: v })
  const setGeneratedContent = (updater: string | ((prev: string) => string)) => {
    if (typeof updater === 'function') {
      setCreationDraft({ generatedContent: sanitizeGeneratedContent(updater(useAppStore.getState().creationDraft.generatedContent)) })
    } else {
      setCreationDraft({ generatedContent: sanitizeGeneratedContent(updater) })
    }
  }
  const setInheritFormat = (v: boolean) => setCreationDraft({ inheritFormat: v })
  const setEnableRag = (v: boolean) => setCreationDraft({ enableRag: v })
  const setEnableWebSearch = (v: boolean) => setCreationDraft({ enableWebSearch: v })
  const setEnableImageGeneration = (v: boolean) => setCreationDraft({ enableImageGeneration: v })
  const setContentWeight = (v: number) => setCreationDraft({ contentWeight: v })
  const setQualityWeight = (v: number) => setCreationDraft({ qualityWeight: v })
  const setCompletenessWeight = (v: number) => setCreationDraft({ completenessWeight: v })
  const setUsageWeight = (v: number) => setCreationDraft({ usageWeight: v })
  const setFormatWeight = (v: number) => setCreationDraft({ formatWeight: v })
  const setFreshnessWeight = (v: number) => setCreationDraft({ freshnessWeight: v })
  const setReferencePreview = (v: ReferencePreview | null) => setCreationDraft({ referencePreview: v })

  const [isGenerating, setIsGenerating] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copySuccess, setCopySuccess] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [topTab, setTopTab] = useState<'creation' | 'history'>('creation')
  const [activeBottomTab, setActiveBottomTab] = useState<'reference' | 'config' | null>(null)
  const toggleBottomTab = (tab: 'reference' | 'config') =>
    setActiveBottomTab(prev => prev === tab ? null : tab)
  const [creationHistory, setCreationHistory] = useState<Array<{ prompt: string; timestamp: string; preview: string; fullContent: string }>>([])
  const contentRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startTimer = () => {
    setElapsedSeconds(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1)
    }, 1000)
  }

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => () => stopTimer(), [])

  const handleOpenReferenceSource = (item: Pick<ReferenceItem, 'id'>) => {
    const templateId = String(item.id)
    pushBakeNavigationTarget({ windowMode: 'creation' })
    setBakeTemplateQuery('')
    setBakeTemplateOffset(0)
    setBakeTemplateLimit(100)
    setBakeTab('templates')
    setSelectedTemplateId(templateId)
    setWindowMode('bake')
  }

  const handleRestoreHistory = (item: typeof creationHistory[0]) => {
    setPrompt(item.prompt)
    setGeneratedContent(item.fullContent)
    setReferencePreview(null)
    if (contentRef.current) {
      setTimeout(() => contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 100)
    }
  }

  const creationModelConfigs = useAppStore((s) => s.creationModelConfigs)

  const buildPayload = () => {
    const LOCAL_MODEL_ID = 'mbcd-std-v1'
    const MODEL_NAMES: Record<string, string> = {
      'mbcd-plus-v1': 'claude-opus-4-8',
      'mbcd-std-v1': 'qwen3.5:4b',
      'claude-opus-4-8': 'claude-opus-4-8',
      'qwen-3-5-4b': 'qwen3.5:4b',
    }
    const activeModel = creationModelConfigs.find(c => c.enabled && (c.id === LOCAL_MODEL_ID || c.apiKey))
    return {
      user_prompt: prompt,
      design_templates: [],
      design_ids: [],
      timeline_ids: [],
      capture_ids: [],
      doc_type: docType,
      audience,
      output_format: 'markdown',
      inherit_format: inheritFormat,
      enable_rag: enableRag,
      enable_web_search: enableWebSearch,
      enable_image_generation: enableImageGeneration,
      content_weight: contentWeight / 100,
      quality_weight: qualityWeight / 100,
      completeness_weight: completenessWeight / 100,
      usage_weight: usageWeight / 100,
      format_weight: formatWeight / 100,
      freshness_weight: freshnessWeight / 100,
      max_references: 6,
      ...(activeModel ? {
        creation_model: MODEL_NAMES[activeModel.id] || activeModel.id,
        ...(activeModel.id !== LOCAL_MODEL_ID && activeModel.apiKey ? { creation_api_key: activeModel.apiKey } : {}),
        creation_base_url: activeModel.baseUrl || undefined,
      } : {}),
    }
  }

  const postReferencePreview = async () => {
    const payload = buildPayload()
    const response = await fetch(`${apiBaseUrl}/api/creation/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (response.ok) return response
    if (response.status !== 404) return response

    return fetch('http://127.0.0.1:8001/creation/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  const handlePreviewReferences = async () => {
    if (!prompt.trim()) return
    setIsPreviewing(true)
    setError(null)
    try {
      const response = await postReferencePreview()
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, `参考资料预览失败: ${response.status}`))
      }
      const data = await response.json()
      setReferencePreview(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '参考资料预览失败')
    } finally {
      setIsPreviewing(false)
    }
  }

  const handleGenerate = async () => {
    if (!prompt.trim()) return

    setIsGenerating(true)
    setError(null)
    setGeneratedContent('')
    startTimer()

    try {
      let refCount = 0
      if (enableRag) {
        try {
          const refResponse = await postReferencePreview()
          if (refResponse.ok) {
            const refData = await refResponse.json()
            setReferencePreview(refData)
            refCount = refData?.references?.length || 0
          }
        } catch (refErr) {
          console.warn('参考资料同步加载失败,继续生成:', refErr)
        }
      }

      const response = await fetch(`${apiBaseUrl}/api/creation/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })

      if (!response.ok) {
        const message = await readApiErrorMessage(response, `生成失败: ${response.status}`)
        throw new Error(message.startsWith('生成失败') ? message : `生成失败: ${message}`)
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error('无法读取响应流')

      let buffer = ''
      let finalContent = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const jsonStr = line.slice(6)
          let event: any
          try {
            event = JSON.parse(jsonStr)
          } catch {
            finalContent += jsonStr
            setGeneratedContent(prev => prev + jsonStr)
            continue
          }

          if (typeof event === 'string') {
            finalContent += event
            setGeneratedContent(prev => prev + event)
            continue
          }
          if (event?.error) {
            throw new Error(`生成失败: ${event.error}`)
          }
          if (event?.done) {
            continue
          }
          const content = typeof event?.content === 'string' ? event.content : ''
          if (content) {
            finalContent += content
            setGeneratedContent(prev => prev + content)
          }
        }
      }

      if (!finalContent.trim()) {
        throw new Error('生成结束但没有返回内容，请检查本地 Ollama 是否运行、当前创作模型是否已安装')
      }

      if (finalContent) {
        try {
          await fetch(`${apiBaseUrl}/api/creation/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: prompt.trim(),
              generated_content: sanitizeGeneratedContent(finalContent),
              doc_type: docType || null,
              audience: audience || null,
              reference_count: refCount,
            }),
          })
          const historyResponse = await fetch(`${apiBaseUrl}/api/creation/history`)
          if (historyResponse.ok) {
            const histories = await historyResponse.json()
            setCreationHistory(mapCreationHistory(histories))
          }
        } catch (saveErr) {
          console.error('保存创作记录失败:', saveErr)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setIsGenerating(false)
      stopTimer()
    }
  }

  useEffect(() => {
    if (!isGenerating && generatedContent && prompt) {
      const preview = generatedContent.slice(0, 100) + (generatedContent.length > 100 ? '...' : '')
      setCreationHistory(prev => {
        if (prev[0]?.prompt === prompt.trim()) return prev
        return [{
          prompt: prompt.trim(),
          timestamp: new Date().toLocaleString('zh-CN'),
          preview,
          fullContent: generatedContent
        }, ...prev].slice(0, 10)
      })
    }
  }, [isGenerating, generatedContent, prompt])

  useEffect(() => {
    const loadHistory = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/creation/history`)
        if (response.ok) {
          const histories = await response.json()
          setCreationHistory(mapCreationHistory(histories))
        }
      } catch (err) {
        console.error('加载创作记录失败:', err)
      }
    }
    loadHistory()
  }, [apiBaseUrl])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(generatedContent)
    setCopySuccess(true)
    setTimeout(() => setCopySuccess(false), 2000)
  }

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = contentRef.current.scrollHeight
  }, [generatedContent])

  const totalWeight = contentWeight + qualityWeight + completenessWeight + usageWeight + formatWeight + freshnessWeight
  const generationProgress = isGenerating
    ? Math.min(95, Math.max(5, Math.round((elapsedSeconds / 90) * 100)))
    : generatedContent
      ? 100
      : 0

  const handleReferenceClick = (refId: string) => {
    const normalizedId = Number(refId)
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) return
    handleOpenReferenceSource({ id: normalizedId })
  }

  const headingId = (node: any) =>
    node.children.map((c: any) => c.value || '').join('').toLowerCase().replace(/\s+/g, '-')

  const markdownComponents = {
    h1: ({ node, children, ...props }: any) => <h1 id={headingId(node)} style={{ fontSize: 26, lineHeight: 1.25, margin: '0 0 18px' }} {...props}>{children}</h1>,
    h2: ({ node, children, ...props }: any) => <h2 id={headingId(node)} style={{ fontSize: 20, lineHeight: 1.35, margin: '24px 0 12px' }} {...props}>{children}</h2>,
    h3: ({ node, children, ...props }: any) => <h3 id={headingId(node)} style={{ fontSize: 16, lineHeight: 1.45, margin: '18px 0 9px' }} {...props}>{children}</h3>,
    p: ({ node, ...props }: any) => <p style={{ margin: '9px 0', lineHeight: 1.75 }} {...props} />,
    li: ({ node, ...props }: any) => <li style={{ margin: '6px 0', lineHeight: 1.65 }} {...props} />,
    code: ({ node, ...props }: any) => <code style={{ background: '#f2f4f7', padding: '2px 5px', borderRadius: 4 }} {...props} />,
    a: ({ node, href, children, ...props }: any) => {
      if (href?.startsWith('#ref-')) {
        const refId = href.substring(5)
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault()
              handleReferenceClick(refId)
            }}
            style={{
              color: '#0f766e',
              textDecoration: 'underline',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            {children}
            <sup style={{ fontSize: '0.75em', marginLeft: 2 }}>📚</sup>
          </a>
        )
      }
      if (href?.startsWith('#')) {
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault()
              document.getElementById(decodeURIComponent(href.substring(1)))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
            style={{ color: '#0f766e', textDecoration: 'underline', cursor: 'pointer' }}
          >{children}</a>
        )
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#0f766e', textDecoration: 'underline' }} {...props}>{children}</a>
    }
  }

  return (
    <div className={className} style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#f6f7f9', color: '#172033' }}>

      {/* 顶部 Tab 栏 */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e1e5ea', background: '#fff', padding: '0 22px', flexShrink: 0 }}>
        {(['creation', 'history'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setTopTab(tab)}
            style={{
              padding: '12px 16px',
              border: 'none',
              borderBottom: topTab === tab ? '2px solid #0f766e' : '2px solid transparent',
              background: 'none',
              color: topTab === tab ? '#0f766e' : '#667085',
              fontWeight: topTab === tab ? 650 : 400,
              fontSize: 14,
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {tab === 'creation' ? '方案创作' : `创作记录${creationHistory.length ? ` (${creationHistory.length})` : ''}`}
          </button>
        ))}
      </div>

      {topTab === 'history' ? (
        <div style={{ flex: 1, overflow: 'auto', padding: 22 }}>
          {creationHistory.length > 0 ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {creationHistory.map((item, idx) => (
                <div
                  key={idx}
                  onClick={() => { handleRestoreHistory(item); setTopTab('creation') }}
                  style={{ padding: 12, border: '1px solid #e1e5ea', borderRadius: 8, background: '#fff', cursor: 'pointer', transition: 'border-color 0.15s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#0f766e' }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e1e5ea' }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', marginBottom: 6 }}>{item.prompt}</div>
                  <div style={{ fontSize: 11, color: '#667085', marginBottom: 6 }}>{item.timestamp}</div>
                  <div style={{ fontSize: 12, color: '#475467', lineHeight: 1.5 }}>{item.preview}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: '#667085', fontSize: 13 }}>暂无创作记录</div>
          )}
        </div>
      ) : (
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <section style={{ padding: 22, borderBottom: '1px solid #e1e5ea', background: '#fff', flexShrink: 0 }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={defaultPrompt}
              style={{ ...inputStyle, minHeight: 118, resize: 'vertical', lineHeight: 1.6 }}
              disabled={isGenerating}
            />
            <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={handlePreviewReferences} disabled={!prompt.trim() || isPreviewing || isGenerating} style={secondaryButtonStyle}>
                {isPreviewing ? <Loader2 size={16} className="spin" /> : <FileText size={16} />}
                预览参考
              </button>
              <button onClick={handleGenerate} disabled={!prompt.trim() || isGenerating} style={primaryButtonStyle}>
                {isGenerating ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                {isGenerating ? '生成中' : '开始创作'}
              </button>
            </div>
            {isGenerating && (
              <ProgressStrip
                label={`已思考 ${elapsedSeconds} 秒`}
                percent={generationProgress}
              />
            )}
            {error && <div style={{ marginTop: 12, color: '#b42318', fontSize: 13 }}>{error}</div>}
          </section>

          <section style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 22 }}>
            <div style={{ height: '100%', border: '1px solid #e1e5ea', borderRadius: 8, background: '#fff', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ height: 48, padding: '0 16px', borderBottom: '1px solid #e1e5ea', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 650 }}>创作文档</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {isGenerating && (
                    <span style={{ fontSize: 12, color: '#0f766e', fontWeight: 650 }}>
                      {generationProgress}% · {elapsedSeconds} 秒
                    </span>
                  )}
                  <button onClick={handleCopy} disabled={!generatedContent} style={compactButtonStyle}>
                    <Copy size={15} />
                    {copySuccess ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
              <div ref={contentRef} style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {generatedContent ? (
                  <MarkdownContent content={generatedContent} components={markdownComponents} />
                ) : isGenerating ? (
                  <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#667085', fontSize: 14, gap: 12 }}>
                    <Loader2 size={28} className="spin" color="#0f766e" />
                    <div style={{ textAlign: 'center', lineHeight: 1.6 }}>
                      <div style={{ fontWeight: 600, color: '#0f766e', marginBottom: 4 }}>模型正在深度推理中</div>
                      <div>已思考 {elapsedSeconds} 秒，预计进度 {generationProgress}%</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#98a2b3', fontSize: 14 }}>
                    输入创作需求后，可以先预览参考资料，也可以直接开始生成。
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* 底部互斥 Tab */}
          <div style={{ background: '#fff', borderTop: '1px solid #e1e5ea', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px' }}>
              {([
                { key: 'reference', label: '参考资料', badge: referencePreview?.references?.length || 0 },
                { key: 'config', label: '创作参数', badge: 0 },
              ] as const).map(({ key, label, badge }) => (
                <button
                  key={key}
                  onClick={() => toggleBottomTab(key)}
                  style={{
                    padding: '10px 16px',
                    border: 'none',
                    borderTop: activeBottomTab === key ? '2px solid #0f766e' : '2px solid transparent',
                    background: 'none',
                    color: activeBottomTab === key ? '#0f766e' : '#667085',
                    fontWeight: activeBottomTab === key ? 650 : 400,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {label}{badge > 0 ? ` (${badge})` : ''}
                </button>
              ))}
              {activeBottomTab && (
                <button
                  onClick={() => setActiveBottomTab(null)}
                  style={{ marginLeft: 'auto', padding: '4px 10px', border: '1px solid #e1e5ea', borderRadius: 5, background: '#f3f4f6', color: '#6b7280', fontSize: 12, cursor: 'pointer' }}
                >
                  收起
                </button>
              )}
            </div>
            {activeBottomTab === 'reference' && (
              <div style={{ padding: 16, maxHeight: 280, overflowY: 'auto', background: '#fafbfc', borderTop: '1px solid #e1e5ea' }}>
                {referencePreview?.references?.length ? (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {referencePreview.references.map((ref: any) => (
                      <ReferenceRow key={ref.id} item={ref} onOpenSource={handleOpenReferenceSource} />
                    ))}
                  </div>
                ) : (
                  <div style={{ color: '#667085', fontSize: 13 }}>暂无资料，请先点击「预览参考」。</div>
                )}
              </div>
            )}
            {activeBottomTab === 'config' && (
              <div style={{ padding: 16, maxHeight: 280, overflowY: 'auto', background: '#fafbfc', borderTop: '1px solid #e1e5ea', display: 'grid', gap: 12 }}>
                <label style={{ display: 'grid', gap: 7, fontSize: 13 }}>
                  文档类型
                  <input value={docType} onChange={(e) => setDocType(e.target.value)} placeholder="建设方案" style={inputStyle} />
                </label>
                <label style={{ display: 'grid', gap: 7, fontSize: 13 }}>
                  目标读者
                  <input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="客户" style={inputStyle} />
                </label>
                <Toggle label="启用 RAG 参考" checked={enableRag} onChange={setEnableRag} />
                <Toggle label="继承历史格式" checked={inheritFormat} onChange={setInheritFormat} />
                <Toggle label="互联网检索" checked={enableWebSearch} onChange={setEnableWebSearch} icon={<Search size={16} />} />
                <Toggle label="图片生成建议" checked={enableImageGeneration} onChange={setEnableImageGeneration} icon={<Image size={16} />} />
                <div style={{ height: 1, background: '#e1e5ea', margin: '4px 0' }} />
                <div style={{ fontSize: 12, color: '#475467', display: 'flex', justifyContent: 'space-between' }}>
                  <span>权重配置</span>
                  <span style={{ color: totalWeight === 100 ? '#0f766e' : '#b54708' }}>{totalWeight}%</span>
                </div>
                <WeightSlider label="内容相关度" value={contentWeight} onChange={setContentWeight} />
                <WeightSlider label="文档质量" value={qualityWeight} onChange={setQualityWeight} />
                <WeightSlider label="完整性" value={completenessWeight} onChange={setCompletenessWeight} />
                <WeightSlider label="打开/引用热度" value={usageWeight} onChange={setUsageWeight} />
                <WeightSlider label="格式匹配" value={formatWeight} onChange={setFormatWeight} />
                <WeightSlider label="时效性" value={freshnessWeight} onChange={setFreshnessWeight} />
              </div>
            )}
          </div>
        </main>
      )}

    </div>
  )
}

const MarkdownContent = ({ content, components }: { content: string; components: any }) => {
  const inlineComponents = {
    ...components,
    p: ({ children }: any) => <>{children}</>,
  }

  return (
    <>
      {parseMarkdownBlocks(content).map((block, index) => {
        if (block.type === 'markdown') {
          return <ReactMarkdown key={`markdown-${index}`} components={components}>{block.content}</ReactMarkdown>
        }

        return (
          <div key={`table-${index}`} style={{ overflowX: 'auto', margin: '16px 0' }}>
            <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 14, lineHeight: 1.55 }}>
              <thead>
                <tr>
                  {block.headers.map((header, cellIndex) => (
                    <th
                      key={cellIndex}
                      style={{
                        border: '1px solid #d0d5dd',
                        background: '#f8fafc',
                        color: '#172033',
                        fontWeight: 700,
                        padding: '10px 12px',
                        textAlign: block.alignments[cellIndex] || 'left',
                        verticalAlign: 'top',
                      }}
                    >
                      <ReactMarkdown components={inlineComponents}>{header}</ReactMarkdown>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {block.headers.map((_, cellIndex) => (
                      <td
                        key={cellIndex}
                        style={{
                          border: '1px solid #d0d5dd',
                          padding: '10px 12px',
                          textAlign: block.alignments[cellIndex] || 'left',
                          verticalAlign: 'top',
                          background: rowIndex % 2 === 0 ? '#fff' : '#fbfcfe',
                        }}
                      >
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

const Toggle = ({ label, checked, onChange, icon }: { label: string; checked: boolean; onChange: (value: boolean) => void; icon?: React.ReactNode }) => (
  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 14, color: '#344054' }}>
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{icon}{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  </label>
)

const WeightSlider = ({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) => (
  <label style={{ display: 'grid', gap: 6, marginBottom: 11, fontSize: 12, color: '#667085' }}>
    <span style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span>{label}</span>
      <span>{value}%</span>
    </span>
    <input type="range" min={0} max={70} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </label>
)

const ProgressStrip = ({ label, percent }: { label: string; percent: number }) => (
  <div style={{ marginTop: 12, display: 'grid', gap: 6, maxWidth: 360 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475467' }}>
      <span>{label}</span>
      <span>{percent}%</span>
    </div>
    <div style={{ height: 6, borderRadius: 999, background: '#e4e7ec', overflow: 'hidden' }}>
      <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: '#0f766e', transition: 'width 0.25s ease' }} />
    </div>
  </div>
)

const ReferenceRow = ({ item, onOpenSource }: { item: ReferenceItem; onOpenSource: (item: ReferenceItem) => void }) => (
  <div style={{ border: '1px solid #e1e5ea', borderRadius: 8, padding: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ fontSize: 14, fontWeight: 650, lineHeight: 1.35 }}>{item.title}</div>
    </div>
    <div style={{ marginTop: 6, fontSize: 12, color: '#667085' }}>{item.doc_type || '未分类'} · 打开/引用 {item.usage_count}</div>
    <div style={{ marginTop: 8, fontSize: 12, color: '#475467', lineHeight: 1.55 }}>{item.reason}</div>
    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, fontSize: 11, color: '#667085' }}>
      <span>相关 {Math.round(item.relevance_score * 100)}</span>
      <span>完整 {Math.round(item.completeness_score * 100)}</span>
      <span>格式 {Math.round(item.format_score * 100)}</span>
    </div>
    <button
      type="button"
      onClick={() => onOpenSource(item)}
      style={{
        marginTop: 10,
        padding: '6px 10px',
        border: '1px solid #d0d5dd',
        borderRadius: 6,
        background: '#fff',
        color: '#0f766e',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <ExternalLink size={13} />
      资料来源
    </button>
  </div>
)

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
  background: '#fff',
}

const primaryButtonStyle: React.CSSProperties = {
  height: 38,
  padding: '0 15px',
  border: '1px solid #0f766e',
  borderRadius: 8,
  background: '#0f766e',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  fontWeight: 650,
}

const secondaryButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  background: '#fff',
  color: '#344054',
  border: '1px solid #d0d5dd',
}

const compactButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  height: 32,
  padding: '0 10px',
  fontSize: 13,
}

export default CreationPanel
