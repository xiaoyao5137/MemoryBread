import React, { useEffect, useRef, useState } from 'react'
import type { ModelEntry } from '../types'
import { CREATION_MODEL_PREFERENCE_KEY, useAppStore } from '../store/useAppStore'
import type { CreationModelConfig } from '../store/useAppStore'

const SIDECAR = 'http://localhost:7071'

type OllamaSetupDetail = {
  message?: string
  is_macos?: boolean
  system_version?: string
  arch?: string
  ollama_installed?: boolean
  ollama_running?: boolean
  ollama_version?: string
  brew_available?: boolean
  recommended_install_method?: string
}

type LlmConcurrencyConfig = {
  max_concurrency: number
  max_allowed: number
  stats?: {
    running_total?: number
    queue_lengths?: Record<string, number>
    running_by_lane?: Record<string, number>
  }
}

const PROVIDER_LABEL: Record<string, string> = {
  ollama: '本地模型', huggingface: 'HuggingFace',
  openai: 'OpenAI', anthropic: 'Anthropic',
  tongyi: '通义千问', doubao: '豆包', deepseek: 'DeepSeek', kimi: 'Kimi',
  google: 'Google', kling: '可灵',
}
const PROVIDER_COLOR: Record<string, string> = {
  ollama: '#007AFF', huggingface: '#FF9500',
  openai: '#34C759', anthropic: '#AF52DE',
  tongyi: '#FF6B35', doubao: '#1677FF', deepseek: '#06B6D4', kimi: '#8B5CF6',
  google: '#4285F4', kling: '#FF2D55',
}
const CATEGORY_LABEL: Record<string, string> = {
  llm: 'LLM', embedding: '向量模型', image: '生图模型', ocr: 'OCR', asr: '语音识别', vlm: '视觉模型',
}
const STATUS_COLOR: Record<string, string> = {
  not_installed: '#AEAEB2', downloading: '#FF9500', loading: '#FF9500',
  installed: '#34C759', active: '#007AFF', error: '#FF3B30',
}
const STATUS_LABEL: Record<string, string> = {
  not_installed: '未安装', downloading: '下载中', loading: '加载中',
  installed: '已安装', active: '使用中', error: '错误',
}

// ── API Key 配置弹窗 ──────────────────────────────────────────────────────────
const ApiKeyDialog: React.FC<{
  model: ModelEntry
  onClose: () => void
  onSaved: () => void
}> = ({ model, onClose, onSaved }) => {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState('')
  const [validMsg, setValidMsg] = useState('')
  const fields = model.api_key_fields || []

  const handleSave = async () => {
    const missing = fields.filter(f => f.required && !values[f.key])
    if (missing.length) { setError(`请填写：${missing.map(f => f.label).join('、')}`); return }
    setSaving(true); setError('')
    try {
      const r = await fetch(`${SIDECAR}/api/models/${model.id}/configure`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: values }),
      })
      const d = await r.json()
      if (d.status !== 'ok') throw new Error(d.message)
      onSaved(); onClose()
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  const handleValidate = async () => {
    setValidating(true); setValidMsg(''); setError('')
    try {
      await fetch(`${SIDECAR}/api/models/${model.id}/configure`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: values }),
      })
      const r = await fetch(`${SIDECAR}/api/models/${model.id}/validate`, { method: 'POST' })
      const d = await r.json()
      if (d.valid) setValidMsg('✓ ' + d.message)
      else setError(d.message)
    } catch (e: any) { setError(e.message) } finally { setValidating(false) }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{ background: 'white', borderRadius: 16, padding: 24, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>配置 {model.name}</div>
        <div style={{ fontSize: 12, color: '#6E6E73', marginBottom: 18 }}>{model.description}</div>
        {fields.map(f => (
          <div key={f.key} style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: '#6E6E73', display: 'block', marginBottom: 4 }}>
              {f.label}{f.required && <span style={{ color: '#FF3B30' }}> *</span>}
            </label>
            <input
              type={f.secret ? 'password' : 'text'}
              placeholder={f.placeholder}
              value={values[f.key] || ''}
              onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 13,
                border: '1px solid rgba(0,0,0,0.15)', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        ))}
        {error && <div style={{ fontSize: 12, color: '#FF3B30', marginBottom: 10 }}>{error}</div>}
        {validMsg && <div style={{ fontSize: 12, color: '#34C759', marginBottom: 10 }}>{validMsg}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
          <button onClick={handleValidate} disabled={validating} style={btn('#F2F2F7', '#333', 12)}>
            {validating ? '验证中...' : '验证 Key'}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btn('#F2F2F7', '#333')}>取消</button>
            <button onClick={handleSave} disabled={saving} style={btn('#007AFF', 'white')}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 模型体验对话弹窗 ──────────────────────────────────────────────────────────
type ChatMessage = { role: 'user' | 'assistant'; content: string }

const ModelChatDialog: React.FC<{
  model: ModelEntry
  onClose: () => void
}> = ({ model, onClose }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }
  useEffect(scrollToBottom, [messages])

  const handleSend = async () => {
    const q = inputValue.trim()
    if (!q || chatLoading) return
    setInputValue('')
    setChatError('')
    const userMsg: ChatMessage = { role: 'user', content: q }
    setMessages(prev => [...prev, userMsg])
    setChatLoading(true)

    try {
      const chatMessages = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
      const response = await fetch(`${SIDECAR}/api/models/${model.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ message: `HTTP ${response.status}` }))
        setChatError(errData.message || `请求失败 (${response.status})`)
        setChatLoading(false)
        return
      }

      // 流式读取 SSE
      const reader = response.body?.getReader()
      if (!reader) {
        setChatError('无法读取响应流')
        setChatLoading(false)
        return
      }

      const decoder = new TextDecoder()
      let assistantContent = ''
      setMessages(prev => [...prev, { role: 'assistant', content: '' }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const dataStr = line.slice(6).trim()
          if (!dataStr) continue
          try {
            const evt = JSON.parse(dataStr)
            if (evt.content) {
              assistantContent += evt.content
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = { role: 'assistant', content: assistantContent }
                return updated
              })
            }
            if (evt.error) {
              setChatError(evt.error)
            }
            if (evt.done) {
              // 流式结束
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e: any) {
      setChatError(e.message || '连接失败')
    } finally {
      setChatLoading(false)
    }
  }

  const handleReset = () => {
    setMessages([])
    setChatError('')
    setInputValue('')
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: 'white', borderRadius: 16, width: 520, maxHeight: '80vh',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column',
      }}>
        {/* 标题栏 */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid rgba(0,0,0,0.07)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>体验 {model.name}</span>
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4,
              background: `${PROVIDER_COLOR[model.provider]}18`, color: PROVIDER_COLOR[model.provider],
            }}>{PROVIDER_LABEL[model.provider]}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleReset} style={btn('#F2F2F7', '#333', 11)}>重置</button>
            <button onClick={onClose} style={btn('#F2F2F7', '#333', 11)}>关闭</button>
          </div>
        </div>

        {/* 对话区域 */}
        <div style={{
          flex: 1, overflow: 'auto', padding: '12px 16px',
          minHeight: 300, maxHeight: 'calc(80vh - 120px)',
          background: '#F5F5F7',
        }}>
          {messages.length === 0 && !chatLoading && (
            <div style={{ textAlign: 'center', color: '#AEAEB2', fontSize: 13, padding: 60 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>💬</div>
              <div>和 {model.name} 开始对话</div>
              <div style={{ fontSize: 11, marginTop: 4 }}>输入任何问题来体验这个模型的能力</div>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} style={{
              display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: 8,
            }}>
              <div style={{
                maxWidth: '80%', padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.5,
                background: msg.role === 'user' ? '#007AFF' : 'white',
                color: msg.role === 'user' ? 'white' : '#333',
                border: msg.role === 'user' ? 'none' : '1px solid rgba(0,0,0,0.07)',
              }}>{msg.content}</div>
            </div>
          ))}
          {chatLoading && messages[messages.length - 1]?.role === 'user' && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
              <div style={{
                padding: '8px 12px', borderRadius: 12, fontSize: 13,
                background: 'white', border: '1px solid rgba(0,0,0,0.07)', color: '#AEAEB2',
              }}>思考中...</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 错误提示 */}
        {chatError && (
          <div style={{ padding: '4px 16px', fontSize: 12, color: '#FF3B30', background: '#FF3B3010' }}>
            ⚠️ {chatError}
          </div>
        )}

        {/* 输入区域 */}
        <div style={{
          padding: '8px 16px', borderTop: '1px solid rgba(0,0,0,0.07)',
          display: 'flex', gap: 8,
        }}>
          <input
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder="输入消息..."
            disabled={chatLoading}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 13,
              border: '1px solid rgba(0,0,0,0.15)', outline: 'none',
            }}
          />
          <button
            onClick={handleSend}
            disabled={!inputValue.trim() || chatLoading}
            style={btn(chatLoading ? '#AEAEB2' : '#007AFF', 'white', 13)}
          >
            {chatLoading ? '...' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 模型卡片 ──────────────────────────────────────────────────────────────────
const ModelCard: React.FC<{
  model: ModelEntry
  onDownload: () => void
  onActivate: () => void
  onDelete: () => void
  onConfigure: () => void
  onUpgrade?: () => void
  onChat?: () => void
  downloading: boolean
  activating?: boolean
}> = ({ model, onDownload, onActivate, onDelete, onConfigure, onUpgrade, onChat, downloading, activating }) => {
  const isApi = model.requires_api_key
  const isInferenceEngine = model.category === 'inference_engine'
  const isActive = model.status === 'active'
  const isInstalled = model.status === 'installed' || isActive
  const isDownloading = model.status === 'downloading' || downloading
  const isLoading = model.status === 'loading' || activating

  return (
    <div style={{
      background: 'white', borderRadius: 12, padding: '12px 14px',
      border: `1px solid ${isActive ? 'rgba(0,122,255,0.3)' : 'rgba(0,0,0,0.07)'}`,
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{model.name}</span>
            {model.size_gb > 0 && (
              <span style={{ fontSize: 11, color: '#AEAEB2' }}>{model.size_gb}GB</span>
            )}
            {(model as any).version && (
              <span style={{ fontSize: 11, color: '#AEAEB2' }}>v{(model as any).version}</span>
            )}
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4,
              background: `${PROVIDER_COLOR[model.provider]}18`,
              color: PROVIDER_COLOR[model.provider],
            }}>{PROVIDER_LABEL[model.provider] || model.provider}</span>
            {model.recommended && (
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 4,
                background: '#34C75918', color: '#34C759', fontWeight: 600,
              }}>推荐</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#6E6E73', marginTop: 3 }}>{model.description}</div>
          {model.tags && model.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
              {model.tags.slice(0, 4).map(t => (
                <span key={t} style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 4,
                  background: 'rgba(0,0,0,0.05)', color: '#6E6E73',
                }}>{t}</span>
              ))}
            </div>
          )}
          {isDownloading && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6E6E73', marginBottom: 3 }}>
                <span>下载中...</span>
                <span>{model.download_progress || 0}%</span>
              </div>
              <div style={{ height: 4, borderRadius: 2, background: '#E5E5EA' }}>
                <div style={{
                  height: '100%', borderRadius: 2, background: '#FF9500',
                  width: `${model.download_progress || 0}%`, transition: 'width 0.3s',
                }} />
              </div>
            </div>
          )}
          {model.error && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#FF3B30', background: '#FF3B3010', padding: '4px 8px', borderRadius: 4 }}>
              ⚠️ {model.error}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLOR[model.status] || '#AEAEB2' }} />
            <span style={{ fontSize: 11, color: STATUS_COLOR[model.status] || '#AEAEB2' }}>
              {STATUS_LABEL[model.status] || model.status}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            {isApi && (
              <button onClick={onConfigure} style={btn('#F2F2F7', '#333', 11)}>
                {isInstalled ? '重新配置' : '配置 Key'}
              </button>
            )}
            {isInferenceEngine && isInstalled && onUpgrade && (model as any).can_upgrade && (
              <button onClick={onUpgrade} style={btn('#007AFF', 'white', 11)}>更新</button>
            )}
            {!isApi && !isInstalled && !isDownloading && !isLoading && !isInferenceEngine && (
              <button onClick={onDownload} style={btn('#007AFF', 'white', 11)}>下载</button>
            )}
            {isInstalled && !isActive && !isLoading && !isInferenceEngine && (
              <button onClick={onActivate} style={btn('#34C759', 'white', 11)}>启用</button>
            )}
            {isActive && (
              <span style={{ fontSize: 11, color: '#007AFF', fontWeight: 600 }}>使用中</span>
            )}
            {/* 体验入口：LLM 模型已可用时显示 */}
            {(isActive || (isApi && isInstalled)) && !isInferenceEngine && onChat && (
              <button onClick={onChat} style={btn('#AF52DE18', '#AF52DE', 11)}>💬 体验</button>
            )}
            {isLoading && (
              <span style={{ fontSize: 11, color: '#FF9500', fontWeight: 600 }}>加载中</span>
            )}
            {isInstalled && !isActive && !isLoading && !isInferenceEngine && (
              <button onClick={onDelete} style={btn('#FF3B3018', '#FF3B30', 11)}>删除</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 主组件 ────────────────────────────────────────────────────────────────────
type TabType = 'llm' | 'embedding' | 'image' | 'creation'

const ModelManager: React.FC = () => {
  const [tab, setTab] = useState<TabType>('llm')
  const [models, setModels] = useState<ModelEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [configuringModel, setConfiguringModel] = useState<ModelEntry | null>(null)
  const [chattingModel, setChattingModel] = useState<ModelEntry | null>(null)
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())
  const [activatingIds, setActivatingIds] = useState<Set<string>>(new Set())
  const [ollamaSetup, setOllamaSetup] = useState<OllamaSetupDetail | null>(null)
  const [ollamaChecking, setOllamaChecking] = useState(false)
  const [ollamaInstalling, setOllamaInstalling] = useState(false)
  const [ollamaUpgrading, setOllamaUpgrading] = useState(false)
  const [ollamaError, setOllamaError] = useState('')
  const [llmConcurrency, setLlmConcurrency] = useState<LlmConcurrencyConfig | null>(null)
  const [llmConcurrencySaving, setLlmConcurrencySaving] = useState(false)
  const [llmConcurrencyError, setLlmConcurrencyError] = useState('')
  const [configuringCreationId, setConfiguringCreationId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { apiBaseUrl, creationModelConfigs, setCreationModelConfig } = useAppStore(s => ({
    apiBaseUrl: s.apiBaseUrl,
    creationModelConfigs: s.creationModelConfigs,
    setCreationModelConfig: s.setCreationModelConfig,
  }))

  const persistCreationModelConfigs = async () => {
    const configs = useAppStore.getState().creationModelConfigs
    await fetch(`${apiBaseUrl}/preferences/${encodeURIComponent(CREATION_MODEL_PREFERENCE_KEY)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(configs) }),
    })
  }

  const handleCreationModelChange = (id: string, patch: Partial<CreationModelConfig>) => {
    setCreationModelConfig(id, patch)
    void persistCreationModelConfigs()
  }

  const loadModels = async () => {
    setLoading(true)
    try {
      const r = await fetch(`${SIDECAR}/api/models`)
      const d = await r.json()
      if (d.status === 'ok') setModels(d.models)
    } catch { } finally { setLoading(false) }
  }

  const refreshOllamaSetup = async () => {
    setOllamaChecking(true)
    setOllamaError('')
    try {
      const r = await fetch(`${SIDECAR}/api/ollama/setup-status`)
      const d = await r.json()
      if (d.status === 'ok') setOllamaSetup(d.detail || null)
      else setOllamaSetup(null)
    } catch {
      setOllamaSetup(null)
      setOllamaError('无法获取 Ollama 状态')
    } finally {
      setOllamaChecking(false)
    }
  }

  const refreshLlmConcurrency = async () => {
    setLlmConcurrencyError('')
    try {
      const r = await fetch(`${SIDECAR}/api/models/llm-concurrency`)
      if (r.status === 404) {
        setLlmConcurrency({ max_concurrency: 1, max_allowed: 3 })
        return
      }
      const d = await r.json()
      if (d.status === 'ok') {
        setLlmConcurrency({
          max_concurrency: d.max_concurrency,
          max_allowed: d.max_allowed || 3,
          stats: d.stats,
        })
      } else {
        setLlmConcurrencyError(d.message || '无法获取 LLM 并发配置')
      }
    } catch {
      setLlmConcurrencyError('无法获取 LLM 并发配置')
    }
  }

  const updateLlmConcurrency = async (value: number) => {
    setLlmConcurrencySaving(true)
    setLlmConcurrencyError('')
    try {
      const r = await fetch(`${SIDECAR}/api/models/llm-concurrency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_concurrency: value }),
      })
      if (r.status === 404) {
        setLlmConcurrencyError('AI Sidecar 需要重启后才能配置 LLM 并发')
        return
      }
      const d = await r.json()
      if (d.status !== 'ok') throw new Error(d.message || '保存失败')
      setLlmConcurrency({
        max_concurrency: d.max_concurrency,
        max_allowed: d.max_allowed || 3,
        stats: d.stats,
      })
    } catch (e: any) {
      setLlmConcurrencyError(e.message || '保存失败')
    } finally {
      setLlmConcurrencySaving(false)
    }
  }

  const handleInstallOllama = async () => {
    setOllamaInstalling(true)
    setOllamaError('')
    try {
      const installResp = await fetch(`${SIDECAR}/api/ollama/install`, { method: 'POST' })
      const installData = await installResp.json()
      if (installData.status !== 'ok') {
        setOllamaError(installData.message || 'Ollama 安装失败')
        await refreshOllamaSetup()
        return
      }

      const startResp = await fetch(`${SIDECAR}/api/ollama/start`, { method: 'POST' })
      const startData = await startResp.json()
      if (startData.status !== 'ok') {
        setOllamaError(startData.message || 'Ollama 启动失败，请手动执行 ollama serve')
      }

      await refreshOllamaSetup()
      await loadModels()
    } catch {
      setOllamaError('无法连接到 AI 服务，请确保 ai-sidecar 已启动')
    } finally {
      setOllamaInstalling(false)
    }
  }

  useEffect(() => {
    loadModels()
    refreshOllamaSetup()
    refreshLlmConcurrency()
  }, [])

  // 轮询下载进度
  useEffect(() => {
    if (downloadingIds.size === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(async () => {
      const updates: Record<string, Partial<ModelEntry>> = {}
      let anyDone = false
      for (const id of downloadingIds) {
        try {
          const r = await fetch(`${SIDECAR}/api/models/${id}/status`)
          const d = await r.json()
          updates[id] = { status: d.status, download_progress: d.download_progress }
          if (d.status === 'installed' || d.status === 'active') anyDone = true
        } catch { }
      }
      setModels(prev => prev.map(m => updates[m.id] ? { ...m, ...updates[m.id] } : m))
      if (anyDone) {
        setDownloadingIds(prev => {
          const next = new Set(prev)
          for (const [id, u] of Object.entries(updates)) {
            if (u.status === 'installed' || u.status === 'active') next.delete(id)
          }
          return next
        })
      }
    }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [downloadingIds])

  const handleDownload = async (model: ModelEntry) => {
    if (model.provider === 'ollama' && !ollamaSetup?.ollama_running) {
      setOllamaError('请先安装并启动 Ollama，再下载本地模型')
      return
    }

    try {
      await fetch(`${SIDECAR}/api/models/${model.id}/download`, { method: 'POST' })
      setDownloadingIds(prev => new Set(prev).add(model.id))
      setModels(prev => prev.map(m => m.id === model.id ? { ...m, status: 'downloading', download_progress: 0 } : m))
    } catch {
      setOllamaError('下载请求失败，请稍后重试')
    }
  }

  const handleActivate = async (model: ModelEntry) => {
    setActivatingIds(prev => new Set(prev).add(model.id))
    try {
      await fetch(`${SIDECAR}/api/models/${model.id}/activate`, { method: 'POST' })
      await loadModels()
    } catch { }
    setActivatingIds(prev => {
      const next = new Set(prev)
      next.delete(model.id)
      return next
    })
  }

  const handleDelete = async (model: ModelEntry) => {
    try {
      await fetch(`${SIDECAR}/api/models/${model.id}/delete`, { method: 'DELETE' })
      await loadModels()
    } catch { }
  }

  const handleUpgrade = async () => {
    setOllamaUpgrading(true)
    setOllamaError('')
    try {
      const res = await fetch(`${SIDECAR}/api/ollama/upgrade`, { method: 'POST' })
      const data = await res.json()
      if (data.status === 'upgrading') {
        // 启动轮询
        pollUpgradeStatus()
      } else if (data.status === 'error') {
        setOllamaError(data.message || '升级失败')
        setOllamaUpgrading(false)
      }
    } catch (e) {
      setOllamaError('升级失败')
      setOllamaUpgrading(false)
    }
  }

  const pollUpgradeStatus = async () => {
    const poll = async () => {
      try {
        const res = await fetch(`${SIDECAR}/api/ollama/upgrade/status`)
        const data = await res.json()

        if (data.status === 'upgrading') {
          setOllamaError(data.message || '升级中...')
          setTimeout(poll, 2000)
        } else if (data.status === 'success') {
          setOllamaError('')
          setOllamaUpgrading(false)
          await refreshOllamaSetup()
          await loadModels()
        } else if (data.status === 'error') {
          setOllamaError(data.message || '升级失败')
          setOllamaUpgrading(false)
        } else {
          setTimeout(poll, 2000)
        }
      } catch {
        setOllamaError('获取升级状态失败')
        setOllamaUpgrading(false)
      }
    }
    poll()
  }

  // 按 tab 过滤
  const filtered = models.filter(m => {
    if (m.category === 'inference_engine') return tab === 'llm'
    return m.category === tab
  })

  // 按 category 分组
  const grouped = filtered.reduce<Record<string, ModelEntry[]>>((acc, m) => {
    const key = m.category
    if (!acc[key]) acc[key] = []
    acc[key].push(m)
    return acc
  }, {})

  // 商业 API 按 provider 分组
  const byProvider = filtered.reduce<Record<string, ModelEntry[]>>((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = []
    acc[m.provider].push(m)
    return acc
  }, {})

  // 当前激活模型
  const activeLlm = models.find(m => (m.status === 'active' || m.is_active) && m.category === 'llm')
  const activeEmb = models.find(m => (m.status === 'active' || m.is_active) && m.category === 'embedding')

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#F5F5F7' }}>

      {/* 顶部激活状态 */}
      <div style={{ padding: '10px 14px 0', display: 'flex', gap: 8 }}>
        {[
          { label: 'LLM', model: activeLlm },
          { label: 'Embedding', model: activeEmb },
        ].map(({ label, model }) => (
          <div key={label} style={{
            flex: 1, background: 'white', borderRadius: 10, padding: '8px 12px',
            border: '1px solid rgba(0,0,0,0.07)',
          }}>
            <div style={{ fontSize: 10, color: '#AEAEB2', marginBottom: 2 }}>{label}</div>
            {model ? (
              <div style={{ fontSize: 12, fontWeight: 600, color: '#007AFF' }}>{model.name}</div>
            ) : (
              <div style={{ fontSize: 12, color: '#FF9500' }}>未配置</div>
            )}
          </div>
        ))}
      </div>

      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 4, padding: '10px 14px 0' }}>
        {([
          { key: 'llm', label: '对话模型' },
          { key: 'embedding', label: '向量模型' },
          { key: 'image', label: '生图模型' },
          { key: 'creation', label: '创作模型' },
        ] as { key: TabType; label: string }[]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            fontSize: 12, padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: tab === t.key ? '#007AFF' : 'white',
            color: tab === t.key ? 'white' : '#6E6E73',
            fontWeight: tab === t.key ? 600 : 400,
          }}>{t.label}</button>
        ))}
        <button onClick={loadModels} style={{
          marginLeft: 'auto', fontSize: 11, padding: '5px 10px', borderRadius: 8,
          border: '1px solid rgba(0,0,0,0.1)', background: 'white', color: '#6E6E73', cursor: 'pointer',
        }}>刷新</button>
      </div>

      {tab === 'llm' && (
        <div style={{ padding: '10px 14px 0' }}>
          <div style={{
            background: 'white',
            borderRadius: 10,
            padding: '10px 12px',
            border: '1px solid rgba(0,0,0,0.07)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1D1D1F' }}>LLM 并发</div>
              <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 2 }}>
                运行中 {llmConcurrency?.stats?.running_total ?? 0} · P0 快速通道保留
              </div>
              {llmConcurrencyError && (
                <div style={{ fontSize: 11, color: '#FF3B30', marginTop: 4 }}>{llmConcurrencyError}</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {[1, 2, 3].map(value => {
                const active = llmConcurrency?.max_concurrency === value
                return (
                  <button
                    key={value}
                    onClick={() => updateLlmConcurrency(value)}
                    disabled={llmConcurrencySaving}
                    style={{
                      width: 32,
                      height: 28,
                      borderRadius: 8,
                      border: active ? 'none' : '1px solid rgba(0,0,0,0.1)',
                      background: active ? '#007AFF' : '#F2F2F7',
                      color: active ? 'white' : '#333',
                      fontSize: 12,
                      fontWeight: active ? 700 : 500,
                      cursor: llmConcurrencySaving ? 'default' : 'pointer',
                    }}
                  >
                    {value}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px 14px' }}>
        {tab === 'creation' ? (
          <CreationModelPanel
            configs={creationModelConfigs}
            openId={configuringCreationId}
            onToggleOpen={setConfiguringCreationId}
            onChange={handleCreationModelChange}
          />
        ) : (
          <>
        {loading && models.length === 0 && (
          <div style={{ textAlign: 'center', color: '#AEAEB2', fontSize: 13, padding: 40 }}>加载中...</div>
        )}

        {Object.entries(byProvider).map(([provider, items]) => (
          <div key={provider} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: PROVIDER_COLOR[provider] || '#AEAEB2',
              }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: '#333' }}>
                {PROVIDER_LABEL[provider] || provider}
              </span>
            </div>

            {/* Ollama 运行环境信息 */}
            {provider === 'ollama' && tab === 'llm' && (
              <div style={{ background: 'white', borderRadius: 10, padding: 12, border: '1px solid rgba(0,0,0,0.07)', marginBottom: 8 }}>
                {ollamaChecking ? (
                  <div style={{ fontSize: 12, color: '#AEAEB2' }}>检测中...</div>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: ollamaSetup?.ollama_running ? '#34C759' : '#6E6E73', marginBottom: 4 }}>
                      {ollamaSetup?.message || '无法获取 Ollama 状态'}
                    </div>
                    {(ollamaSetup?.system_version || ollamaSetup?.arch || ollamaSetup?.ollama_version) && (
                      <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 8 }}>
                        macOS {ollamaSetup?.system_version || 'unknown'} · {ollamaSetup?.arch || 'unknown'}
                        {ollamaSetup?.ollama_version && ` · Ollama v${ollamaSetup.ollama_version}`}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={refreshOllamaSetup} style={btn('#F2F2F7', '#333', 11)}>重新检测</button>
                      {ollamaSetup?.ollama_installed && ollamaSetup?.brew_available && (
                        <button onClick={handleUpgrade} disabled={ollamaUpgrading} style={btn('#007AFF', 'white', 11)}>
                          {ollamaUpgrading ? '升级中...' : '更新 Ollama'}
                        </button>
                      )}
                      {!ollamaSetup?.ollama_running && (
                        <button
                          onClick={handleInstallOllama}
                          disabled={ollamaInstalling}
                          style={btn('#007AFF', 'white', 11)}
                        >
                          {ollamaInstalling ? '安装中...' : '检测并安装 Ollama'}
                        </button>
                      )}
                    </div>
                    {ollamaSetup?.recommended_install_method && !ollamaSetup?.ollama_running && (
                      <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 6 }}>
                        推荐命令：{ollamaSetup.recommended_install_method}
                      </div>
                    )}
                    {ollamaError && <div style={{ fontSize: 11, color: '#FF3B30', marginTop: 6 }}>{ollamaError}</div>}
                  </>
                )}
              </div>
            )}

            {items.filter(m => m.category !== 'inference_engine').map(m => (
              <ModelCard
                key={m.id} model={m}
                downloading={downloadingIds.has(m.id)}
                activating={activatingIds.has(m.id)}
                onDownload={() => handleDownload(m)}
                onActivate={() => handleActivate(m)}
                onDelete={() => handleDelete(m)}
                onConfigure={() => setConfiguringModel(m)}
                onUpgrade={m.category === 'inference_engine' ? handleUpgrade : undefined}
                onChat={m.category === 'llm' && (m.status === 'active' || (m.requires_api_key && (m.status as string === 'installed' || m.status as string === 'active'))) ? () => setChattingModel(m) : undefined}
              />
            ))}
          </div>
        ))}

        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: '#AEAEB2', fontSize: 13, padding: 40 }}>
            暂无模型
          </div>
        )}
          </>
        )}
      </div>

      {configuringModel && (
        <ApiKeyDialog
          model={configuringModel}
          onClose={() => setConfiguringModel(null)}
          onSaved={loadModels}
        />
      )}
      {chattingModel && (
        <ModelChatDialog
          model={chattingModel}
          onClose={() => setChattingModel(null)}
        />
      )}
    </div>
  )
}

const CREATION_MODEL_DEFS = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8',    provider: 'anthropic', hasBaseUrl: true },
  { id: 'gpt-5-5',         name: 'GPT 5.5',            provider: 'openai',    hasBaseUrl: false },
  { id: 'qwen-3-7',        name: 'Qwen 3.7B',          provider: 'tongyi',    hasBaseUrl: false },
  { id: 'qwen-3-5-4b',     name: 'Qwen 3.5 4B (本地)', provider: 'ollama',    hasBaseUrl: true },
  { id: 'glm-latest',      name: 'GLM 最新版',          provider: 'doubao',    hasBaseUrl: false },
  { id: 'kimi-latest',     name: 'Kimi 最新版',         provider: 'kimi',      hasBaseUrl: false },
] as const

const CREATION_MODEL_ID_TO_NAME: Record<string, string> = {
  'claude-opus-4-8': 'claude-opus-4-8',
  'gpt-5-5':         'gpt-5.5-turbo',
  'qwen-3-7':        'qwen3-7b-instruct',
  'qwen-3-5-4b':     'qwen3.5:4b',
  'glm-latest':      'glm-4-plus',
  'kimi-latest':     'moonshot-v1-128k',
}

const CREATION_SVC = 'http://127.0.0.1:8001'
const LOCAL_CREATION_MODEL_ID = 'qwen-3-5-4b'

type CreationChatEntry = { def: typeof CREATION_MODEL_DEFS[number]; cfg: { id: string; apiKey: string; baseUrl?: string } }

const CreationModelChatDialog: React.FC<{ entry: CreationChatEntry; onClose: () => void }> = ({ entry, onClose }) => {
  const { def, cfg } = entry
  const modelName = CREATION_MODEL_ID_TO_NAME[def.id] || def.id
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const handleSend = async () => {
    const q = input.trim()
    if (!q || loading) return
    setInput('')
    setChatError('')
    const userMsg: ChatMessage = { role: 'user', content: q }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)
    try {
      const allMsgs = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
      const resp = await fetch(`${CREATION_SVC}/creation/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, api_key: cfg.apiKey, base_url: cfg.baseUrl || undefined, messages: allMsgs }),
      })
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({ detail: `HTTP ${resp.status}` }))
        setChatError(d.detail || '请求失败')
        setLoading(false)
        return
      }
      const reader = resp.body?.getReader()
      if (!reader) { setChatError('无法读取响应流'); setLoading(false); return }
      const decoder = new TextDecoder()
      let content = ''
      setMessages(prev => [...prev, { role: 'assistant', content: '' }])
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6))
            if (evt.content) { content += evt.content; setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content }; return u }) }
            if (evt.error) setChatError(evt.error)
          } catch { /* ignore */ }
        }
      }
    } catch (e: any) {
      setChatError(e.message || '连接失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'white', borderRadius: 16, width: 520, maxHeight: '80vh', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(0,0,0,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>体验 {def.name}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => { setMessages([]); setChatError('') }} style={btn('#F2F2F7', '#333', 11)}>重置</button>
            <button onClick={onClose} style={btn('#F2F2F7', '#333', 11)}>关闭</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px', minHeight: 300, maxHeight: 'calc(80vh - 120px)', background: '#F5F5F7' }}>
          {messages.length === 0 && !loading && (
            <div style={{ textAlign: 'center', color: '#AEAEB2', fontSize: 13, padding: 60 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>💬</div>
              <div>和 {def.name} 开始对话</div>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
              <div style={{ maxWidth: '75%', padding: '8px 12px', borderRadius: msg.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px', background: msg.role === 'user' ? '#007AFF' : 'white', color: msg.role === 'user' ? 'white' : '#1D1D1F', fontSize: 13, whiteSpace: 'pre-wrap', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                {msg.content || (msg.role === 'assistant' && loading ? '▌' : '')}
              </div>
            </div>
          ))}
          {chatError && <div style={{ fontSize: 11, color: '#FF3B30', textAlign: 'center', padding: 8 }}>{chatError}</div>}
          <div ref={endRef} />
        </div>
        <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(0,0,0,0.07)', display: 'flex', gap: 8 }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() } }}
            placeholder="输入消息…"
            style={{ flex: 1, padding: '8px 10px', border: '1px solid #E5E5EA', borderRadius: 8, fontSize: 13, outline: 'none' }} />
          <button onClick={handleSend} disabled={loading || !input.trim()} style={btn(loading || !input.trim() ? '#E5E5EA' : '#007AFF', loading || !input.trim() ? '#AEAEB2' : 'white', 12)}>
            {loading ? '…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}

const CreationModelPanel: React.FC<{
  configs: import('../store/useAppStore').CreationModelConfig[]
  openId: string | null
  onToggleOpen: (id: string | null) => void
  onChange: (id: string, patch: Partial<import('../store/useAppStore').CreationModelConfig>) => void
}> = ({ configs, openId, onToggleOpen, onChange }) => {
  const [testState, setTestState] = React.useState<Record<string, { loading: boolean; result?: string; error?: string }>>({})
  const [chattingModel, setChattingModel] = React.useState<CreationChatEntry | null>(null)

  const handleTest = async (def: typeof CREATION_MODEL_DEFS[number], cfg: { id: string; enabled: boolean; apiKey: string; baseUrl?: string }) => {
    if (!cfg.apiKey) return
    setTestState(s => ({ ...s, [def.id]: { loading: true } }))
    try {
      const r = await fetch(`${CREATION_SVC}/creation/test_model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CREATION_MODEL_ID_TO_NAME[def.id] || def.id,
          api_key: cfg.apiKey,
          base_url: cfg.baseUrl || undefined,
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || '请求失败')
      setTestState(s => ({ ...s, [def.id]: { loading: false, result: data.message } }))
    } catch (e: any) {
      setTestState(s => ({ ...s, [def.id]: { loading: false, error: e.message } }))
    }
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 10 }}>
        启用后，创作页面将调用该模型代替本地模型生成文档。
      </div>
      {CREATION_MODEL_DEFS.map(def => {
        const cfg = configs.find(c => c.id === def.id) || { id: def.id, enabled: false, apiKey: '' }
        const isOpen = openId === def.id
        const isLocalModel = def.id === LOCAL_CREATION_MODEL_ID
        const ts = testState[def.id]
        return (
          <div key={def.id} style={{ background: 'white', borderRadius: 10, padding: '10px 12px', border: '1px solid rgba(0,0,0,0.07)', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: PROVIDER_COLOR[def.provider] || '#AEAEB2', flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#1D1D1F' }}>{def.name}</span>
              {!isLocalModel && cfg.apiKey && (
                <button onClick={() => handleTest(def, cfg)} disabled={ts?.loading} style={btn(ts?.result ? '#34C759' : ts?.error ? '#FF3B30' : '#F2F2F7', ts?.result || ts?.error ? 'white' : '#333', 11)}>
                  {ts?.loading ? '验证中…' : ts?.result ? '已通' : ts?.error ? '失败' : '验证'}
                </button>
              )}
              {!isLocalModel && cfg.apiKey && (
                <button onClick={() => setChattingModel({ def, cfg })} style={btn('#AF52DE18', '#AF52DE', 11)}>💬 体验</button>
              )}
              {!isLocalModel && (
                <button onClick={() => onToggleOpen(isOpen ? null : def.id)} style={btn('#F2F2F7', '#333', 11)}>
                  {isOpen ? '收起' : '配置'}
                </button>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={cfg.enabled} onChange={() => onChange(def.id, { enabled: !cfg.enabled })} />
                <span style={{ fontSize: 11, color: cfg.enabled ? '#007AFF' : '#AEAEB2' }}>启用</span>
              </label>
            </div>
            {ts?.error && <div style={{ fontSize: 11, color: '#FF3B30', marginTop: 6 }}>{ts.error}</div>}
            {ts?.result && <div style={{ fontSize: 11, color: '#34C759', marginTop: 6 }}>回复：{ts.result}</div>}
            {isOpen && !isLocalModel && (
              <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 4 }}>API Key</div>
                  <input type="password" value={cfg.apiKey} onChange={e => onChange(def.id, { apiKey: e.target.value })}
                    placeholder="请输入 API Key"
                    style={{ width: '100%', padding: '6px 8px', border: '1px solid #E5E5EA', borderRadius: 6, fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                </div>
                {def.hasBaseUrl && (
                  <div>
                    <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 4 }}>API URL（可选）</div>
                    <input value={cfg.baseUrl || ''} onChange={e => onChange(def.id, { baseUrl: e.target.value })}
                      placeholder="https://api.anthropic.com"
                      style={{ width: '100%', padding: '6px 8px', border: '1px solid #E5E5EA', borderRadius: 6, fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
      {chattingModel && <CreationModelChatDialog entry={chattingModel} onClose={() => setChattingModel(null)} />}
    </div>
  )
}

function btn(bg: string, color: string, fontSize = 13): React.CSSProperties {
  return {
    background: bg, color, fontSize, fontWeight: 500,
    padding: fontSize <= 11 ? '4px 10px' : '7px 16px',
    borderRadius: 8, border: 'none', cursor: 'pointer',
  }
}

export default ModelManager
