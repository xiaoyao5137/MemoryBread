import type { CloudSubscription, CloudUser } from '../types'

export const getUserDisplayName = (user?: CloudUser | null): string => {
  if (!user) return '登录账户'
  return (
    user.display_name ||
    user.nickname ||
    user.name ||
    user.username ||
    user.email ||
    user.phone ||
    '已连接账户'
  )
}

export const getMembershipPlanLabel = (
  user?: CloudUser | null,
  subscription?: CloudSubscription | null,
): string => {
  if (!user) return '本地模式'
  return (
    subscription?.name ||
    user.membership_plan ||
    user.plan_name ||
    user.subscription_plan ||
    '普通套餐'
  )
}
