import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Settings from '../components/Settings'
import { useAppStore } from '../store/useAppStore'

const preference = {
  id: 1,
  key: 'performance.energy_saving_mode',
  value: 'true',
  source: 'manual',
  confidence: 1,
  updated_at: 1,
}

beforeEach(() => {
  useAppStore.getState().reset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Settings energy saving mode', () => {
  it('默认展示为开启，并可立即持久化关闭', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/config-checks')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        }
      }
      if (init?.method === 'PUT') {
        return {
          ok: true,
          json: async () => ({
            ...preference,
            value: 'false',
            source: 'user',
            updated_at: 2,
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({ preferences: [preference] }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<Settings />)

    const toggle = await screen.findByTestId('energy-saving-mode-toggle')
    expect(toggle).toBeChecked()

    fireEvent.click(toggle)

    await waitFor(() => expect(toggle).not.toBeChecked())
    const updateCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(updateCall?.[0]).toBe(
      'http://127.0.0.1:7070/preferences/performance.energy_saving_mode'
    )
    expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({ value: 'false' })
  })
})
