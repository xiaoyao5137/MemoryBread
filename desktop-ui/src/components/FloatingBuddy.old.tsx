/**
 * FloatingBuddy — 悬浮搭子窗口
 *
 * 最小化的常驻悬浮按钮，点击展开 RAG Panel 或跳转到设置。
 * 在 Tauri 中作为 always-on-top 透明窗口显示。
 */

import React from 'react'
import { useAppStore } from '../store/useAppStore'

interface FloatingBuddyProps {
  /** 测试时可注入 className */
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
      className={`floating-buddy ${className}`}
      data-testid="floating-buddy"
      role="button"
      aria-label="工作搭子"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      {/* 搭子头像 */}
      <div
        className="buddy-avatar"
        data-testid="buddy-avatar"
        aria-label={windowMode === 'buddy' ? '点击打开助手面板' : '点击收起'}
        title={windowMode === 'buddy' ? '点击打开助手面板' : '点击收起'}
      >
        🤖
      </div>

      {/* 展开状态指示 */}
      {windowMode !== 'buddy' && (
        <div className="buddy-status" data-testid="buddy-status-dot" />
      )}

      {/* 知识库入口 */}
      <button
        className="buddy-knowledge-btn"
        data-testid="knowledge-btn"
        onClick={handleKnowledgeClick}
        aria-label="知识库"
        title="知识库"
        type="button"
      >
        📚
      </button>

      {/* 模型管理入口 */}
      <button
        className="buddy-models-btn"
        data-testid="models-btn"
        onClick={handleModelsClick}
        aria-label="模型管理"
        title="模型管理"
        type="button"
      >
        🤖
      </button>

      {/* 设置入口 */}
      <button
        className="buddy-settings-btn"
        data-testid="settings-btn"
        onClick={handleSettingsClick}
        aria-label="设置"
        title="设置"
        type="button"
      >
        ⚙️
      </button>
    </div>
  )
}

export default FloatingBuddy
