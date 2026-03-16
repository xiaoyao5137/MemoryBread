/**
 * FloatingBuddy v2 — 悬浮搭子窗口（优化版）
 *
 * 改进：
 * 1. 使用 SVG 图标替代 Emoji
 * 2. 修复 hover 时所有图标放大的问题
 * 3. 遵循设计规范
 */

import React from 'react'
import { useAppStore } from '../store/useAppStore'
import './FloatingBuddy.v2.css'

interface FloatingBuddyProps {
  className?: string
}

const FloatingBuddy: React.FC<FloatingBuddyProps> = ({ className = '' }) => {
  const { windowMode, setWindowMode } = useAppStore()

  const handleClick = () => {
    // 主按钮始终打开工作搭子面板，不支持收起
    setWindowMode('rag')
  }

  const handleKnowledgeClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setWindowMode('knowledge')
  }

  const handleModelsClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setWindowMode('models')
  }

  const handleSettingsClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setWindowMode('settings')
  }

  const handleTasksClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setWindowMode('tasks')
  }

  const handleMonitorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setWindowMode('monitor')
  }

  return (
    <div
      className={`floating-buddy-v2 ${className}`}
      data-testid="floating-buddy"
    >
      {/* 主按钮 - AI 助手 */}
      <button
        className="buddy-main-btn"
        data-testid="buddy-avatar"
        onClick={handleClick}
        aria-label="打开工作搭子"
        title="打开工作搭子"
        type="button"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {/* 次要按钮组 */}
      <div className="buddy-actions">
        {/* 知识库 */}
        <button
          className="buddy-action-btn"
          data-testid="knowledge-btn"
          onClick={handleKnowledgeClick}
          aria-label="知识库"
          title="知识库"
          type="button"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
            <path d="M8 7h6"/>
            <path d="M8 11h8"/>
          </svg>
        </button>

        {/* 定时任务 */}
        <button
          className="buddy-action-btn"
          data-testid="tasks-btn"
          onClick={handleTasksClick}
          aria-label="定时任务"
          title="定时任务"
          type="button"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </button>

        {/* 模型管理 */}
        <button
          className="buddy-action-btn"
          data-testid="models-btn"
          onClick={handleModelsClick}
          aria-label="模型管理"
          title="模型管理"
          type="button"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="16" height="16" x="4" y="4" rx="2"/>
            <rect width="6" height="6" x="9" y="9" rx="1"/>
            <path d="M15 2v2"/><path d="M15 20v2"/>
            <path d="M2 15h2"/><path d="M2 9h2"/>
            <path d="M20 15h2"/><path d="M20 9h2"/>
            <path d="M9 2v2"/><path d="M9 20v2"/>
          </svg>
        </button>

        {/* 监控 */}
        <button
          className="buddy-action-btn"
          data-testid="monitor-btn"
          onClick={handleMonitorClick}
          aria-label="监控"
          title="监控"
          type="button"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
        </button>

        {/* 设置 */}
        <button
          className="buddy-action-btn"
          data-testid="settings-btn"
          onClick={handleSettingsClick}
          aria-label="设置"
          title="设置"
          type="button"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

export default FloatingBuddy
