import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import PrivacyPanel from '../components/PrivacyPanel'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/privacy/blacklist')) {
      return {
        ok: true,
        json: async () => ({
          data: [{
            id: 1,
            bundle_id: 'com.example.private',
            app_name: '私密应用',
            enabled: true,
            reason: '包含私密内容',
            created_at: '2026-07-18T00:00:00Z',
            updated_at: '2026-07-18T00:00:00Z',
            week_blocked: 3,
          }],
        }),
      }
    }

    return {
      ok: true,
      json: async () => ({
        data: [{
          id: 1,
          filter_type: 'chat',
          filter_name: '聊天敏感内容',
          enabled: true,
          config_json: null,
          updated_at: '2026-07-18T00:00:00Z',
          week_blocked: 5,
        }],
      }),
    }
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PrivacyPanel', () => {
  it('在撑满式布局中展示规则、黑名单和带标签的添加表单', async () => {
    const { container } = render(<PrivacyPanel />)

    expect(await screen.findByRole('heading', { name: '隐私设置' })).toBeInTheDocument()
    expect(container.querySelector('.privacy-grid')).toBeInTheDocument()
    expect(container.querySelectorAll('.privacy-section')).toHaveLength(2)
    expect(screen.getByText('聊天敏感内容')).toBeInTheDocument()
    expect(screen.getByText('私密应用')).toBeInTheDocument()
    expect(screen.getByLabelText('Bundle ID')).toBeInTheDocument()
    expect(screen.getByLabelText('应用名称')).toBeInTheDocument()
    expect(screen.getByLabelText(/排除原因/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '聊天敏感内容已开启' })).toBeChecked()
  })
})
