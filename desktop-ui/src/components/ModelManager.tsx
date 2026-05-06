import React, { useEffect, useRef, useState } from 'react'
import type { ModelEntry } from '../types'

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

const PROVIDER_LABEL: Record<string, string> = {
  ollama: 'Ollama', huggingface: 'HuggingFace',
  openai: 'OpenAI', anthropic: 'Anthropic',
  tongyi: '通义千问', doubao: '豆包', deepseek: 'DeepSeek', kimi: 'Kimi',
}
const PROVIDER_COLOR: Record<string, string> = {
  ollama: '#007AFF', huggingface: '#FF9500',
  openai: '#34C759', anthropic: '#AF52DE',
  tongyi: '#FF6B35', doubao: '#1677FF', deepseek: '#06B6D4', kimi: '#8B5CF6',
}
const CATEGORY_LABEL: Record<string, string> = {
  llm: 'LLM', embedding: '向量模型', ocr: 'OCR', asr: '语音识别', vlm: '视觉模型',
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

// ── 模型卡片 ──────────────────────────────────────────────────────────────────
const ModelCard: React.FC<{
  model: ModelEntry
  onDownload: () => void
  onActivate: () => void
  onDelete: () => void
  onConfigure: () => void
  onUpgrade?: () => void
  downloading: boolean
  activating?: boolean
}> = ({ model, onDownload, onActivate, onDelete, onConfigure, onUpgrade, downloading, activating }) => {
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
              <button onClick={onActivate} style={btn('#34C759', 'white', 11)}>激活</button>
            )}
            {isActive && (
              <span style={{ fontSize: 11, color: '#007AFF', fontWeight: 600 }}>使用中</span>
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
type TabType = 'local' | 'quantized' | 'api'

const ModelManager: React.FC = () => {
  const [tab, setTab] = useState<TabType>('local')
  const [models, setModels] = useState<ModelEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [configuringModel, setConfiguringModel] = useState<ModelEntry | null>(null)
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())
  const [activatingIds, setActivatingIds] = useState<Set<string>>(new Set())
  const [ollamaSetup, setOllamaSetup] = useState<OllamaSetupDetail | null>(null)
  const [ollamaChecking, setOllamaChecking] = useState(false)
  const [ollamaInstalling, setOllamaInstalling] = useState(false)
  const [ollamaUpgrading, setOllamaUpgrading] = useState(false)
  const [ollamaError, setOllamaError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
    if (tab === 'local') return m.provider === 'ollama' || m.category === 'inference_engine'
    if (tab === 'quantized') return m.provider === 'huggingface'
    if (tab === 'api') return !['ollama', 'huggingface'].includes(m.provider) && m.category !== 'inference_engine'
    return true
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
          { key: 'local', label: '本地模型' },
          { key: 'quantized', label: '量化模型' },
          { key: 'api', label: '商业 API' },
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

      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px 14px' }}>
        {tab === 'local' && (
          <div style={{ background: 'white', borderRadius: 10, padding: 12, border: '1px solid rgba(0,0,0,0.07)', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Ollama 运行环境</div>
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

        {loading && models.length === 0 && (
          <div style={{ textAlign: 'center', color: '#AEAEB2', fontSize: 13, padding: 40 }}>加载中...</div>
        )}

        {tab !== 'api' && Object.entries(grouped).map(([category, items]) => (
          <div key={category} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#6E6E73', marginBottom: 6, textTransform: 'uppercase' }}>
              {CATEGORY_LABEL[category] || category}
            </div>
            {items.map(m => (
              <ModelCard
                key={m.id} model={m}
                downloading={downloadingIds.has(m.id)}
                activating={activatingIds.has(m.id)}
                onDownload={() => handleDownload(m)}
                onActivate={() => handleActivate(m)}
                onDelete={() => handleDelete(m)}
                onConfigure={() => setConfiguringModel(m)}
                onUpgrade={m.category === 'inference_engine' ? handleUpgrade : undefined}
              />
            ))}
          </div>
        ))}

        {tab === 'api' && Object.entries(byProvider).map(([provider, items]) => (
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
            {items.map(m => (
              <ModelCard
                key={m.id} model={m}
                downloading={false}
                activating={activatingIds.has(m.id)}
                onDownload={() => {}}
                onActivate={() => handleActivate(m)}
                onDelete={() => {}}
                onConfigure={() => setConfiguringModel(m)}
              />
            ))}
          </div>
        ))}

        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: '#AEAEB2', fontSize: 13, padding: 40 }}>
            {tab === 'quantized' ? '暂无量化模型' : '暂无模型'}
          </div>
        )}
      </div>

      {configuringModel && (
        <ApiKeyDialog
          model={configuringModel}
          onClose={() => setConfiguringModel(null)}
          onSaved={loadModels}
        />
      )}
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
