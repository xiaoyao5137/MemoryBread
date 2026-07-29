import React, { useEffect, useState } from 'react'
import { Download, ShieldAlert, Sparkles, X } from 'lucide-react'
import type { SoftwareUpdateCheck } from '../utils/softwareUpdate'
import { openExternalUrl } from '../utils/appMetadata'
import './SoftwareUpdateNotice.css'

interface SoftwareUpdateNoticeProps {
  update: SoftwareUpdateCheck
  onDismiss: () => void
}

const SoftwareUpdateNotice: React.FC<SoftwareUpdateNoticeProps> = ({ update, onDismiss }) => {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const release = update.release

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !update.is_mandatory) onDismiss()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss, update.is_mandatory])

  if (!release) return null

  const startDownload = async () => {
    setOpening(true)
    setError('')
    try {
      await openExternalUrl(release.download_url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开下载页面')
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="software-update-notice" role="presentation">
      <section
        aria-describedby="software-update-description"
        aria-labelledby="software-update-title"
        aria-modal="true"
        className="software-update-notice__dialog"
        role="dialog"
      >
        <div className="software-update-notice__mark" aria-hidden>
          {update.is_mandatory ? <ShieldAlert size={30} /> : <Sparkles size={30} />}
        </div>
        {!update.is_mandatory && (
          <button aria-label="稍后提醒" className="software-update-notice__close" onClick={onDismiss} type="button">
            <X size={18} />
          </button>
        )}
        <div className="software-update-notice__eyebrow">
          {update.is_mandatory ? '重要软件更新' : '新鲜出炉的软件更新'}
        </div>
        <h2 id="software-update-title">{release.title}</h2>
        <p id="software-update-description">
          当前版本 <code>v{update.current_version}</code>
          <span aria-hidden> → </span>
          最新版本 <code>v{update.latest_version}</code>
        </p>
        <div className="software-update-notice__notes">{release.release_notes}</div>
        {release.checksum_sha256 && (
          <details>
            <summary>安装包校验信息</summary>
            <code>{release.checksum_sha256}</code>
          </details>
        )}
        {error && <div className="software-update-notice__error" role="alert">{error}</div>}
        <div className="software-update-notice__actions">
          {!update.is_mandatory && <button onClick={onDismiss} type="button">24 小时后提醒</button>}
          <button autoFocus className="software-update-notice__download" disabled={opening} onClick={() => void startDownload()} type="button">
            <Download size={17} aria-hidden /> {opening ? '正在打开' : '下载并安装'}
          </button>
        </div>
      </section>
    </div>
  )
}

export default SoftwareUpdateNotice
