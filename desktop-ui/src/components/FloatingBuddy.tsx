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
import { type WindowMode } from '../types'
import './FloatingBuddy.v2.css'

interface FloatingBuddyProps {
  className?: string
}

interface MenuItem {
  mode: WindowMode
  label: string
  testId: string
  icon: React.ReactNode
}

const MENU_ITEMS: MenuItem[] = [
  {
    mode: 'rag',
    label: '吃面包',
    testId: 'buddy-avatar',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    )
  },
  {
    mode: 'bake',
    label: '烤面包',
    testId: 'bake-btn',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 10V8a6 6 0 0 1 12 0v2" />
        <path d="M4 10h16v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-5Z" />
        <path d="M9 14h.01" />
        <path d="M12 14h.01" />
        <path d="M15 14h.01" />
      </svg>
    )
  },
  {
    mode: 'knowledge',
    label: '醒发箱',
    testId: 'knowledge-btn',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
        <path d="M8 7h6"/>
        <path d="M8 11h8"/>
      </svg>
    )
  },
  {
    mode: 'tasks',
    label: '定时烤',
    testId: 'tasks-btn',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
    )
  },
  {
    mode: 'models',
    label: '烤箱型号',
    testId: 'models-btn',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="16" height="16" x="4" y="4" rx="2"/>
        <rect width="6" height="6" x="9" y="9" rx="1"/>
        <path d="M15 2v2"/><path d="M15 20v2"/>
        <path d="M2 15h2"/><path d="M2 9h2"/>
        <path d="M20 15h2"/><path d="M20 9h2"/>
        <path d="M9 2v2"/><path d="M9 20v2"/>
      </svg>
    )
  },
  {
    mode: 'monitor',
    label: '温度计',
    testId: 'monitor-btn',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/>
        <line x1="12" y1="20" x2="12" y2="4"/>
        <line x1="6" y1="20" x2="6" y2="14"/>
      </svg>
    )
  },
  {
    mode: 'settings',
    label: '手艺调教',
    testId: 'settings-btn',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    )
  }
]

const FloatingBuddy: React.FC<FloatingBuddyProps> = ({ className = '' }) => {
  const { windowMode, setWindowMode } = useAppStore()

  return (
    <aside
      className={`floating-buddy-v2 ${className}`}
      data-testid="floating-buddy"
    >
      <div className="buddy-sidebar-header">
        <div className="buddy-sidebar-logo">
          <img src="/logo.png" alt="记忆面包" className="buddy-sidebar-logo-img" />
        </div>
        <div className="buddy-sidebar-title-group">
          <h1 className="buddy-sidebar-title">记忆面包</h1>
          <p className="buddy-sidebar-subtitle">品尝新知识</p>
        </div>
      </div>

      <nav className="buddy-actions" aria-label="主菜单">
        {MENU_ITEMS.map((item) => {
          const isActive = windowMode === item.mode

          return (
            <button
              key={item.mode}
              className={`buddy-action-btn ${isActive ? 'buddy-action-btn--active' : ''}`}
              data-testid={item.testId}
              onClick={() => setWindowMode(item.mode)}
              aria-label={item.label}
              title={item.label}
              type="button"
            >
              <span className="buddy-action-btn__icon" aria-hidden="true">{item.icon}</span>
              <span className="buddy-action-btn__label">{item.label}</span>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}

export default FloatingBuddy
