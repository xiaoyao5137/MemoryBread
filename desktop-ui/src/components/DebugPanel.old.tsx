/**
 * DebugPanel — 调试面板
 *
 * 实时显示：
 * - 最新采集记录（轮询或 WebSocket）
 * - OCR 识别结果
 * - 向量化入库状态
 * - 系统性能指标
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
  const [refreshInterval, setRefreshInterval] = useState(2000) // 2秒
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
    await Promise.all([
      fetchCaptures(),
      fetchVectorStatus(),
      fetchStats(),
    ])
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

      // 查找并打开该采集记录
      const capture = captures.find(c => c.id === captureId)
      if (capture) {
        setSelectedCapture(capture)
      }

      // 3秒后取消高亮
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
      second: '2-digit'
    })
  }

  const getVectorStatusForCapture = (captureId: number) => {
    return vectorStatus.find(v => v.capture_id === captureId)
  }

  return (
    <div
      className={`min-h-screen bg-gray-50 p-6 ${className}`}
      data-testid="debug-panel"
      role="main"
    >
      {/* 标题栏 */}
      <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">🔧 调试面板</h1>
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
              className="px-4 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 text-sm"
            >
              {loading ? '刷新中...' : '🔄 刷新'}
            </button>
            <button
              onClick={handleClose}
              className="px-4 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 text-sm"
            >
              ✕ 关闭
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6" role="alert">
          ⚠️ {error}
        </div>
      )}

      {/* 系统统计 */}
      {stats && (
        <section className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-800 mb-4">📊 系统统计</h2>
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
                  : 0}%
              </div>
            </div>
            <div className="bg-yellow-50 rounded p-4">
              <div className="text-sm text-gray-600 mb-1">数据库大小</div>
              <div className="text-2xl font-bold text-yellow-600">{stats.db_size_mb.toFixed(2)} MB</div>
            </div>
            <div className="bg-pink-50 rounded p-4">
              <div className="text-sm text-gray-600 mb-1">最后采集</div>
              <div className="text-lg font-bold text-pink-600">
                {stats.last_capture_ts
                  ? formatTimestamp(stats.last_capture_ts)
                  : '无'}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 实时采集记录 */}
      <section className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">📸 最新采集记录（最近20条）</h2>
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
                  <th className="px-3 py-2 text-center">向量化</th>
                  <th className="px-3 py-2 text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {captures.map((cap) => {
                  const vecStatus = getVectorStatusForCapture(cap.id)
                  const isSelected = selectedCapture?.id === cap.id
                  const isHighlighted = highlightCaptureId === cap.id
                  return (
                    <tr key={cap.id} className={`border-b hover:bg-gray-50 ${isSelected ? 'bg-blue-50' : ''} ${isHighlighted ? 'bg-yellow-100 animate-pulse' : ''}`}>
                      <td className="px-3 py-2">{cap.id}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatTimestamp(cap.ts)}</td>
                      <td className="px-3 py-2">{cap.app_name || '-'}</td>
                      <td className="px-3 py-2 max-w-xs truncate" title={cap.win_title || ''}>
                        {cap.win_title || '-'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {cap.ax_text ? (
                          <span className="inline-block px-2 py-1 bg-green-100 text-green-700 rounded text-xs" title={cap.ax_text.substring(0, 100)}>
                            ✓ {cap.ax_text.length}字
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {cap.ocr_text ? (
                          <span className="inline-block px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs" title={cap.ocr_text.substring(0, 100)}>
                            ✓ {cap.ocr_text.length}字
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {cap.input_text ? (
                          <span className="inline-block px-2 py-1 bg-purple-100 text-purple-700 rounded text-xs" title={cap.input_text.substring(0, 100)}>
                            ✓ {cap.input_text.length}字
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {cap.knowledge ? (
                          <span
                            className="inline-block px-2 py-1 bg-amber-100 text-amber-700 rounded text-xs cursor-pointer hover:bg-amber-200"
                            title={cap.knowledge.summary}
                          >
                            📚 {'⭐'.repeat(cap.knowledge.importance)}
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {vecStatus?.vectorized ? (
                          <span className="inline-block px-2 py-1 bg-green-100 text-green-700 rounded text-xs" title={vecStatus.point_id || ''}>
                            ✓ 已入库
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs">⏳ 待处理</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-xs"
                          onClick={() => setSelectedCapture(cap)}
                        >
                          查看详情
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* 详细信息弹窗 */}
      {selectedCapture && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setSelectedCapture(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-6 py-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">🔍 采集记录详情 - ID: {selectedCapture.id}</h2>
              <button className="text-white hover:text-gray-200 text-2xl" onClick={() => setSelectedCapture(null)}>✕</button>
            </div>
            <div className="overflow-y-auto p-6 space-y-6">
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">📋 基本信息</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-600">采集时间:</span>
                    <span className="ml-2 font-medium">{new Date(selectedCapture.ts).toLocaleString('zh-CN')}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">应用名称:</span>
                    <span className="ml-2 font-medium">{selectedCapture.app_name || '(无)'}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">Bundle ID:</span>
                    <span className="ml-2 font-medium text-xs">{selectedCapture.app_bundle_id || '(无)'}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">事件类型:</span>
                    <span className="ml-2 font-medium">{selectedCapture.event_type}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-gray-600">窗口标题:</span>
                    <span className="ml-2 font-medium">{selectedCapture.win_title || '(无)'}</span>
                  </div>
                </div>
              </div>

              <div className="bg-green-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">📝 AX 文本（Accessibility）</h3>
                <pre className="bg-white border border-green-200 rounded p-3 text-sm overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {selectedCapture.ax_text || '(无 AX 文本)'}
                </pre>
                {selectedCapture.ax_text && (
                  <div className="mt-2 text-xs text-gray-600">
                    字符数: {selectedCapture.ax_text.length}
                  </div>
                )}
              </div>

              <div className="bg-blue-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">🔍 OCR 文本（图像识别）</h3>
                <pre className="bg-white border border-blue-200 rounded p-3 text-sm overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {selectedCapture.ocr_text || '(无 OCR 文本)'}
                </pre>
                {selectedCapture.ocr_text && (
                  <div className="mt-2 text-xs text-gray-600">
                    字符数: {selectedCapture.ocr_text.length}
                  </div>
                )}
              </div>

              <div className="bg-purple-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">⌨️ 输入文本（键盘输入）</h3>
                <pre className="bg-white border border-purple-200 rounded p-3 text-sm overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {selectedCapture.input_text || '(无输入文本)'}
                </pre>
                {selectedCapture.input_text && (
                  <div className="mt-2 text-xs text-gray-600">
                    字符数: {selectedCapture.input_text.length}
                  </div>
                )}
              </div>

              <div className="bg-pink-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">🎤 音频文本（ASR 转录）</h3>
                <pre className="bg-white border border-pink-200 rounded p-3 text-sm overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {selectedCapture.audio_text || '(无音频文本)'}
                </pre>
                {selectedCapture.audio_text && (
                  <div className="mt-2 text-xs text-gray-600">
                    字符数: {selectedCapture.audio_text.length}
                  </div>
                )}
              </div>

              {/* 知识库关联信息 */}
              {selectedCapture.knowledge && (
                <div className="bg-amber-50 rounded-lg p-4 border-2 border-amber-200">
                  <h3 className="text-lg font-semibold text-gray-800 mb-3">📚 关联知识库</h3>
                  <div className="bg-white rounded-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium">
                          {selectedCapture.knowledge.category}
                        </span>
                        <span className="text-amber-500 text-lg">
                          {'⭐'.repeat(selectedCapture.knowledge.importance)}
                        </span>
                        {selectedCapture.knowledge.occurrence_count && selectedCapture.knowledge.occurrence_count > 1 && (
                          <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium">
                            出现 {selectedCapture.knowledge.occurrence_count} 次
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-gray-500">ID: {selectedCapture.knowledge.id}</span>
                    </div>
                    <div>
                      <div className="text-sm text-gray-600 mb-1">概述：</div>
                      <div className="text-base text-gray-800 leading-relaxed">
                        {selectedCapture.knowledge.overview || selectedCapture.knowledge.summary}
                      </div>
                    </div>
                    {selectedCapture.knowledge.details && (
                      <div>
                        <div className="text-sm text-gray-600 mb-1">详细内容：</div>
                        <div className="text-sm text-gray-700 leading-relaxed bg-gray-50 p-3 rounded max-h-40 overflow-y-auto">
                          {selectedCapture.knowledge.details}
                        </div>
                      </div>
                    )}
                    {selectedCapture.knowledge.entities && selectedCapture.knowledge.entities.length > 0 && (
                      <div>
                        <div className="text-sm text-gray-600 mb-1" title="从内容中提取的关键实体（人名、项目名、地点等）">实体：</div>
                        <div className="flex flex-wrap gap-2">
                          {selectedCapture.knowledge.entities.map((entity: string, idx: number) => (
                            <span key={idx} className="px-2 py-1 bg-purple-100 text-purple-700 rounded text-xs">
                              {entity}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="bg-yellow-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">📸 截图信息</h3>
                <div className="text-sm">
                  <span className="text-gray-600">截图路径:</span>
                  <code className="ml-2 bg-white px-2 py-1 rounded text-xs">{selectedCapture.screenshot_path || '(无截图)'}</code>
                </div>
              </div>

              <div className="bg-red-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">🔒 隐私信息</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-600">敏感内容:</span>
                    <span className={`ml-2 font-medium ${selectedCapture.is_sensitive ? 'text-red-600' : 'text-green-600'}`}>
                      {selectedCapture.is_sensitive ? '是' : '否'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-600">已脱敏:</span>
                    <span className={`ml-2 font-medium ${selectedCapture.pii_scrubbed ? 'text-green-600' : 'text-gray-600'}`}>
                      {selectedCapture.pii_scrubbed ? '是' : '否'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="bg-gray-100 px-6 py-4 flex justify-end">
              <button
                className="px-6 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                onClick={() => setSelectedCapture(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 原有的最新记录详情（保留作为快速预览） */}
      {captures.length > 0 && !selectedCapture && (
        <section className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-xl font-semibold text-gray-800 mb-4">🔍 最新记录快速预览</h2>
          <div className="space-y-3 text-sm">
            <div className="flex">
              <span className="text-gray-600 w-24">ID:</span>
              <span className="font-medium">{captures[0].id}</span>
            </div>
            <div className="flex">
              <span className="text-gray-600 w-24">应用:</span>
              <span className="font-medium">{captures[0].app_name || '(无)'}</span>
            </div>
            <div className="flex">
              <span className="text-gray-600 w-24">窗口标题:</span>
              <span className="font-medium">{captures[0].win_title || '(无)'}</span>
            </div>
            <div>
              <span className="text-gray-600">AX 文本:</span>
              <pre className="mt-1 bg-gray-50 border rounded p-2 text-xs overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                {captures[0].ax_text ?
                  (captures[0].ax_text.length > 200
                    ? captures[0].ax_text.substring(0, 200) + '...'
                    : captures[0].ax_text)
                  : '(无)'}
              </pre>
            </div>
            <div>
              <span className="text-gray-600">OCR 文本:</span>
              <pre className="mt-1 bg-gray-50 border rounded p-2 text-xs overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                {captures[0].ocr_text ?
                  (captures[0].ocr_text.length > 200
                    ? captures[0].ocr_text.substring(0, 200) + '...'
                    : captures[0].ocr_text)
                  : '(无)'}
              </pre>
            </div>
            <div>
              <span className="text-gray-600">输入文本:</span>
              <pre className="mt-1 bg-gray-50 border rounded p-2 text-xs overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                {captures[0].input_text ?
                  (captures[0].input_text.length > 200
                    ? captures[0].input_text.substring(0, 200) + '...'
                    : captures[0].input_text)
                  : '(无)'}
              </pre>
            </div>
            {captures[0].screenshot_path && (
              <div className="flex">
                <span className="text-gray-600 w-24">截图路径:</span>
                <code className="text-xs bg-gray-100 px-2 py-1 rounded">{captures[0].screenshot_path}</code>
              </div>
            )}
            <div className="pt-2">
              <button
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                onClick={() => setSelectedCapture(captures[0])}
              >
                查看完整详情
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

export default DebugPanel
