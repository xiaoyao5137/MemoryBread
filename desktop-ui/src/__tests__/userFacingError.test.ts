import { describe, expect, it } from 'vitest'
import { toUserFacingError } from '../utils/userFacingError'

describe('toUserFacingError', () => {
  it('保留可操作的中文业务提示', () => {
    expect(toUserFacingError(new Error('验证码不正确或已过期'), '操作失败')).toBe('验证码不正确或已过期')
  })

  it('屏蔽供应商、地址和内部请求细节', () => {
    expect(toUserFacingError(new Error('provider secret missing at https://api.example.com'), '云能力暂时不可用'))
      .toBe('云能力暂时不可用')
    expect(toUserFacingError(new Error('HTTP 502 request_id=req-123'), '请求失败'))
      .toBe('请求失败')
  })

  it('把余额不足转换成可操作提示', () => {
    expect(toUserFacingError(new Error('insufficient wallet balance'), '请求失败'))
      .toBe('可用 Credit 不足，请充值或切换到本地能力')
  })

  it('保留可操作的中文连接提示，屏蔽浏览器底层网络错误', () => {
    expect(toUserFacingError(new Error('账户服务暂时无法连接'), '登录失败'))
      .toBe('账户服务暂时无法连接')
    expect(toUserFacingError(new TypeError('Failed to fetch'), '登录失败'))
      .toBe('登录失败')
  })
})
