import React from 'react'
import './BakePanel.css'

export const BakeCard: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ className = '', children }) => (
  <section className={`bake-card ${className}`.trim()}>{children}</section>
)

export const BakePill: React.FC<{ text: string }> = ({ text }) => (
  <span className="bake-pill">{text}</span>
)

export const BakeButton: React.FC<React.PropsWithChildren<{
  active?: boolean
  primary?: boolean
  compact?: boolean
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit' | 'reset'
}>> = ({ active, primary, compact, disabled, onClick, type = 'button', children }) => (
  <button
    type={type}
    onClick={onClick}
    disabled={disabled}
    className={`bake-btn ${active ? 'bake-btn--active' : ''} ${primary ? 'bake-btn--primary' : ''} ${compact ? 'bake-btn--compact' : ''}`.trim()}
  >
    {children}
  </button>
)

export const BakeSectionHeader: React.FC<{
  title: string
  subtitle?: string
  right?: React.ReactNode
}> = ({ title, subtitle, right }) => (
  <div className="bake-section-header">
    <div className="bake-section-header__main">
      <div className="bake-section-title">{title}</div>
      {subtitle && <div className="bake-section-subtitle">{subtitle}</div>}
    </div>
    {right ? <div className="bake-section-header__right">{right}</div> : null}
  </div>
)
