import React, { useEffect, useState } from 'react'
import type { HardwareInfo, ModelEntry } from '../types'
import { useAppStore } from '../store/useAppStore'
import { toUserFacingError } from '../utils/userFacingError'
import { openExternalUrl } from '../utils/openExternalUrl'

const SIDECAR = 'http://localhost:7071'
const OLLAMA_MACOS_DOWNLOAD_URL = 'https://ollama.com/download/mac'

type OllamaSetupDetail = {
  message?: string
  is_macos?: boolean
  system_version?: string
  arch?: string
  version_compatible?: boolean
  ollama_installed?: boolean
  ollama_running?: boolean
  brew_available?: boolean
  can_auto_install?: boolean
  minimum_macos_major?: number
  official_download_url?: string
  recommended_install_method?: string
}

// ── 硬件档次颜色 ──────────────────────────────────────────────────────────────
const TIER_COLOR = { low: '#FF9500', mid: '#007AFF', high: '#34C759' }
const TIER_LABEL = { low: '入门配置', mid: '标准配置', high: '高性能配置' }

const LOCAL_ANALYSIS_IDS = new Set(['mbem-v1-local', 'qwen3.5-4b'])
const LOCAL_VECTOR_IDS = new Set(['bge-small-zh'])
const isModelReady = (model?: ModelEntry) => model?.status === 'installed' || model?.status === 'active'

function normalizeSetupModels(models: ModelEntry[], category: 'llm' | 'embedding'): ModelEntry[] {
  const matchingIds = category === 'llm' ? LOCAL_ANALYSIS_IDS : LOCAL_VECTOR_IDS
  const model = models.find(item => matchingIds.has(item.id) && !item.requires_api_key)
  if (!model) return []

  if (category === 'llm') {
    return [{
      ...model,
      name: 'MBEM v1.0',
      description: '在本机完成内容理解、知识提炼和问答分析。',
      tags: ['推荐', '本地运行', '内容分析'],
    }]
  }

  return [{
    ...model,
    id: 'bge-small-zh',
    name: '本地语义索引',
    description: '在本机建立语义索引，帮助更准确地找回相关内容。',
    tags: ['本地运行', '语义检索'],
  }]
}

// ── 模型卡片 ──────────────────────────────────────────────────────────────────
const ModelCard: React.FC<{
  model: ModelEntry
  selected: boolean
  onSelect: () => void
}> = ({ model, selected, onSelect }) => {
  return (
    <div
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      style={{
        border: `2px solid ${selected ? '#007AFF' : 'rgba(0,0,0,0.08)'}`,
        borderRadius: 12, padding: '12px 14px', cursor: 'pointer',
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
        <div style={{
          width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
          border: `2px solid ${selected ? '#007AFF' : '#C7C7CC'}`,
          background: selected ? '#007AFF' : 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {selected && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'white' }} />}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{model.name}</span>
        {model.size_gb > 0 && (
          <span style={{ fontSize: 11, color: '#AEAEB2' }}>{model.size_gb}GB</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#6E6E73', marginLeft: 24 }}>{model.description}</div>
      {model.tags && model.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6, marginLeft: 24 }}>
          {model.tags.slice(0, 3).map(t => (
            <span key={t} style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4,
              background: 'rgba(0,122,255,0.08)', color: '#007AFF',
            }}>{t}</span>
          ))}
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

  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [error, setError] = useState('')

  const [ollamaSetup, setOllamaSetup] = useState<OllamaSetupDetail | null>(null)
  const [ollamaChecking, setOllamaChecking] = useState(false)
  const [ollamaInstalling, setOllamaInstalling] = useState(false)
  const [activatingId, setActivatingId] = useState<string | null>(null)

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
      if (!r.ok || d.status !== 'ok') throw new Error(d.message || `HTTP ${r.status}`)
      setOllamaSetup(d.detail || null)
      return Boolean(d.detail)
    } catch {
      setOllamaSetup(null)
      return false
    } finally {
      setOllamaChecking(false)
    }
  }

  // DMG 冷启动时内置 sidecar 通常比 WebView 晚几秒就绪，自动重试避免用户手动刷新。
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const checkUntilReady = async () => {
      attempts += 1
      const ready = await refreshOllamaSetup()
      if (!ready && !cancelled && attempts < 10) {
        timer = setTimeout(checkUntilReady, 1500)
      }
    }
    checkUntilReady()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const loadSetupModels = async (category: 'llm' | 'embedding'): Promise<boolean> => {
    try {
      const response = await fetch(`${SIDECAR}/api/models?category=${category}`)
      const data = await response.json()
      if (!response.ok || data.status !== 'ok') return false
      const models = normalizeSetupModels(data.models || [], category)
      if (category === 'llm') setLlmModels(models)
      else setEmbModels(models)
      return models.length > 0
    } catch {
      return false
    }
  }

  useEffect(() => {
    if (step !== 1 && step !== 2) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const category = step === 1 ? 'llm' : 'embedding'
    const loadUntilReady = async () => {
      attempts += 1
      if (category === 'llm') await refreshOllamaSetup()
      const ready = await loadSetupModels(category)
      if (!ready && !cancelled && attempts < 10) {
        timer = setTimeout(loadUntilReady, 1500)
      }
    }
    loadUntilReady()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [step])

  const refreshCurrentStep = async () => {
    await refreshOllamaSetup()
    if (step === 1) await loadSetupModels('llm')
    if (step === 2) await loadSetupModels('embedding')
  }

  // 轮询下载进度
  useEffect(() => {
    if (!downloadingId) return
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`${SIDECAR}/api/models/${downloadingId}/status`)
        const d = await r.json()
        setDownloadProgress(d.download_progress || 0)
        if (d.status === 'error' || d.error) {
          setDownloadingId(null)
          setError(toUserFacingError(d.error || d.message, '下载失败，请稍后重试'))
        } else if (d.status === 'installed' || d.status === 'active') {
          setDownloadingId(null)
          setDownloadProgress(100)
          const category = llmModels.some(model => model.id === downloadingId) ? 'llm' : 'embedding'
          const listResponse = await fetch(`${SIDECAR}/api/models?category=${category}`)
          const listData = await listResponse.json()
          if (listData.status === 'ok') {
            const models = normalizeSetupModels(listData.models || [], category)
            if (category === 'llm') setLlmModels(models)
            else setEmbModels(models)
          }
        }
      } catch {}
    }, 2000)
    return () => clearInterval(timer)
  }, [downloadingId, embModels, llmModels])

  const handleSkip = () => {
    setSetupSkipped(true)
    setWindowMode('rag')
  }

  const handleComplete = () => {
    setHasCompletedSetup(true)
    setWindowMode('rag')
  }

  const handleInstallOllama = async () => {
    if (ollamaSetup && !ollamaSetup.ollama_installed && !ollamaSetup.can_auto_install) {
      await openExternalUrl(ollamaSetup.official_download_url || OLLAMA_MACOS_DOWNLOAD_URL)
      return
    }

    setError('')
    setOllamaInstalling(true)
    try {
      const installResp = await fetch(`${SIDECAR}/api/ollama/install`, { method: 'POST' })
      const installData = await installResp.json()
      if (installData.status !== 'ok') {
        setError(toUserFacingError(installData.message, '本地运行环境安装失败，请稍后重试'))
        await refreshOllamaSetup()
        return
      }

      const startResp = await fetch(`${SIDECAR}/api/ollama/start`, { method: 'POST' })
      const startData = await startResp.json()
      if (startData.status !== 'ok') {
        setError(toUserFacingError(startData.message, '本地运行环境启动失败，请稍后重试'))
      }

      await refreshOllamaSetup()
      if (step === 1) {
        await loadSetupModels('llm')
      }
    } catch (cause) {
      setError(toUserFacingError(cause, '暂时无法准备本地运行环境，请稍后重试'))
    } finally {
      setOllamaInstalling(false)
    }
  }

  const handleDownload = async (modelId: string) => {
    setError('')

    const model = [...llmModels, ...embModels].find(m => m.id === modelId)
    if (model?.provider === 'ollama' && !ollamaSetup?.ollama_running) {
      setError('请先准备本地运行环境，再下载分析模型')
      return
    }

    try {
      const r = await fetch(`${SIDECAR}/api/models/${modelId}/download`, { method: 'POST' })
      const d = await r.json()
      if (d.status === 'ok') {
        setDownloadingId(modelId)
        setDownloadProgress(0)
      } else {
        setError(toUserFacingError(d.message, '下载失败，请稍后重试'))
      }
    } catch (cause) {
      setError(toUserFacingError(cause, '暂时无法连接本地服务，请稍后重试'))
    }
  }

  const handleActivate = async (modelId: string): Promise<boolean> => {
    setError('')
    setActivatingId(modelId)
    try {
      const response = await fetch(`${SIDECAR}/api/models/${modelId}/activate`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok || data.status !== 'ok') {
        setError(toUserFacingError(data.message, '模型启用失败，请稍后重试'))
        return false
      }
      return true
    } catch (cause) {
      setError(toUserFacingError(cause, '模型启用失败，请稍后重试'))
      return false
    } finally {
      setActivatingId(null)
    }
  }

  const selectedLlmModel = llmModels.find(m => m.id === selectedLlm)
  const selectedEmbModel = embModels.find(m => m.id === selectedEmb)
  const canProceedLlm = Boolean(
    selectedLlm &&
    ollamaSetup?.ollama_running &&
    isModelReady(selectedLlmModel) &&
    downloadingId !== selectedLlm &&
    activatingId !== selectedLlm,
  )
  const canCompleteEmbedding = Boolean(
    selectedEmb &&
    isModelReady(selectedEmbModel) &&
    downloadingId !== selectedEmb &&
    activatingId !== selectedEmb,
  )
  const needsDownloadLlm = selectedLlmModel && !selectedLlmModel.requires_api_key &&
    (selectedLlmModel.status === 'not_installed' || selectedLlmModel.status === 'error')
  const needsManualOllamaInstall = Boolean(
    ollamaSetup &&
    !ollamaSetup.ollama_installed &&
    !ollamaSetup.can_auto_install,
  )

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
                <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>欢迎使用记忆面包</div>
                <div style={{ fontSize: 13, color: '#8E8E93', marginBottom: 10 }}>
                  让看过的内容，在下一次工作中继续发挥作用
                </div>
                <div style={{ fontSize: 13, color: '#6E6E73', lineHeight: 1.6 }}>
                  记忆面包帮助你整理知识、回答问题和完成重复工作。<br />
                  先准备本地 AI 能力，即可开始使用。
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
                  <div style={{ fontSize: 12, color: '#AEAEB2' }}>暂时无法读取本机配置，可继续手动选择</div>
                )}
              </div>
            </>
          )}

          {/* ── Step 1: 选择 LLM ─────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>选择本地分析模型</div>
                <div style={{ fontSize: 12, color: '#6E6E73' }}>用于内容理解、知识提炼和问答，需要选择一个。</div>
              </div>

              <div style={{ background: 'white', borderRadius: 12, padding: 12, marginBottom: 12, border: '1px solid rgba(0,0,0,0.08)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>本地运行环境</div>
                {ollamaChecking ? (
                  <div style={{ fontSize: 12, color: '#AEAEB2' }}>检测中...</div>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: ollamaSetup?.ollama_running ? '#34C759' : '#6E6E73', marginBottom: 4 }}>
                      {ollamaSetup?.ollama_running
                        ? '本地运行环境已就绪'
                        : ollamaSetup?.version_compatible === false
                          ? `当前系统版本不兼容，需要 macOS ${ollamaSetup.minimum_macos_major || 14} 或更高版本`
                          : ollamaSetup
                            ? '本地运行环境尚未就绪'
                            : '本地 AI 服务正在启动或暂时无法连接'}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={refreshCurrentStep} style={btnStyle('#F2F2F7', '#333', 12)}>重新检测</button>
                      {!ollamaSetup?.ollama_running && ollamaSetup && ollamaSetup.version_compatible !== false && (
                        <button
                          onClick={handleInstallOllama}
                          disabled={ollamaInstalling}
                          style={btnStyle('#007AFF', 'white', 12)}
                        >
                          {ollamaInstalling
                            ? '准备中...'
                            : needsManualOllamaInstall
                              ? '打开官方下载页'
                              : ollamaSetup.ollama_installed
                                ? '启动本地运行环境'
                                : '自动安装并启动'}
                        </button>
                      )}
                    </div>
                    {needsManualOllamaInstall && (
                      <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 7, lineHeight: 1.5 }}>
                        下载并打开本地运行环境后，返回这里点击“重新检测”。
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 分析模型 */}
              <div style={{ fontSize: 12, fontWeight: 600, color: '#6E6E73', marginBottom: 8 }}>
                分析模型
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {llmModels.map(m => (
                  <ModelCard key={m.id} model={m} selected={selectedLlm === m.id}
                    onSelect={() => setSelectedLlm(m.id)}
                  />
                ))}
                {llmModels.length === 0 && (
                  <div style={{ padding: 12, borderRadius: 10, background: 'white', color: '#8E8E93', fontSize: 12 }}>
                    暂时无法读取可用模型，请确认本地运行环境已就绪后重新检测。
                  </div>
                )}
              </div>

              {/* 下载进度 */}
              {downloadingId && (
                <div style={{ background: 'white', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 12, marginBottom: 6 }}>
                    正在下载 {[...llmModels, ...embModels].find(model => model.id === downloadingId)?.name || '本地模型'}...
                  </div>
                  <div style={{ height: 6, background: '#E5E5EA', borderRadius: 3 }}>
                    <div style={{ height: '100%', background: '#007AFF', borderRadius: 3,
                      width: `${downloadProgress}%`, transition: 'width 0.5s' }} />
                  </div>
                  <div style={{ fontSize: 11, color: '#AEAEB2', marginTop: 4 }}>{downloadProgress}%</div>
                </div>
              )}

              {/* 下载按钮（分析模型未安装时） */}
              {needsDownloadLlm && !downloadingId && (
                <button
                  onClick={() => handleDownload(selectedLlm)}
                  style={{ ...btnStyle('#007AFF', 'white'), width: '100%', marginBottom: 8 }}
                >
                  下载 {selectedLlmModel?.name}（{selectedLlmModel?.size_gb}GB）
                </button>
              )}

              {selectedLlmModel && !isModelReady(selectedLlmModel) && !downloadingId && (
                <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 8 }}>
                  完成模型下载后才能进入下一步。
                </div>
              )}

              {error && <div role="alert" style={{ fontSize: 12, color: '#FF3B30', marginBottom: 8 }}>{error}</div>}
            </>
          )}

          {/* ── Step 2: 选择 Embedding ───────────────────────────────────── */}
          {step === 2 && (
            <>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>选择本地语义索引</div>
                <div style={{ fontSize: 12, color: '#6E6E73' }}>用于找回与问题相关的内容，建议现在配置，也可以稍后完成。</div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {embModels.map(m => (
                  <ModelCard key={m.id} model={m} selected={selectedEmb === m.id}
                    onSelect={() => setSelectedEmb(m.id)}
                  />
                ))}
              </div>

              {downloadingId && (
                <div style={{ background: 'white', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 12, marginBottom: 6 }}>
                    正在下载 {embModels.find(model => model.id === downloadingId)?.name || '本地语义索引'}...
                  </div>
                  <div style={{ height: 6, background: '#E5E5EA', borderRadius: 3 }}>
                    <div style={{ height: '100%', background: '#34C759', borderRadius: 3,
                      width: `${downloadProgress}%`, transition: 'width 0.5s' }} />
                  </div>
                </div>
              )}

              {selectedEmb && selectedEmbModel &&
                (selectedEmbModel.status === 'not_installed' || selectedEmbModel.status === 'error') &&
                !downloadingId && (
                <button
                  onClick={() => handleDownload(selectedEmb)}
                  style={{ ...btnStyle('#34C759', 'white'), width: '100%', marginBottom: 8 }}
                >
                  下载 {selectedEmbModel.name}
                </button>
              )}

              {embModels.length === 0 && (
                <div style={{ padding: 12, borderRadius: 10, background: 'white', color: '#8E8E93', fontSize: 12, marginBottom: 12 }}>
                  暂时无法读取本地语义索引，请返回上一步确认本地运行环境后重试。
                </div>
              )}

              {error && <div role="alert" style={{ fontSize: 12, color: '#FF3B30', marginBottom: 8 }}>{error}</div>}
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
                  if (selectedLlm && await handleActivate(selectedLlm)) setStep(2)
                }}
                disabled={!canProceedLlm}
                style={btnStyle(canProceedLlm ? '#007AFF' : '#C7C7CC', 'white')}
              >
                {activatingId === selectedLlm ? '正在启用...' : '下一步'}
              </button>
            )}
            {step === 2 && (
              <button
                onClick={async () => {
                  if (selectedEmb && await handleActivate(selectedEmb)) handleComplete()
                }}
                disabled={!canCompleteEmbedding}
                style={btnStyle(canCompleteEmbedding ? '#34C759' : '#C7C7CC', 'white')}
              >
                {activatingId === selectedEmb ? '正在启用...' : '完成配置'}
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
