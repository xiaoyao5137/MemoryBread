import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBackupCard } from '../components/RepositoryPanel'

type MemoryBackupCardProps = React.ComponentProps<typeof MemoryBackupCard>

const renderBackupCard = (overrides: Partial<MemoryBackupCardProps> = {}) => {
  const props: MemoryBackupCardProps = {
    accessState: 'signed-out',
    busy: null,
    cloudSnapshots: [],
    cloudSnapshotsStatus: 'idle',
    cloudSnapshotsError: null,
    selectedCloudSnapshotId: '',
    recoveryKey: '',
    generatedRecoveryKey: null,
    lastImportReport: null,
    importFileInputRef: React.createRef<HTMLInputElement>(),
    onExport: vi.fn(),
    onImportClick: vi.fn(),
    onImportFile: vi.fn(),
    onOpenAccount: vi.fn(),
    onRecoveryKeyChange: vi.fn(),
    onCloudSnapshotChange: vi.fn(),
    onRefreshCloudSnapshots: vi.fn(),
    onBackupToCloud: vi.fn(),
    onRestoreFromCloud: vi.fn(),
    ...overrides,
  }

  render(<MemoryBackupCard {...props} />)
  return props
}

describe('MemoryBackupCard', () => {
  it('未登录时保留本机操作，并用单一登录引导替代禁用的云端表单', () => {
    const props = renderBackupCard()

    expect(screen.getByText('记忆备份')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出备份' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '导入记忆包' })).toBeEnabled()
    expect(screen.getByText('登录后使用云端备份')).toBeInTheDocument()
    expect(screen.queryByLabelText('恢复密钥')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '云端备份' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '备份到云端' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '登录后使用' }))
    expect(props.onOpenAccount).toHaveBeenCalledTimes(1)
  })

  it('已登录且有权限时展示云端操作和明确的加载状态', () => {
    renderBackupCard({
      accessState: 'available',
      cloudSnapshotsStatus: 'loading',
    })

    expect(screen.getByLabelText('恢复密钥')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在读取云端备份')
    expect(screen.getByRole('button', { name: '正在读取...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '备份到云端' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '恢复到本机' })).toBeDisabled()
  })

  it('已登录后展示云端备份列表，并保留刷新、备份和恢复入口', () => {
    const props = renderBackupCard({
      accessState: 'available',
      cloudSnapshotsStatus: 'ready',
      cloudSnapshots: [{
        id: 'snapshot-1',
        device_id: 'device-1',
        encrypted_size: 2048,
        status: 'committed',
        committed_at: '2026-07-13T10:00:00Z',
      }],
      selectedCloudSnapshotId: 'snapshot-1',
      generatedRecoveryKey: 'generated-recovery-key',
    })

    expect(screen.getByRole('combobox', { name: '云端备份' })).toHaveValue('snapshot-1')
    expect(screen.getByLabelText('本次恢复密钥')).toHaveValue('generated-recovery-key')

    fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
    fireEvent.click(screen.getByRole('button', { name: '备份到云端' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复到本机' }))

    expect(props.onRefreshCloudSnapshots).toHaveBeenCalledTimes(1)
    expect(props.onBackupToCloud).toHaveBeenCalledTimes(1)
    expect(props.onRestoreFromCloud).toHaveBeenCalledTimes(1)
  })

  it('云端列表为空或读取失败时展示上下文状态，不留下空白控件', () => {
    const { rerender } = render(<MemoryBackupCard
      accessState="available"
      busy={null}
      cloudSnapshots={[]}
      cloudSnapshotsStatus="ready"
      cloudSnapshotsError={null}
      selectedCloudSnapshotId=""
      recoveryKey=""
      generatedRecoveryKey={null}
      lastImportReport={null}
      importFileInputRef={React.createRef<HTMLInputElement>()}
      onExport={vi.fn()}
      onImportClick={vi.fn()}
      onImportFile={vi.fn()}
      onOpenAccount={vi.fn()}
      onRecoveryKeyChange={vi.fn()}
      onCloudSnapshotChange={vi.fn()}
      onRefreshCloudSnapshots={vi.fn()}
      onBackupToCloud={vi.fn()}
      onRestoreFromCloud={vi.fn()}
    />)

    expect(screen.getByText('还没有云端备份，可以先创建一份。')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '云端备份' })).not.toBeInTheDocument()

    rerender(<MemoryBackupCard
      accessState="available"
      busy={null}
      cloudSnapshots={[]}
      cloudSnapshotsStatus="error"
      cloudSnapshotsError="账户服务暂时不可用"
      selectedCloudSnapshotId=""
      recoveryKey=""
      generatedRecoveryKey={null}
      lastImportReport={null}
      importFileInputRef={React.createRef<HTMLInputElement>()}
      onExport={vi.fn()}
      onImportClick={vi.fn()}
      onImportFile={vi.fn()}
      onOpenAccount={vi.fn()}
      onRecoveryKeyChange={vi.fn()}
      onCloudSnapshotChange={vi.fn()}
      onRefreshCloudSnapshots={vi.fn()}
      onBackupToCloud={vi.fn()}
      onRestoreFromCloud={vi.fn()}
    />)

    expect(screen.getByRole('alert')).toHaveTextContent('账户服务暂时不可用')
  })

  it('已登录但暂未开通时展示账户说明，不渲染空白云端表单', () => {
    const props = renderBackupCard({ accessState: 'unavailable' })

    expect(screen.getByText('当前账户暂未开通云端备份')).toBeInTheDocument()
    expect(screen.queryByLabelText('恢复密钥')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '备份到云端' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '查看账户' }))
    expect(props.onOpenAccount).toHaveBeenCalledTimes(1)
  })
})
