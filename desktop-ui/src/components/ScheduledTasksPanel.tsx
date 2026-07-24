import React, { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import type { ScheduledTask, TaskExecution, TaskTemplate } from '../types'
import { useAppStore } from '../store/useAppStore'
import { BUILTIN_TEMPLATES, CATEGORY_COLORS, groupTemplatesByCategory } from '../data/taskTemplates'
import {
  FLOATING_ASSIST_ENABLED_KEY,
  readFloatingAssistAutoTaskConfig,
  writeFloatingAssistAutoTaskConfig,
  type FloatingAssistAutoTaskAppTarget,
  type FloatingAssistAutoTaskConfig,
} from '../utils/floatingAssistAutoTask'

const API = 'http://localhost:7070'

function formatTs(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function cronHint(expr: string): string {
  const fields = expr.trim().split(/\s+/)
  const canonicalDayToFiveField: Record<string, string> = {
    '1': '0', '2': '1', '3': '2', '4': '3', '5': '4', '6': '5', '7': '6',
    '2,3,4,5,6': '1-5',
  }
  const displayExpr = fields.length === 6 && fields[0] === '0'
    ? [...fields.slice(1, 5), canonicalDayToFiveField[fields[5]] || fields[5]].join(' ')
    : fields.join(' ')
  const map: Record<string, string> = {
    '0 20 * * *': '每天 20:00', '0 18 * * 5': '每周五 18:00',
    '0 18 28 * *': '每月28日 18:00', '0 21 * * *': '每天 21:00',
    '0 9 * * *': '每天 09:00', '0 10 * * 0': '每周日 10:00', '0 9 * * 1': '每周一 09:00',
    '0 9 1 * *': '每月1日 09:00',
    '0 17 * * 1-5': '工作日 17:00', '0 20 * * 0': '每周日 20:00',
    '0 19 * * 1-5': '工作日 19:00', '0 12 * * 3': '每周三 12:00',
    '0 17 * * 5': '每周五 17:00', '0 18 * * 1-5': '工作日 18:00',
    '0 9 * * 1-5': '工作日 09:00', '0 16 * * 5': '每周五 16:00',
  }
  return map[displayExpr] || displayExpr
}

// ── 子组件：任务卡片 ─────────────────────────────────────────────────────────
const TaskCard: React.FC<{
  task: ScheduledTask
  onToggle: (id: number, enabled: boolean) => void
  onTrigger: (id: number) => void
  onDelete: (id: number) => void
  onViewResult: (task: ScheduledTask) => void
}> = ({ task, onToggle, onTrigger, onDelete, onViewResult }) => {
  const statusColor = task.last_run_status === 'success' ? '#34C759'
    : task.last_run_status === 'failed' ? '#FF3B30' : '#AEAEB2'

  return (
    <div style={{
      background: 'white', borderRadius: 12, padding: '14px 16px',
      border: '1px solid rgba(0,0,0,0.08)', marginBottom: 10,
      opacity: task.enabled ? 1 : 0.5,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* 启用开关 */}
        <button
          onClick={() => onToggle(task.id, !task.enabled)}
          style={{
            width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
            background: task.enabled ? '#007AFF' : '#E5E5EA', flexShrink: 0, marginTop: 2,
            position: 'relative', transition: 'background 0.2s',
          }}
          title={task.enabled ? '点击禁用' : '点击启用'}
        >
          <span style={{
            position: 'absolute', top: 2, left: task.enabled ? 18 : 2,
            width: 16, height: 16, borderRadius: '50%', background: 'white',
            transition: 'left 0.2s', display: 'block',
          }} />
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: '#000' }}>{task.name}</span>
            <span style={{
              fontSize: 11, padding: '1px 6px', borderRadius: 4,
              background: 'rgba(0,122,255,0.08)', color: '#007AFF',
            }}>{cronHint(task.cron_expression)}</span>
            {task.last_run_status && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
            )}
          </div>
          <p style={{ fontSize: 12, color: '#6E6E73', margin: 0, lineHeight: 1.4,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.user_instruction}
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11, color: '#AEAEB2' }}>
            <span>执行 {task.run_count} 次</span>
            {task.last_run_at && <span>上次 {formatTs(task.last_run_at)}</span>}
            {task.next_run_at && <span>下次 {formatTs(task.next_run_at)}</span>}
          </div>
        </div>

        {/* 操作按钮 */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {task.last_run_status === 'success' && (
            <button onClick={() => onViewResult(task)} style={btnStyle('#007AFF')} title="查看结果">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          )}
          <button onClick={() => onTrigger(task.id)} style={btnStyle('#34C759')} title="立即执行">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </button>
          <button onClick={() => onDelete(task.id)} style={btnStyle('#FF3B30')} title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 主组件 ───────────────────────────────────────────────────────────────────
const ScheduledTasksPanel: React.FC = () => {
  const { apiBaseUrl } = useAppStore()
  const base = apiBaseUrl || API

  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'list' | 'create' | 'templates' | 'result'>('list')
  const [selectedTask, setSelectedTask] = useState<ScheduledTask | null>(null)
  const [executions, setExecutions] = useState<TaskExecution[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [autoTaskConfig, setAutoTaskConfig] = useState<FloatingAssistAutoTaskConfig>(readFloatingAssistAutoTaskConfig)
  const [autoTaskDraft, setAutoTaskDraft] = useState(() => readFloatingAssistAutoTaskConfig())
  const [autoTaskAppDraft, setAutoTaskAppDraft] = useState<FloatingAssistAutoTaskAppTarget>({ bundleId: '', appName: '' })
  const [triggerWordDraft, setTriggerWordDraft] = useState('')

  // 创建表单状态
  const [form, setForm] = useState({ name: '', user_instruction: '', cron_expression: '0 20 * * *' })

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const persistAutoTaskConfig = async (next: FloatingAssistAutoTaskConfig) => {
    const saved = writeFloatingAssistAutoTaskConfig(next)
    setAutoTaskConfig(saved)
    setAutoTaskDraft(saved)
    try {
      if (saved.enabled) {
        localStorage.setItem(FLOATING_ASSIST_ENABLED_KEY, 'true')
        await invoke('set_floating_assist_menu_state', { enabled: true })
        await invoke('set_floating_assist_visible', { enabled: true })
      }
      await invoke('set_floating_assist_auto_task_menu_state', {
        checked: saved.enabled,
        enabled: localStorage.getItem(FLOATING_ASSIST_ENABLED_KEY) === 'true',
      })
      await emit('floating-assist-auto-task-changed', saved)
    } catch {
      // 浏览器预览或 Tauri runtime 不可用时，本地配置仍然生效。
    }
  }

  const handleAutoTaskToggle = async () => {
    await persistAutoTaskConfig({
      ...autoTaskConfig,
      enabled: !autoTaskConfig.enabled,
    })
    showToast(!autoTaskConfig.enabled ? '自动识别任务已开启' : '自动识别任务已关闭')
  }

  const handleAutoTaskSave = async () => {
    await persistAutoTaskConfig({
      ...autoTaskConfig,
      appTargets: autoTaskDraft.appTargets,
      triggerWords: autoTaskDraft.triggerWords,
    })
    showToast('自动识别任务配置已保存')
  }

  const handleAddAutoTaskApp = () => {
    const bundleId = autoTaskAppDraft.bundleId.trim()
    const appName = autoTaskAppDraft.appName.trim()
    if (!bundleId && !appName) {
      showToast('请填写 Bundle ID 或应用名称')
      return
    }
    setAutoTaskDraft(value => ({
      ...value,
      appTargets: [...value.appTargets, { bundleId, appName }],
    }))
    setAutoTaskAppDraft({ bundleId: '', appName: '' })
  }

  const handleRemoveAutoTaskApp = (index: number) => {
    setAutoTaskDraft(value => ({
      ...value,
      appTargets: value.appTargets.filter((_, itemIndex) => itemIndex !== index),
    }))
  }

  const handleAddTriggerWord = () => {
    const word = triggerWordDraft.trim()
    if (!word) return
    setAutoTaskDraft(value => value.triggerWords.some(item => item.toLocaleLowerCase() === word.toLocaleLowerCase())
      ? value
      : { ...value, triggerWords: [...value.triggerWords, word] })
    setTriggerWordDraft('')
  }

  const handleRemoveTriggerWord = (word: string) => {
    setAutoTaskDraft(value => ({
      ...value,
      triggerWords: value.triggerWords.filter(item => item !== word),
    }))
  }

  const loadTasks = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${base}/api/tasks`)
      const data = await res.json()
      setTasks(data.tasks || [])
    } catch (e) {
      showToast('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTasks() }, [])

  const handleToggle = async (id: number, enabled: boolean) => {
    await fetch(`${base}/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    loadTasks()
  }

  const handleTrigger = async (id: number) => {
    showToast('任务已触发，正在执行...')
    await fetch(`${base}/api/tasks/${id}/trigger`, { method: 'POST' })
    setTimeout(loadTasks, 2000)
  }

  const handleDelete = async (id: number) => {
    if (!confirm('确认删除此任务？')) return
    await fetch(`${base}/api/tasks/${id}`, { method: 'DELETE' })
    loadTasks()
  }

  const handleViewResult = async (task: ScheduledTask) => {
    setSelectedTask(task)
    const res = await fetch(`${base}/api/tasks/${task.id}/executions?limit=5`)
    const data = await res.json()
    setExecutions(data.executions || [])
    setView('result')
  }

  const handleCreate = async () => {
    if (!form.name || !form.user_instruction || !form.cron_expression) {
      showToast('请填写所有字段')
      return
    }
    try {
      const res = await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(err.error || '创建失败')
        return
      }
      showToast('任务创建成功')
      setForm({ name: '', user_instruction: '', cron_expression: '0 20 * * *' })
      setView('list')
      loadTasks()
    } catch (e) {
      showToast('创建失败')
    }
  }

  const handleUseTemplate = (tpl: TaskTemplate) => {
    setForm({ name: tpl.name, user_instruction: tpl.user_instruction, cron_expression: tpl.cron })
    setView('create')
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#F5F5F7' }}>
      {/* Header */}
      <div style={{ padding: '16px 16px 0', background: '#F5F5F7' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: '#000' }}>定时任务</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setView('templates')} style={{
              fontSize: 12, padding: '5px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.1)',
              background: 'white', color: '#007AFF', cursor: 'pointer',
            }}>模板库</button>
            <button onClick={() => setView('create')} style={{
              fontSize: 12, padding: '5px 10px', borderRadius: 8, border: 'none',
              background: '#007AFF', color: 'white', cursor: 'pointer',
            }}>+ 新建</button>
          </div>
        </div>

        {/* Tab bar */}
        {view !== 'list' && (
          <button onClick={() => setView('list')} style={{
            fontSize: 12, color: '#007AFF', background: 'none', border: 'none',
            cursor: 'pointer', padding: 0, marginBottom: 8,
          }}>← 返回列表</button>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px 16px' }}>

        {/* 任务列表 */}
        {view === 'list' && (
          <>
            <div style={{
              background: 'white', borderRadius: 12, padding: 16,
              border: '1px solid rgba(0,0,0,0.08)', marginBottom: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
                <button
                  onClick={handleAutoTaskToggle}
                  style={{
                    width: 38, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                    background: autoTaskConfig.enabled ? '#34C759' : '#E5E5EA', flexShrink: 0,
                    position: 'relative', transition: 'background 0.2s',
                  }}
                  title={autoTaskConfig.enabled ? '关闭自动识别任务' : '开启自动识别任务'}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: autoTaskConfig.enabled ? 18 : 2,
                    width: 18, height: 18, borderRadius: '50%', background: 'white',
                    transition: 'left 0.2s', display: 'block',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
                  }} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: '#000' }}>自动识别任务</span>
                    <span style={{
                      fontSize: 11, padding: '1px 6px', borderRadius: 4,
                      background: autoTaskConfig.enabled ? 'rgba(52,199,89,0.1)' : 'rgba(142,142,147,0.12)',
                      color: autoTaskConfig.enabled ? '#248A3D' : '#6E6E73',
                    }}>{autoTaskConfig.enabled ? '运行中' : '已关闭'}</span>
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>识别软件</label>
                <div style={{ display: 'grid', gap: 8 }}>
                  {autoTaskDraft.appTargets.map((item, index) => (
                    <div key={`${item.bundleId}-${item.appName}-${index}`} style={{
                      display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 0.9fr) auto',
                      gap: 8, alignItems: 'center',
                    }}>
                      <input
                        value={item.bundleId}
                        onChange={event => setAutoTaskDraft(value => ({
                          ...value,
                          appTargets: value.appTargets.map((target, itemIndex) => itemIndex === index
                            ? { ...target, bundleId: event.target.value }
                            : target),
                        }))}
                        placeholder="Bundle ID (如 com.tencent.xinWeChat)"
                        style={inputStyle}
                      />
                      <input
                        value={item.appName}
                        onChange={event => setAutoTaskDraft(value => ({
                          ...value,
                          appTargets: value.appTargets.map((target, itemIndex) => itemIndex === index
                            ? { ...target, appName: event.target.value }
                            : target),
                        }))}
                        placeholder="应用名称 (如 微信)"
                        style={inputStyle}
                      />
                      <button type="button" onClick={() => handleRemoveAutoTaskApp(index)} style={smallDangerButtonStyle}>
                        删除
                      </button>
                    </div>
                  ))}
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 0.9fr) auto',
                    gap: 8, alignItems: 'center',
                  }}>
                    <input
                      value={autoTaskAppDraft.bundleId}
                      onChange={event => setAutoTaskAppDraft(value => ({ ...value, bundleId: event.target.value }))}
                      placeholder="Bundle ID (如 com.bytedance.lark)"
                      style={inputStyle}
                    />
                    <input
                      value={autoTaskAppDraft.appName}
                      onChange={event => setAutoTaskAppDraft(value => ({ ...value, appName: event.target.value }))}
                      placeholder="应用名称 (如 飞书)"
                      style={inputStyle}
                    />
                    <button type="button" onClick={handleAddAutoTaskApp} style={smallPrimaryButtonStyle}>
                      添加
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label style={labelStyle}>触发词</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                  {autoTaskDraft.triggerWords.map(word => (
                    <span key={word} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      fontSize: 12, color: '#3A2A1A', background: 'rgba(181,122,43,0.12)',
                      border: '1px solid rgba(181,122,43,0.18)', borderRadius: 999,
                      padding: '4px 8px',
                    }}>
                      {word}
                      <button
                        type="button"
                        onClick={() => handleRemoveTriggerWord(word)}
                        style={{ border: 'none', background: 'transparent', color: '#8A5A1F', cursor: 'pointer', padding: 0 }}
                        title="删除触发词"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
                  <input
                    value={triggerWordDraft}
                    onChange={event => setTriggerWordDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        handleAddTriggerWord()
                      }
                    }}
                    placeholder="输入触发词后回车或点击添加"
                    style={inputStyle}
                  />
                  <button type="button" onClick={handleAddTriggerWord} style={smallPrimaryButtonStyle}>
                    添加触发词
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button onClick={handleAutoTaskSave} style={{
                  fontSize: 12, padding: '7px 12px', borderRadius: 8, border: 'none',
                  background: '#007AFF', color: 'white', cursor: 'pointer',
                }}>保存配置</button>
              </div>
            </div>

            {loading && <div style={{ textAlign: 'center', color: '#AEAEB2', padding: 20 }}>加载中...</div>}
            {!loading && tasks.length === 0 && (
              <div style={{ textAlign: 'center', color: '#AEAEB2', padding: 40 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>⏰</div>
                <div style={{ fontSize: 14 }}>还没有定时任务</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>点击「模板库」快速创建</div>
              </div>
            )}
            {tasks.map(task => (
              <TaskCard key={task.id} task={task}
                onToggle={handleToggle} onTrigger={handleTrigger}
                onDelete={handleDelete} onViewResult={handleViewResult}
              />
            ))}
          </>
        )}

        {/* 创建表单 */}
        {view === 'create' && (
          <div style={{ background: 'white', borderRadius: 12, padding: 16, border: '1px solid rgba(0,0,0,0.08)' }}>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>任务名称</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="例：每日工作日记" style={inputStyle} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>执行指令（自然语言）</label>
              <textarea value={form.user_instruction}
                onChange={e => setForm(f => ({ ...f, user_instruction: e.target.value }))}
                placeholder="描述你希望 AI 做什么，例如：请根据今天的工作记录生成工作日记..."
                style={{ ...inputStyle, height: 100, resize: 'vertical' as const }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>执行频率（Cron 表达式）</label>
              <input value={form.cron_expression}
                onChange={e => setForm(f => ({ ...f, cron_expression: e.target.value }))}
                placeholder="0 20 * * *" style={inputStyle} />
              <div style={{ fontSize: 11, color: '#AEAEB2', marginTop: 4 }}>
                {cronHint(form.cron_expression)}
                &nbsp;·&nbsp;常用：每天20点 <code>0 20 * * *</code>，每周五18点 <code>0 18 * * 5</code>
              </div>
            </div>
            <button onClick={handleCreate} style={{
              width: '100%', padding: '10px', borderRadius: 8, border: 'none',
              background: '#007AFF', color: 'white', fontSize: 14, fontWeight: 500, cursor: 'pointer',
            }}>创建任务</button>
          </div>
        )}

        {/* 模板库 */}
        {view === 'templates' && (
          <>
            {Object.entries(groupTemplatesByCategory(BUILTIN_TEMPLATES)).map(([category, tpls]) => (
              <div key={category} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: CATEGORY_COLORS[category] || '#6E6E73',
                  marginBottom: 8, paddingLeft: 2 }}>{category}</div>
                {tpls.map(tpl => (
                  <div key={tpl.id} onClick={() => handleUseTemplate(tpl)} style={{
                    background: 'white', borderRadius: 10, padding: '10px 14px',
                    border: '1px solid rgba(0,0,0,0.08)', marginBottom: 8, cursor: 'pointer',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{tpl.name}</span>
                      <span style={{ fontSize: 11, color: '#007AFF' }}>{cronHint(tpl.cron)}</span>
                    </div>
                    <p style={{ fontSize: 11, color: '#6E6E73', margin: '4px 0 0',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tpl.user_instruction}
                    </p>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {/* 执行结果 */}
        {view === 'result' && selectedTask && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{selectedTask.name} — 执行历史</div>
            {executions.map(exec => (
              <div key={exec.id} style={{
                background: 'white', borderRadius: 10, padding: 14,
                border: '1px solid rgba(0,0,0,0.08)', marginBottom: 10,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: exec.status === 'success' ? '#34C759' : '#FF3B30', fontWeight: 500 }}>
                    {exec.status === 'success' ? '成功' : exec.status === 'failed' ? '失败' : '执行中'}
                  </span>
                  <span style={{ fontSize: 11, color: '#AEAEB2' }}>
                    {formatTs(exec.started_at)}
                    {exec.latency_ms && ` · ${(exec.latency_ms / 1000).toFixed(1)}s`}
                    {exec.knowledge_count && ` · ${exec.knowledge_count} 条知识`}
                  </span>
                </div>
                {exec.result_text && (
                  <pre style={{ fontSize: 12, color: '#333', margin: 0, whiteSpace: 'pre-wrap',
                    maxHeight: 300, overflow: 'auto', lineHeight: 1.6 }}>
                    {exec.result_text}
                  </pre>
                )}
                {exec.error_message && (
                  <div style={{ fontSize: 12, color: '#FF3B30' }}>{exec.error_message}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.75)', color: 'white', padding: '8px 16px',
          borderRadius: 20, fontSize: 13, zIndex: 9999,
        }}>{toast}</div>
      )}
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: '#6E6E73', marginBottom: 6,
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
  border: '1px solid rgba(0,0,0,0.15)', outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit',
}

const smallPrimaryButtonStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '7px 10px',
  borderRadius: 8,
  border: 'none',
  background: '#007AFF',
  color: 'white',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const smallDangerButtonStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,59,48,0.18)',
  background: 'rgba(255,59,48,0.08)',
  color: '#D70015',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg, color: 'white', border: 'none', borderRadius: 6,
    padding: '5px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center',
  }
}

export default ScheduledTasksPanel
