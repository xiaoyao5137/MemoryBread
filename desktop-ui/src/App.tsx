/**
 * App — 根组件
 *
 * 根据 windowMode 渲染对应的 UI 模块：
 * - 'buddy'     → 悬浮搭子（仅显示按钮）
 * - 'rag'       → RAG 问答面板
 * - 'knowledge' → 知识库管理面板
 * - 'models'    → 模型管理面板
 * - 'settings'  → 设置页
 * - 'debug'     → 调试面板
 *
 * ActionConfirm 弹窗永远存在（当有 pendingAction 时显示）。
 */

import React, { useEffect } from 'react'
import { useAppStore }        from './store/useAppStore'
import FloatingBuddy          from './components/FloatingBuddy'
import RagPanel               from './components/RagPanel'
import KnowledgePanel         from './components/KnowledgePanel'
import ModelManager           from './components/ModelManager'
import ActionConfirm          from './components/ActionConfirm'
import Settings               from './components/Settings'
import DebugPanel             from './components/DebugPanel'
import ScheduledTasksPanel    from './components/ScheduledTasksPanel'
import MonitorPanel           from './components/MonitorPanel'

const App: React.FC = () => {
  const { windowMode, setWindowMode } = useAppStore()

  // 监听查看采集记录事件
  useEffect(() => {
    const handleViewCapture = (event: CustomEvent) => {
      const { captureId } = event.detail
      // 切换到调试面板
      setWindowMode('debug')
      // 触发滚动到指定采集记录的事件
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('scroll-to-capture', {
          detail: { captureId }
        }))
      }, 100)
    }

    window.addEventListener('view-capture', handleViewCapture as EventListener)
    return () => {
      window.removeEventListener('view-capture', handleViewCapture as EventListener)
    }
  }, [setWindowMode])

  return (
    <div className="app" data-testid="app-root">
      {/* 悬浮按钮（始终存在） */}
      <FloatingBuddy />

      {/* 主内容区域 */}
      {windowMode === 'rag'       && <RagPanel />}
      {windowMode === 'knowledge' && <KnowledgePanel />}
      {windowMode === 'models'    && <ModelManager />}
      {windowMode === 'settings'  && <Settings />}
      {windowMode === 'debug'     && <DebugPanel />}
      {windowMode === 'tasks'     && <ScheduledTasksPanel />}
      {windowMode === 'monitor'   && <MonitorPanel />}

      {/* 接管确认弹窗（条件渲染） */}
      <ActionConfirm />
    </div>
  )
}

export default App
