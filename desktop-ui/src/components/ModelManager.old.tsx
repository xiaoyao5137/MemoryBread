/**
 * ModelManager - 模型管理面板
 *
 * 功能：
 * - 显示可用的文本推理模型和向量模型
 * - 支持模型下载、激活、删除
 * - 配置 API Key（用于云端模型）
 */

import React, { useState, useEffect } from 'react'
import './ModelManager.css'

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
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedTab, setSelectedTab] = useState<'llm' | 'embedding'>('llm')
  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')

  // 获取模型列表
  const fetchModels = async () => {
    setLoading(true)
    try {
      const response = await fetch('http://localhost:7071/api/models')
      const data = await response.json()
      if (data.status === 'ok') {
        setModels(data.models)
      }
    } catch (error) {
      console.error('获取模型列表失败:', error)
    } finally {
      setLoading(false)
    }
  }

  // 下载模型
  const downloadModel = async (modelId: string) => {
    const model = models.find(m => m.id === modelId)
    if (!model) return

    // 如果需要 API Key，先弹出对话框
    if (model.requires_api_key) {
      setSelectedProvider(model.provider)
      setShowApiKeyDialog(true)
      return
    }

    try {
      // 更新状态为下载中
      setModels(prev => prev.map(m =>
        m.id === modelId ? { ...m, status: 'downloading' as const } : m
      ))

      const response = await fetch(`http://localhost:7071/api/models/${modelId}/download`, {
        method: 'POST'
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
      const response = await fetch(`http://localhost:7071/api/models/${modelId}/activate`, {
        method: 'POST'
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
      const response = await fetch(`http://localhost:7071/api/models/${modelId}/delete`, {
        method: 'DELETE'
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
      const response = await fetch('http://localhost:7071/api/models/config/api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          api_key: apiKey
        })
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
      'not_installed': '未安装',
      'downloading': '下载中...',
      'installed': '已安装',
      'active': '使用中'
    }
    return labels[status] || status
  }

  // 获取状态颜色
  const getStatusColor = (status: string): string => {
    const colors: Record<string, string> = {
      'not_installed': '#999',
      'downloading': '#1890ff',
      'installed': '#52c41a',
      'active': '#722ed1'
    }
    return colors[status] || '#999'
  }

  // 筛选模型
  const filteredModels = models.filter(m => m.type === selectedTab)

  useEffect(() => {
    fetchModels()
  }, [])

  return (
    <div className="model-manager">
      <div className="header">
        <h2>🤖 模型管理</h2>
        <button onClick={fetchModels} className="refresh-btn">🔄 刷新</button>
      </div>

      {/* 标签页 */}
      <div className="tabs">
        <button
          className={`tab ${selectedTab === 'llm' ? 'active' : ''}`}
          onClick={() => setSelectedTab('llm')}
        >
          💬 文本推理模型
        </button>
        <button
          className={`tab ${selectedTab === 'embedding' ? 'active' : ''}`}
          onClick={() => setSelectedTab('embedding')}
        >
          🔍 向量模型
        </button>
      </div>

      {/* 模型列表 */}
      {loading ? (
        <div className="loading">加载中...</div>
      ) : (
        <div className="model-list">
          {filteredModels.map(model => (
            <div key={model.id} className="model-card">
              <div className="model-header">
                <div className="model-title">
                  <h3>{model.name}</h3>
                  <span
                    className="status-badge"
                    style={{ backgroundColor: getStatusColor(model.status) }}
                  >
                    {getStatusLabel(model.status)}
                  </span>
                  {model.is_default && <span className="default-badge">默认</span>}
                </div>
                <div className="model-size">
                  {model.size_gb > 0 ? `${model.size_gb} GB` : '云端 API'}
                </div>
              </div>

              <p className="model-description">{model.description}</p>

              <div className="model-meta">
                <span className="meta-item">📦 {model.provider}</span>
                <span className="meta-item">🆔 {model.model_id}</span>
              </div>

              <div className="model-actions">
                {/* 未安装 */}
                {model.status === 'not_installed' && (
                  <button
                    onClick={() => downloadModel(model.id)}
                    className="btn btn-primary"
                  >
                    {model.requires_api_key ? '⚙️ 配置 API Key' : '⬇️ 下载'}
                  </button>
                )}

                {/* 下载中 */}
                {model.status === 'downloading' && (
                  <button className="btn btn-disabled" disabled>
                    ⏳ 下载中...
                  </button>
                )}

                {/* 已安装 */}
                {model.status === 'installed' && (
                  <>
                    <button
                      onClick={() => activateModel(model.id)}
                      className="btn btn-success"
                    >
                      ✅ 激活
                    </button>
                    <button
                      onClick={() => deleteModel(model.id)}
                      className="btn btn-danger"
                    >
                      🗑️ 删除
                    </button>
                  </>
                )}

                {/* 使用中 */}
                {model.status === 'active' && (
                  <button className="btn btn-active" disabled>
                    ⭐ 使用中
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* API Key 对话框 */}
      {showApiKeyDialog && (
        <div className="dialog-overlay" onClick={() => setShowApiKeyDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>配置 {selectedProvider} API Key</h3>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="请输入 API Key"
              className="api-key-input"
            />
            <div className="dialog-actions">
              <button onClick={handleSetApiKey} className="btn btn-primary">
                确定
              </button>
              <button
                onClick={() => {
                  setShowApiKeyDialog(false)
                  setApiKey('')
                }}
                className="btn btn-secondary"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ModelManager
