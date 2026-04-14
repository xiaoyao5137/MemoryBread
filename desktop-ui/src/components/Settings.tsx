/**
 * Settings v2 — 设置页（优化版）
 *
 * 改进：
 * 1. 使用卡片式布局，增加视觉层级
 * 2. 使用 SVG 图标替代 Emoji
 * 3. 优化表单样式和间距
 * 4. 添加图标和描述文字
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useFetchPreferences, useRunScreenshotCleanup, useUpdatePreference } from '../hooks/useApi'
import type { PreferenceRecord } from '../types'
import './Settings.v2.css'

interface SettingsProps {
  className?: string
}

const Settings: React.FC<SettingsProps> = ({ className = '' }) => {
  const CAPTURE_INTERVAL_KEY = 'privacy.capture_interval_sec'
  const SCREENSHOT_KEEP_DAYS_KEY = 'privacy.screenshot_keep_days'
  const USER_IDENTITY_KEY = 'user.identity_keywords'
  const DEFAULT_API_BASE = 'http://localhost:7070'

  const {
    apiBaseUrl,
    sidecarVersion,
    setApiBaseUrl,
    setWindowMode,
  } = useAppStore()

  const [preferences, setPreferences] = useState<PreferenceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apiUrlInput, setApiUrlInput] = useState(apiBaseUrl)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [identityInput, setIdentityInput] = useState('')
  const [identitySaved, setIdentitySaved] = useState(false)
  const [cleanupRunning, setCleanupRunning] = useState(false)

  const fetchPrefs = useFetchPreferences()
  const updatePref = useUpdatePreference()
  const runScreenshotCleanup = useRunScreenshotCleanup()

  const sortedPreferences = useMemo(() => {
    return [...preferences].sort((a, b) => {
      if (a.key === CAPTURE_INTERVAL_KEY) return -1
      if (b.key === CAPTURE_INTERVAL_KEY) return 1
      if (a.key === SCREENSHOT_KEEP_DAYS_KEY) return -1
      if (b.key === SCREENSHOT_KEEP_DAYS_KEY) return 1
      return a.key.localeCompare(b.key)
    })
  }, [preferences, CAPTURE_INTERVAL_KEY, SCREENSHOT_KEEP_DAYS_KEY])

  useEffect(() => {
    setLoading(true)
    fetchPrefs()
      .then((prefs) => {
        setPreferences(prefs)
        const identityPref = prefs.find((p) => p.key === USER_IDENTITY_KEY)
        if (identityPref) setIdentityInput(identityPref.value)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [fetchPrefs])

  const handleSaveApiUrl = useCallback(() => {
    const trimmed = apiUrlInput.trim()

    if (!trimmed) {
      setApiBaseUrl(DEFAULT_API_BASE)
      setError(null)
      setApiUrlInput(DEFAULT_API_BASE)
      setSaveMsg('API 地址已恢复默认值')
      setTimeout(() => setSaveMsg(null), 2000)
      return
    }

    try {
      const url = new URL(trimmed)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('仅支持 http/https 地址')
      }
      setApiBaseUrl(url.toString().replace(/\/$/, ''))
      setError(null)
      setSaveMsg('API 地址已更新')
      setTimeout(() => setSaveMsg(null), 2000)
    } catch {
      setError('API 地址格式无效，请输入完整的 http:// 或 https:// 地址')
      setSaveMsg(null)
    }
  }, [DEFAULT_API_BASE, apiUrlInput, setApiBaseUrl])

  const handlePrefChange = useCallback(
    async (key: string, value: string) => {
      try {
        const updated = await updatePref(key, value)
        setPreferences((prev) =>
          prev.map((p) => (p.key === key ? { ...p, value: updated.value } : p))
        )
        if (key === CAPTURE_INTERVAL_KEY) {
          setSaveMsg('OCR / 截图频率已保存，需重启 Core Engine 后生效')
          setTimeout(() => setSaveMsg(null), 3000)
        } else if (key === SCREENSHOT_KEEP_DAYS_KEY) {
          setSaveMsg('图片过期时间已保存，将在下一次后台清理时生效')
          setTimeout(() => setSaveMsg(null), 3000)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [CAPTURE_INTERVAL_KEY, updatePref]
  )

  const handleRunScreenshotCleanup = useCallback(async () => {
    setCleanupRunning(true)
    setError(null)
    try {
      const result = await runScreenshotCleanup()
      const freedMb = Math.round(result.freed_bytes / 1024 / 1024)
      setSaveMsg(`截图清理完成：删除 ${result.deleted_count} 个文件，释放约 ${freedMb} MB（保留 ${result.keep_days} 天）`)
      setTimeout(() => setSaveMsg(null), 5000)
      const prefs = await fetchPrefs()
      setPreferences(prefs)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCleanupRunning(false)
    }
  }, [fetchPrefs, runScreenshotCleanup])

  const handleClose = () => setWindowMode('buddy')

  const handleSaveIdentity = useCallback(async () => {
    const val = identityInput.trim()
    if (!val) return
    try {
      await updatePref(USER_IDENTITY_KEY, val)
      setIdentitySaved(true)
      setTimeout(() => setIdentitySaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [identityInput, updatePref, USER_IDENTITY_KEY])

  return (
    <div className={`settings-v2 ${className}`} data-testid="settings-page">
      {/* 标题栏 */}
      <div className="settings-v2__header">
        <div className="settings-v2__title-group">
          {/* 设置图标 */}
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
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <h1 className="settings-v2__title">设置</h1>
        </div>

        <button
          className="settings-v2__close-btn"
          data-testid="settings-close"
          onClick={handleClose}
          type="button"
          aria-label="关闭设置"
        >
          {/* X 图标 */}
          <svg
            width="20"
            height="20"
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
        </button>
      </div>

      <div className="settings-v2__content">
        {/* 我是谁 */}
        <section className="settings-v2__card settings-v2__card--identity" data-testid="settings-identity-section">
          <div className="settings-v2__card-header">
            <div className="settings-v2__card-icon settings-v2__card-icon--green">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            </div>
            <div>
              <h2 className="settings-v2__card-title">我是谁</h2>
              <p className="settings-v2__card-desc">告诉记忆面包你的身份，让它准确识别哪些内容是你自己的工作产出</p>
            </div>
          </div>

          <div className="settings-v2__form-group">
            <label htmlFor="identity-input" className="settings-v2__label">
              你的名字 / 昵称 / 网名
            </label>
            <p className="settings-v2__pref-help">
              多个名称用逗号分隔，例如：张三,zhangsan,老张。记忆面包会用这些信息区分屏幕上"你做的事"和"别人做的事"，避免把无关内容写入你的工作记录。
            </p>
            <div className="settings-v2__input-group">
              <input
                id="identity-input"
                data-testid="identity-input"
                type="text"
                className="settings-v2__input"
                value={identityInput}
                onChange={(e) => setIdentityInput(e.target.value)}
                placeholder="输入你的名字或昵称，多个用逗号分隔"
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveIdentity() }}
              />
              <button
                data-testid="identity-save"
                onClick={handleSaveIdentity}
                type="button"
                className="settings-v2__btn settings-v2__btn--primary"
                disabled={!identityInput.trim()}
              >
                保存
              </button>
            </div>
            {identitySaved && (
              <div className="settings-v2__success-msg">✓ 身份信息已保存</div>
            )}
            {!identityInput.trim() && !loading && (
              <div className="settings-v2__identity-hint">
                ⚠️ 尚未设置身份信息，建议在使用前先完成设置
              </div>
            )}
          </div>
        </section>

        {/* API 服务配置 */}
        <section className="settings-v2__card" data-testid="settings-api-section">
          <div className="settings-v2__card-header">
            <div className="settings-v2__card-icon settings-v2__card-icon--blue">
              {/* server 图标 */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
                <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
                <line x1="6" x2="6.01" y1="6" y2="6" />
                <line x1="6" x2="6.01" y1="18" y2="18" />
              </svg>
            </div>
            <div>
              <h2 className="settings-v2__card-title">API 服务</h2>
              <p className="settings-v2__card-desc">配置 Core Engine 连接地址</p>
            </div>
          </div>

          <div className="settings-v2__form-group">
            <label htmlFor="api-url-input" className="settings-v2__label">
              服务地址
            </label>
            <div className="settings-v2__input-group">
              <input
                id="api-url-input"
                data-testid="api-url-input"
                type="text"
                className="settings-v2__input"
                value={apiUrlInput}
                onChange={(e) => setApiUrlInput(e.target.value)}
                placeholder="http://localhost:7070"
              />
              <button
                data-testid="api-url-save"
                onClick={handleSaveApiUrl}
                type="button"
                className="settings-v2__btn settings-v2__btn--primary"
              >
                保存
              </button>
            </div>
            {saveMsg && (
              <div className="settings-v2__success-msg" data-testid="save-msg">
                ✓ {saveMsg}
              </div>
            )}
          </div>
        </section>

        {/* 个性化偏好 */}
        <section className="settings-v2__card" data-testid="settings-prefs-section">
          <div className="settings-v2__card-header">
            <div className="settings-v2__card-icon settings-v2__card-icon--purple">
              {/* sliders 图标 */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="4" x2="4" y1="21" y2="14" />
                <line x1="4" x2="4" y1="10" y2="3" />
                <line x1="12" x2="12" y1="21" y2="12" />
                <line x1="12" x2="12" y1="8" y2="3" />
                <line x1="20" x2="20" y1="21" y2="16" />
                <line x1="20" x2="20" y1="12" y2="3" />
                <line x1="2" x2="6" y1="14" y2="14" />
                <line x1="10" x2="14" y1="8" y2="8" />
                <line x1="18" x2="22" y1="16" y2="16" />
              </svg>
            </div>
            <div>
              <h2 className="settings-v2__card-title">个性化偏好</h2>
              <p className="settings-v2__card-desc">自定义应用行为和显示方式</p>
            </div>
          </div>

          {loading && (
            <div className="settings-v2__loading" data-testid="prefs-loading">
              加载中...
            </div>
          )}
          {error && (
            <div className="settings-v2__error" data-testid="prefs-error">
              ⚠️ {error}
            </div>
          )}

          <div className="settings-v2__pref-list">
            {sortedPreferences.map((pref) => {
              const isCaptureInterval = pref.key === CAPTURE_INTERVAL_KEY
              const isScreenshotKeepDays = pref.key === SCREENSHOT_KEEP_DAYS_KEY
              return (
                <div
                  key={pref.key}
                  className="settings-v2__pref-item"
                  data-testid={`pref-row-${pref.key}`}
                >
                  <label htmlFor={`pref-${pref.key}`} className="settings-v2__pref-label">
                    {isCaptureInterval
                      ? 'OCR / 截图频率（秒）'
                      : isScreenshotKeepDays
                        ? '图片过期时间（天）'
                        : pref.key}
                  </label>
                  {isCaptureInterval && (
                    <p className="settings-v2__pref-help">
                      控制后台 OCR / 截图采集频率，不是调试面板的页面刷新频率。默认值保持当前配置，修改后需重启 Core Engine 生效。
                    </p>
                  )}
                  {isScreenshotKeepDays && (
                    <p className="settings-v2__pref-help">
                      控制图片缓存的过期时间。超过该天数的本地截图文件会自动删除，并清空对应 capture 记录中的截图路径。
                    </p>
                  )}
                  {isScreenshotKeepDays && (
                    <div className="settings-v2__input-group" style={{ marginBottom: 8 }}>
                      <button
                        type="button"
                        className="settings-v2__btn settings-v2__btn--secondary"
                        onClick={handleRunScreenshotCleanup}
                        disabled={cleanupRunning}
                      >
                        {cleanupRunning ? '清理中...' : '立即清理一次'}
                      </button>
                    </div>
                  )}
                  {!isCaptureInterval && !isScreenshotKeepDays && (
                    <div className="settings-v2__pref-key">{pref.key}</div>
                  )}
                  <input
                    id={`pref-${pref.key}`}
                    type="text"
                    className="settings-v2__pref-input"
                    defaultValue={pref.value}
                    onBlur={(e) => {
                      if (e.target.value !== pref.value) {
                        handlePrefChange(pref.key, e.target.value)
                      }
                    }}
                  />
                </div>
              )
            })}
          </div>
        </section>

        {/* 开发者工具 */}
        <section className="settings-v2__card" data-testid="settings-debug-section">
          <div className="settings-v2__card-header">
            <div className="settings-v2__card-icon settings-v2__card-icon--orange">
              {/* wrench 图标 */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            </div>
            <div>
              <h2 className="settings-v2__card-title">开发者工具</h2>
              <p className="settings-v2__card-desc">
                查看实时采集记录、向量化状态和系统性能指标
              </p>
            </div>
          </div>

          <button
            data-testid="open-debug-btn"
            onClick={() => setWindowMode('debug')}
            type="button"
            className="settings-v2__btn settings-v2__btn--secondary"
          >
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
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            打开调试面板
          </button>
        </section>

        {/* 版本信息 */}
        <section className="settings-v2__card" data-testid="settings-version-section">
          <div className="settings-v2__card-header">
            <div className="settings-v2__card-icon settings-v2__card-icon--gray">
              {/* info 图标 */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            </div>
            <div>
              <h2 className="settings-v2__card-title">版本信息</h2>
            </div>
          </div>

          <div className="settings-v2__version-list">
            <div className="settings-v2__version-item" data-testid="sidecar-version">
              <span className="settings-v2__version-label">AI Sidecar</span>
              <span className="settings-v2__version-value">{sidecarVersion}</span>
            </div>
            <div className="settings-v2__version-item" data-testid="app-version">
              <span className="settings-v2__version-label">Desktop UI</span>
              <span className="settings-v2__version-value">0.1.0</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

export default Settings
