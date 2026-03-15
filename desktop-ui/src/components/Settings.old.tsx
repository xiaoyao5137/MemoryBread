/**
 * Settings — 设置页
 *
 * 管理：
 * - API 服务地址（默认 http://localhost:7070）
 * - 隐私过滤开关
 * - 数据清理
 * - 版本信息
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useAppStore }        from '../store/useAppStore'
import { useFetchPreferences, useUpdatePreference } from '../hooks/useApi'
import type { PreferenceRecord } from '../types'

interface SettingsProps {
  className?: string
}

const Settings: React.FC<SettingsProps> = ({ className = '' }) => {
  const {
    apiBaseUrl, sidecarVersion,
    setApiBaseUrl, setWindowMode,
  } = useAppStore()

  const [preferences, setPreferences] = useState<PreferenceRecord[]>([])
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [apiUrlInput, setApiUrlInput] = useState(apiBaseUrl)
  const [saveMsg, setSaveMsg]         = useState<string | null>(null)

  const fetchPrefs = useFetchPreferences()
  const updatePref = useUpdatePreference()

  useEffect(() => {
    setLoading(true)
    fetchPrefs()
      .then(setPreferences)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [fetchPrefs])

  const handleSaveApiUrl = useCallback(() => {
    setApiBaseUrl(apiUrlInput.trim())
    setSaveMsg('API 地址已更新')
    setTimeout(() => setSaveMsg(null), 2000)
  }, [apiUrlInput, setApiBaseUrl])

  const handlePrefChange = useCallback(async (key: string, value: string) => {
    try {
      const updated = await updatePref(key, value)
      setPreferences((prev) =>
        prev.map((p) => (p.key === key ? { ...p, value: updated.value } : p))
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [updatePref])

  const handleClose = () => setWindowMode('buddy')

  return (
    <div
      className={`settings-page ${className}`}
      data-testid="settings-page"
      role="main"
    >
      {/* 标题栏 */}
      <div className="settings__header">
        <h1 className="settings__title">设置</h1>
        <button
          data-testid="settings-close"
          onClick={handleClose}
          type="button"
          aria-label="关闭设置"
        >
          ✕
        </button>
      </div>

      {/* API 地址配置 */}
      <section className="settings__section" data-testid="settings-api-section">
        <h2 className="settings__section-title">API 服务</h2>
        <label htmlFor="api-url-input">Core Engine 地址</label>
        <div className="settings__row">
          <input
            id="api-url-input"
            data-testid="api-url-input"
            type="text"
            value={apiUrlInput}
            onChange={(e) => setApiUrlInput(e.target.value)}
            placeholder="http://localhost:7070"
          />
          <button
            data-testid="api-url-save"
            onClick={handleSaveApiUrl}
            type="button"
          >
            保存
          </button>
        </div>
        {saveMsg && (
          <div data-testid="save-msg" role="status">{saveMsg}</div>
        )}
      </section>

      {/* 偏好设置 */}
      <section className="settings__section" data-testid="settings-prefs-section">
        <h2 className="settings__section-title">个性化偏好</h2>

        {loading && <div data-testid="prefs-loading">加载中…</div>}
        {error   && <div data-testid="prefs-error" role="alert">⚠️ {error}</div>}

        {preferences.slice(0, 10).map((pref) => (
          <div key={pref.key} className="settings__pref-row" data-testid={`pref-row-${pref.key}`}>
            <label htmlFor={`pref-${pref.key}`}>{pref.key}</label>
            <input
              id={`pref-${pref.key}`}
              type="text"
              defaultValue={pref.value}
              onBlur={(e) => {
                if (e.target.value !== pref.value) {
                  handlePrefChange(pref.key, e.target.value)
                }
              }}
            />
          </div>
        ))}
      </section>

      {/* 版本信息 */}
      <section className="settings__section" data-testid="settings-version-section">
        <h2 className="settings__section-title">版本信息</h2>
        <div data-testid="sidecar-version">AI Sidecar: {sidecarVersion}</div>
        <div data-testid="app-version">Desktop UI: 0.1.0</div>
      </section>

      {/* 开发者工具 */}
      <section className="settings__section" data-testid="settings-debug-section">
        <h2 className="settings__section-title">开发者工具</h2>
        <button
          data-testid="open-debug-btn"
          onClick={() => setWindowMode('debug')}
          type="button"
          className="settings__debug-btn"
        >
          🔧 打开调试面板
        </button>
        <p className="settings__hint">
          查看实时采集记录、向量化状态和系统性能指标
        </p>
      </section>
    </div>
  )
}

export default Settings
