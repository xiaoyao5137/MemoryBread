import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, HardDriveDownload, LockKeyhole, LogIn, ShieldCheck } from 'lucide-react'
import {
  useBackupMemoryPackageToCloud,
  useExportMemoryPackage,
  useFetchBakeMemory,
  useFetchBakeMemories,
  useFetchBakeCaptureDetail,
  useFetchBakeCaptures,
  useFetchBakeKnowledge,
  useFetchBakeKnowledgeDetail,
  useFetchBakeSop,
  useFetchBakeSops,
  useFetchBakeTemplates,
  useFetchCaptures,
  useImportMemoryPackage,
  useRestoreMemoryPackageFromCloud,
} from '../hooks/useApi'
import { useAppStore, type BakeNavigationTarget } from '../store/useAppStore'
import type {
  ArticleTemplate,
  BakeCaptureItem,
  BakeKnowledgeItem,
  CaptureRecord,
  CloudSnapshot,
  MemoryPackageImportReport,
  RepositoryTab,
  SopCandidate,
  TimelineItem,
} from '../types'
import { fetchCloudSnapshots, upsertCloudDevice } from '../utils/authApi'
import BakeCaptureTab, { parseDateInputToMs } from './bake/BakeCaptureTab'
import BakeHeader from './bake/BakeHeader'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './bake/BakeShared'
import './bake/BakePanel.css'

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

const formatMemoryTime = (item: Pick<TimelineItem, 'createdAt' | 'createdAtMs'>) => {
  if (item.createdAtMs > 0) {
    return new Date(item.createdAtMs).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }
  return item.createdAt || '创建时间未知'
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

const RepositoryPanel: React.FC = () => {
  const {
    repositoryTab,
    selectedMemoryId,
    selectedCaptureId,
    bakeMemoryOffset,
    bakeCaptureOffset,
    repositoryMemoryQuery,
    repositoryMemoryFrom,
    repositoryMemoryTo,
    repositoryMemoryLimit,
    repositoryCaptureQuery,
    repositoryCaptureFrom,
    repositoryCaptureTo,
    repositoryCaptureLimit,
    repositoryCaptureSourceCaptureId,
    repositoryMemoryFocusId,
    selectedTemplateId,
    selectedSopId,
    selectedKnowledgeId,
    setWindowMode,
    setBakeTab,
    setRepositoryTab,
    setSelectedMemoryId,
    setSelectedKnowledgeId,
    setSelectedTemplateId,
    setSelectedSopId,
    setSelectedCaptureId,
    setRepositoryMemoryFocusId,
    setBakeTemplateFocusId,
    setBakeKnowledgeFocusId,
    setBakeSopFocusId,
    setBakeMemoryOffset,
    setBakeCaptureOffset,
    setRepositoryMemoryLimit,
    setRepositoryCaptureLimit,
    setRepositoryCaptureSourceCaptureId,
    captureBackTarget,
    bakeNavigationStack,
    adminApiBaseUrl,
    authToken,
    currentUser,
    accountType,
    cloudSubscription,
    sidecarVersion,
    pushBakeNavigationTarget,
    popBakeNavigationTarget,
    clearBakeNavigationStack,
  } = useAppStore()

  const fetchMemories = useFetchBakeMemories()
  const fetchMemory = useFetchBakeMemory()
  const fetchCaptures = useFetchBakeCaptures()
  const fetchCaptureDetail = useFetchBakeCaptureDetail()
  const fetchCapturesRaw = useFetchCaptures()
  const fetchTemplates = useFetchBakeTemplates()
  const fetchKnowledge = useFetchBakeKnowledge()
  const fetchKnowledgeDetail = useFetchBakeKnowledgeDetail()
  const fetchSops = useFetchBakeSops()
  const fetchSop = useFetchBakeSop()
  const exportMemoryPackage = useExportMemoryPackage()
  const importMemoryPackage = useImportMemoryPackage()
  const backupMemoryPackageToCloud = useBackupMemoryPackageToCloud()
  const restoreMemoryPackageFromCloud = useRestoreMemoryPackageFromCloud()

  const [memories, setMemories] = useState<TimelineItem[]>([])
  const [memoryTotal, setMemoryTotal] = useState(0)
  const [captureItems, setCaptureItems] = useState<BakeCaptureItem[]>([])
  const [captureTotal, setCaptureTotal] = useState(0)
  const [captureDetail, setCaptureDetail] = useState<BakeCaptureItem | null>(null)
  const [memoryCaptures, setMemoryCaptures] = useState<CaptureRecord[]>([])
  const [selectedMemoryRelations, setSelectedMemoryRelations] = useState<{
    document: ArticleTemplate | null
    knowledge: BakeKnowledgeItem | null
    sop: SopCandidate | null
    loading: boolean
  }>({ document: null, knowledge: null, sop: null, loading: false })
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [memoryPageInput, setMemoryPageInput] = useState('')
  const [draftMemoryQuery, setDraftMemoryQuery] = useState(repositoryMemoryQuery)
  const [draftMemoryFrom, setDraftMemoryFrom] = useState(repositoryMemoryFrom)
  const [draftMemoryTo, setDraftMemoryTo] = useState(repositoryMemoryTo)
  const [draftCaptureQuery, setDraftCaptureQuery] = useState(repositoryCaptureQuery)
  const [draftCaptureFrom, setDraftCaptureFrom] = useState(repositoryCaptureFrom)
  const [draftCaptureTo, setDraftCaptureTo] = useState(repositoryCaptureTo)
  const [memoryPackageBusy, setMemoryPackageBusy] = useState<MemoryPackageBusy>(null)
  const [cloudSnapshots, setCloudSnapshots] = useState<CloudSnapshot[]>([])
  const [cloudSnapshotsStatus, setCloudSnapshotsStatus] = useState<CloudSnapshotsStatus>('idle')
  const [cloudSnapshotsError, setCloudSnapshotsError] = useState<string | null>(null)
  const [selectedCloudSnapshotId, setSelectedCloudSnapshotId] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(null)
  const [lastImportReport, setLastImportReport] = useState<MemoryPackageImportReport | null>(null)
  const memoryRequestSeqRef = useRef(0)
  const captureRequestSeqRef = useRef(0)
  const cloudSnapshotsRequestSeqRef = useRef(0)
  const importFileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (repositoryTab !== 'memory') return
    if (repositoryMemoryFocusId) {
      const requestSeq = memoryRequestSeqRef.current + 1
      memoryRequestSeqRef.current = requestSeq
      void fetchMemory(repositoryMemoryFocusId).then((item) => {
        if (requestSeq !== memoryRequestSeqRef.current) return
        setMemories([item])
        setMemoryTotal(1)
        setSelectedMemoryId(item.id)
      }).catch((error) => {
        if (requestSeq !== memoryRequestSeqRef.current) return
        setMemories([])
        setMemoryTotal(0)
        setStatusMessage(error instanceof Error ? error.message : `未找到时间线 #${repositoryMemoryFocusId}`)
      })
      return
    }
    const requestSeq = memoryRequestSeqRef.current + 1
    memoryRequestSeqRef.current = requestSeq
    void fetchMemories({
      q: repositoryMemoryQuery.trim() || undefined,
      from: parseDateInputToMs(repositoryMemoryFrom),
      to: parseDateInputToMs(repositoryMemoryTo, true),
      limit: repositoryMemoryLimit,
      offset: bakeMemoryOffset,
    }).then((data) => {
      if (requestSeq !== memoryRequestSeqRef.current) return
      setMemories(data.items)
      setMemoryTotal(data.total)
    }).catch((error) => {
      if (requestSeq !== memoryRequestSeqRef.current) return
      setStatusMessage(error instanceof Error ? error.message : '时间线加载失败')
    })
  }, [
    bakeMemoryOffset,
    fetchMemories,
    fetchMemory,
    repositoryMemoryFocusId,
    repositoryMemoryFrom,
    repositoryMemoryLimit,
    repositoryMemoryQuery,
    repositoryMemoryTo,
    repositoryTab,
    setSelectedMemoryId,
  ])

  useEffect(() => {
    if (repositoryTab !== 'capture') return
    const requestSeq = captureRequestSeqRef.current + 1
    captureRequestSeqRef.current = requestSeq
    void fetchCaptures({
      q: repositoryCaptureQuery.trim() || undefined,
      from: parseDateInputToMs(repositoryCaptureFrom),
      to: parseDateInputToMs(repositoryCaptureTo, true),
      source_capture_id: repositoryCaptureSourceCaptureId ? Number(repositoryCaptureSourceCaptureId) : undefined,
      limit: repositoryCaptureLimit,
      offset: bakeCaptureOffset,
    }).then((data) => {
      if (requestSeq !== captureRequestSeqRef.current) return
      setCaptureItems(data.items)
      setCaptureTotal(data.total)
    }).catch((error) => {
      if (requestSeq !== captureRequestSeqRef.current) return
      setStatusMessage(error instanceof Error ? error.message : '采集记录加载失败')
    })
  }, [
    bakeCaptureOffset,
    fetchCaptures,
    repositoryCaptureFrom,
    repositoryCaptureLimit,
    repositoryCaptureQuery,
    repositoryCaptureSourceCaptureId,
    repositoryCaptureTo,
    repositoryTab,
  ])

  useEffect(() => {
    if (repositoryTab !== 'capture' || !selectedCaptureId) {
      setCaptureDetail(null)
      return
    }
    void fetchCaptureDetail(selectedCaptureId).then(setCaptureDetail).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : '采集记录详情加载失败')
    })
  }, [fetchCaptureDetail, repositoryTab, selectedCaptureId])

  useEffect(() => {
    if (!statusMessage) return
    const timer = window.setTimeout(() => setStatusMessage(null), 2400)
    return () => window.clearTimeout(timer)
  }, [statusMessage])

  useEffect(() => {
    setDraftMemoryQuery(repositoryMemoryQuery)
    setDraftMemoryFrom(repositoryMemoryFrom)
    setDraftMemoryTo(repositoryMemoryTo)
  }, [repositoryMemoryFrom, repositoryMemoryQuery, repositoryMemoryTo])

  useEffect(() => {
    setDraftCaptureQuery(repositoryCaptureQuery)
    setDraftCaptureFrom(repositoryCaptureFrom)
    setDraftCaptureTo(repositoryCaptureTo)
  }, [repositoryCaptureFrom, repositoryCaptureQuery, repositoryCaptureTo])

  const resolvedMemoryId = selectedMemoryId ?? memories[0]?.id ?? null
  const resolvedCaptureId = selectedCaptureId ?? captureItems[0]?.id ?? null
  const selectedMemory = memories.find(item => item.id === resolvedMemoryId) ?? (selectedMemoryId ? null : memories[0] ?? null)

  useEffect(() => {
    if (repositoryTab !== 'memory') return
    if (memories.length === 0) return
    if (!selectedMemoryId) {
      setSelectedMemoryId(memories[0].id)
    }
  }, [memories, repositoryTab, selectedMemoryId, setSelectedMemoryId])

  useEffect(() => {
    if (repositoryTab !== 'memory' || !resolvedMemoryId) {
      setSelectedMemoryRelations({ document: null, knowledge: null, sop: null, loading: false })
      return
    }

    let cancelled = false
    setSelectedMemoryRelations(prev => ({ ...prev, loading: true }))
    void Promise.all([
      fetchTemplates({ limit: 1000 }),
      fetchKnowledge({ limit: 1000 }),
      fetchSops({ limit: 1000 }),
    ]).then(([templateData, knowledgeData, sopData]) => {
      if (cancelled) return
      setSelectedMemoryRelations({
        document: templateData.items.find(template => template.sourceMemoryIds.includes(resolvedMemoryId)) ?? null,
        knowledge: knowledgeData.items.find(item => item.sourceTimelineId === resolvedMemoryId) ?? null,
        sop: sopData.items.find(item => item.sourceTimelineId === resolvedMemoryId) ?? null,
        loading: false,
      })
    }).catch(() => {
      if (!cancelled) {
        setSelectedMemoryRelations({ document: null, knowledge: null, sop: null, loading: false })
      }
    })

    return () => {
      cancelled = true
    }
  }, [fetchKnowledge, fetchSops, fetchTemplates, repositoryTab, resolvedMemoryId])

  useEffect(() => {
    if (repositoryTab !== 'capture') return
    if (captureItems.length === 0) {
      setSelectedCaptureId(null)
      setCaptureDetail(null)
      return
    }
    if (!selectedCaptureId || !captureItems.some(item => item.id === selectedCaptureId)) {
      setSelectedCaptureId(captureItems[0].id)
    }
  }, [captureItems, repositoryTab, selectedCaptureId, setSelectedCaptureId])

  useEffect(() => {
    const memory = memories.find(m => m.id === selectedMemoryId)
    if (!memory?.captureIds || memory.captureIds.length === 0) {
      setMemoryCaptures([])
      return
    }
    void fetchCapturesRaw({ ids: memory.captureIds.join(','), limit: 500 }).then(data => {
      setMemoryCaptures(data.captures.sort((a, b) => a.ts - b.ts))
    }).catch(() => setMemoryCaptures([]))
  }, [selectedMemoryId, memories, fetchCapturesRaw])

  const memoryPage = Math.floor(bakeMemoryOffset / repositoryMemoryLimit) + 1
  const memoryTotalPages = Math.max(1, Math.ceil(memoryTotal / repositoryMemoryLimit))
  const memoryFilterPills = useMemo(() => {
    const pills: string[] = []
    if (repositoryMemoryFocusId) pills.push(`仅看时间线 #${repositoryMemoryFocusId}`)
    if (repositoryMemoryFrom) pills.push(`开始：${repositoryMemoryFrom}`)
    if (repositoryMemoryTo) pills.push(`结束：${repositoryMemoryTo}`)
    return pills
  }, [repositoryMemoryFocusId, repositoryMemoryFrom, repositoryMemoryTo])

  const handleSearchMemories = () => {
    clearBakeNavigationStack()
    setSelectedMemoryId(null)
    setRepositoryMemoryFocusId(null)
    useAppStore.setState({
      repositoryMemoryFocusId: null,
      repositoryMemoryQuery: draftMemoryQuery,
      repositoryMemoryFrom: draftMemoryFrom,
      repositoryMemoryTo: draftMemoryTo,
      bakeMemoryOffset: 0,
    })
  }

  const handleClearMemoryFilters = () => {
    clearBakeNavigationStack()
    setDraftMemoryQuery('')
    setDraftMemoryFrom('')
    setDraftMemoryTo('')
    setSelectedMemoryId(null)
    useAppStore.setState({
      repositoryMemoryFocusId: null,
      repositoryMemoryQuery: '',
      repositoryMemoryFrom: '',
      repositoryMemoryTo: '',
      bakeMemoryOffset: 0,
    })
  }

  const handleSearchCaptures = () => {
    clearBakeNavigationStack()
    setSelectedCaptureId(null)
    setCaptureDetail(null)
    useAppStore.setState({
      repositoryCaptureQuery: draftCaptureQuery,
      repositoryCaptureFrom: draftCaptureFrom,
      repositoryCaptureTo: draftCaptureTo,
      bakeCaptureOffset: 0,
    })
  }

  const handleClearCaptureFilters = () => {
    clearBakeNavigationStack()
    setDraftCaptureQuery('')
    setDraftCaptureFrom('')
    setDraftCaptureTo('')
    useAppStore.setState({
      repositoryCaptureQuery: '',
      repositoryCaptureFrom: '',
      repositoryCaptureTo: '',
      repositoryCaptureSourceCaptureId: null,
      bakeCaptureOffset: 0,
    })
  }

  const handleRepositoryTabChange = (tab: RepositoryTab) => {
    if (tab === repositoryTab) return
    clearBakeNavigationStack()
    setRepositoryTab(tab)
  }

  const currentNavigationTarget = () => ({
    windowMode: 'knowledge' as const,
    repositoryTab,
    selectedMemoryId: resolvedMemoryId,
    selectedCaptureId: resolvedCaptureId,
    selectedTemplateId,
    selectedSopId,
    selectedKnowledgeId,
    repositoryCaptureSourceCaptureId,
    repositoryMemoryFocusId,
  })

  const restoreNavigationTarget = (target: BakeNavigationTarget) => {
    setWindowMode(target.windowMode)
    if (target.bakeTab) setBakeTab(target.bakeTab)
    if (target.repositoryTab) setRepositoryTab(target.repositoryTab)
    if (target.selectedMemoryId !== undefined) setSelectedMemoryId(target.selectedMemoryId)
    if (target.selectedTemplateId !== undefined) setSelectedTemplateId(target.selectedTemplateId)
    if (target.selectedSopId !== undefined) setSelectedSopId(target.selectedSopId)
    if (target.selectedKnowledgeId !== undefined) setSelectedKnowledgeId(target.selectedKnowledgeId)
    if (target.selectedCaptureId !== undefined) setSelectedCaptureId(target.selectedCaptureId)
    if (target.repositoryMemoryFocusId !== undefined) setRepositoryMemoryFocusId(target.repositoryMemoryFocusId)
    if (target.bakeTemplateFocusId !== undefined) setBakeTemplateFocusId(target.bakeTemplateFocusId)
    if (target.bakeKnowledgeFocusId !== undefined) setBakeKnowledgeFocusId(target.bakeKnowledgeFocusId)
    if (target.bakeSopFocusId !== undefined) setBakeSopFocusId(target.bakeSopFocusId)
    if (target.repositoryCaptureSourceCaptureId !== undefined) {
      setRepositoryCaptureSourceCaptureId(target.repositoryCaptureSourceCaptureId)
    }
  }

  const handleViewLinkedKnowledge = (knowledgeId?: string | null) => {
    if (!knowledgeId) {
      setStatusMessage('当前时间线尚未提炼出 bake 知识')
      return
    }
    pushBakeNavigationTarget(currentNavigationTarget())
    setWindowMode('bake')
    setBakeTab('knowledge')
    setBakeKnowledgeFocusId(knowledgeId)
    setSelectedKnowledgeId(knowledgeId)
    setStatusMessage('已切换到关联知识')
  }

  const handleViewRelatedDocument = async (timelineId: string) => {
    try {
      const { items: templates } = await fetchTemplates({ limit: 1000 })
      const relatedDoc = templates.find(template => template.sourceMemoryIds.includes(timelineId))
      if (!relatedDoc) {
        setStatusMessage('当前时间线还没有关联文档')
        return
      }
      pushBakeNavigationTarget(currentNavigationTarget())
      setWindowMode('bake')
      setBakeTab('templates')
      setBakeTemplateFocusId(relatedDoc.id)
      setSelectedTemplateId(relatedDoc.id)
      setStatusMessage(`已切换到关联文档「${relatedDoc.title}」`)
    } catch (error) {
      setStatusMessage('查询关联文档失败')
    }
  }

  const handleViewRelatedKnowledge = async (timelineId: string) => {
    try {
      const { items: knowledgeItems } = await fetchKnowledge({ limit: 1000 })
      const relatedKnowledge = knowledgeItems.find(item => item.sourceTimelineId === timelineId)
      if (!relatedKnowledge) {
        setStatusMessage('当前时间线还没有关联知识')
        return
      }
      const focusedKnowledge = await fetchKnowledgeDetail(relatedKnowledge.id).catch(() => relatedKnowledge)
      pushBakeNavigationTarget(currentNavigationTarget())
      setWindowMode('bake')
      setBakeTab('knowledge')
      setBakeKnowledgeFocusId(focusedKnowledge.id)
      setSelectedKnowledgeId(focusedKnowledge.id)
      setStatusMessage(`已切换到关联知识「${focusedKnowledge.summary}」`)
    } catch {
      setStatusMessage('查询关联知识失败')
    }
  }

  const handleViewRelatedSop = async (timelineId: string) => {
    try {
      const { items: sops } = await fetchSops({ limit: 1000 })
      const relatedSop = sops.find(item => item.sourceTimelineId === timelineId)
      if (!relatedSop) {
        setStatusMessage('当前时间线还没有关联操作')
        return
      }
      const focusedSop = await fetchSop(relatedSop.id).catch(() => relatedSop)
      pushBakeNavigationTarget(currentNavigationTarget())
      setWindowMode('bake')
      setBakeTab('sop')
      setBakeSopFocusId(focusedSop.id)
      setSelectedSopId(focusedSop.id)
      setStatusMessage(`已切换到关联操作「${focusedSop.extractedProblem || focusedSop.sourceTitle || focusedSop.id}」`)
    } catch {
      setStatusMessage('查询关联操作失败')
    }
  }

  const handleViewLinkedTimeline = (timelineId?: string | null) => {
    if (!timelineId) {
      setStatusMessage('该采集尚未归入任何时间线')
      return
    }
    pushBakeNavigationTarget(currentNavigationTarget())
    setWindowMode('knowledge')
    setRepositoryTab('memory')
    setRepositoryMemoryFocusId(timelineId)
    setSelectedMemoryId(timelineId)
    setStatusMessage('已切换到所属时间线')
  }

  const handleCaptureGoBack = () => {
    if (!captureBackTarget) {
      setStatusMessage('当前没有可返回的上一步页面')
      return
    }

    const target = popBakeNavigationTarget()
    if (!target) return
    restoreNavigationTarget(target)
    setStatusMessage('已返回上一步页面')
  }

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
      setStatusMessage(`记忆包已保存：${result.path}（${formatBytes(result.file_size_bytes)}，${tables || '暂无数据'}）`)
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
  }, [adminApiBaseUrl, authToken, hasCloudMemoryAccess])

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

  const tabs: Array<{ key: RepositoryTab; label: string }> = [
    { key: 'memory', label: '时间线' },
    { key: 'capture', label: '采集记录' },
  ]

  return (
    <div className="bake-panel bake-panel--repository">
      <BakeHeader title="采集" subtitle="" />
      {bakeNavigationStack.length > 0 && (
        <div className="bake-backbar">
          <span>可以返回上一步页面</span>
          <BakeButton compact onClick={handleCaptureGoBack}>返回上一步</BakeButton>
        </div>
      )}
      {statusMessage && <div className="bake-inline-message">{statusMessage}</div>}
      <section className="bake-tabs bake-tabs--scroll">
        {tabs.map(tab => (
          <BakeButton key={tab.key} active={repositoryTab === tab.key} onClick={() => handleRepositoryTabChange(tab.key)}>
            {tab.label}
          </BakeButton>
        ))}
      </section>

      {repositoryTab === 'memory' && (
        <>
          <form
            className="bake-list-toolbar bake-list-toolbar--repository"
            onSubmit={(event) => {
              event.preventDefault()
              handleSearchMemories()
            }}
          >
            <div className="bake-list-toolbar__repository">
              <div className="bake-list-toolbar__repository-row bake-list-toolbar__repository-row--search">
                <label className="bake-form-field bake-filter-field bake-filter-field--search">
                  <span className="bake-filter-label">关键词</span>
                  <input
                    className="bake-input"
                    value={draftMemoryQuery}
                    onChange={(event) => setDraftMemoryQuery(event.target.value)}
                    placeholder="搜索时间线标题、摘要或详情"
                  />
                </label>
                <div className="bake-list-toolbar__repository-actions bake-list-toolbar__repository-actions--search">
                  <BakeButton compact primary type="submit">搜索</BakeButton>
                </div>
              </div>
              <div className="bake-list-toolbar__repository-row bake-list-toolbar__repository-row--dates">
                <label className="bake-form-field bake-filter-field">
                  <span className="bake-filter-label">开始日期</span>
                  <input
                    className="bake-input"
                    type="date"
                    value={draftMemoryFrom}
                    onChange={(event) => setDraftMemoryFrom(event.target.value)}
                  />
                </label>
                <label className="bake-form-field bake-filter-field">
                  <span className="bake-filter-label">结束日期</span>
                  <input
                    className="bake-input"
                    type="date"
                    value={draftMemoryTo}
                    onChange={(event) => setDraftMemoryTo(event.target.value)}
                  />
                </label>
                <div className="bake-list-toolbar__repository-actions bake-list-toolbar__repository-actions--secondary">
                  {(draftMemoryQuery || draftMemoryFrom || draftMemoryTo || repositoryMemoryQuery || repositoryMemoryFrom || repositoryMemoryTo || repositoryMemoryFocusId) && (
                    <BakeButton compact onClick={handleClearMemoryFilters}>清除筛选</BakeButton>
                  )}
                </div>
              </div>
            </div>
          </form>

          {memoryFilterPills.length > 0 && (
            <div className="bake-filter-summary">
              {memoryFilterPills.map(item => <BakePill key={item} text={item} />)}
              {repositoryMemoryFocusId && <BakeButton compact onClick={handleClearMemoryFilters}>查看全部</BakeButton>}
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
        </>
      )}

      <div className="bake-tab-content">
        {repositoryTab === 'memory' && (
          <div className="bake-split-list-detail bake-split-list-detail--memories-fixed">
            <BakeCard className="bake-memory-list-card bake-memory-list-card--fixed">
              <BakeSectionHeader
                title="时间线"
              />

              {memories.length === 0 ? (
                <div className="bake-muted">当前筛选条件下没有可浏览的时间线。</div>
              ) : (
                <>
                  <div className="bake-list bake-memory-list bake-memory-list--paged">
                    {memories.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedMemoryId(item.id)}
                        className={`bake-list-item bake-memory-list-item bake-memory-list-item--compact ${item.id === selectedMemory?.id ? 'bake-list-item--active' : ''}`.trim()}
                      >
                        <div className="bake-list-item__title bake-line-clamp-1">{item.title}</div>
                        <div className="bake-muted bake-line-clamp-2">{item.summary || '暂无摘要'}</div>
                        <div className="bake-memory-list-item__meta">
                          <span>创建于 {formatMemoryTime(item)}</span>
                          <span>权重 {item.weight}</span>
                          <span>打开 {item.openCount} 次</span>
                          <span>停留 {item.dwellSeconds}s</span>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="bake-pagination bake-pagination--extended">
                    <div className="bake-pagination__controls">
                      <BakeButton compact onClick={() => setBakeMemoryOffset(Math.max(0, bakeMemoryOffset - repositoryMemoryLimit))}>上一页</BakeButton>
                      <BakeButton compact onClick={() => setBakeMemoryOffset(bakeMemoryOffset + repositoryMemoryLimit)}>
                        {bakeMemoryOffset + repositoryMemoryLimit >= memoryTotal ? '已到底' : '下一页'}
                      </BakeButton>
                    </div>
                    <div className="bake-pagination__summary-group bake-muted">
                      <span className="bake-pagination__summary">共 {memoryTotal} 条</span>
                      <span className="bake-pagination__summary">第 {memoryPage}/{memoryTotalPages} 页</span>
                    </div>
                    <div className="bake-pagination__right">
                      <label className="bake-pagination__field">
                        <span className="bake-muted">每页</span>
                        <select
                          className="bake-input bake-pagination__select"
                          value={String(repositoryMemoryLimit)}
                          onChange={(event) => setRepositoryMemoryLimit(Number(event.target.value))}
                        >
                          {[10, 20, 50, 100].map(option => (
                            <option key={option} value={option}>{option} 条</option>
                          ))}
                        </select>
                      </label>
                      <div className="bake-pagination__jump">
                        <span className="bake-muted">第</span>
                        <input
                          className="bake-input bake-pagination__input"
                          type="number"
                          min={1}
                          max={memoryTotalPages}
                          value={memoryPageInput}
                          onChange={(event) => setMemoryPageInput(event.target.value)}
                          placeholder={String(memoryPage)}
                        />
                        <span className="bake-muted">页</span>
                        <BakeButton
                          compact
                          onClick={() => {
                            const target = Number(memoryPageInput)
                            if (!Number.isFinite(target) || target < 1) return
                            const nextPage = Math.min(memoryTotalPages, Math.floor(target))
                            setBakeMemoryOffset((nextPage - 1) * repositoryMemoryLimit)
                            setMemoryPageInput('')
                          }}
                        >
                          前往
                        </BakeButton>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </BakeCard>

            <BakeCard className="bake-memory-detail-card bake-memory-detail-card--stacked">
              {selectedMemory ? (
                <div className="bake-memory-detail bake-memory-detail--fixed">
                  <div className="bake-memory-detail__header-block">
                    <div className="bake-inline-meta">
                      <div style={{ minWidth: 0 }}>
                        <div className="bake-title" style={{ fontSize: 20, lineHeight: 1.4 }}>{selectedMemory.title}</div>
                        <div className="bake-muted bake-line-clamp-1" style={{ marginTop: 6 }}>{selectedMemory.url || `时间线 #${selectedMemory.id || '暂无编号'}`}</div>
                      </div>
                    </div>
                    <div className="bake-memory-detail__stats">
                      <span className="bake-stat-chip">创建于 {formatMemoryTime(selectedMemory)}</span>
                      <span className="bake-stat-chip">权重 {selectedMemory.weight}</span>
                      <span className="bake-stat-chip">打开 {selectedMemory.openCount} 次</span>
                      <span className="bake-stat-chip">停留 {selectedMemory.dwellSeconds}s</span>
                      <span className="bake-stat-chip">重复观察 {selectedMemory.knowledgeRefCount} 次</span>
                    </div>
                  </div>

                  <div className="bake-memory-action-card">
                    <div className="bake-kv__title">时间线摘要</div>
                    <div className="bake-muted" style={{ lineHeight: 1.8 }}>{selectedMemory.summary || '暂无摘要'}</div>
                  </div>

                  {memoryCaptures.length > 0 && (() => {
                    const minTs = memoryCaptures[0].ts
                    const maxTs = memoryCaptures[memoryCaptures.length - 1].ts
                    const minDate = new Date(minTs)
                    const maxDate = new Date(maxTs)
                    const timeRange = `${minDate.getMonth() + 1}月${minDate.getDate()}日 ${minDate.getHours()}:${String(minDate.getMinutes()).padStart(2, '0')}-${maxDate.getHours()}:${String(maxDate.getMinutes()).padStart(2, '0')}`

                    const segments = selectedMemory.keyTimestamps || []
                    const items = segments.length > 0 ? segments.map(seg => {
                      const minDate = new Date(seg.start_ts)
                      const maxDate = new Date(seg.end_ts)
                      const itemTimeRange = seg.start_ts === seg.end_ts
                        ? `${minDate.getHours()}:${String(minDate.getMinutes()).padStart(2, '0')}`
                        : `${minDate.getHours()}:${String(minDate.getMinutes()).padStart(2, '0')}-${maxDate.getHours()}:${String(maxDate.getMinutes()).padStart(2, '0')}`
                      return {
                        ids: seg.capture_ids,
                        itemTimeRange,
                        summary: seg.summary
                      }
                    }) : (() => {
                      const itemMap = new Map<string, { ids: number[]; captures: CaptureRecord[] }>()
                      memoryCaptures.forEach(cap => {
                        const key = `${cap.app_name}|${cap.win_title || ''}`
                        if (!itemMap.has(key)) {
                          itemMap.set(key, { ids: [], captures: [] })
                        }
                        const item = itemMap.get(key)!
                        item.ids.push(cap.id)
                        item.captures.push(cap)
                      })
                      return Array.from(itemMap.values()).map(item => {
                        const minTs = Math.min(...item.captures.map(c => c.ts))
                        const maxTs = Math.max(...item.captures.map(c => c.ts))
                        const minDate = new Date(minTs)
                        const maxDate = new Date(maxTs)
                        const itemTimeRange = minTs === maxTs
                          ? `${minDate.getHours()}:${String(minDate.getMinutes()).padStart(2, '0')}`
                          : `${minDate.getHours()}:${String(minDate.getMinutes()).padStart(2, '0')}-${maxDate.getHours()}:${String(maxDate.getMinutes()).padStart(2, '0')}`
                        const text = item.captures.map(c => c.ocr_text || c.ax_text || '').join(' ').trim()
                        const summary = text.slice(0, 60) + (text.length > 60 ? '...' : '')
                        return { ids: item.ids, itemTimeRange, summary: summary || `${item.captures[0].app_name}活动` }
                      })
                    })()

                    return (
                      <div className="bake-memory-action-card">
                        <div className="bake-kv__title">详细内容</div>
                        <div style={{ marginTop: 12 }}>
                          <div style={{ fontWeight: 600, marginBottom: 12, color: '#333' }}>{timeRange}</div>
                          <div style={{ paddingLeft: 12, borderLeft: '2px solid #e0e0e0' }}>
                            {items.map((item, idx) => (
                              <div key={idx} style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.6 }}>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600, color: '#666', marginRight: 8 }}>{item.itemTimeRange}</span>
                                  <span>{item.summary}</span>
                                </div>
                                <div>
                                  {item.ids.map((id, i) => (
                                    <span key={id}>
                                      <a
                                        href="#"
                                        onClick={(e) => {
                                          e.preventDefault()
                                          pushBakeNavigationTarget({
                                            windowMode: 'knowledge',
                                            repositoryTab: 'memory',
                                            selectedMemoryId: selectedMemory.id,
                                          })
                                          setRepositoryTab('capture')
                                          setRepositoryCaptureSourceCaptureId(String(id))
                                          setSelectedCaptureId(String(id))
                                          setStatusMessage(`已切换到采集记录 #${id}`)
                                        }}
                                        style={{ color: '#0066cc', textDecoration: 'none', fontSize: 12 }}
                                      >
                                        #{id}
                                      </a>
                                      {i < item.ids.length - 1 && ', '}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )
                  })()}

                  <div className="bake-memory-action-card bake-memory-action-card--secondary">
                    <div>
                      <div className="bake-kv__title">回溯</div>
                    </div>
                    <div className="bake-actions bake-actions--secondary bake-memory-detail__action-copy">
                      <BakeButton compact onClick={() => {
                        if (!selectedMemory.sourceCaptureId) {
                          setStatusMessage('当前时间线暂无来源采集记录')
                          return
                        }
                        pushBakeNavigationTarget({
                          windowMode: 'knowledge',
                          repositoryTab: 'memory',
                          selectedMemoryId: selectedMemory.id,
                        })
                        setRepositoryTab('capture')
                        setRepositoryCaptureSourceCaptureId(selectedMemory.sourceCaptureId)
                        setSelectedCaptureId(selectedMemory.sourceCaptureId)
                        setStatusMessage('已切换到来源采集记录')
                      }}>来源采集记录</BakeButton>
                      <BakeButton compact onClick={() => handleViewRelatedDocument(selectedMemory.id)}>关联文档</BakeButton>
                      <BakeButton compact onClick={() => handleViewRelatedKnowledge(selectedMemory.id)}>关联知识</BakeButton>
                      <BakeButton compact onClick={() => handleViewRelatedSop(selectedMemory.id)}>关联操作</BakeButton>
                    </div>
                    <div className="bake-related-summary">
                      <div className="bake-related-row">
                        <span className="bake-related-row__label">来源采集记录</span>
                        <span className="bake-related-row__value">{selectedMemory.sourceCaptureId ? `采集记录 #${selectedMemory.sourceCaptureId}` : '暂无'}</span>
                      </div>
                      <div className="bake-related-row">
                        <span className="bake-related-row__label">关联文档</span>
                        <span className="bake-related-row__value">
                          {selectedMemoryRelations.loading ? '查询中...' : selectedMemoryRelations.document?.title ?? '暂无'}
                        </span>
                      </div>
                      <div className="bake-related-row">
                        <span className="bake-related-row__label">关联知识</span>
                        <span className="bake-related-row__value">
                          {selectedMemoryRelations.loading ? '查询中...' : selectedMemoryRelations.knowledge?.summary ?? '暂无'}
                        </span>
                      </div>
                      <div className="bake-related-row">
                        <span className="bake-related-row__label">关联操作</span>
                        <span className="bake-related-row__value">
                          {selectedMemoryRelations.loading
                            ? '查询中...'
                            : selectedMemoryRelations.sop?.extractedProblem || selectedMemoryRelations.sop?.sourceTitle || '暂无'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bake-muted">暂无时间线详情</div>
              )}
            </BakeCard>
          </div>
        )}
        {repositoryTab === 'capture' && (
          <BakeCaptureTab
            captures={captureItems}
            total={captureTotal}
            limit={repositoryCaptureLimit}
            offset={bakeCaptureOffset}
            query={repositoryCaptureQuery}
            from={repositoryCaptureFrom}
            to={repositoryCaptureTo}
            draftQuery={draftCaptureQuery}
            draftFrom={draftCaptureFrom}
            draftTo={draftCaptureTo}
            sourceCaptureId={repositoryCaptureSourceCaptureId}
            selectedCaptureId={resolvedCaptureId}
            selectedCaptureDetail={captureDetail}
            onSelectCapture={setSelectedCaptureId}
            onPageChange={setBakeCaptureOffset}
            onLimitChange={setRepositoryCaptureLimit}
            onDraftQueryChange={setDraftCaptureQuery}
            onDraftFromChange={setDraftCaptureFrom}
            onDraftToChange={setDraftCaptureTo}
            onSearch={handleSearchCaptures}
            onClearFilters={handleClearCaptureFilters}
            onClearScope={() => {
              clearBakeNavigationStack()
              setRepositoryCaptureSourceCaptureId(null)
            }}
            onViewLinkedTimeline={handleViewLinkedTimeline}
            canGoBack={Boolean(captureBackTarget)}
            onGoBack={handleCaptureGoBack}
          />
        )}
      </div>
    </div>
  )
}

export default RepositoryPanel
