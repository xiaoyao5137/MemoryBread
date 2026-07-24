import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import Settings from '../components/Settings'
import { useAppStore } from '../store/useAppStore'
import type { PreferenceRecord } from '../types'

const preference = (id: number, key: string, value: string): PreferenceRecord => ({
  id,
  key,
  value,
  source: 'manual',
  confidence: 1,
  updated_at: 1,
})

beforeEach(() => {
  useAppStore.getState().reset()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/config-checks')) {
      return {
        ok: true,
        json: async () => ({ items: [] }),
      }
    }
    return {
      ok: true,
      json: async () => ({
        preferences: [
          preference(1, 'privacy.capture_interval_sec', '90'),
          preference(2, 'privacy.screenshot_keep_days', '30'),
          preference(3, 'creation.models', '[]'),
          preference(4, 'style.greeting', '"你好"'),
          preference(5, 'llm.api_key', '""'),
        ],
      }),
    }
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Settings preference visibility', () => {
  it('只展示有中文产品定义的用户偏好，不暴露内部变量名', async () => {
    render(<Settings />)

    expect(await screen.findByText('OCR / 截图频率（秒）')).toBeInTheDocument()
    expect(screen.getByText('图片过期时间（天）')).toBeInTheDocument()

    expect(screen.queryByTestId('pref-row-creation.models')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pref-row-style.greeting')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pref-row-llm.api_key')).not.toBeInTheDocument()
    expect(screen.queryByText('creation.models')).not.toBeInTheDocument()
  })
})
