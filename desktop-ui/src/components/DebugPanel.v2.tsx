/**
 * DebugPanel v2 — 调试面板（优化版）
 *
 * 改进：
 * 1. 使用 SVG 图标替代 Emoji
 * 2. 保持 Image3 的优秀布局和配色
 * 3. 优化图标视觉效果
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { CaptureRecord } from '../types'

interface DebugPanelProps {
  className?: string
}

interface VectorStatus {
  capture_id: number
  vectorized: boolean
  point_id: string | null
}

interface SystemStats {
  total_captures: number
  total_vectorized: number
  db_size_mb: number
  last_capture_ts: number | null
}

const DebugPanel: React.FC<DebugPanelProps> = ({ className = '' }) => {
  const { apiBaseUrl, setWindowMode } = useAppStore()

  const [captures, setCaptures] = useState<CaptureRecord[]>([])
  const [vectorStatus, setVectorStatus] = useState<VectorStatus[]>([])
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [refreshInterval, setRefreshInterval] = useState(2000)
  const [selectedCapture, setSelectedCapture] = useState<CaptureRecord | null>(null)
  const [highlightCaptureId, setHighlightCaptureId] = useState<number | null>(null)

  // 获取最新采集记录
  const fetchCaptures = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/captures?limit=20`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCaptures(data.captures || [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [apiBaseUrl])

  // 获取向量化状态
  const fetchVectorStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/vector/status`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setVectorStatus(data.items || [])
    } catch (e) {
      console.error('获取向量状态失败:', e)
    }
  }, [apiBaseUrl])

  // 获取系统统计
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/stats`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStats(data)
    } catch (e) {
      console.error('获取统计信息失败:', e)
    }
  }, [apiBaseUrl])

  // 刷新所有数据
  const refreshAll = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchCaptures(), fetchVectorStatus(), fetchStats()])
    setLoading(false)
  }, [fetchCaptures, fetchVectorStatus, fetchStats])

  // 初始加载
  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(refreshAll, refreshInterval)
    return () => clearInterval(timer)
  }, [autoRefresh, refreshInterval, refreshAll])

  // 监听滚动到指定采集记录的事件
  useEffect(() => {
    const handleScrollToCapture = (event: CustomEvent) => {
      const { captureId } = event.detail
      setHighlightCaptureId(captureId)

      const capture = captures.find((c) => c.id === captureId)
      if (capture) {
        setSelectedCapture(capture)
      }

      setTimeout(() => {
        setHighlightCaptureId(null)
      }, 3000)
    }

    window.addEventListener('scroll-to-capture', handleScrollToCapture as EventListener)
    return () => {
      window.removeEventListener('scroll-to-capture', handleScrollToCapture as EventListener)
    }
  }, [captures])

  const handleClose = () => setWindowMode('buddy')

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts)
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  const getVectorStatusForCapture = (captureId: number) => {
    return vectorStatus.find((v) => v.capture_id === captureId)
  }

  return (
    <div className={`min-h-screen bg-gray-50 p-6 ${className}`} data-testid="debug-panel">
      {/* 标题栏 */}
      <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* 调试图标 - wrench.and.screwdriver */}
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-gray-700"
            >
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <h1 className="text-2xl font-bold text-gray-800">调试面板</h1>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              <span>自动刷新</span>
            </label>

            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              disabled={!autoRefresh}
              className="text-sm border rounded px-2 py-1"
            >
              <option value={1000}>1秒</option>
              <option value={2000}>2秒</option>
              <option value={5000}>5秒</option>
              <option value={10000}>10秒</option>
            </select>

            <button
              onClick={refreshAll}
              disabled={loading}
              className="px-4 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 text-sm flex items-center gap-2"
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
                className={loading ? 'animate-spin' : ''}
              >
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 16h5v5" />
              </svg>
              {loading ? '刷新中...' : '刷新'}
            </button>

            <button
              onClick={handleClose}
              className="px-4 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 text-sm flex items-center gap-2"
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
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6 flex items-center gap-2">
          {/* 警告图标 */}
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
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          {error}
        </div>
      )}

      {/* 系统统计 */}
      {stats && (
        <section className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            {/* 统计图标 - bar-chart */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-gray-700"
            >
              <line x1="12" x2="12" y1="20" y2="10" />
              <line x1="18" x2="18" y1="20" y2="4" />
              <line x1="6" x2="6" y1="20" y2="16" />
            </svg>
            <h2 className="text-xl font-semibold text-gray-800">系统统计</h2>
          </div>

          <div className="grid grid-cols-5 gap-4">
            <div className="bg-blue-50 rounded p-4">
              <div className="text-sm text-gray-600 mb-1">总采集数</div>
              <div className="text-2xl font-bold text-blue-600">{stats.total_captures}</div>
            </div>
            <div className="bg-green-50 rounded p-4">
              <div className="text-sm text-gray-600 mb-1">已向量化</div>
              <div className="text-2xl font-bold text-green-600">{stats.total_vectorized}</div>
            </div>
            <div className="bg-purple-50 rounded p-4">
              <div className="text-sm text-gray-600 mb-1">向量化率</div>
              <div className="text-2xl font-bold text-purple-600">
                {stats.total_captures > 0
                  ? ((stats.total_vectorized / stats.total_captures) * 100).toFixed(1)
                  : 0}
                %
              </div>
            </div>
            <div className="bg-yellow-50 rounded p-4">
              <div className="text-sm text-gray-600 mb-1">数据库大小</div>
              <div className="text-2xl font-bold text-yellow-600">
                {stats.db_size_mb.toFixed(2)} MB
              </div>
            </div>
            <div className="bg-pink-50 rounded p-4">
              <div className="text-sm text-gray-600 mb-1">最后采集</div>
              <div className="text-lg font-bold text-pink-600">
                {stats.last_capture_ts ? formatTimestamp(stats.last_capture_ts) : '无'}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 实时采集记录 */}
      <section className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          {/* 相机图标 - camera */}
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-gray-700"
          >
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
          <h2 className="text-xl font-semibold text-gray-800">最新采集记录（最近20条）</h2>
        </div>

        <div className="overflow-x-auto">
          {captures.length === 0 ? (
            <div className="text-center text-gray-500 py-8">暂无采集记录</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-3 py-2 text-left">ID</th>
                  <th className="px-3 py-2 text-left">时间</th>
                  <th className="px-3 py-2 text-left">应用</th>
                  <th className="px-3 py-2 text-left">窗口标题</th>
                  <th className="px-3 py-2 text-center">AX文本</th>
                  <th className="px-3 py-2 text-center">OCR</th>
                  <th className="px-3 py-2 text-center">输入</th>
                  <th className="px-3 py-2 text-center">知识库</th>
                </tr>
              </thead>
              <tbody>
                {captures.map((cap) => {
                  const vs = getVectorStatusForCapture(cap.id)
                  const isHighlighted = cap.id === highlightCaptureId

                  return (
                    <tr
                      key={cap.id}
                      className={`border-b hover:bg-gray-50 cursor-pointer ${
                        isHighlighted ? 'bg-yellow-100' : ''
                      }`}
                      onClick={() =>
                        setSelectedCapture(selectedCapture?.id === cap.id ? null : cap)
                      }
                    >
                      <td className="px-3 py-2">{cap.id}</td>
                      <td className="px-3 py-2">{formatTimestamp(cap.timestamp)}</td>
                      <td className="px-3 py-2">{cap.app_name || '-'}</td>
                      <td className="px-3 py-2 max-w-xs truncate">{cap.window_title || '-'}</td>
                      <td className="px-3 py-2 text-center">
                        {cap.ax_text ? '✓' : '-'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {cap.ocr_text ? '✓' : '-'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {cap.user_input ? '✓' : '-'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {vs?.vectorized ? (
                          <span className="text-green-600 font-semibold">✓</span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 详情展开 */}
        {selectedCapture && (
          <div className="mt-4 p-4 bg-gray-50 rounded border">
            <h3 className="font-semibold mb-2">采集详情 (ID: {selectedCapture.id})</h3>
            <div className="space-y-2 text-sm">
              {selectedCapture.ax_text && (
                <div>
                  <strong>AX 文本:</strong>
                  <pre className="mt-1 p-2 bg-white rounded text-xs overflow-auto max-h-40">
                    {selectedCapture.ax_text}
                  </pre>
                </div>
              )}
              {selectedCapture.ocr_text && (
                <div>
                  <strong>OCR 文本:</strong>
                  <pre className="mt-1 p-2 bg-white rounded text-xs overflow-auto max-h-40">
                    {selectedCapture.ocr_text}
                  </pre>
                </div>
              )}
              {selectedCapture.user_input && (
                <div>
                  <strong>用户输入:</strong>
                  <pre className="mt-1 p-2 bg-white rounded text-xs overflow-auto max-h-40">
                    {selectedCapture.user_input}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export default DebugPanel
