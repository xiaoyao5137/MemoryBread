/**
 * ModelManager v2 - 模型管理面板（优化版）
 *
 * 改进：
 * 1. 使用 SVG 图标替代 Emoji
 * 2. 统一界面尺寸和样式
 * 3. 修复模型数据显示问题
 * 4. 遵循设计规范
 */

import React, { useState, useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import './ModelManager.v2.css'

interface Model {
  id: string
  name: string
  type: 'llm' | 'embedding'
  provider: string
  model_id: string
  size_gb: number
  description: string
  status: 'not_installed' | 'downloading' | 'installed' | 'active'
  is_active: boolean
  is_default: boolean
  requires_api_key: boolean
}

const ModelManager: React.FC = () => {
  const { apiBaseUrl, setWindowMode } = useAppStore()
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedTab, setSelectedTab] = useState<'llm' | 'embedding'>('llm')
  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')

  // 获取模型列表
  const fetchModels = async () => {
    setLoading(true)
    setError(null)
    try {
      // 尝试从 AI Sidecar 获取模型信息
      const response = await fetch(`${apiBaseUrl}/api/models`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json()

      if (data.status === 'ok' && data.models) {
        setModels(data.models)
      } else {
        // 如果没有模型数据，使用模拟数据
        setModels(getMockModels())
      }
    } catch (err) {
      console.error('获取模型列表失败:', err)
      setError('无法连接到模型服务，显示模拟数据')
      // 使用模拟数据
      setModels(getMockModels())
    } finally {
      setLoading(false)
    }
  }

  // 模拟数据（用于演示）
  const getMockModels = (): Model[] => {
    return [
      {
        id: 'qwen2.5-3b',
        name: 'Qwen2.5-3B-INT8',
        type: 'llm',
        provider: 'ollama',
        model_id: 'qwen2.5:3b-instruct-q8_0',
        size_gb: 2.5,
        description: '轻量级对话模型，适合日常问答',
        status: 'installed',
        is_active: true,
        is_default: true,
        requires_api_key: false,
      },
      {
        id: 'qwen2.5-7b',
        name: 'Qwen2.5-7B-INT4',
        type: 'llm',
        provider: 'ollama',
        model_id: 'qwen2.5:7b-instruct-q4_0',
        size_gb: 4.5,
        description: '中等规模对话模型，平衡性能与质量',
        status: 'not_installed',
        is_active: false,
        is_default: false,
        requires_api_key: false,
      },
      {
        id: 'bge-m3',
        name: 'BGE-M3-INT8',
        type: 'embedding',
        provider: 'local',
        model_id: 'BAAI/bge-m3',
        size_gb: 0.65,
        description: '多语言向量模型，支持中英文',
        status: 'installed',
        is_active: true,
        is_default: true,
        requires_api_key: false,
      },
      {
        id: 'openai-gpt4',
        name: 'GPT-4',
        type: 'llm',
        provider: 'openai',
        model_id: 'gpt-4',
        size_gb: 0,
        description: 'OpenAI 最强大的模型（需要 API Key）',
        status: 'not_installed',
        is_active: false,
        is_default: false,
        requires_api_key: true,
      },
    ]
  }

  // 下载模型
  const downloadModel = async (modelId: string) => {
    const model = models.find((m) => m.id === modelId)
    if (!model) return

    // 如果需要 API Key，先弹出对话框
    if (model.requires_api_key) {
      setSelectedProvider(model.provider)
      setShowApiKeyDialog(true)
      return
    }

    try {
      // 更新状态为下载中
      setModels((prev) =>
        prev.map((m) =>
          m.id === modelId ? { ...m, status: 'downloading' as const } : m
        )
      )

      const response = await fetch(`${apiBaseUrl}/api/models/${modelId}/download`, {
        method: 'POST',
      })
      const data = await response.json()

      if (data.status === 'ok') {
        alert(`模型 ${model.name} 下载成功！`)
        await fetchModels()
      } else {
        alert(`下载失败: ${data.message}`)
        await fetchModels()
      }
    } catch (error) {
      console.error('下载模型失败:', error)
      alert('下载失败，请查看日志')
      await fetchModels()
    }
  }

  // 激活模型
  const activateModel = async (modelId: string) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/models/${modelId}/activate`, {
        method: 'POST',
      })
      const data = await response.json()

      if (data.status === 'ok') {
        alert('模型已激活！')
        await fetchModels()
      } else {
        alert(`激活失败: ${data.message}`)
      }
    } catch (error) {
      console.error('激活模型失败:', error)
      alert('激活失败，请查看日志')
    }
  }

  // 删除模型
  const deleteModel = async (modelId: string) => {
    if (!window.confirm('确定要删除这个模型吗？')) return

    try {
      const response = await fetch(`${apiBaseUrl}/api/models/${modelId}/delete`, {
        method: 'DELETE',
      })
      const data = await response.json()

      if (data.status === 'ok') {
        alert('模型已删除')
        await fetchModels()
      } else {
        alert(`删除失败: ${data.message}`)
      }
    } catch (error) {
      console.error('删除模型失败:', error)
      alert('删除失败，请查看日志')
    }
  }

  // 设置 API Key
  const handleSetApiKey = async () => {
    if (!apiKey.trim()) {
      alert('请输入 API Key')
      return
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/models/config/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          api_key: apiKey,
        }),
      })
      const data = await response.json()

      if (data.status === 'ok') {
        alert('API Key 已设置')
        setShowApiKeyDialog(false)
        setApiKey('')
        await fetchModels()
      } else {
        alert(`设置失败: ${data.message}`)
      }
    } catch (error) {
      console.error('设置 API Key 失败:', error)
      alert('设置失败，请查看日志')
    }
  }

  // 获取状态标签
  const getStatusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      not_installed: '未安装',
      downloading: '下载中...',
      installed: '已安装',
      active: '使用中',
    }
    return labels[status] || status
  }

  // 筛选模型
  const filteredModels = models.filter((m) => m.type === selectedTab)

  useEffect(() => {
    fetchModels()
  }, [])

  const handleClose = () => setWindowMode('buddy')

  return (
    <div className="model-manager-v2">
      {/* 标题栏 */}
      <div className="model-manager-v2__header">
        <div className="model-manager-v2__title-group">
          {/* CPU 图标 */}
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect width="16" height="16" x="4" y="4" rx="2" />
            <rect width="6" height="6" x="9" y="9" rx="1" />
            <path d="M15 2v2" />
            <path d="M15 20v2" />
            <path d="M2 15h2" />
            <path d="M2 9h2" />
            <path d="M20 15h2" />
            <path d="M20 9h2" />
            <path d="M9 2v2" />
            <path d="M9 20v2" />
          </svg>
          <h1 className="model-manager-v2__title">模型管理</h1>
        </div>

        <div className="model-manager-v2__actions">
          <button
            onClick={fetchModels}
            disabled={loading}
            className="model-manager-v2__btn model-manager-v2__btn--secondary"
          >
            {/* 刷新图标 */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={loading ? 'rotating' : ''}
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            刷新
          </button>

          <button
            onClick={handleClose}
            className="model-manager-v2__btn model-manager-v2__btn--close"
          >
            {/* X 图标 */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
            关闭
          </button>
        </div>
      </div>

      <div className="model-manager-v2__content">
        {/* 标签页 */}
        <div className="model-manager-v2__tabs">
          <button
            className={`model-manager-v2__tab ${
              selectedTab === 'llm' ? 'model-manager-v2__tab--active' : ''
            }`}
            onClick={() => setSelectedTab('llm')}
          >
            {/* 对话图标 */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
            </svg>
            对话模型
          </button>

          <button
            className={`model-manager-v2__tab ${
              selectedTab === 'embedding' ? 'model-manager-v2__tab--active' : ''
            }`}
            onClick={() => setSelectedTab('embedding')}
          >
            {/* 向量图标 */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2v20" />
              <path d="M2 12h20" />
              <path d="m5 5 14 14" />
              <path d="m19 5-14 14" />
            </svg>
            向量模型
          </button>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="model-manager-v2__error">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="m15 9-6 6" />
              <path d="m9 9 6 6" />
            </svg>
            {error}
          </div>
        )}

        {/* 模型列表 */}
        {loading ? (
          <div className="model-manager-v2__loading">加载中...</div>
        ) : filteredModels.length === 0 ? (
          <div className="model-manager-v2__empty">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 9h.01" />
              <path d="M15 9h.01" />
              <path d="M9 15h6" />
            </svg>
            <p>暂无{selectedTab === 'llm' ? '对话' : '向量'}模型</p>
          </div>
        ) : (
          <div className="model-manager-v2__list">
            {filteredModels.map((model) => (
              <div key={model.id} className="model-manager-v2__card">
                <div className="model-manager-v2__card-header">
                  <div className="model-manager-v2__card-info">
                    <h3 className="model-manager-v2__card-name">{model.name}</h3>
                    <p className="model-manager-v2__card-desc">{model.description}</p>
                  </div>

                  <div
                    className={`model-manager-v2__status model-manager-v2__status--${model.status}`}
                  >
                    {getStatusLabel(model.status)}
                  </div>
                </div>

                <div className="model-manager-v2__card-meta">
                  <span className="model-manager-v2__meta-item">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    </svg>
                    {model.provider}
                  </span>

                  {model.size_gb > 0 && (
                    <span className="model-manager-v2__meta-item">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" x2="12" y1="15" y2="3" />
                      </svg>
                      {model.size_gb.toFixed(1)} GB
                    </span>
                  )}

                  {model.is_default && (
                    <span className="model-manager-v2__badge">默认</span>
                  )}
                </div>

                <div className="model-manager-v2__card-actions">
                  {model.status === 'not_installed' && (
                    <button
                      onClick={() => downloadModel(model.id)}
                      className="model-manager-v2__btn model-manager-v2__btn--primary"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" x2="12" y1="15" y2="3" />
                      </svg>
                      {model.requires_api_key ? '配置' : '下载'}
                    </button>
                  )}

                  {model.status === 'installed' && !model.is_active && (
                    <button
                      onClick={() => activateModel(model.id)}
                      className="model-manager-v2__btn model-manager-v2__btn--primary"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      激活
                    </button>
                  )}

                  {model.status === 'active' && (
                    <span className="model-manager-v2__active-badge">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      使用中
                    </span>
                  )}

                  {(model.status === 'installed' || model.status === 'active') &&
                    !model.is_default && (
                      <button
                        onClick={() => deleteModel(model.id)}
                        className="model-manager-v2__btn model-manager-v2__btn--danger"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        </svg>
                        删除
                      </button>
                    )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* API Key 对话框 */}
      {showApiKeyDialog && (
        <div className="model-manager-v2__dialog-overlay">
          <div className="model-manager-v2__dialog">
            <h3 className="model-manager-v2__dialog-title">
              设置 {selectedProvider} API Key
            </h3>
            <input
              type="password"
              className="model-manager-v2__dialog-input"
              placeholder="请输入 API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <div className="model-manager-v2__dialog-actions">
              <button
                onClick={() => {
                  setShowApiKeyDialog(false)
                  setApiKey('')
                }}
                className="model-manager-v2__btn model-manager-v2__btn--secondary"
              >
                取消
              </button>
              <button
                onClick={handleSetApiKey}
                className="model-manager-v2__btn model-manager-v2__btn--primary"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ModelManager
