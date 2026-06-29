import React, { useEffect, useState } from 'react'
import type { AppBlacklistRecord, PrivacyFilterRecord } from '../types'
import './PrivacyPanel.css'

const API_BASE = 'http://127.0.0.1:7070'

const FILTER_DESCRIPTIONS: Record<string, string> = {
  chat: '检测密码、验证码、账号等聊天敏感内容',
  pii: '检测身份证、银行卡、手机号、邮箱等身份信息',
  policy: '检测涉密、机密、内部文件等政策敏感信息'
}

const PrivacyPanel: React.FC = () => {
  const [blacklist, setBlacklist] = useState<AppBlacklistRecord[]>([])
  const [filters, setFilters] = useState<PrivacyFilterRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newApp, setNewApp] = useState({ bundle_id: '', app_name: '', reason: '' })

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [blacklistRes, filtersRes] = await Promise.all([
        fetch(`${API_BASE}/api/privacy/blacklist`),
        fetch(`${API_BASE}/api/privacy/filters`)
      ])

      if (!blacklistRes.ok || !filtersRes.ok) {
        throw new Error('API 请求失败')
      }

      const blacklistData = await blacklistRes.json()
      const filtersData = await filtersRes.json()

      setBlacklist(blacklistData.data || [])
      setFilters(filtersData.data || [])
      setError(null)
    } catch (err) {
      console.error('加载隐私设置失败:', err)
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const toggleBlacklist = async (id: number, enabled: boolean) => {
    try {
      const res = await fetch(`${API_BASE}/api/privacy/blacklist/${id}/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      })
      if (!res.ok) throw new Error('更新失败')
      setBlacklist(prev => prev.map(item =>
        item.id === id ? { ...item, enabled } : item
      ))
    } catch (err) {
      console.error('更新黑名单失败:', err)
      alert('更新失败')
    }
  }

  const deleteBlacklist = async (id: number) => {
    if (!confirm('确定删除此应用？')) return
    try {
      const res = await fetch(`${API_BASE}/api/privacy/blacklist/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      setBlacklist(prev => prev.filter(item => item.id !== id))
    } catch (err) {
      console.error('删除黑名单失败:', err)
      alert('删除失败')
    }
  }

  const addBlacklist = async () => {
    if (!newApp.bundle_id || !newApp.app_name) {
      alert('请填写 Bundle ID 和应用名称')
      return
    }
    try {
      const res = await fetch(`${API_BASE}/api/privacy/blacklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newApp)
      })
      if (!res.ok) throw new Error('添加失败')
      setNewApp({ bundle_id: '', app_name: '', reason: '' })
      loadData()
    } catch (err) {
      console.error('添加黑名单失败:', err)
      alert('添加失败')
    }
  }

  const toggleFilter = async (filterType: string, enabled: boolean) => {
    try {
      const res = await fetch(`${API_BASE}/api/privacy/filters/${filterType}/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      })
      if (!res.ok) throw new Error('更新失败')
      setFilters(prev => prev.map(item =>
        item.filter_type === filterType ? { ...item, enabled } : item
      ))
    } catch (err) {
      console.error('更新过滤规则失败:', err)
      alert('更新失败')
    }
  }

  if (loading) {
    return <div className="privacy-panel loading">加载中...</div>
  }

  if (error) {
    return (
      <div className="privacy-panel error">
        <p>加载失败: {error}</p>
        <button onClick={loadData}>重试</button>
      </div>
    )
  }

  return (
    <div className="privacy-panel">
      <div className="privacy-header">
        <h1>隐私设置</h1>
        <p>管理应用黑名单和敏感内容过滤规则</p>
        <div className="privacy-notice">
          <span className="notice-icon">🔒</span>
          <span className="notice-text">
            拦截的内容会直接丢弃，不会存档，只统计条数。本地和云端都不会有记录，可以绝对放心使用。
          </span>
        </div>
      </div>

      <div className="privacy-section">
        <div className="section-card">
          <div className="card-header">
            <h2>敏感内容过滤</h2>
            <p>自动检测并抹除敏感信息，保留其他内容</p>
          </div>
          <div className="card-content">
            {filters.map(filter => (
              <div key={filter.id} className="filter-item">
                <div className="filter-info">
                  <div className="filter-name">{filter.filter_name}</div>
                  <div className="filter-desc">
                    {FILTER_DESCRIPTIONS[filter.filter_type] || '使用配置规则检测并过滤敏感内容'}
                    <span className="stat-badge"> · 本周已拦截 {filter.week_blocked ?? 0} 条</span>
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={filter.enabled}
                    onChange={(e) => toggleFilter(filter.filter_type, e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="privacy-section">
        <div className="section-card">
          <div className="card-header">
            <h2>应用黑名单</h2>
            <p>这些应用的窗口内容将不会被采集</p>
          </div>
          <div className="card-content">
            <div className="blacklist-list">
              {blacklist.map(item => (
                <div key={item.id} className="blacklist-item">
                  <div className="blacklist-info">
                    <div className="app-name">{item.app_name}</div>
                    <div className="bundle-id">
                      {item.bundle_id}
                      <span className="stat-badge"> · 本周已拦截 {item.week_blocked ?? 0} 次</span>
                    </div>
                    {item.reason && <div className="reason">{item.reason}</div>}
                  </div>
                  <div className="blacklist-actions">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={item.enabled}
                        onChange={(e) => toggleBlacklist(item.id, e.target.checked)}
                      />
                      <span className="slider"></span>
                    </label>
                    <button
                      className="btn-delete"
                      onClick={() => deleteBlacklist(item.id)}
                      title="删除"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="add-app-form">
              <h3>添加新应用</h3>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Bundle ID (如 com.tencent.xinWeChat)"
                  value={newApp.bundle_id}
                  onChange={(e) => setNewApp({ ...newApp, bundle_id: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="应用名称 (如 微信)"
                  value={newApp.app_name}
                  onChange={(e) => setNewApp({ ...newApp, app_name: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="原因 (可选)"
                  value={newApp.reason}
                  onChange={(e) => setNewApp({ ...newApp, reason: e.target.value })}
                />
                <button className="btn-add" onClick={addBlacklist}>
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default PrivacyPanel
