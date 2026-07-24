import React, { useMemo, useState } from 'react'
import { Keyboard, MousePointerClick, RotateCcw, X } from 'lucide-react'
import {
  DEFAULT_INTERACTION_SETTINGS,
  FLOATING_BALL_ACTIONS,
  SHORTCUT_ACTIONS,
  findShortcutConflict,
  readInteractionSettings,
  saveInteractionSettings,
  shortcutDisplayParts,
  shortcutFromKeyboardEvent,
  type FloatingBallAction,
  type InteractionSettings as InteractionSettingsValue,
  type ShortcutAction,
} from '../utils/interactionSettings'

const actionLabel = (action: ShortcutAction) =>
  SHORTCUT_ACTIONS.find(item => item.id === action)?.label ?? action

const InteractionSettings: React.FC = () => {
  const [settings, setSettings] = useState(readInteractionSettings)
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const conflict = useMemo(() => findShortcutConflict(settings.shortcuts), [settings.shortcuts])

  const commit = async (next: InteractionSettingsValue) => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const persisted = await saveInteractionSettings(next)
      setSettings(persisted)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1800)
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message === '快捷键不能重复'
        ? message
        : '快捷键启用失败，可能已被其他应用占用。原设置已保留。')
      return false
    } finally {
      setSaving(false)
    }
  }

  const updateShortcut = async (action: ShortcutAction, shortcut: string | null) => {
    const next = {
      ...settings,
      shortcuts: { ...settings.shortcuts, [action]: shortcut },
    }
    const nextConflict = findShortcutConflict(next.shortcuts)
    if (nextConflict) {
      setError(`${actionLabel(nextConflict[0])}与${actionLabel(nextConflict[1])}不能使用同一组快捷键`)
      return
    }
    if (await commit(next)) setRecordingAction(null)
  }

  const handleShortcutKeyDown = (action: ShortcutAction, event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecordingAction(null)
      setError(null)
      return
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      void updateShortcut(action, null)
      return
    }
    const shortcut = shortcutFromKeyboardEvent(event)
    if (!shortcut) {
      setError('请按下至少一个修饰键和一个字母、数字或功能键')
      return
    }
    void updateShortcut(action, shortcut)
  }

  const updateFloatingBallAction = (
    eventName: 'singleClick' | 'doubleClick',
    action: FloatingBallAction,
  ) => {
    void commit({
      ...settings,
      floatingBall: { ...settings.floatingBall, [eventName]: action },
    })
  }

  const restoreDefaults = () => {
    void commit({
      shortcuts: { ...DEFAULT_INTERACTION_SETTINGS.shortcuts },
      floatingBall: { ...DEFAULT_INTERACTION_SETTINGS.floatingBall },
    })
  }

  return (
    <section
      className="settings-v2__card settings-v2__card--interactions"
      data-testid="settings-interactions-section"
    >
      <div className="settings-v2__card-header">
        <div className="settings-v2__card-icon settings-v2__card-icon--bread">
          <Keyboard size={20} aria-hidden="true" />
        </div>
        <div className="settings-v2__interaction-heading">
          <div>
            <h2 className="settings-v2__card-title">快捷键与悬浮球</h2>
            <p className="settings-v2__card-desc">不用离开当前工作，直接叫出记忆面包或识别当屏任务</p>
          </div>
          <button
            type="button"
            className="settings-v2__reset-shortcuts"
            onClick={restoreDefaults}
            disabled={saving}
          >
            <RotateCcw size={14} aria-hidden="true" />
            恢复默认
          </button>
        </div>
      </div>

      <div className="settings-v2__interaction-grid">
        <div className="settings-v2__interaction-group">
          <div className="settings-v2__interaction-group-title">
            <Keyboard size={16} aria-hidden="true" />
            <span>全局快捷键</span>
          </div>
          <p className="settings-v2__interaction-group-help">点击按键区后录制；按 Delete 清除，按 Esc 取消。</p>
          <div className="settings-v2__shortcut-list">
            {SHORTCUT_ACTIONS.map(item => {
              const shortcut = settings.shortcuts[item.id]
              const recording = recordingAction === item.id
              return (
                <div className="settings-v2__shortcut-row" key={item.id}>
                  <div className="settings-v2__shortcut-copy">
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </div>
                  <div className="settings-v2__shortcut-controls">
                    <button
                      type="button"
                      className={`settings-v2__shortcut-recorder${recording ? ' is-recording' : ''}`}
                      aria-label={`${item.label}快捷键`}
                      aria-pressed={recording}
                      onClick={() => {
                        setRecordingAction(item.id)
                        setError(null)
                      }}
                      onKeyDown={recording ? event => handleShortcutKeyDown(item.id, event) : undefined}
                      onBlur={() => setRecordingAction(current => current === item.id ? null : current)}
                      disabled={saving}
                    >
                      {recording ? (
                        <span className="settings-v2__recording-label">请按快捷键…</span>
                      ) : shortcut ? (
                        <span className="settings-v2__keycaps" aria-hidden="true">
                          {shortcutDisplayParts(shortcut).map((part, index) => (
                            <kbd key={`${part}-${index}`}>{part}</kbd>
                          ))}
                        </span>
                      ) : (
                        <span className="settings-v2__shortcut-empty">未设置</span>
                      )}
                    </button>
                    {shortcut && (
                      <button
                        type="button"
                        className="settings-v2__shortcut-clear"
                        aria-label={`清除${item.label}快捷键`}
                        onClick={() => void updateShortcut(item.id, null)}
                        disabled={saving}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="settings-v2__interaction-group">
          <div className="settings-v2__interaction-group-title">
            <MousePointerClick size={16} aria-hidden="true" />
            <span>悬浮球触发</span>
          </div>
          <p className="settings-v2__interaction-group-help">单击会等待片刻以区分双击，拖动悬浮球不会触发事件。</p>
          <div className="settings-v2__gesture-list">
            <label className="settings-v2__gesture-row" htmlFor="floating-ball-single-click">
              <span>
                <strong>单击悬浮球</strong>
                <small>默认打开悬浮球咨询框</small>
              </span>
              <select
                id="floating-ball-single-click"
                aria-label="单击悬浮球"
                value={settings.floatingBall.singleClick}
                onChange={event => updateFloatingBallAction('singleClick', event.target.value as FloatingBallAction)}
                disabled={saving}
              >
                {FLOATING_BALL_ACTIONS.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="settings-v2__gesture-row" htmlFor="floating-ball-double-click">
              <span>
                <strong>双击悬浮球</strong>
                <small>默认打开主面板</small>
              </span>
              <select
                id="floating-ball-double-click"
                aria-label="双击悬浮球"
                value={settings.floatingBall.doubleClick}
                onChange={event => updateFloatingBallAction('doubleClick', event.target.value as FloatingBallAction)}
                disabled={saving}
              >
                {FLOATING_BALL_ACTIONS.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
              </select>
            </label>
          </div>
        </div>
      </div>

      {(error || conflict) && (
        <div className="settings-v2__interaction-feedback settings-v2__interaction-feedback--error" role="alert">
          {error || '快捷键不能重复'}
        </div>
      )}
      {saved && !error && (
        <div className="settings-v2__interaction-feedback settings-v2__interaction-feedback--success" role="status">
          快捷操作已保存并立即生效
        </div>
      )}
    </section>
  )
}

export default InteractionSettings
