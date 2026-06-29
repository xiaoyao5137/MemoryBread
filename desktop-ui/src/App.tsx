import React, { useEffect } from 'react'
import {
  CREATION_MODEL_PREFERENCE_KEY,
  loadCreationModels,
  normalizeCreationModels,
  useAppStore,
} from './store/useAppStore'
import FloatingBuddy          from './components/FloatingBuddy'
import RagPanel               from './components/RagPanel.v2'
import CreationPanel          from './components/CreationPanel'
import RepositoryPanel        from './components/RepositoryPanel'
import ModelManager           from './components/ModelManager'
import PrivacyPanel           from './components/PrivacyPanel'
import ActionConfirm          from './components/ActionConfirm'
import Settings               from './components/Settings'
import DebugPanel             from './components/DebugPanel'
import ScheduledTasksPanel    from './components/ScheduledTasksPanel'
import MonitorPanel           from './components/MonitorPanel'
import BakePanel              from './components/BakePanel'
import ProfilePanel           from './components/ProfilePanel'
import OnboardingWizard       from './components/OnboardingWizard'

const hasConfiguredCreationModel = (configs: Array<{ enabled?: boolean; apiKey?: string }>) =>
  configs.some(config => Boolean(config.enabled || config.apiKey))

const parseReferenceId = (docKey?: string | null) => {
  if (!docKey) return null
  const match = String(docKey).match(/:(\d+)$/)
  return match ? match[1] : null
}

const App: React.FC = () => {
  const {
    windowMode,
    setWindowMode,
    setBakeTab,
    setRepositoryTab,
    setSelectedMemoryId,
    setSelectedCaptureId,
    setSelectedTemplateId,
    setSelectedKnowledgeId,
    setSelectedSopId,
    setBakeTemplateOffset,
    setBakeTemplateLimit,
    setBakeKnowledgeOffset,
    setBakeKnowledgeLimit,
    setBakeSopOffset,
    setBakeSopLimit,
    setRepositoryCaptureSourceCaptureId,
    pushBakeNavigationTarget,
    hasCompletedSetup,
    setupSkipped,
    apiBaseUrl,
    setCreationModelConfigs,
  } = useAppStore()
  const showOnboarding = !hasCompletedSetup && !setupSkipped

  useEffect(() => {
    let cancelled = false

    const loadCreationModelPreference = async () => {
      try {
        const resp = await fetch(`${apiBaseUrl}/preferences`)
        if (!resp.ok) return
        const data = await resp.json()
        const pref = (data.preferences || []).find((item: { key: string }) => item.key === CREATION_MODEL_PREFERENCE_KEY)
        const localConfigs = loadCreationModels()
        if (pref?.value) {
          const configs = normalizeCreationModels(JSON.parse(pref.value))
          if (!hasConfiguredCreationModel(configs) && hasConfiguredCreationModel(localConfigs)) {
            if (!cancelled) setCreationModelConfigs(localConfigs)
            await fetch(`${apiBaseUrl}/preferences/${encodeURIComponent(CREATION_MODEL_PREFERENCE_KEY)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: JSON.stringify(localConfigs) }),
            })
            return
          }
          if (!cancelled) setCreationModelConfigs(configs)
          return
        }

        await fetch(`${apiBaseUrl}/preferences/${encodeURIComponent(CREATION_MODEL_PREFERENCE_KEY)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: JSON.stringify(localConfigs) }),
        })
      } catch {
        // 保留本地配置作为离线兜底。
      }
    }

    void loadCreationModelPreference()
    return () => { cancelled = true }
  }, [apiBaseUrl, setCreationModelConfigs])

  // 监听查看采集记录事件
  useEffect(() => {
    const handleViewCapture = (event: CustomEvent) => {
      const { captureId } = event.detail
      setWindowMode('debug')
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('scroll-to-capture', {
          detail: { captureId }
        }))
      }, 100)
    }

    window.addEventListener('view-capture', handleViewCapture as EventListener)
    return () => {
      window.removeEventListener('view-capture', handleViewCapture as EventListener)
    }
  }, [setWindowMode])

  useEffect(() => {
    const handleViewReference = (event: CustomEvent) => {
      const { type, captureId, knowledgeId, artifactId, documentId, docKey } = event.detail || {}
      const parsedTargetId = parseReferenceId(docKey)
      const targetId = String(documentId ?? artifactId ?? parsedTargetId ?? '')
      pushBakeNavigationTarget({ windowMode: 'rag' })

      if (type === 'document') {
        setBakeTab('templates')
        setBakeTemplateOffset(0)
        setBakeTemplateLimit(100)
        setSelectedTemplateId(targetId || null)
        setWindowMode('bake')
        return
      }
      if (type === 'bake_knowledge') {
        setBakeTab('knowledge')
        setBakeKnowledgeOffset(0)
        setBakeKnowledgeLimit(1000)
        setSelectedKnowledgeId(targetId || null)
        setWindowMode('bake')
        return
      }
      if (type === 'operation' || type === 'action') {
        setBakeTab('sop')
        setBakeSopOffset(0)
        setBakeSopLimit(1000)
        setSelectedSopId(targetId || null)
        setWindowMode('bake')
        return
      }
      setWindowMode('knowledge')
      if (type === 'knowledge' && knowledgeId) {
        setRepositoryTab('memory')
        setSelectedMemoryId(String(knowledgeId))
        return
      }
      if (captureId) {
        setRepositoryTab('capture')
        setRepositoryCaptureSourceCaptureId(String(captureId))
        setSelectedCaptureId(String(captureId))
      }
    }

    window.addEventListener('view-rag-reference', handleViewReference as EventListener)
    return () => {
      window.removeEventListener('view-rag-reference', handleViewReference as EventListener)
    }
  }, [
    pushBakeNavigationTarget,
    setBakeKnowledgeLimit,
    setBakeKnowledgeOffset,
    setBakeSopLimit,
    setBakeSopOffset,
    setBakeTab,
    setBakeTemplateLimit,
    setBakeTemplateOffset,
    setRepositoryCaptureSourceCaptureId,
    setRepositoryTab,
    setSelectedCaptureId,
    setSelectedKnowledgeId,
    setSelectedMemoryId,
    setSelectedSopId,
    setSelectedTemplateId,
    setWindowMode,
  ])

  if (showOnboarding) {
    return (
      <div className="app" data-testid="app-root">
        <OnboardingWizard />
        <ActionConfirm />
      </div>
    )
  }

  return (
    <div className="app" data-testid="app-root">
      <FloatingBuddy />

      <main className="app-content">
        {windowMode === 'rag'       && <RagPanel />}
        {windowMode === 'creation'  && <CreationPanel />}
        {windowMode === 'knowledge' && <RepositoryPanel />}
        {windowMode === 'models'    && <ModelManager />}
        {windowMode === 'privacy'   && <PrivacyPanel />}
        {windowMode === 'settings'  && <Settings />}
        {windowMode === 'debug'     && <DebugPanel />}
        {windowMode === 'tasks'     && <ScheduledTasksPanel />}
        {windowMode === 'monitor'   && <MonitorPanel />}
        {windowMode === 'bake'      && <BakePanel />}
        {windowMode === 'profile'   && <ProfilePanel />}
      </main>

      <ActionConfirm />
    </div>
  )
}

export default App
