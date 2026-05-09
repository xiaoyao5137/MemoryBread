import React, { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'

interface CreationPanelProps {
  className?: string
}

const CreationPanel: React.FC<CreationPanelProps> = ({ className = '' }) => {
  const [prompt, setPrompt] = useState('')
  const [generatedContent, setGeneratedContent] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copySuccess, setCopySuccess] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const handleGenerate = async () => {
    if (!prompt.trim()) return

    setIsGenerating(true)
    setError(null)
    setGeneratedContent('')

    try {
      const response = await fetch('http://localhost:7070/api/creation/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_prompt: prompt,
          design_ids: [],
          timeline_ids: [],
          capture_ids: []
        })
      })

      if (!response.ok) {
        throw new Error(`生成失败: ${response.statusText}`)
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) {
        throw new Error('无法读取响应流')
      }

      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6)
            try {
              const content = JSON.parse(jsonStr)
              console.log('SSE行:', JSON.stringify(line.substring(0, 50)), '提取内容:', JSON.stringify(content))
              setGeneratedContent(prev => {
                const newContent = prev + content
                console.log('拼接内容:', JSON.stringify(newContent.slice(-50)))
                return newContent
              })
            } catch (e) {
              console.error('JSON解析失败:', jsonStr)
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(generatedContent)
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [generatedContent])

  return (
    <div style={{ padding: '24px', height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#fff' }}>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '8px' }}>
          ✨ 创作
        </h2>
        <p style={{ color: '#666', fontSize: '14px' }}>
          输入创作指令，基于设计模板和采集内容生成文档
        </p>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="例如：帮我写一份关于本周工作总结的文档..."
          style={{
            width: '100%',
            minHeight: '120px',
            padding: '12px',
            border: '1px solid #ddd',
            borderRadius: '8px',
            fontSize: '14px',
            resize: 'vertical',
            fontFamily: 'inherit'
          }}
          disabled={isGenerating}
        />
      </div>

      <div style={{ marginBottom: '16px' }}>
        <button
          onClick={handleGenerate}
          disabled={!prompt.trim() || isGenerating}
          style={{
            padding: '10px 20px',
            backgroundColor: isGenerating ? '#ccc' : '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: isGenerating ? 'not-allowed' : 'pointer',
            fontSize: '14px',
            fontWeight: '500'
          }}
        >
          {isGenerating ? '生成中...' : '开始创作'}
        </button>
      </div>

      {error && (
        <div style={{
          padding: '12px',
          backgroundColor: '#fee',
          border: '1px solid #fcc',
          borderRadius: '6px',
          color: '#c33',
          fontSize: '14px',
          marginBottom: '16px'
        }}>
          {error}
        </div>
      )}

      {generatedContent && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{
            padding: '12px 16px',
            backgroundColor: '#f8f9fa',
            borderBottom: '1px solid #ddd',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <span style={{ fontSize: '14px', fontWeight: '500' }}>生成的文档</span>
            {generatedContent && (
              <button
                onClick={handleCopy}
                style={{
                  padding: '6px 12px',
                  backgroundColor: copySuccess ? '#28a745' : 'white',
                  color: copySuccess ? 'white' : '#333',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '13px'
                }}
              >
                {copySuccess ? '✓ 已复制' : '📋 复制'}
              </button>
            )}
          </div>
          <div
            ref={contentRef}
            style={{
              flex: 1,
              padding: '16px',
              overflowY: 'auto',
              backgroundColor: 'white'
            }}
          >
            {console.log('最终渲染内容:', JSON.stringify(generatedContent.substring(0, 200)))}
            <ReactMarkdown
              components={{
                h1: ({node, ...props}) => <h1 style={{fontSize: '2em', fontWeight: 'bold', marginTop: '0.67em', marginBottom: '0.67em'}} {...props} />,
                h2: ({node, ...props}) => <h2 style={{fontSize: '1.5em', fontWeight: 'bold', marginTop: '0.83em', marginBottom: '0.83em'}} {...props} />,
                h3: ({node, ...props}) => <h3 style={{fontSize: '1.17em', fontWeight: 'bold', marginTop: '1em', marginBottom: '1em'}} {...props} />,
                h4: ({node, ...props}) => <h4 style={{fontSize: '1em', fontWeight: 'bold', marginTop: '1.33em', marginBottom: '1.33em'}} {...props} />,
                p: ({node, ...props}) => <p style={{marginTop: '1em', marginBottom: '1em'}} {...props} />,
              }}
            >
              {generatedContent}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}

export default CreationPanel
