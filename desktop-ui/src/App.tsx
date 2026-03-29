import React, { useEffect } from 'react'
import { useAppStore }        from './store/useAppStore'
import FloatingBuddy          from './components/FloatingBuddy'
import RagPanel               from './components/RagPanel.v2'
import KnowledgePanel         from './components/KnowledgePanel'
import ModelManager           from './components/ModelManager'
import ActionConfirm          from './components/ActionConfirm'
import Settings               from './components/Settings'
import DebugPanel             from './components/DebugPanel'
import ScheduledTasksPanel    from './components/ScheduledTasksPanel'
import MonitorPanel           from './components/MonitorPanel'
import OnboardingWizard       from './components/OnboardingWizard'

const App: React.FC = () => {
  const { windowMode, setWindowMode, hasCompletedSetup, setupSkipped } = useAppStore()
  const showOnboarding = !hasCompletedSetup && !setupSkipped

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
        {windowMode === 'knowledge' && <KnowledgePanel />}
        {windowMode === 'models'    && <ModelManager />}
        {windowMode === 'settings'  && <Settings />}
        {windowMode === 'debug'     && <DebugPanel />}
        {windowMode === 'tasks'     && <ScheduledTasksPanel />}
        {windowMode === 'monitor'   && <MonitorPanel />}
      </main>

      <ActionConfirm />
    </div>
  )
}

export default App
