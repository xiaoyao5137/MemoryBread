import React, { useEffect, useState } from 'react'
import { CheckCircle2, Download, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { openExternalUrl, useAppMetadata } from '../utils/appMetadata'
import { fetchSoftwareUpdate, type SoftwareUpdateCheck } from '../utils/softwareUpdate'
import './AboutPanel.css'

const AboutPanel: React.FC = () => {
  const { adminApiBaseUrl, serviceEnvironment, setWindowMode } = useAppStore()
  const metadata = useAppMetadata()
  const [update, setUpdate] = useState<SoftwareUpdateCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')

  const checkForUpdates = async () => {
    setChecking(true)
    setError('')
    try {
      setUpdate(await fetchSoftwareUpdate(adminApiBaseUrl, metadata))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法检查更新')
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void checkForUpdates()
  }, [adminApiBaseUrl, metadata.version, metadata.platform, metadata.architecture, serviceEnvironment])

  return (
    <section className="about-panel">
      <header className="about-panel__header">
        <div>
          <span>ABOUT MEMORYBREAD</span>
          <h1>关于记忆面包</h1>
        </div>
        <button aria-label="关闭关于页面" onClick={() => setWindowMode('rag')} type="button"><X size={20} /></button>
      </header>

      <div className="about-panel__body">
        <article className="about-panel__identity">
          <div className="about-panel__loaf" aria-hidden>
            <span>MB</span>
          </div>
          <div>
            <p>把每天发生过的工作，慢慢烘焙成以后持续受益的能力。</p>
            <strong>{metadata.product_name}</strong>
            <code>v{metadata.version}</code>
          </div>
        </article>

        <article className="about-panel__version-card">
          <div className="about-panel__version-heading">
            <div>
              <h2>软件版本</h2>
              <p>版本来自当前安装包的构建信息。</p>
            </div>
            <button disabled={checking} onClick={() => void checkForUpdates()} type="button">
              <RefreshCw className={checking ? 'is-spinning' : ''} size={16} />
              {checking ? '检查中' : '检查更新'}
            </button>
          </div>
          <dl>
            <div><dt>当前版本</dt><dd>v{metadata.version}</dd></div>
            <div><dt>运行平台</dt><dd>{metadata.platform} · {metadata.architecture}</dd></div>
            <div><dt>更新渠道</dt><dd>stable</dd></div>
          </dl>

          {error && <div className="about-panel__status about-panel__status--error" role="alert">{error}</div>}
          {!error && update && !update.update_available && (
            <div className="about-panel__status"><CheckCircle2 size={18} aria-hidden /> 已是最新版本</div>
          )}
          {!error && update?.update_available && update.release && (
            <div className="about-panel__update">
              <div><Download size={19} aria-hidden /><span><strong>v{update.latest_version} 可下载安装</strong><small>{update.release.title}</small></span></div>
              <p>{update.release.release_notes}</p>
              <button onClick={() => void openExternalUrl(update.release!.download_url)} type="button">打开下载页面</button>
            </div>
          )}
        </article>

        <footer className="about-panel__privacy">
          <ShieldCheck size={20} aria-hidden />
          <p><strong>本地优先</strong><span>软件版本检查只发送版本号、平台和架构，不上传截图、窗口标题或知识内容。</span></p>
        </footer>
      </div>
    </section>
  )
}

export default AboutPanel
