/**
 * ActionConfirm — 接管确认弹窗
 *
 * AI 即将执行键鼠操作时，弹出此对话框要求用户确认。
 * 提供「确认执行」和「取消」两个选项。
 * 支持倒计时自动取消（防止误触）。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { ActionCommand } from '../types'

const ACTION_TYPE_LABELS: Record<ActionCommand['type'], string> = {
  click: '点击一次',
  right_click: '点击右键',
  double_click: '双击',
  move_to: '移动指针',
  type_text: '输入文字',
  hotkey: '使用快捷键',
  key_press: '按下按键',
  scroll: '滚动页面',
  wait: '等待页面响应',
  sequence: '连续执行多个操作',
}

interface ActionConfirmProps {
  /** 用户确认后的回调（执行动作） */
  onConfirm?: (action: ActionCommand) => Promise<void>
  /** 倒计时秒数，0 表示不自动取消（默认 10s） */
  autoCancel?: number
  className?: string
}

const ActionConfirm: React.FC<ActionConfirmProps> = ({
  onConfirm,
  autoCancel = 10,
  className = '',
}) => {
  const {
    pendingAction,
    confirmAction,
    cancelAction,
  } = useAppStore()

  const [countdown, setCountdown] = useState(autoCancel)
  const [isExecuting, setIsExecuting] = useState(false)

  // 倒计时逻辑
  useEffect(() => {
    if (!pendingAction || autoCancel === 0) return
    setCountdown(autoCancel)

    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer)
          cancelAction()
          return 0
        }
        return c - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [pendingAction, autoCancel, cancelAction])

  useEffect(() => {
    if (!pendingAction) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isExecuting) cancelAction()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelAction, isExecuting, pendingAction])

  const handleConfirm = useCallback(async () => {
    if (!pendingAction) return
    confirmAction()
    if (onConfirm) {
      setIsExecuting(true)
      try {
        await onConfirm(pendingAction)
      } finally {
        setIsExecuting(false)
      }
    }
  }, [pendingAction, confirmAction, onConfirm])

  const handleCancel = useCallback(() => {
    cancelAction()
  }, [cancelAction])

  if (!pendingAction) return null

  return (
    <div
      className={`action-confirm-overlay ${className}`}
      data-testid="action-confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="action-confirm-title"
    >
      <div className="action-confirm-dialog" data-testid="action-confirm-dialog">
        {/* 标题 */}
        <h2 id="action-confirm-title" className="action-confirm__title" data-testid="action-confirm-title">
          确认执行此操作
        </h2>

        {/* 动作描述 */}
        <div className="action-confirm__action" data-testid="action-confirm-action">
          <strong>即将执行：</strong>
          <span>{pendingAction.description ?? ACTION_TYPE_LABELS[pendingAction.type]}</span>
        </div>

        {/* 详细信息 */}
        <div className="action-confirm__details" data-testid="action-confirm-details">
          <span>操作类型</span>
          <strong>{ACTION_TYPE_LABELS[pendingAction.type]}</strong>
          {pendingAction.type === 'sequence' && pendingAction.steps?.length ? <small>共 {pendingAction.steps.length} 个步骤</small> : null}
        </div>

        {/* 警告 */}
        <div className="action-confirm__warning" data-testid="action-confirm-warning" role="alert">
          确认后，记忆面包会操作键盘或鼠标。请先确认目标应用和当前页面无误。
        </div>

        {/* 操作按钮 */}
        <div className="action-confirm__buttons">
          <button
            className="action-confirm__btn action-confirm__btn--cancel"
            data-testid="action-cancel-btn"
            onClick={handleCancel}
            type="button"
            disabled={isExecuting}
            autoFocus
          >
            取消
            {autoCancel > 0 && ` (${countdown}s)`}
          </button>
          <button
            className="action-confirm__btn action-confirm__btn--confirm"
            data-testid="action-confirm-btn"
            onClick={handleConfirm}
            type="button"
            disabled={isExecuting}
            aria-busy={isExecuting}
          >
            {isExecuting ? '执行中…' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ActionConfirm
