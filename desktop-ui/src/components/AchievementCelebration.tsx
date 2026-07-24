import React, { useEffect, useRef } from 'react'
import {
  ArrowRight,
  Award,
  BookOpen,
  Briefcase,
  Code2,
  Flame,
  Focus,
  Moon,
  PenTool,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import type { AchievementBadge } from '../types'
import './AchievementCelebration.css'

interface AchievementCelebrationProps {
  badges: AchievementBadge[]
  onDismiss: () => void
  onViewCards: () => void
}

const BADGE_ICONS: Record<string, LucideIcon> = {
  code: Code2,
  blueprint: PenTool,
  moon: Moon,
  focus: Focus,
  book: BookOpen,
  flame: Flame,
}

const CRUMB_COUNT = 12

const AchievementCelebration: React.FC<AchievementCelebrationProps> = ({
  badges,
  onDismiss,
  onViewCards,
}) => {
  const dialogRef = useRef<HTMLElement>(null)
  const primaryActionRef = useRef<HTMLButtonElement>(null)
  const primaryBadge = badges[0]
  const Icon = BADGE_ICONS[primaryBadge?.icon_key] ?? Briefcase
  const badgeNames = badges.map((badge) => `「${badge.name}」`).join('、')

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const focusFrame = window.requestAnimationFrame(() => primaryActionRef.current?.focus())
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
      )
      if (focusable.length < 2) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [onDismiss])

  if (!primaryBadge) return null

  return (
    <div className="achievement-celebration" data-testid="achievement-celebration">
      <div className="achievement-celebration__crumbs" aria-hidden="true">
        {Array.from({ length: CRUMB_COUNT }, (_, index) => <span key={index} />)}
      </div>
      <section
        aria-describedby="achievement-celebration-description"
        aria-labelledby="achievement-celebration-title"
        aria-live="polite"
        aria-modal="true"
        className="achievement-celebration__dialog"
        ref={dialogRef}
        role="dialog"
      >
        <div className="achievement-celebration__intro">
          <span className="achievement-celebration__spark" aria-hidden="true">
            <Sparkles size={18} strokeWidth={2.2} />
          </span>
          <span>{badges.length > 1 ? `获得 ${badges.length} 张新卡片` : '获得新卡片'}</span>
        </div>

        <div
          className={`achievement-celebration__card achievement-celebration__card--${primaryBadge.palette_key}`}
        >
          <span className="achievement-celebration__icon" aria-hidden="true">
            <Icon size={38} strokeWidth={2.1} />
          </span>
          <span className="achievement-celebration__card-status"><Award size={13} aria-hidden="true" /> 已收入收藏</span>
          <strong>{primaryBadge.name}</strong>
          <span>{primaryBadge.tagline}</span>
          {badges.length > 1 && (
            <small>本次还获得 {badges.slice(1).map((badge) => badge.name).join('、')}</small>
          )}
        </div>

        <div className="achievement-celebration__copy">
          <h2 id="achievement-celebration-title">卡片已经烘焙完成</h2>
          <p id="achievement-celebration-description">
            你获得了{badgeNames}。前往标签卡片页查看详情，也可以把它佩戴到头像或悬浮球。
          </p>
        </div>

        <div className="achievement-celebration__actions">
          <button onClick={onDismiss} type="button">稍后查看</button>
          <button onClick={onViewCards} ref={primaryActionRef} type="button">
            去查收 <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  )
}

export default AchievementCelebration
