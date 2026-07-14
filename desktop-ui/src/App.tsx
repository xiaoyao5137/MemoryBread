import React, { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
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
import DiaryPanel             from './components/DiaryPanel'
import OnboardingWizard       from './components/OnboardingWizard'
import AuthPanel              from './components/AuthPanel'
import SystemFloatingAssist   from './components/SystemFloatingAssist'
import { fetchConsoleSummary, fetchCurrentUser } from './utils/authApi'
import {
  FLOATING_ASSIST_ENABLED_KEY,
  readFloatingAssistAutoTaskConfig,
  type FloatingAssistAutoTaskConfig,
  writeFloatingAssistAutoTaskConfig,
} from './utils/floatingAssistAutoTask'

const hasConfiguredCreationModel = (configs: Array<{ enabled?: boolean; apiKey?: string }>) =>
  configs.some(config => Boolean(config.enabled || config.apiKey))

const parseReferenceId = (docKey?: string | null) => {
  if (!docKey) return null
  const match = String(docKey).match(/:(\d+)$/)
  return match ? match[1] : null
}

const App: React.FC = () => {
  const searchParams = new URLSearchParams(window.location.search)
  const isFloatingAssistWindow = searchParams.get('view') === 'floating-assist'
  if (isFloatingAssistWindow) {
    return <SystemFloatingAssist />
  }

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
    setRepositoryMemoryFocusId,
    setBakeTemplateFocusId,
    setBakeKnowledgeFocusId,
    setBakeSopFocusId,
    setBakeTemplateOffset,
    setBakeTemplateLimit,
    setBakeKnowledgeOffset,
    setBakeKnowledgeLimit,
    setBakeSopOffset,
    setBakeSopLimit,
    setRepositoryCaptureSourceCaptureId,
    pushBakeNavigationTarget,
    clearBakeNavigationStack,
    hasCompletedSetup,
    setupSkipped,
    apiBaseUrl,
    adminApiBaseUrl,
    authToken,
    setCreationModelConfigs,
    setAuthSession,
    setCloudBalance,
    setCloudSubscription,
    clearAuthSession,
  } = useAppStore()

  const showOnboarding = !hasCompletedSetup && !setupSkipped

  useEffect(() => {
    let cancelled = false
    const cleanups: Array<() => void> = []

    const syncCaptureMenuState = async (): Promise<boolean> => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/runtime/status`)
        if (!response.ok) return false
        const status = await response.json() as { capture_enabled: boolean }
        if (!cancelled) {
          await invoke('set_capture_menu_state', { enabled: status.capture_enabled })
        }
        return true
      } catch {
        // 浏览器预览或 Core Engine 尚未启动时保持菜单默认开启。
        return false
      }
    }

    const syncCaptureMenuUntilReady = async () => {
      for (let attempt = 0; attempt < 12 && !cancelled; attempt += 1) {
        if (await syncCaptureMenuState()) return
        await new Promise(resolve => window.setTimeout(resolve, 5000))
      }
    }

    const registerTrayEvents = async () => {
      try {
        const floatingAssistEnabled = localStorage.getItem(FLOATING_ASSIST_ENABLED_KEY) === 'true'
        const autoTaskConfig = readFloatingAssistAutoTaskConfig()
        const autoTaskDetectionEnabled = floatingAssistEnabled && autoTaskConfig.enabled
        await invoke('set_floating_assist_menu_state', { enabled: floatingAssistEnabled })
        await invoke('set_floating_assist_auto_task_menu_state', {
          checked: autoTaskDetectionEnabled,
          enabled: floatingAssistEnabled,
        })
        if (floatingAssistEnabled) {
          await invoke('set_floating_assist_visible', { enabled: true })
        }
        cleanups.push(await listen('tray-navigate-settings', () => {
          setWindowMode('settings')
        }))
        cleanups.push(await listen<boolean>('tray-floating-assist-changed', event => {
          localStorage.setItem(FLOATING_ASSIST_ENABLED_KEY, String(event.payload))
          if (!event.payload) {
            writeFloatingAssistAutoTaskConfig({
              ...readFloatingAssistAutoTaskConfig(),
              enabled: false,
            })
          }
          invoke('set_floating_assist_auto_task_menu_state', {
            checked: event.payload && readFloatingAssistAutoTaskConfig().enabled,
            enabled: event.payload,
          }).catch(() => {})
        }))
        cleanups.push(await listen<boolean | FloatingAssistAutoTaskConfig>('floating-assist-auto-task-changed', event => {
          if (typeof event.payload === 'boolean') {
            writeFloatingAssistAutoTaskConfig({
              ...readFloatingAssistAutoTaskConfig(),
              enabled: Boolean(event.payload),
            })
          } else {
            writeFloatingAssistAutoTaskConfig(event.payload)
          }
        }))
        cleanups.push(await listen<boolean>('tray-capture-changed', async event => {
          const requested = event.payload
          try {
            const response = await fetch(`${apiBaseUrl}/api/runtime/status`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ capture_enabled: requested }),
            })
            if (!response.ok) throw new Error(`runtime status update failed: ${response.status}`)
          } catch {
            await syncCaptureMenuState()
          }
        }))
        void syncCaptureMenuUntilReady()
      } catch {
        // 普通浏览器环境没有 Tauri event runtime。
      }
    }

    void registerTrayEvents()
    return () => {
      cancelled = true
      cleanups.forEach(cleanup => cleanup())
    }
  }, [apiBaseUrl, setWindowMode])

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

  useEffect(() => {
    if (!authToken) return
    let cancelled = false
    const validateSession = async () => {
      try {
        const user = await fetchCurrentUser(adminApiBaseUrl, authToken)
        if (!cancelled) {
          setAuthSession({
            access_token: authToken,
            expires_at: useAppStore.getState().authExpiresAt || new Date(Date.now() + 30 * 86400_000).toISOString(),
            user,
          })
        }
        const summary = await fetchConsoleSummary(adminApiBaseUrl, authToken).catch(() => null)
        if (!cancelled && summary) {
          setCloudBalance(summary.balance ?? null)
          setCloudSubscription(summary.current_subscription ?? null)
        }
      } catch {
        if (!cancelled) clearAuthSession()
      }
    }
    void validateSession()
    return () => { cancelled = true }
  }, [adminApiBaseUrl, authToken, clearAuthSession, setAuthSession, setCloudBalance, setCloudSubscription])

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
    const openReferenceDetail = (detail: any) => {
      const { type, captureId, knowledgeId, artifactId, documentId, docKey } = detail || {}
      const parsedTargetId = parseReferenceId(docKey)
      const targetId = String(documentId ?? artifactId ?? parsedTargetId ?? '')
      const hasTargetId = targetId.trim().length > 0
      const setRagBackTarget = (enabled: boolean) => {
        if (enabled) {
          pushBakeNavigationTarget({ windowMode: 'rag' })
        } else {
          clearBakeNavigationStack()
        }
      }

      if (type === 'document') {
        setRagBackTarget(hasTargetId)
        setBakeTab('templates')
        setBakeTemplateOffset(0)
        setBakeTemplateLimit(100)
        setBakeTemplateFocusId(targetId || null)
        setSelectedTemplateId(targetId || null)
        setWindowMode('bake')
        return
      }
      if (type === 'bake_knowledge') {
        setRagBackTarget(hasTargetId)
        setBakeTab('knowledge')
        setBakeKnowledgeOffset(0)
        setBakeKnowledgeLimit(1000)
        setBakeKnowledgeFocusId(targetId || null)
        setSelectedKnowledgeId(targetId || null)
        setWindowMode('bake')
        return
      }
      if (type === 'operation' || type === 'action') {
        setRagBackTarget(hasTargetId)
        setBakeTab('sop')
        setBakeSopOffset(0)
        setBakeSopLimit(1000)
        setBakeSopFocusId(targetId || null)
        setSelectedSopId(targetId || null)
        setWindowMode('bake')
        return
      }
      if (type === 'knowledge' && knowledgeId) {
        pushBakeNavigationTarget({ windowMode: 'rag' })
        setWindowMode('knowledge')
        setRepositoryTab('memory')
        setRepositoryMemoryFocusId(String(knowledgeId))
        setSelectedMemoryId(String(knowledgeId))
        return
      }
      if (captureId) {
        pushBakeNavigationTarget({ windowMode: 'rag' })
        setWindowMode('knowledge')
        setRepositoryTab('capture')
        setRepositoryCaptureSourceCaptureId(String(captureId))
        setSelectedCaptureId(String(captureId))
      }
    }

    const handleViewReference = (event: CustomEvent) => {
      openReferenceDetail(event.detail)
    }

    let tauriCleanup: (() => void) | null = null
    void listen<any>('floating-assist-open-reference', event => {
      openReferenceDetail(event.payload)
    }).then(cleanup => {
      tauriCleanup = cleanup
    }).catch(() => {})

    window.addEventListener('view-rag-reference', handleViewReference as EventListener)
    return () => {
      window.removeEventListener('view-rag-reference', handleViewReference as EventListener)
      tauriCleanup?.()
    }
  }, [
    clearBakeNavigationStack,
    pushBakeNavigationTarget,
    setBakeKnowledgeLimit,
    setBakeKnowledgeOffset,
    setBakeSopLimit,
    setBakeSopOffset,
    setBakeTab,
    setBakeTemplateLimit,
    setBakeTemplateOffset,
    setRepositoryCaptureSourceCaptureId,
    setRepositoryMemoryFocusId,
    setRepositoryTab,
    setBakeKnowledgeFocusId,
    setSelectedCaptureId,
    setSelectedKnowledgeId,
    setSelectedMemoryId,
    setSelectedSopId,
    setSelectedTemplateId,
    setBakeSopFocusId,
    setBakeTemplateFocusId,
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
        {windowMode === 'diary'     && <DiaryPanel />}
        {windowMode === 'account'   && <AuthPanel />}
      </main>

      <ActionConfirm />
    </div>
  )
}

export default App
