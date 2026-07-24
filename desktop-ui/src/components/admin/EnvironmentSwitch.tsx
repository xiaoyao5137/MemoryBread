import React from 'react'
import { useAppStore } from '../../store/useAppStore'

const EnvironmentSwitch: React.FC = () => {
  const {
    debugModeEnabled,
    localDebugModeEnabled,
    serviceEnvironment,
    setServiceEnvironment,
  } = useAppStore()

  if (!debugModeEnabled) return null

  const isStaging = serviceEnvironment === 'staging'

  return (
    <section className="admin-env-switch" aria-label="服务环境切换">
      <div>
        <span className="admin-env-switch__eyebrow">
          {localDebugModeEnabled ? '本机服务环境' : '调试服务环境'}
        </span>
        <strong>{isStaging ? '测试' : '正式'}</strong>
      </div>
      <div className="admin-env-switch__actions" role="group" aria-label="选择服务环境">
        <button
          type="button"
          className={!isStaging ? 'admin-env-switch__button admin-env-switch__button--active' : 'admin-env-switch__button'}
          aria-pressed={!isStaging}
          onClick={() => setServiceEnvironment('production')}
        >
          正式
        </button>
        <button
          type="button"
          className={isStaging ? 'admin-env-switch__button admin-env-switch__button--active' : 'admin-env-switch__button'}
          aria-pressed={isStaging}
          onClick={() => setServiceEnvironment('staging')}
        >
          测试
        </button>
      </div>
    </section>
  )
}

export default EnvironmentSwitch
