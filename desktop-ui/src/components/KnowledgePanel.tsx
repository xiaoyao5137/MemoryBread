/**
 * KnowledgePanel - 知识库管理面板
 *
 * 展示从 OCR 文本中提炼的结构化知识条目
 * 用户可以查看、编辑、删除、验证知识条目
 */

import React, { useCallback, useState, useEffect } from 'react'

import { useAppStore } from '../store/useAppStore'

interface KnowledgeEntry {
  id: number
  capture_id: number
  summary: string
  overview?: string  // 概述：正在做什么
  details?: string   // 明细：具体内容细节
  entities: string[]
  category: string
  importance: number
  occurrence_count?: number  // 出现次数
  user_verified: boolean
  user_edited: boolean
  created_at: string
  updated_at: string
  created_at_ms: number
  updated_at_ms: number
}

interface KnowledgePanelProps {
  className?: string
}

const KnowledgePanel: React.FC<KnowledgePanelProps> = ({ className = '' }) => {
  const apiBaseUrl = useAppStore((s) => s.apiBaseUrl)
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [extractMessage, setExtractMessage] = useState<string | null>(null)

  // 加载知识条目
  const loadEntries = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      params.append('limit', '50')
      params.append('offset', '0')

      if (filter !== 'all') {
        params.append('category', filter)
      }

      const response = await fetch(`${apiBaseUrl}/api/knowledge?${params}`)
      if (!response.ok) {
        throw new Error('加载知识库失败')
      }

      const data = await response.json()
      setEntries(data.entries || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }, [apiBaseUrl, filter])

  // 初始加载
  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  // 验证条目
  const handleVerify = async (id: number) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/knowledge/${id}/verify`, {
        method: 'POST'
      })

      if (!response.ok) {
        throw new Error('验证失败')
      }

      // 刷新列表
      loadEntries()
    } catch (err) {
      alert(err instanceof Error ? err.message : '验证失败')
    }
  }

  // 删除条目
  const handleDelete = async (id: number) => {
    if (!confirm('确定要删除这条知识吗？')) {
      return
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/knowledge/${id}`, {
        method: 'DELETE'
      })

      if (!response.ok) {
        throw new Error('删除失败')
      }

      // 刷新列表
      loadEntries()
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败')
    }
  }

  // 查看原文
  const handleViewOriginal = (captureId: number) => {
    // 触发自定义事件，通知主应用切换到调试面板并定位到该采集记录
    window.dispatchEvent(new CustomEvent('view-capture', {
      detail: { captureId }
    }))
  }

  // 搜索
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      loadEntries()
      return
    }

    setError('当前版本暂不支持服务端搜索，请先使用分类筛选或直接刷新列表')
  }

  const handleExtract = async () => {
    setExtracting(true)
    setError(null)
    setExtractMessage(null)

    try {
      const response = await fetch(`${apiBaseUrl}/api/knowledge/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force_finalize_tail: true }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.message || data.error || '触发提炼失败')
      }

      setExtractMessage(data.message || '已触发知识提炼')
      await loadEntries()
    } catch (err) {
      setError(err instanceof Error ? err.message : '触发提炼失败')
    } finally {
      setExtracting(false)
    }
  }

  const renderStars = (importance: number) => {
    return '⭐'.repeat(importance)
  }

  // 分类图标
  const getCategoryIcon = (category: string) => {
    const icons: Record<string, string> = {
      '会议': '📝',
      '文档': '📄',
      '代码': '💻',
      '聊天': '💬',
      '其他': '📌'
    }
    return icons[category] || '📌'
  }

  return (
    <div
      className={`knowledge-panel ${className}`}
      data-testid="knowledge-panel"
      role="main"
      aria-label="知识库管理面板"
    >
      {/* 标题栏 */}
      <div className="knowledge-panel__header" data-testid="knowledge-panel-header">
        <h2 className="knowledge-panel__title">知识库</h2>
        <div className="knowledge-panel__header-actions">
          <button
            className="knowledge-panel__extract"
            onClick={handleExtract}
            aria-label="提炼知识"
            type="button"
            disabled={extracting || loading}
          >
            {extracting ? '提炼中...' : '提炼知识'}
          </button>
          <button
            className="knowledge-panel__refresh"
            onClick={loadEntries}
            aria-label="刷新"
            type="button"
            disabled={loading}
          >
            🔄
          </button>
        </div>
      </div>

      {/* 筛选和搜索 */}
      <div className="knowledge-panel__toolbar" data-testid="knowledge-panel-toolbar">
        <div className="knowledge-panel__filters">
          <button
            className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            全部
          </button>
          <button
            className={`filter-btn ${filter === '会议' ? 'active' : ''}`}
            onClick={() => setFilter('会议')}
          >
            会议
          </button>
          <button
            className={`filter-btn ${filter === '文档' ? 'active' : ''}`}
            onClick={() => setFilter('文档')}
          >
            文档
          </button>
          <button
            className={`filter-btn ${filter === '代码' ? 'active' : ''}`}
            onClick={() => setFilter('代码')}
          >
            代码
          </button>
          <button
            className={`filter-btn ${filter === '聊天' ? 'active' : ''}`}
            onClick={() => setFilter('聊天')}
          >
            聊天
          </button>
        </div>

        <div className="knowledge-panel__search">
          <input
            type="text"
            placeholder="搜索知识..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="search-input"
          />
          <button onClick={handleSearch} className="search-btn">
            🔍
          </button>
        </div>
      </div>

      {/* 提炼结果 */}
      {extractMessage && !error && (
        <div className="knowledge-panel__notice" role="status">
          {extractMessage}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="knowledge-panel__error" role="alert">
          ⚠️ {error}
        </div>
      )}

      {/* 加载中 */}
      {loading && (
        <div className="knowledge-panel__loading">
          加载中...
        </div>
      )}

      {/* 知识条目列表 */}
      {!loading && entries.length > 0 && (
        <div className="knowledge-panel__list" data-testid="knowledge-list">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="knowledge-item"
              data-testid={`knowledge-item-${entry.id}`}
            >
              <div className="knowledge-item__header">
                <span className="knowledge-item__icon">
                  {getCategoryIcon(entry.category)}
                </span>
                <span className="knowledge-item__summary">
                  {entry.overview || entry.summary}
                </span>
                <span className="knowledge-item__stars">
                  {renderStars(entry.importance)}
                </span>
                {entry.occurrence_count && entry.occurrence_count > 1 && (
                  <span className="knowledge-item__count" title="重复观察次数">
                    重复观察 ×{entry.occurrence_count}
                  </span>
                )}
              </div>

              {/* 详细内容 */}
              {entry.details && (
                <div className="knowledge-item__details">
                  <div className="details-label">详细内容：</div>
                  <div className="details-content">{entry.details}</div>
                </div>
              )}

              <div className="knowledge-item__meta">
                <span className="knowledge-item__time">
                  {new Date(entry.created_at_ms).toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  })}
                </span>
                <span className="knowledge-item__category">
                  {entry.category}
                </span>
                {entry.user_verified && (
                  <span className="knowledge-item__badge verified">
                    已验证
                  </span>
                )}
                {entry.user_edited && (
                  <span className="knowledge-item__badge edited">
                    已编辑
                  </span>
                )}
              </div>

              {/* 实体标签 - 添加描述 */}
              {entry.entities.length > 0 && (
                <div className="knowledge-item__entities">
                  <span className="entities-label" title="从内容中提取的关键实体（人名、项目名、地点等）">
                    实体：
                  </span>
                  {entry.entities.map((entity, idx) => (
                    <span key={idx} className="entity-tag">
                      {entity}
                    </span>
                  ))}
                </div>
              )}

              <div className="knowledge-item__actions">
                <button
                  onClick={() => handleViewOriginal(entry.capture_id)}
                  className="action-btn"
                  title="查看原文"
                >
                  查看原文
                </button>
                {!entry.user_verified && (
                  <button
                    onClick={() => handleVerify(entry.id)}
                    className="action-btn verify"
                    title="验证"
                  >
                    验证
                  </button>
                )}
                <button
                  onClick={() => handleDelete(entry.id)}
                  className="action-btn delete"
                  title="删除"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!loading && entries.length === 0 && (
        <div className="knowledge-panel__empty" data-testid="knowledge-empty">
          <p>暂无知识条目</p>
          <p className="empty-hint">系统会自动从采集记录中提炼知识</p>
        </div>
      )}
    </div>
  )
}

export default KnowledgePanel
