import type { CloudSubscription, CloudUser } from '../types'

const firstNonEmpty = (...values: Array<string | null | undefined>): string | null => {
  for (const value of values) {
    const normalized = value?.trim()
    if (normalized) return normalized
  }
  return null
}

const PLAN_LABELS: Record<string, string> = {
  silver: 'Std',
  silver_monthly: 'Std',
  silver_annual: 'Std Annual',
  gold: 'Plus',
  gold_monthly: 'Plus',
  gold_annual: 'Plus Annual',
  platinum: 'Pro',
  platinum_monthly: 'Pro',
  platinum_annual: 'Pro Annual',
  enterprise_monthly: 'Enterprise',
  enterprise_annual: 'Enterprise Annual',
  普通套餐: 'Std',
  基础套餐: 'Std',
  白银: 'Std',
  白银套餐: 'Std',
  白银年费套餐: 'Std Annual',
  黄金: 'Plus',
  黄金套餐: 'Plus',
  黄金年费套餐: 'Plus Annual',
  白金: 'Pro',
  白金套餐: 'Pro',
  白金年费套餐: 'Pro Annual',
  企业月费套餐: 'Enterprise',
  企业年费套餐: 'Enterprise Annual',
}

const normalizePlanLabel = (value?: string | null): string | null => {
  const normalized = firstNonEmpty(value)
  if (!normalized) return null
  return PLAN_LABELS[normalized] ?? PLAN_LABELS[normalized.toLowerCase()] ?? normalized
}

export const getUserDisplayName = (user?: CloudUser | null): string => {
  if (!user) return '登录账户'
  return (
    firstNonEmpty(
      user.username,
      user.display_name,
      user.nickname,
      user.name,
      user.email,
      user.phone,
    ) ||
    '已连接账户'
  )
}

export const getMembershipPlanLabel = (
  user?: CloudUser | null,
  subscription?: CloudSubscription | null,
): string => {
  if (!user) return '本地模式'
  return (
    normalizePlanLabel(subscription?.plan_key) ||
    normalizePlanLabel(subscription?.name) ||
    normalizePlanLabel(user.membership_plan) ||
    normalizePlanLabel(user.plan_name) ||
    normalizePlanLabel(user.subscription_plan) ||
    'Std'
  )
}
