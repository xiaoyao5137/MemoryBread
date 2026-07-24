import React, { useState } from 'react'
import {
  AlertCircle,
  Award,
  BookOpen,
  Briefcase,
  Code2,
  Flame,
  Focus,
  Moon,
  PenTool,
  RefreshCw,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import type { AchievementBadge, AchievementProfile, AchievementSurface } from '../types'
import { equipAchievementBadge } from '../utils/authApi'
import './AchievementGallery.css'

interface AchievementGalleryProps {
  adminApiBaseUrl: string
  authToken: string
  error: string | null
  loading: boolean
  onChange: (profile: AchievementProfile) => void
  onRetry: () => void
  profile: AchievementProfile | null
}

const BADGE_ICONS: Record<string, LucideIcon> = {
  code: Code2,
  blueprint: PenTool,
  moon: Moon,
  focus: Focus,
  book: BookOpen,
  flame: Flame,
}

const RARITY_LABELS: Record<AchievementBadge['rarity'], string> = {
  common: '常见',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
}

const BADGE_WELLNESS_NOTES: Partial<Record<string, string>> = {
  sleepless_warrior: '高强度纪念卡：请优先补充睡眠和休息。',
  overnight_writer: '通宵纪念卡：完成赶稿后，请尽快补充睡眠。',
  uninterrupted_four_hours: '长时间久坐会影响健康。记得起身、喝水和休息。',
}

const formatCredit = (value: string) => {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return value
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(amount)
}

const AchievementGallery: React.FC<AchievementGalleryProps> = ({
  adminApiBaseUrl,
  authToken,
  error,
  loading,
  onChange,
  onRetry,
  profile,
}) => {
  const [equippingSurface, setEquippingSurface] = useState<AchievementSurface | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const toggleBadge = async (surface: AchievementSurface, badge: AchievementBadge) => {
    const nextBadgeId = profile?.equipped[surface]?.id === badge.id ? null : badge.id
    setEquippingSurface(surface)
    setMessage(null)
    try {
      const nextProfile = await equipAchievementBadge(adminApiBaseUrl, authToken, surface, nextBadgeId)
      onChange(nextProfile)
      const target = surface === 'profile_avatar' ? '个人头像' : '悬浮球'
      setMessage(nextBadgeId ? `已将「${badge.name}」佩戴到${target}。` : `已从${target}取下标签。`)
    } catch (equipError) {
      setMessage(equipError instanceof Error ? equipError.message : '佩戴标签失败')
    } finally {
      setEquippingSurface(null)
    }
  }

  const totalQuantity = profile?.badges.reduce((sum, item) => sum + item.quantity, 0) ?? 0

  return (
    <section className="achievement-gallery" aria-labelledby="achievement-gallery-title">
      <header className="achievement-gallery__header">
        <div>
          <span className="achievement-gallery__eyebrow">ACHIEVEMENT ARCHIVE</span>
          <h2 id="achievement-gallery-title">标签卡片</h2>
          <p>完成任务后卡片会持续累积，并同步发放对应 Credit 奖励。</p>
        </div>
        {!loading && !error && profile && profile.badges.length > 0 && (
          <div className="achievement-gallery__total" aria-label="标签卡片统计">
            <strong>{totalQuantity}</strong>
            <span>{profile.badges.length} 种卡片</span>
          </div>
        )}
      </header>

      {loading && (
        <div className="achievement-gallery__loading" aria-label="正在读取标签卡片">
          <span />
          <span />
          <span />
        </div>
      )}

      {!loading && error && (
        <div className="achievement-gallery__error" role="alert">
          <AlertCircle size={20} aria-hidden />
          <div><strong>暂时无法读取标签卡片</strong><span>{error}</span></div>
          <button onClick={onRetry} type="button"><RefreshCw size={14} aria-hidden />重试</button>
        </div>
      )}

      {!loading && !error && profile?.badges.length === 0 && (
        <div className="achievement-gallery__empty">
          <span aria-hidden="true"><Award size={30} /></span>
          <strong>第一张卡片还在烘焙</strong>
          <p>完成运营中的任务后，标签卡片和 Credit 奖励会一起进入你的账户。</p>
        </div>
      )}

      {!loading && !error && profile && profile.badges.length > 0 && (
        <div className="achievement-gallery__grid">
          {profile.badges.map((item) => {
            const badge = item.badge
            const Icon = BADGE_ICONS[badge.icon_key] ?? Briefcase
            const onProfile = profile.equipped.profile_avatar?.id === badge.id
            const onFloating = profile.equipped.floating_avatar?.id === badge.id
            return (
              <article
                className={`achievement-gallery__card achievement-gallery__card--${badge.palette_key}`}
                key={badge.id}
              >
                <div className="achievement-gallery__card-top">
                  <span className="achievement-gallery__icon" aria-hidden="true"><Icon size={27} strokeWidth={2.2} /></span>
                  <span className="achievement-gallery__rarity">{RARITY_LABELS[badge.rarity]}</span>
                  <span className="achievement-gallery__quantity">×{item.quantity}</span>
                </div>
                <div className="achievement-gallery__copy">
                  <strong>{badge.name}</strong>
                  <span>{badge.tagline}</span>
                  <p>{badge.description}</p>
                </div>
                <div className="achievement-gallery__meta">
                  <span>累计奖励 <strong>{formatCredit(item.total_credit_earned)}</strong> Credit</span>
                  <span>最近获得 {new Date(item.last_earned_at).toLocaleDateString('zh-CN')}</span>
                </div>
                {BADGE_WELLNESS_NOTES[badge.badge_key] && (
                  <div className="achievement-gallery__rest-note">{BADGE_WELLNESS_NOTES[badge.badge_key]}</div>
                )}
                <div className="achievement-gallery__actions">
                  <button
                    aria-pressed={onProfile}
                    className={onProfile ? 'is-equipped' : ''}
                    disabled={equippingSurface !== null}
                    onClick={() => void toggleBadge('profile_avatar', badge)}
                    type="button"
                  >
                    <UserRound size={14} aria-hidden />
                    {onProfile ? '从头像取下' : '佩戴到头像'}
                  </button>
                  <button
                    aria-pressed={onFloating}
                    className={onFloating ? 'is-equipped' : ''}
                    disabled={equippingSurface !== null}
                    onClick={() => void toggleBadge('floating_avatar', badge)}
                    type="button"
                  >
                    <Briefcase size={14} aria-hidden />
                    {onFloating ? '从悬浮球取下' : '佩戴到悬浮球'}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {message && <div className="achievement-gallery__message" role="status">{message}</div>}
    </section>
  )
}

export default AchievementGallery
