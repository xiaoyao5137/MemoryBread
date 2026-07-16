import React, { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Cloud, FolderOpen, HardDriveDownload, LockKeyhole, LogIn, ShieldCheck } from 'lucide-react'
import {
  useBackupMemoryPackageToCloud,
  useExportMemoryPackage,
  useImportMemoryPackage,
  useRestoreMemoryPackageFromCloud,
} from '../hooks/useApi'
import { useAppStore } from '../store/useAppStore'
import type { CloudSnapshot, MemoryPackageImportReport } from '../types'
import { fetchCloudSnapshots, upsertCloudDevice } from '../utils/authApi'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './bake/BakeShared'

const CLOUD_DEVICE_ID_KEY = 'memory-bread_cloud_device_id'
const CLOUD_DEVICE_PUBLIC_KEY = 'memory-bread_cloud_device_public_key'

const tableLabels: Record<string, string> = {
  capture_refs: '占位引用',
  timelines: '时间线',
  bake_knowledge: '知识',
  bake_documents: '文档',
  bake_document_sections: '文档章节',
  bake_sops: '操作',
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const summarizeImportReport = (report: MemoryPackageImportReport) => {
  const rows = [report.capture_refs, ...report.tables]
  const inserted = rows.reduce((sum, item) => sum + (item.inserted || 0), 0)
  const updated = rows.reduce((sum, item) => sum + (item.updated || 0), 0)
  const skipped = rows.reduce((sum, item) => sum + (item.skipped || 0), 0)
  return `新增 ${inserted}，更新 ${updated}，跳过 ${skipped}`
}

const importReportRows = (report: MemoryPackageImportReport | null) => {
  if (!report) return []
  return [report.capture_refs, ...report.tables]
    .filter(item => item.incoming > 0)
    .map(item => ({
      ...item,
      label: tableLabels[item.name] ?? item.name,
    }))
}

type MemoryPackageBusy = 'export' | 'import' | 'cloud-backup' | 'cloud-restore' | null
type CloudBackupAccessState = 'signed-out' | 'unavailable' | 'available'
type CloudSnapshotsStatus = 'idle' | 'loading' | 'ready' | 'error'
interface MemoryBackupNotice {
  message: string
  exportPath?: string
}

interface MemoryBackupCardProps {
  accessState: CloudBackupAccessState
  busy: MemoryPackageBusy
  cloudSnapshots: CloudSnapshot[]
  cloudSnapshotsStatus: CloudSnapshotsStatus
  cloudSnapshotsError: string | null
  selectedCloudSnapshotId: string
  recoveryKey: string
  generatedRecoveryKey: string | null
  lastImportReport: MemoryPackageImportReport | null
  importFileInputRef: React.RefObject<HTMLInputElement>
  onExport: () => void
  onImportClick: () => void
  onImportFile: (file?: File | null) => void
  onOpenAccount: () => void
  onRecoveryKeyChange: (value: string) => void
  onCloudSnapshotChange: (value: string) => void
  onRefreshCloudSnapshots: () => void
  onBackupToCloud: () => void
  onRestoreFromCloud: () => void
}

const cloudAccessLabels: Record<CloudBackupAccessState, string> = {
  'signed-out': '未登录',
  unavailable: '暂未开通',
  available: '云端可用',
}

export const MemoryBackupCard: React.FC<MemoryBackupCardProps> = ({
  accessState,
  busy,
  cloudSnapshots,
  cloudSnapshotsStatus,
  cloudSnapshotsError,
  selectedCloudSnapshotId,
  recoveryKey,
  generatedRecoveryKey,
  lastImportReport,
  importFileInputRef,
  onExport,
  onImportClick,
  onImportFile,
  onOpenAccount,
  onRecoveryKeyChange,
  onCloudSnapshotChange,
  onRefreshCloudSnapshots,
  onBackupToCloud,
  onRestoreFromCloud,
}) => {
  const isBusy = busy !== null
  const cloudListLoading = cloudSnapshotsStatus === 'loading'

  return (
    <BakeCard className="bake-memory-package-card">
      <BakeSectionHeader
        title="记忆备份"
        subtitle="备份时间线、知识、文档和操作记录；原始截图不会包含在记忆包中。"
        right={<BakePill text={cloudAccessLabels[accessState]} />}
      />

      <div className="bake-memory-package-grid">
        <div className="bake-memory-package-group" aria-labelledby="local-backup-title">
          <div className="bake-memory-package-group__header">
            <span className="bake-memory-package-group__icon" aria-hidden>
              <HardDriveDownload size={17} />
            </span>
            <div>
              <div id="local-backup-title" className="bake-memory-package-group__title">本机备份</div>
              <div className="bake-muted">随时导出到本机，或从已有记忆包恢复。</div>
            </div>
          </div>
          <div className="bake-actions bake-actions--secondary bake-memory-package-actions">
            <BakeButton compact primary disabled={isBusy} onClick={onExport}>
              {busy === 'export' ? '正在导出...' : '导出备份'}
            </BakeButton>
            <BakeButton compact disabled={isBusy} onClick={onImportClick}>
              {busy === 'import' ? '正在导入...' : '导入记忆包'}
            </BakeButton>
            <input
              ref={importFileInputRef}
              type="file"
              accept=".json,.mbmemory,.mbsnapshot"
              aria-label="选择本机记忆包"
              className="bake-memory-package-file"
              onChange={(event) => onImportFile(event.target.files?.[0])}
            />
          </div>
        </div>

        <div className="bake-memory-package-group bake-memory-package-group--cloud" aria-labelledby="cloud-backup-title">
          <div className="bake-memory-package-group__header">
            <span className="bake-memory-package-group__icon" aria-hidden>
              <Cloud size={17} />
            </span>
            <div>
              <div id="cloud-backup-title" className="bake-memory-package-group__title">云端备份</div>
              <div className="bake-muted">跨设备保存加密记忆包，需要账户权限。</div>
            </div>
          </div>

          {accessState === 'signed-out' && (
            <div className="bake-memory-package-access-state">
              <span className="bake-memory-package-access-state__icon" aria-hidden>
                <LockKeyhole size={19} />
              </span>
              <div className="bake-memory-package-access-state__body">
                <strong>登录后使用云端备份</strong>
                <span>登录只解锁云端同步，本机导入和导出不受影响。</span>
              </div>
              <BakeButton compact primary onClick={onOpenAccount}>
                <LogIn size={14} aria-hidden />
                登录后使用
              </BakeButton>
            </div>
          )}

          {accessState === 'unavailable' && (
            <div className="bake-memory-package-access-state">
              <span className="bake-memory-package-access-state__icon" aria-hidden>
                <LockKeyhole size={19} />
              </span>
              <div className="bake-memory-package-access-state__body">
                <strong>当前账户暂未开通云端备份</strong>
                <span>你仍可使用本机备份；账户开通后，这里会显示云端操作。</span>
              </div>
              <BakeButton compact onClick={onOpenAccount}>查看账户</BakeButton>
            </div>
          )}

          {accessState === 'available' && (
            <div className="bake-memory-package-cloud">
              <div className="bake-memory-package-privacy-note">
                <ShieldCheck size={16} aria-hidden />
                <span>记忆包会先在本机加密再上传，云端无法读取内容；恢复密钥只由你保管。</span>
              </div>

              <div className="bake-memory-package-fields">
                <label className="bake-form-field bake-memory-package-key">
                  <span className="bake-filter-label">恢复密钥</span>
                  <input
                    className="bake-input"
                    type="password"
                    aria-label="恢复密钥"
                    autoComplete="off"
                    spellCheck={false}
                    value={recoveryKey}
                    onChange={(event) => onRecoveryKeyChange(event.target.value)}
                    placeholder="留空时自动生成"
                  />
                  <span className="bake-memory-package-field-help">备份时可留空；恢复时请输入对应密钥。</span>
                </label>

                <div className="bake-form-field bake-memory-package-select">
                  <span className="bake-filter-label">云端备份</span>
                  {cloudSnapshotsStatus === 'idle' && (
                    <div className="bake-memory-package-list-state" role="status">准备读取云端备份...</div>
                  )}
                  {cloudListLoading && (
                    <div className="bake-memory-package-list-state bake-memory-package-list-state--loading" role="status">
                      正在读取云端备份...
                    </div>
                  )}
                  {cloudSnapshotsStatus === 'error' && (
                    <div className="bake-memory-package-list-state bake-memory-package-list-state--error" role="alert">
                      {cloudSnapshotsError || '云端备份暂时无法读取，请稍后重试。'}
                    </div>
                  )}
                  {cloudSnapshotsStatus === 'ready' && cloudSnapshots.length === 0 && (
                    <div className="bake-memory-package-list-state">还没有云端备份，可以先创建一份。</div>
                  )}
                  {cloudSnapshotsStatus === 'ready' && cloudSnapshots.length > 0 && (
                    <select
                      className="bake-input"
                      aria-label="云端备份"
                      value={selectedCloudSnapshotId}
                      onChange={(event) => onCloudSnapshotChange(event.target.value)}
                    >
                      {cloudSnapshots.map(snapshot => (
                        <option key={snapshot.id} value={snapshot.id}>
                          {snapshot.committed_at ? new Date(snapshot.committed_at).toLocaleString('zh-CN') : snapshot.id} · {formatBytes(snapshot.encrypted_size)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <div className="bake-actions bake-actions--secondary bake-memory-package-actions">
                <BakeButton
                  compact
                  disabled={isBusy || cloudListLoading}
                  onClick={onRefreshCloudSnapshots}
                >
                  {cloudListLoading ? '正在读取...' : '刷新列表'}
                </BakeButton>
                <BakeButton compact primary disabled={isBusy} onClick={onBackupToCloud}>
                  {busy === 'cloud-backup' ? '正在备份...' : '备份到云端'}
                </BakeButton>
                <BakeButton
                  compact
                  disabled={isBusy || cloudListLoading || !selectedCloudSnapshotId}
                  onClick={onRestoreFromCloud}
                >
                  {busy === 'cloud-restore' ? '正在恢复...' : '恢复到本机'}
                </BakeButton>
              </div>
            </div>
          )}
        </div>
      </div>

      {generatedRecoveryKey && (
        <div className="bake-memory-package-generated-key" role="status">
          <div>
            <strong>请立即保存本次恢复密钥</strong>
            <span>MemoryBread 不会上传这把密钥，遗失后无法恢复该云端备份。</span>
          </div>
          <input className="bake-input" aria-label="本次恢复密钥" readOnly value={generatedRecoveryKey} />
        </div>
      )}

      {lastImportReport && (
        <div className="bake-memory-package-report" aria-label="记忆包导入结果">
          {importReportRows(lastImportReport).map(row => (
            <span key={row.name}>
              {row.label} 新增 {row.inserted} / 跳过 {row.skipped}
            </span>
          ))}
        </div>
      )}
    </BakeCard>
  )
}

const randomUuid = () => {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : null
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoApi) {
    cryptoApi.getRandomValues(bytes)
  } else {
    bytes.forEach((_, index) => {
      bytes[index] = Math.floor(Math.random() * 256)
    })
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const randomBase64 = () => {
  const bytes = new Uint8Array(32)
  if (typeof crypto !== 'undefined') {
    crypto.getRandomValues(bytes)
  } else {
    bytes.forEach((_, index) => {
      bytes[index] = Math.floor(Math.random() * 256)
    })
  }
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
}

const MemoryBackupSection: React.FC = () => {
  const {
    adminApiBaseUrl,
    authToken,
    currentUser,
    accountType,
    cloudSubscription,
    sidecarVersion,
    setWindowMode,
    setBakeMemoryOffset,
  } = useAppStore()

  const exportMemoryPackage = useExportMemoryPackage()
  const importMemoryPackage = useImportMemoryPackage()
  const backupMemoryPackageToCloud = useBackupMemoryPackageToCloud()
  const restoreMemoryPackageFromCloud = useRestoreMemoryPackageFromCloud()

  const [statusNotice, setStatusNotice] = useState<MemoryBackupNotice | null>(null)
  const [memoryPackageBusy, setMemoryPackageBusy] = useState<MemoryPackageBusy>(null)
  const [cloudSnapshots, setCloudSnapshots] = useState<CloudSnapshot[]>([])
  const [cloudSnapshotsStatus, setCloudSnapshotsStatus] = useState<CloudSnapshotsStatus>('idle')
  const [cloudSnapshotsError, setCloudSnapshotsError] = useState<string | null>(null)
  const [selectedCloudSnapshotId, setSelectedCloudSnapshotId] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(null)
  const [lastImportReport, setLastImportReport] = useState<MemoryPackageImportReport | null>(null)
  const cloudSnapshotsRequestSeqRef = useRef(0)
  const importFileInputRef = useRef<HTMLInputElement | null>(null)

  const setStatusMessage = useCallback((message: string, exportPath?: string) => {
    setStatusNotice({ message, exportPath })
  }, [])

  const hasCloudMemoryAccess = Boolean(
    authToken &&
    currentUser &&
    (
      accountType !== 'user' ||
      currentUser.roles.some(role => role !== 'user') ||
      cloudSubscription?.status === 'active'
    ),
  )
  const cloudBackupAccessState: CloudBackupAccessState = !authToken || !currentUser
    ? 'signed-out'
    : hasCloudMemoryAccess
      ? 'available'
      : 'unavailable'

  const ensureCloudDevice = async () => {
    if (!authToken) throw new Error('请先登录账户')
    let deviceId = window.localStorage.getItem(CLOUD_DEVICE_ID_KEY)
    if (!deviceId) {
      deviceId = randomUuid()
      window.localStorage.setItem(CLOUD_DEVICE_ID_KEY, deviceId)
    }
    let publicKey = window.localStorage.getItem(CLOUD_DEVICE_PUBLIC_KEY)
    if (!publicKey) {
      publicKey = randomBase64()
      window.localStorage.setItem(CLOUD_DEVICE_PUBLIC_KEY, publicKey)
    }
    const platform = navigator.platform || 'desktop'
    const device = await upsertCloudDevice(adminApiBaseUrl, authToken, {
      device_id: deviceId,
      name: `MemoryBread ${platform}`,
      platform,
      client_version: sidecarVersion || '0.1.0',
      public_key_base64: publicKey,
    })
    window.localStorage.setItem(CLOUD_DEVICE_ID_KEY, device.id)
    return device.id
  }

  const handleExportMemoryPackage = async () => {
    setMemoryPackageBusy('export')
    setLastImportReport(null)
    try {
      const result = await exportMemoryPackage()
      const tables = result.manifest.table_summaries
        .map(item => `${tableLabels[item.name] ?? item.name} ${item.row_count}`)
        .join(' / ')
      setStatusMessage(
        `记忆包已保存：${result.path}（${formatBytes(result.file_size_bytes)}，${tables || '暂无数据'}）`,
        result.path,
      )
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '记忆包导出失败')
    } finally {
      setMemoryPackageBusy(null)
    }
  }

  const handleImportMemoryPackageFile = async (file?: File | null) => {
    if (!file) return
    setMemoryPackageBusy('import')
    setLastImportReport(null)
    try {
      const content = await file.text()
      const report = await importMemoryPackage(content, false)
      setLastImportReport(report)
      setStatusMessage(`记忆包导入完成：${summarizeImportReport(report)}`)
      setBakeMemoryOffset(0)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '记忆包导入失败')
    } finally {
      setMemoryPackageBusy(null)
      if (importFileInputRef.current) importFileInputRef.current.value = ''
    }
  }

  const handleOpenExportFolder = async () => {
    if (!statusNotice?.exportPath) return
    try {
      await invoke('open_export_folder', { path: statusNotice.exportPath })
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error || '无法打开备份所在文件夹'))
    }
  }

  const loadCloudSnapshots = useCallback(async (announceResult: boolean) => {
    if (!authToken || !hasCloudMemoryAccess) return
    const requestSeq = cloudSnapshotsRequestSeqRef.current + 1
    cloudSnapshotsRequestSeqRef.current = requestSeq
    setCloudSnapshotsStatus('loading')
    setCloudSnapshotsError(null)
    try {
      const snapshots = await fetchCloudSnapshots(adminApiBaseUrl, authToken)
      if (requestSeq !== cloudSnapshotsRequestSeqRef.current) return
      setCloudSnapshots(snapshots)
      setSelectedCloudSnapshotId(prev => snapshots.some(item => item.id === prev) ? prev : snapshots[0]?.id || '')
      setCloudSnapshotsStatus('ready')
      if (announceResult) {
        setStatusMessage(snapshots.length > 0 ? `已读取 ${snapshots.length} 个云端备份` : '当前账户还没有云端备份')
      }
    } catch (error) {
      if (requestSeq !== cloudSnapshotsRequestSeqRef.current) return
      const message = error instanceof Error ? error.message : '云端备份列表读取失败'
      setCloudSnapshotsStatus('error')
      setCloudSnapshotsError(message)
      if (announceResult) setStatusMessage(message)
    }
  }, [adminApiBaseUrl, authToken, hasCloudMemoryAccess, setStatusMessage])

  useEffect(() => {
    if (!authToken || !hasCloudMemoryAccess) {
      cloudSnapshotsRequestSeqRef.current += 1
      setCloudSnapshots([])
      setSelectedCloudSnapshotId('')
      setCloudSnapshotsStatus('idle')
      setCloudSnapshotsError(null)
      setRecoveryKey('')
      setGeneratedRecoveryKey(null)
      return
    }
    void loadCloudSnapshots(false)
    return () => {
      cloudSnapshotsRequestSeqRef.current += 1
    }
  }, [authToken, hasCloudMemoryAccess, loadCloudSnapshots])

  const handleBackupMemoryPackageToCloud = async () => {
    if (!authToken) {
      setStatusMessage('请先登录账户')
      return
    }
    if (!hasCloudMemoryAccess) {
      setStatusMessage('当前账号无云端记忆包权限')
      return
    }
    setMemoryPackageBusy('cloud-backup')
    setGeneratedRecoveryKey(null)
    try {
      const deviceId = await ensureCloudDevice()
      const result = await backupMemoryPackageToCloud({
        admin_base_url: adminApiBaseUrl,
        access_token: authToken,
        device_id: deviceId,
        recovery_key_base64: recoveryKey.trim() || undefined,
      })
      if (result.generated_recovery_key_base64) {
        setGeneratedRecoveryKey(result.generated_recovery_key_base64)
        setRecoveryKey(result.generated_recovery_key_base64)
      }
      setCloudSnapshots(prev => [result.snapshot, ...prev.filter(item => item.id !== result.snapshot.id)])
      setSelectedCloudSnapshotId(result.snapshot.id)
      setCloudSnapshotsStatus('ready')
      setCloudSnapshotsError(null)
      setStatusMessage(`云端备份完成：${formatBytes(result.encrypted_size)}，校验值 ${result.checksum_sha256.slice(0, 12)}...`)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '云端上传失败')
    } finally {
      setMemoryPackageBusy(null)
    }
  }

  const handleRestoreMemoryPackageFromCloud = async () => {
    if (!authToken) {
      setStatusMessage('请先登录账户')
      return
    }
    if (!selectedCloudSnapshotId) {
      setStatusMessage('请选择云端记忆包')
      return
    }
    if (!recoveryKey.trim()) {
      setStatusMessage('请输入恢复密钥')
      return
    }
    setMemoryPackageBusy('cloud-restore')
    setLastImportReport(null)
    try {
      const result = await restoreMemoryPackageFromCloud({
        admin_base_url: adminApiBaseUrl,
        access_token: authToken,
        snapshot_id: selectedCloudSnapshotId,
        recovery_key_base64: recoveryKey.trim(),
        import_to_local: true,
        dry_run: false,
      })
      setLastImportReport(result.import_report ?? null)
      setStatusMessage(result.import_report
        ? `云端下载并导入完成：${summarizeImportReport(result.import_report)}`
        : '云端记忆包已下载')
      setBakeMemoryOffset(0)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '云端下载失败')
    } finally {
      setMemoryPackageBusy(null)
    }
  }

  return (
    <section className="bake-memory-backup-section" aria-label="记忆备份">
      {statusNotice && (
        <div className="bake-inline-message bake-memory-backup-status" role="status">
          <span>{statusNotice.message}</span>
          {statusNotice.exportPath && (
            <BakeButton compact onClick={() => void handleOpenExportFolder()}>
              <FolderOpen size={14} aria-hidden />
              打开文件夹
            </BakeButton>
          )}
        </div>
      )}
      <MemoryBackupCard
        accessState={cloudBackupAccessState}
        busy={memoryPackageBusy}
        cloudSnapshots={cloudSnapshots}
        cloudSnapshotsStatus={cloudSnapshotsStatus}
        cloudSnapshotsError={cloudSnapshotsError}
        selectedCloudSnapshotId={selectedCloudSnapshotId}
        recoveryKey={recoveryKey}
        generatedRecoveryKey={generatedRecoveryKey}
        lastImportReport={lastImportReport}
        importFileInputRef={importFileInputRef}
        onExport={() => void handleExportMemoryPackage()}
        onImportClick={() => importFileInputRef.current?.click()}
        onImportFile={(file) => void handleImportMemoryPackageFile(file)}
        onOpenAccount={() => setWindowMode('account')}
        onRecoveryKeyChange={setRecoveryKey}
        onCloudSnapshotChange={setSelectedCloudSnapshotId}
        onRefreshCloudSnapshots={() => void loadCloudSnapshots(true)}
        onBackupToCloud={() => void handleBackupMemoryPackageToCloud()}
        onRestoreFromCloud={() => void handleRestoreMemoryPackageFromCloud()}
      />
    </section>
  )
}

export default MemoryBackupSection
