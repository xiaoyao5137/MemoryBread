import { describe, expect, it } from 'vitest'
import { getRunModeLabel, getUserDisplayName } from '../utils/accountDisplay'
import type { CloudUser } from '../types'

const user: CloudUser = {
  id: '018f0000-0000-7000-8000-000000000004',
  email: 'mode@memorybread.local',
  status: 'active',
  roles: ['user'],
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  created_at: new Date().toISOString(),
}

describe('getRunModeLabel', () => {
  it.each([
    ['Std', '标准模式'],
    ['Plus', '增强模式'],
    ['Pro', '专家模式'],
  ])('将 %s 显示为 %s', (membershipPlan, expectedLabel) => {
    expect(getRunModeLabel({ ...user, membership_plan: membershipPlan })).toBe(expectedLabel)
  })

  it('登录用户没有模式信息时默认显示标准模式', () => {
    expect(getRunModeLabel(user)).toBe('标准模式')
  })
})

describe('getUserDisplayName', () => {
  it('uses nickname before the immutable account name', () => {
    expect(getUserDisplayName({
      ...user,
      username: 'account-name',
      display_name: 'legacy display name',
      nickname: '小麦',
    })).toBe('小麦')
  })

  it('falls back to the account name for old sessions', () => {
    expect(getUserDisplayName({ ...user, username: 'account-name' })).toBe('account-name')
  })
})
