import React, { useEffect, useState } from 'react'
import type { HardwareInfo, ModelEntry } from '../types'
import { useAppStore } from '../store/useAppStore'

const SIDECAR = 'http://localhost:7071'

type OllamaSetupDetail = {
  message?: string
  is_macos?: boolean
  system_version?: string
  arch?: string
  version_compatible?: boolean
  ollama_installed?: boolean
  ollama_running?: boolean
  recommended_install_method?: string
}

// ── 硬件档次颜色 ──────────────────────────────────────────────────────────────
const TIER_COLOR = { low: '#FF9500', mid: '#007AFF', high: '#34C759' }
const TIER_LABEL = { low: '入门配置', mid: '标准配置', high: '高性能配置' }

// ── API Key 输入表单 ──────────────────────────────────────────────────────────
const ApiKeyForm: React.FC<{
  model: ModelEntry
  onSave: (fields: Record<string, string>) => Promise<void>
  onCancel: () => void
}> = ({ model, onSave, onCancel }) => {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const fields = model.api_key_fields || []

  const handleSave = async () => {
    const missing = fields.filter(f => f.required && !values[f.key])
    if (missing.length) { setError(`请填写：${missing.map(f => f.label).join('、')}`); return }
    setSaving(true)
    setError('')
    try { await onSave(values) } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  return (
    <div style={{ background: 'white', borderRadius: 12, padding: 20, border: '1px solid rgba(0,0,0,0.1)' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>配置 {model.name}</div>
      {fields.map(f => (
        <div key={f.key} style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: '#6E6E73', display: 'block', marginBottom: 4 }}>
            {f.label}{f.required && <span style={{ color: '#FF3B30' }}> *</span>}
          </label>
          <input
            type={f.secret ? 'password' : 'text'}
            placeholder={f.placeholder}
            value={values[f.key] || ''}
            onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
              border: '1px solid rgba(0,0,0,0.15)', outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
      ))}
      {error && <div style={{ fontSize: 12, color: '#FF3B30', marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={btnStyle('#F2F2F7', '#333')}>取消</button>
        <button onClick={handleSave} disabled={saving} style={btnStyle('#007AFF', 'white')}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  )
}

// ── 模型卡片 ──────────────────────────────────────────────────────────────────
const ModelCard: React.FC<{
  model: ModelEntry
  selected: boolean
  onSelect: () => void
  onConfigure: () => void
  configuring: boolean
}> = ({ model, selected, onSelect, onConfigure, configuring }) => {
  const isApi = model.requires_api_key
  const configured = model.status === 'installed' || model.status === 'active'

  return (
    <div
      onClick={isApi ? undefined : onSelect}
      style={{
        border: `2px solid ${selected ? '#007AFF' : 'rgba(0,0,0,0.08)'}`,
        borderRadius: 12, padding: '12px 14px', cursor: isApi ? 'default' : 'pointer',
        background: selected ? 'rgba(0,122,255,0.04)' : 'white',
        transition: 'border-color 0.15s',
        position: 'relative',
      }}
    >
      {model.recommended && (
        <span style={{
          position: 'absolute', top: 8, right: 8, fontSize: 10, fontWeight: 600,
          background: '#34C759', color: 'white', padding: '2px 6px', borderRadius: 6,
        }}>推荐</span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        {!isApi && (
          <div style={{
            width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
            border: `2px solid ${selected ? '#007AFF' : '#C7C7CC'}`,
            background: selected ? '#007AFF' : 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {selected && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'white' }} />}
          </div>
        )}
        <span style={{ fontSize: 13, fontWeight: 600 }}>{model.name}</span>
        {model.size_gb > 0 && (
          <span style={{ fontSize: 11, color: '#AEAEB2' }}>{model.size_gb}GB</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#6E6E73', marginLeft: isApi ? 0 : 24 }}>{model.description}</div>
      {model.tags && model.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6, marginLeft: isApi ? 0 : 24 }}>
          {model.tags.slice(0, 3).map(t => (
            <span key={t} style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4,
              background: 'rgba(0,122,255,0.08)', color: '#007AFF',
            }}>{t}</span>
          ))}
        </div>
      )}
      {isApi && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          {configured ? (
            <span style={{ fontSize: 12, color: '#34C759' }}>✓ 已配置</span>
          ) : (
            <span style={{ fontSize: 12, color: '#AEAEB2' }}>未配置</span>
          )}
          <button
            onClick={e => { e.stopPropagation(); onConfigure() }}
            style={btnStyle(configured ? '#F2F2F7' : '#007AFF', configured ? '#333' : 'white', 11)}
          >
            {configuring ? '配置中...' : configured ? '重新配置' : '配置 API Key'}
          </button>
          {configured && (
            <button
              onClick={e => { e.stopPropagation(); onSelect() }}
              style={btnStyle(selected ? '#007AFF' : '#F2F2F7', selected ? 'white' : '#333', 11)}
            >
              {selected ? '已选择' : '选择'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── 主组件 ────────────────────────────────────────────────────────────────────
const OnboardingWizard: React.FC = () => {
  const { setHasCompletedSetup, setSetupSkipped, setWindowMode } = useAppStore()

  const [step, setStep] = useState(0)                          // 0=欢迎 1=LLM 2=Embedding
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [hwTier, setHwTier] = useState<'low' | 'mid' | 'high'>('mid')
  const [hwReason, setHwReason] = useState('')
  const [hwLoading, setHwLoading] = useState(false)

  const [llmModels, setLlmModels] = useState<ModelEntry[]>([])
  const [embModels, setEmbModels] = useState<ModelEntry[]>([])
  const [selectedLlm, setSelectedLlm] = useState('')
  const [selectedEmb, setSelectedEmb] = useState('')

  const [configuringId, setConfiguringId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [error, setError] = useState('')

  const [ollamaSetup, setOllamaSetup] = useState<OllamaSetupDetail | null>(null)
  const [ollamaChecking, setOllamaChecking] = useState(false)
  const [ollamaInstalling, setOllamaInstalling] = useState(false)

  // 检测硬件
  useEffect(() => {
    setHwLoading(true)
    fetch(`${SIDECAR}/api/models/hardware`)
      .then(r => r.json())
      .then(d => {
        if (d.status === 'ok') {
          setHardware(d.hardware)
          setHwTier(d.recommendation.tier)
          setHwReason(d.recommendation.reason)
        }
      })
      .catch(() => {})
      .finally(() => setHwLoading(false))
  }, [])

  const refreshOllamaSetup = async () => {
    setOllamaChecking(true)
    try {
      const r = await fetch(`${SIDECAR}/api/ollama/setup-status`)
      const d = await r.json()
      if (d.status === 'ok') setOllamaSetup(d.detail || null)
      else setOllamaSetup(null)
    } catch {
      setOllamaSetup(null)
    } finally {
      setOllamaChecking(false)
    }
  }

  useEffect(() => { refreshOllamaSetup() }, [])

  useEffect(() => {
    if (step === 1) {
      refreshOllamaSetup()
      fetch(`${SIDECAR}/api/models?category=llm`)
        .then(r => r.json())
        .then(d => { if (d.status === 'ok') setLlmModels(d.models) })
        .catch(() => {})
    }
    if (step === 2) {
      fetch(`${SIDECAR}/api/models?category=embedding`)
        .then(r => r.json())
        .then(d => { if (d.status === 'ok') setEmbModels(d.models) })
        .catch(() => {})
    }
  }, [step])

  // 轮询下载进度
  useEffect(() => {
    if (!downloadingId) return
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`${SIDECAR}/api/models/${downloadingId}/status`)
        const d = await r.json()
        if (d.status === 'ok') {
          setDownloadProgress(d.download_progress || 0)
          if (d.status === 'installed' || d.status === 'active') {
            setDownloadingId(null)
            setDownloadProgress(100)
          }
        }
      } catch {}
    }, 2000)
    return () => clearInterval(timer)
  }, [downloadingId])

  const handleSkip = () => {
    setSetupSkipped(true)
    setWindowMode('rag')
  }

  const handleComplete = () => {
    setHasCompletedSetup(true)
    setWindowMode('rag')
  }

  const handleInstallOllama = async () => {
    setError('')
    setOllamaInstalling(true)
    try {
      const installResp = await fetch(`${SIDECAR}/api/ollama/install`, { method: 'POST' })
      const installData = await installResp.json()
      if (installData.status !== 'ok') {
        setError(installData.message || 'Ollama 安装失败')
        await refreshOllamaSetup()
        return
      }

      const startResp = await fetch(`${SIDECAR}/api/ollama/start`, { method: 'POST' })
      const startData = await startResp.json()
      if (startData.status !== 'ok') {
        setError(startData.message || 'Ollama 启动失败，请手动执行 ollama serve')
      }

      await refreshOllamaSetup()
      if (step === 1) {
        const r = await fetch(`${SIDECAR}/api/models?category=llm`)
        const d = await r.json()
        if (d.status === 'ok') setLlmModels(d.models)
      }
    } catch {
      setError('无法连接到 AI 服务，请确保 ai-sidecar 已启动')
    } finally {
      setOllamaInstalling(false)
    }
  }

  const handleDownload = async (modelId: string) => {
    setError('')

    const model = [...llmModels, ...embModels].find(m => m.id === modelId)
    if (model?.provider === 'ollama' && !ollamaSetup?.ollama_running) {
      setError('请先完成 Ollama 安装并启动服务，再下载本地模型')
      return
    }

    try {
      const r = await fetch(`${SIDECAR}/api/models/${modelId}/download`, { method: 'POST' })
      const d = await r.json()
      if (d.status === 'ok') {
        setDownloadingId(modelId)
        setDownloadProgress(0)
      } else {
        setError(d.message || '下载失败')
      }
    } catch (e: any) {
      setError('无法连接到 AI 服务，请确保 ai-sidecar 已启动')
    }
  }

  const handleConfigure = async (modelId: string, fields: Record<string, string>) => {
    const r = await fetch(`${SIDECAR}/api/models/${modelId}/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
    const d = await r.json()
    if (d.status !== 'ok') throw new Error(d.message)
    setConfiguringId(null)
    // 刷新列表
    const cat = step === 1 ? 'llm' : 'embedding'
    const r2 = await fetch(`${SIDECAR}/api/models?category=${cat}`)
    const d2 = await r2.json()
    if (d2.status === 'ok') {
      if (step === 1) setLlmModels(d2.models)
      else setEmbModels(d2.models)
    }
  }

  const handleActivate = async (modelId: string) => {
    await fetch(`${SIDECAR}/api/models/${modelId}/activate`, { method: 'POST' })
  }

  const canProceedLlm = selectedLlm !== ''
  const selectedLlmModel = llmModels.find(m => m.id === selectedLlm)
  const needsDownloadLlm = selectedLlmModel && !selectedLlmModel.requires_api_key &&
    selectedLlmModel.status === 'not_installed'

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        background: '#F5F5F7', borderRadius: 20, width: 520, maxHeight: '85vh',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>

        {/* 进度条 */}
        <div style={{ height: 3, background: '#E5E5EA' }}>
          <div style={{
            height: '100%', background: '#007AFF', borderRadius: 2,
            width: `${((step + 1) / 3) * 100}%`, transition: 'width 0.3s',
          }} />
        </div>

        <div style={{ overflow: 'auto', flex: 1, padding: '28px 28px 20px' }}>

          {/* ── Step 0: 欢迎 ─────────────────────────────────────────────── */}
          {step === 0 && (
            <>
              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
                <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>欢迎使用记忆面包</div>
                <div style={{ fontSize: 13, color: '#8E8E93', marginBottom: 10 }}>
                  看过就会记住,记住就会理解
                </div>
                <div style={{ fontSize: 13, color: '#6E6E73', lineHeight: 1.6 }}>
                  记忆面包是你的本地 AI 助手，帮助你整理知识、回答问题、自动化任务。<br />
                  首先需要配置一个 AI 模型才能开始使用。
                </div>
              </div>

              {/* 硬件检测 */}
              <div style={{ background: 'white', borderRadius: 12, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 10 }}>本机配置检测</div>
                {hwLoading ? (
                  <div style={{ fontSize: 12, color: '#AEAEB2' }}>检测中...</div>
                ) : hardware ? (
                  <>
                    <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                      {[
                        { label: '内存', value: `${hardware.memory_gb} GB` },
                        { label: 'CPU', value: `${hardware.cpu_cores} 核` },
                        { label: '可用磁盘', value: `${hardware.disk_free_gb} GB` },
                      ].map(item => (
                        <div key={item.label} style={{ flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: 16, fontWeight: 700 }}>{item.value}</div>
                          <div style={{ fontSize: 11, color: '#AEAEB2' }}>{item.label}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{
                      fontSize: 12, padding: '6px 10px', borderRadius: 8,
                      background: `${TIER_COLOR[hwTier]}18`, color: TIER_COLOR[hwTier],
                      fontWeight: 500,
                    }}>
                      {TIER_LABEL[hwTier]}：{hwReason}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: '#AEAEB2' }}>无法检测（ai-sidecar 未启动）</div>
                )}
              </div>
            </>
          )}

          {/* ── Step 1: 选择 LLM ─────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>选择语言模型（LLM）</div>
                <div style={{ fontSize: 12, color: '#6E6E73' }}>LLM 是核心功能，用于知识提炼和问答。必须选择一个。</div>
              </div>

              <div style={{ background: 'white', borderRadius: 12, padding: 12, marginBottom: 12, border: '1px solid rgba(0,0,0,0.08)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Ollama 运行环境</div>
                {ollamaChecking ? (
                  <div style={{ fontSize: 12, color: '#AEAEB2' }}>检测中...</div>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: ollamaSetup?.ollama_running ? '#34C759' : '#6E6E73', marginBottom: 4 }}>
                      {ollamaSetup?.message || '无法获取 Ollama 状态'}
                    </div>
                    {(ollamaSetup?.system_version || ollamaSetup?.arch) && (
                      <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 8 }}>
                        macOS {ollamaSetup?.system_version || 'unknown'} · {ollamaSetup?.arch || 'unknown'}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={refreshOllamaSetup} style={btnStyle('#F2F2F7', '#333', 12)}>重新检测</button>
                      {!ollamaSetup?.ollama_running && (
                        <button
                          onClick={handleInstallOllama}
                          disabled={ollamaInstalling}
                          style={btnStyle('#007AFF', 'white', 12)}
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
                  </>
                )}
              </div>

              {/* 本地模型 */}
              <div style={{ fontSize: 11, fontWeight: 600, color: '#AEAEB2', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                本地模型（Ollama）
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {llmModels.filter(m => m.provider === 'ollama').map(m => (
                  <ModelCard key={m.id} model={m} selected={selectedLlm === m.id}
                    onSelect={() => setSelectedLlm(m.id)}
                    onConfigure={() => setConfiguringId(m.id)}
                    configuring={configuringId === m.id}
                  />
                ))}
              </div>

              {/* 商业 API */}
              <div style={{ fontSize: 11, fontWeight: 600, color: '#AEAEB2', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                商业 API
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {llmModels.filter(m => m.requires_api_key).map(m => (
                  configuringId === m.id ? (
                    <ApiKeyForm key={m.id} model={m}
                      onSave={fields => handleConfigure(m.id, fields)}
                      onCancel={() => setConfiguringId(null)}
                    />
                  ) : (
                    <ModelCard key={m.id} model={m} selected={selectedLlm === m.id}
                      onSelect={() => setSelectedLlm(m.id)}
                      onConfigure={() => setConfiguringId(m.id)}
                      configuring={false}
                    />
                  )
                ))}
              </div>

              {/* 下载进度 */}
              {downloadingId && (
                <div style={{ background: 'white', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 12, marginBottom: 6 }}>正在下载 {downloadingId}...</div>
                  <div style={{ height: 6, background: '#E5E5EA', borderRadius: 3 }}>
                    <div style={{ height: '100%', background: '#007AFF', borderRadius: 3,
                      width: `${downloadProgress}%`, transition: 'width 0.5s' }} />
                  </div>
                  <div style={{ fontSize: 11, color: '#AEAEB2', marginTop: 4 }}>{downloadProgress}%</div>
                </div>
              )}

              {/* 下载按钮（本地模型未安装时） */}
              {needsDownloadLlm && !downloadingId && (
                <button
                  onClick={() => handleDownload(selectedLlm)}
                  style={{ ...btnStyle('#007AFF', 'white'), width: '100%', marginBottom: 8 }}
                >
                  下载 {selectedLlmModel?.name}（{selectedLlmModel?.size_gb}GB）
                </button>
              )}

              {error && <div style={{ fontSize: 12, color: '#FF3B30', marginBottom: 8 }}>{error}</div>}
            </>
          )}

          {/* ── Step 2: 选择 Embedding ───────────────────────────────────── */}
          {step === 2 && (
            <>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>选择向量模型（Embedding）</div>
                <div style={{ fontSize: 12, color: '#6E6E73' }}>向量模型用于 RAG 问答的语义检索，建议配置。可跳过后续再配置。</div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {embModels.map(m => (
                  configuringId === m.id ? (
                    <ApiKeyForm key={m.id} model={m}
                      onSave={fields => handleConfigure(m.id, fields)}
                      onCancel={() => setConfiguringId(null)}
                    />
                  ) : (
                    <ModelCard key={m.id} model={m} selected={selectedEmb === m.id}
                      onSelect={() => setSelectedEmb(m.id)}
                      onConfigure={() => setConfiguringId(m.id)}
                      configuring={false}
                    />
                  )
                ))}
              </div>

              {downloadingId && (
                <div style={{ background: 'white', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 12, marginBottom: 6 }}>正在下载 {downloadingId}...</div>
                  <div style={{ height: 6, background: '#E5E5EA', borderRadius: 3 }}>
                    <div style={{ height: '100%', background: '#34C759', borderRadius: 3,
                      width: `${downloadProgress}%`, transition: 'width 0.5s' }} />
                  </div>
                </div>
              )}

              {selectedEmb && embModels.find(m => m.id === selectedEmb)?.status === 'not_installed' && !downloadingId && (
                <button
                  onClick={() => handleDownload(selectedEmb)}
                  style={{ ...btnStyle('#34C759', 'white'), width: '100%', marginBottom: 8 }}
                >
                  下载 {embModels.find(m => m.id === selectedEmb)?.name}
                </button>
              )}
            </>
          )}

        </div>

        {/* 底部按钮 */}
        <div style={{
          padding: '16px 28px', borderTop: '1px solid rgba(0,0,0,0.06)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'white',
        }}>
          <button onClick={handleSkip} style={{ fontSize: 12, color: '#AEAEB2', background: 'none',
            border: 'none', cursor: 'pointer', padding: '6px 0' }}>
            跳过，稍后配置
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button onClick={() => setStep(s => s - 1)} style={btnStyle('#F2F2F7', '#333')}>
                上一步
              </button>
            )}
            {step === 0 && (
              <button onClick={() => setStep(1)} style={btnStyle('#007AFF', 'white')}>
                开始配置
              </button>
            )}
            {step === 1 && (
              <button
                onClick={async () => {
                  if (selectedLlm) await handleActivate(selectedLlm)
                  setStep(2)
                }}
                disabled={!canProceedLlm}
                style={btnStyle(canProceedLlm ? '#007AFF' : '#C7C7CC', 'white')}
              >
                下一步
              </button>
            )}
            {step === 2 && (
              <button
                onClick={async () => {
                  if (selectedEmb) await handleActivate(selectedEmb)
                  handleComplete()
                }}
                style={btnStyle('#34C759', 'white')}
              >
                完成配置
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}

function btnStyle(bg: string, color: string, fontSize = 13): React.CSSProperties {
  return {
    background: bg, color, fontSize, fontWeight: 500,
    padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
  }
}

export default OnboardingWizard
