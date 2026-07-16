/**
 * FloatingBuddy v2 — 悬浮搭子窗口（优化版）
 *
 * 改进：
 * 1. 使用 SVG 图标替代 Emoji
 * 2. 修复 hover 时所有图标放大的问题
 * 3. 遵循设计规范
 * 4. 多级分组菜单：吃面包 / 烤面包 / 面包机
 */

import React from 'react'
import { ChevronRight, CircleUserRound, LogIn } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { type WindowMode } from '../types'
import { getRunModeLabel, getUserDisplayName } from '../utils/accountDisplay'
import EnvironmentSwitch from './admin/EnvironmentSwitch'
import { BreadAppIcon, type BreadAppIconName } from './icons/BreadIcons'
import './FloatingBuddy.v2.css'

interface FloatingBuddyProps {
  className?: string
}

interface MenuItem {
  mode: WindowMode
  label: string
  testId: string
  icon: BreadAppIconName
}

interface MenuGroup {
  groupLabel: string
  items: MenuItem[]
}

const MENU_GROUPS: MenuGroup[] = [
  {
    groupLabel: '吃面包',
    items: [
      {
        mode: 'rag',
        label: '咨询',
        testId: 'buddy-avatar',
        icon: 'consult'
      },
      {
        mode: 'creation',
        label: '创作',
        testId: 'creation-btn',
        icon: 'creation'
      },
      {
        mode: 'tasks',
        label: '任务',
        testId: 'tasks-btn',
        icon: 'tasks'
      },
    ]
  },
  {
    groupLabel: '烤面包',
    items: [
      {
        mode: 'bake',
        label: '记忆',
        testId: 'bake-btn',
        icon: 'memory'
      },
      {
        mode: 'knowledge',
        label: '采集',
        testId: 'knowledge-btn',
        icon: 'capture'
      },
      {
        mode: 'diary',
        label: '日记',
        testId: 'diary-btn',
        icon: 'profile'
      },
    ]
  },
  {
    groupLabel: '面包机',
    items: [
      {
        mode: 'models',
        label: '模型',
        testId: 'models-btn',
        icon: 'models'
      },
      {
        mode: 'privacy',
        label: '隐私',
        testId: 'privacy-btn',
        icon: 'privacy'
      },
      {
        mode: 'monitor',
        label: '监控',
        testId: 'monitor-btn',
        icon: 'monitor'
      },
      {
        mode: 'settings',
        label: '配置',
        testId: 'settings-btn',
        icon: 'settings'
      },
    ]
  }
]

const FloatingBuddy: React.FC<FloatingBuddyProps> = ({ className = '' }) => {
  const { windowMode, setWindowMode, clearBakeNavigationStack, currentUser, cloudSubscription } = useAppStore()
  const accountLabel = getUserDisplayName(currentUser)
  const runModeLabel = getRunModeLabel(currentUser, cloudSubscription)
  const handleNavigate = (mode: WindowMode) => {
    clearBakeNavigationStack()
    setWindowMode(mode)
  }

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

      <EnvironmentSwitch />

      <nav className="buddy-actions" aria-label="主菜单">
        {MENU_GROUPS.map((group) => (
          <div key={group.groupLabel} className="buddy-menu-group">
            <div className="buddy-menu-group__label">{group.groupLabel}</div>
            {group.items.map((item) => {
              const isActive = windowMode === item.mode
              return (
                <button
                  key={item.mode}
                  className={`buddy-action-btn ${isActive ? 'buddy-action-btn--active' : ''}`}
                  data-testid={item.testId}
                  onClick={() => handleNavigate(item.mode)}
                  aria-label={item.label}
                  title={item.label}
                  type="button"
                >
                  <span className="buddy-action-btn__icon" aria-hidden="true">
                    <BreadAppIcon name={item.icon} size={24} />
                  </span>
                  <span className="buddy-action-btn__label">{item.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      <button
        className={`buddy-account-pill ${windowMode === 'account' ? 'buddy-account-pill--active' : ''}`}
        type="button"
        aria-label={currentUser ? '打开用户账户' : '未登录，打开登录'}
        onClick={() => handleNavigate('account')}
      >
        <span className="buddy-account-pill__icon" aria-hidden="true">
          {currentUser ? <CircleUserRound size={17} /> : <LogIn size={17} />}
        </span>
        <span className="buddy-account-pill__text">
          <strong>{accountLabel}</strong>
          <span>{runModeLabel}</span>
        </span>
        <ChevronRight className="buddy-account-pill__chevron" size={15} aria-hidden="true" />
      </button>
    </aside>
  )
}

export default FloatingBuddy
