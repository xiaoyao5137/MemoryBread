import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RepositoryPanel from '../components/RepositoryPanel'
import { useAppStore } from '../store/useAppStore'

const mocks = vi.hoisted(() => ({
  fetchMemories: vi.fn(),
  fetchMemory: vi.fn(),
  fetchCaptures: vi.fn(),
  fetchCaptureDetail: vi.fn(),
  fetchCapturesRaw: vi.fn(),
  fetchTemplates: vi.fn(),
  fetchKnowledge: vi.fn(),
  fetchKnowledgeDetail: vi.fn(),
  fetchSops: vi.fn(),
  fetchSop: vi.fn(),
  exportMemoryPackage: vi.fn(),
  importMemoryPackage: vi.fn(),
  backupMemoryPackageToCloud: vi.fn(),
  restoreMemoryPackageFromCloud: vi.fn(),
  fetchCloudSnapshots: vi.fn(),
  upsertCloudDevice: vi.fn(),
}))

vi.mock('../hooks/useApi', () => ({
  useFetchBakeMemories: () => mocks.fetchMemories,
  useFetchBakeMemory: () => mocks.fetchMemory,
  useFetchBakeCaptures: () => mocks.fetchCaptures,
  useFetchBakeCaptureDetail: () => mocks.fetchCaptureDetail,
  useFetchCaptures: () => mocks.fetchCapturesRaw,
  useFetchBakeTemplates: () => mocks.fetchTemplates,
  useFetchBakeKnowledge: () => mocks.fetchKnowledge,
  useFetchBakeKnowledgeDetail: () => mocks.fetchKnowledgeDetail,
  useFetchBakeSops: () => mocks.fetchSops,
  useFetchBakeSop: () => mocks.fetchSop,
  useExportMemoryPackage: () => mocks.exportMemoryPackage,
  useImportMemoryPackage: () => mocks.importMemoryPackage,
  useBackupMemoryPackageToCloud: () => mocks.backupMemoryPackageToCloud,
  useRestoreMemoryPackageFromCloud: () => mocks.restoreMemoryPackageFromCloud,
}))

vi.mock('../utils/authApi', () => ({
  fetchCloudSnapshots: mocks.fetchCloudSnapshots,
  upsertCloudDevice: mocks.upsertCloudDevice,
}))

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset())
  mocks.fetchMemories.mockResolvedValue({ items: [], total: 0 })
  mocks.fetchCaptures.mockResolvedValue({ items: [], total: 0 })
  mocks.fetchTemplates.mockResolvedValue({ items: [], total: 0 })
  mocks.fetchKnowledge.mockResolvedValue({ items: [], total: 0 })
  mocks.fetchSops.mockResolvedValue({ items: [], total: 0 })
  mocks.fetchCapturesRaw.mockResolvedValue([])
  mocks.fetchCloudSnapshots.mockResolvedValue([{
    id: 'snapshot-after-login',
    device_id: 'device-1',
    encrypted_size: 4096,
    status: 'committed',
    committed_at: '2026-07-13T10:00:00Z',
  }])

  useAppStore.getState().reset()
  useAppStore.getState().clearAuthSession()
  useAppStore.getState().setRepositoryTab('memory')
})

describe('RepositoryPanel memory backup', () => {
  it('登录且具备权限后自动读取并显示云端备份', async () => {
    useAppStore.getState().setAuthSession({
      access_token: 'mbs-test-token',
      expires_at: '2026-07-14T10:00:00Z',
      user: {
        id: 'user-1',
        email: 'user@memorybread.local',
        status: 'active',
        roles: ['user'],
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        created_at: '2026-07-13T10:00:00Z',
      },
    })
    useAppStore.getState().setCloudSubscription({
      id: 'subscription-1',
      status: 'active',
      plan_key: 'cloud-backup',
      name: '云端备份',
    })

    render(<RepositoryPanel />)

    await waitFor(() => {
      expect(mocks.fetchCloudSnapshots).toHaveBeenCalledWith(
        useAppStore.getState().adminApiBaseUrl,
        'mbs-test-token',
      )
    })
    expect(await screen.findByRole('combobox', { name: '云端备份' })).toHaveValue('snapshot-after-login')
    expect(screen.getByRole('button', { name: '备份到云端' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '恢复到本机' })).toBeEnabled()
  })
})
