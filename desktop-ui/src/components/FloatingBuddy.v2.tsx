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

interface FloatingBuddyProps {
  className?: string
}

const FloatingBuddy: React.FC<FloatingBuddyProps> = ({ className = '' }) => {
  const { windowMode, setWindowMode } = useAppStore()

  const handleClick = () => {
    if (windowMode === 'buddy') {
      setWindowMode('rag')
    } else {
      setWindowMode('buddy')
    }
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
        aria-label={windowMode === 'buddy' ? '点击打开助手面板' : '点击收起'}
        title={windowMode === 'buddy' ? '点击打开助手面板' : '点击收起'}
        type="button"
      >
        {/* AI 图标 - brain.head.profile */}
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
          <path d="M9 13a4.5 4.5 0 0 0 3-4"/>
          <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>
          <path d="M3.477 10.896a4 4 0 0 1 .585-.396"/>
          <path d="M6 18a4 4 0 0 1-1.967-.516"/>
          <path d="M12 13h4"/>
          <path d="M12 18h6a2 2 0 0 1 2 2v1"/>
          <path d="M12 8h8"/>
          <path d="M16 8V5a2 2 0 0 1 2-2"/>
          <circle cx="16" cy="13" r=".5"/>
          <circle cx="18" cy="3" r=".5"/>
          <circle cx="20" cy="21" r=".5"/>
          <circle cx="20" cy="8" r=".5"/>
        </svg>

        {/* 状态指示点 */}
        {windowMode !== 'buddy' && (
          <span className="buddy-status-dot" data-testid="buddy-status-dot" />
        )}
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
          {/* books.vertical.fill */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
            <path d="M8 7h6"/>
            <path d="M8 11h8"/>
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
          {/* cpu */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="16" height="16" x="4" y="4" rx="2"/>
            <rect width="6" height="6" x="9" y="9" rx="1"/>
            <path d="M15 2v2"/>
            <path d="M15 20v2"/>
            <path d="M2 15h2"/>
            <path d="M2 9h2"/>
            <path d="M20 15h2"/>
            <path d="M20 9h2"/>
            <path d="M9 2v2"/>
            <path d="M9 20v2"/>
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
          {/* settings */}
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
