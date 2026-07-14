import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Calendar, CheckCircle2, Edit2, NotebookText, RefreshCw } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'

type PeriodType = 'daily' | 'weekly' | 'monthly'

interface DiaryContent {
  title?: string
  summary?: string
  markdown?: string
  work_outputs?: string[]
  problems_solved?: string[]
  next_plan?: string[]
  timeline?: Array<{
    timeline_id?: number
    time?: string
    duration_minutes?: number | null
    summary?: string
    category?: string
  }>
  source_dates?: string[]
}

interface DiaryEntry {
  id: number
  period_type: PeriodType
  period_start: string
  period_end: string
  diary_date: string
  content: DiaryContent
  source_timeline_ids: number[]
  source_diary_ids: number[]
  generation_status: string
  is_system_generated: boolean
  created_at: string
  updated_at: string
}

interface LegacyProfileEntry {
  id: number
  snapshot_type: PeriodType
  snapshot_date: string
  content: DiaryContent
  is_system_generated: boolean
  created_at: string
  updated_at: string
}

interface ScheduledTaskSummary {
  id: number
  name: string
  user_instruction?: string
  template_id?: string | null
  enabled: boolean
}

const PERIOD_LABELS: Record<PeriodType, string> = {
  daily: '日记',
  weekly: '周记',
  monthly: '月记',
}

const RECENT_DAILY_CATCHUP_DAYS = 2
const AUTO_REFRESH_POLL_INTERVAL_MS = 3000
const AUTO_REFRESH_MAX_POLLS = 6

const DiaryPanel: React.FC = () => {
  const apiBaseUrl = useAppStore(state => state.apiBaseUrl)
  const [diaries, setDiaries] = useState<DiaryEntry[]>([])
  const [selectedType, setSelectedType] = useState<PeriodType>('daily')
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedDiary, setSelectedDiary] = useState<DiaryEntry | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editMarkdown, setEditMarkdown] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoRefreshMessage, setAutoRefreshMessage] = useState<string | null>(null)
  const autoRefreshKeyRef = useRef<string | null>(null)

  useEffect(() => {
    void fetchDiaries()
  }, [selectedType, selectedDate, apiBaseUrl])

  const applyDiaryEntries = (data: DiaryEntry[]) => {
    setDiaries(data)
    setSelectedDiary(current => {
      if (data.length === 0) return null
      if (current && data.some(item => item.id === current.id)) return current
      return data[0]
    })
  }

  const fetchDiaries = async (options: { skipAutoRefresh?: boolean } = {}) => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchDiaryEntries(apiBaseUrl, selectedType, selectedDate || undefined)
      applyDiaryEntries(data)
      if (!options.skipAutoRefresh && selectedType === 'daily' && !selectedDate) {
        void maybeRefreshRecentDailyDiaries(data)
      }
    } catch (err) {
      console.error('获取日记失败:', err)
      setError('日记加载失败')
    } finally {
      setLoading(false)
    }
  }

  const maybeRefreshRecentDailyDiaries = async (data: DiaryEntry[]) => {
    const missingDates = findMissingRecentDailyDates(data)
    if (missingDates.length === 0) {
      setAutoRefreshMessage(null)
      return
    }

    const refreshKey = `${apiBaseUrl}:${missingDates.join('|')}`
    if (autoRefreshKeyRef.current === refreshKey) return
    autoRefreshKeyRef.current = refreshKey

    try {
      const triggered = await triggerDailyJournalTask(apiBaseUrl)
      if (!triggered) {
        setAutoRefreshMessage(null)
        return
      }

      setAutoRefreshMessage('正在后台补齐最近日记...')
      for (let attempt = 0; attempt < AUTO_REFRESH_MAX_POLLS; attempt += 1) {
        await delay(AUTO_REFRESH_POLL_INTERVAL_MS)
        const nextData = await fetchDiaryEntries(apiBaseUrl, 'daily')
        applyDiaryEntries(nextData)
        if (findMissingRecentDailyDates(nextData).length === 0) {
          setAutoRefreshMessage('最近日记已更新')
          window.setTimeout(() => setAutoRefreshMessage(null), 2500)
          return
        }
      }

      setAutoRefreshMessage('后台日记任务已触发，生成完成后会显示在列表中')
    } catch (err) {
      console.warn('自动触发日记更新失败:', err)
      setAutoRefreshMessage(null)
      autoRefreshKeyRef.current = null
    }
  }

  const handleEdit = () => {
    if (!selectedDiary) return
    setEditMarkdown(selectedDiary.content.markdown || '')
    setIsEditing(true)
  }

  const handleSave = async () => {
    if (!selectedDiary) return
    const nextContent = {
      ...selectedDiary.content,
      markdown: editMarkdown,
      summary: firstMeaningfulLine(editMarkdown) || selectedDiary.content.summary,
    }

    const res = await fetch(`${apiBaseUrl}/api/diaries/${selectedDiary.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: nextContent }),
    })
    if (!res.ok) {
      setError('保存失败')
      return
    }
    setIsEditing(false)
    await fetchDiaries()
  }

  const periodText = useMemo(() => {
    if (!selectedDiary) return ''
    if (selectedDiary.period_start === selectedDiary.period_end) return selectedDiary.diary_date
    return `${selectedDiary.period_start} 至 ${selectedDiary.period_end}`
  }, [selectedDiary])

  return (
    <div style={{ padding: '24px', maxWidth: '1180px', margin: '0 auto', color: '#2f241b' }}>
      <header style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <NotebookText size={24} />
          工作日记
        </h1>
      </header>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '8px' }} role="tablist" aria-label="日记周期">
            {(['daily', 'weekly', 'monthly'] as PeriodType[]).map((type) => (
              <button
                key={type}
                onClick={() => {
                  setSelectedType(type)
                  setIsEditing(false)
                }}
                style={{
                  minWidth: '72px',
                  padding: '8px 14px',
                  borderRadius: '8px',
                  border: selectedType === type ? '1px solid #b56b2a' : '1px solid #e6d8c9',
                  background: selectedType === type ? '#fff2e2' : '#fffaf4',
                  color: selectedType === type ? '#8a4a16' : '#514238',
                  cursor: 'pointer',
                  fontWeight: selectedType === type ? 700 : 500,
                }}
                type="button"
              >
                {PERIOD_LABELS[type]}
              </button>
            ))}
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: '#514238', fontSize: '14px' }}>
            日期
            <input
              aria-label="选择日记日期"
              type="date"
              value={selectedDate}
              onChange={(event) => {
                setSelectedDate(event.target.value)
                setIsEditing(false)
              }}
              style={{
                height: '36px',
                borderRadius: '8px',
                border: '1px solid #e6d8c9',
                background: '#fffdf9',
                color: '#2f241b',
                padding: '0 10px',
              }}
            />
          </label>
          {selectedDate && (
            <button
              onClick={() => {
                setSelectedDate('')
                setIsEditing(false)
              }}
              style={secondaryButtonStyle}
              type="button"
            >
              清除日期
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
          {autoRefreshMessage && (
            <span role="status" style={{ color: '#8a7668', fontSize: '13px' }}>
              {autoRefreshMessage}
            </span>
          )}
          <button
            onClick={() => fetchDiaries({ skipAutoRefresh: true })}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px solid #e6d8c9',
              background: '#fffaf4',
              color: '#514238',
              cursor: 'pointer',
            }}
            type="button"
          >
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
      </div>

      {loading ? (
        <StatusBlock text="加载中..." />
      ) : error ? (
        <StatusBlock text={error} />
      ) : diaries.length === 0 ? (
        <StatusBlock text={selectedDate ? '该日期暂无日记' : '暂无日记'} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', gap: '24px' }}>
          <aside style={{ borderRight: '1px solid #eadccd', paddingRight: '20px' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Calendar size={16} />
              {PERIOD_LABELS[selectedType]}列表
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {diaries.map((diary) => (
                <button
                  key={diary.id}
                  onClick={() => {
                    setSelectedDiary(diary)
                    setIsEditing(false)
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px',
                    borderRadius: '8px',
                    border: selectedDiary?.id === diary.id ? '1px solid #b56b2a' : '1px solid #eadccd',
                    background: selectedDiary?.id === diary.id ? '#fff2e2' : '#fffdf9',
                    color: '#2f241b',
                    cursor: 'pointer',
                  }}
                  type="button"
                >
                  <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>
                    {diary.diary_date}
                  </div>
                  <div style={{ fontSize: '12px', color: '#7c6d62', display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <CheckCircle2 size={13} />
                    {diary.is_system_generated ? '系统生成' : '用户编辑'}
                  </div>
                </button>
              ))}
            </div>
          </aside>

          {selectedDiary && (
            <section style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start', marginBottom: '18px' }}>
                <div>
                  <h2 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 6px' }}>
                    {selectedDiary.content.title || `${selectedDiary.diary_date} ${PERIOD_LABELS[selectedType]}`}
                  </h2>
                  <div style={{ color: '#7c6d62', fontSize: '13px' }}>{periodText}</div>
                </div>
                {!isEditing && (
                  <button
                    onClick={handleEdit}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid #e6d8c9',
                      background: '#fffaf4',
                      color: '#514238',
                      cursor: 'pointer',
                    }}
                    type="button"
                  >
                    <Edit2 size={15} />
                    编辑
                  </button>
                )}
              </div>

              {isEditing ? (
                <div style={{ display: 'grid', gap: '12px' }}>
                  <textarea
                    value={editMarkdown}
                    onChange={(event) => setEditMarkdown(event.target.value)}
                    style={{
                      width: '100%',
                      minHeight: '360px',
                      resize: 'vertical',
                      border: '1px solid #e6d8c9',
                      borderRadius: '8px',
                      padding: '12px',
                      fontSize: '14px',
                      lineHeight: 1.6,
                      color: '#2f241b',
                      background: '#fffdf9',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button onClick={() => setIsEditing(false)} style={secondaryButtonStyle} type="button">取消</button>
                    <button onClick={handleSave} style={primaryButtonStyle} type="button">保存</button>
                  </div>
                </div>
              ) : (
                <DiaryContentView diary={selectedDiary} />
              )}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

const DiaryContentView: React.FC<{ diary: DiaryEntry }> = ({ diary }) => {
  const content = diary.content || {}
  const hasStructured = Boolean(
    content.work_outputs?.length || content.problems_solved?.length || content.next_plan?.length || content.timeline?.length
  )

  if (!hasStructured && content.markdown) {
    return <MarkdownBlock markdown={content.markdown} />
  }

  return (
    <div style={{ display: 'grid', gap: '20px' }}>
      <SectionList title="工作产出" items={content.work_outputs || []} />
      <SectionList title="问题与解决" items={content.problems_solved || []} />
      <SectionList title="后续计划" items={content.next_plan || []} />
      {content.timeline && content.timeline.length > 0 && (
        <div>
          <h3 style={sectionTitleStyle}>来源线索</h3>
          <div style={{ display: 'grid', gap: '8px' }}>
            {content.timeline.map((item, index) => (
              <div key={`${item.timeline_id || index}-${item.time || ''}`} style={{ padding: '10px 12px', border: '1px solid #eadccd', borderRadius: '8px', background: '#fffdf9' }}>
                <div style={{ fontSize: '12px', color: '#8a7668', marginBottom: '4px' }}>
                  {item.time || '未知时间'}{item.duration_minutes ? ` · ${item.duration_minutes} 分钟` : ''}{item.category ? ` · ${item.category}` : ''}
                </div>
                <div style={{ fontSize: '14px', lineHeight: 1.6 }}>{item.summary}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const SectionList: React.FC<{ title: string; items: string[] }> = ({ title, items }) => (
  <section>
    <h3 style={sectionTitleStyle}>{title}</h3>
    {items.length === 0 ? (
      <div style={{ color: '#8a7668', fontSize: '14px' }}>暂无记录</div>
    ) : (
      <ul style={{ margin: 0, paddingLeft: '18px', display: 'grid', gap: '8px' }}>
        {items.map((item, index) => (
          <li key={`${title}-${index}`} style={{ fontSize: '14px', lineHeight: 1.6 }}>{item}</li>
        ))}
      </ul>
    )}
  </section>
)

const MarkdownBlock: React.FC<{ markdown: string }> = ({ markdown }) => (
  <pre style={{
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
    padding: '14px',
    borderRadius: '8px',
    border: '1px solid #eadccd',
    background: '#fffdf9',
    color: '#3b2c22',
    fontFamily: 'inherit',
    fontSize: '14px',
    lineHeight: 1.65,
  }}>
    {markdown}
  </pre>
)

const StatusBlock: React.FC<{ text: string }> = ({ text }) => (
  <div style={{
    minHeight: '220px',
    display: 'grid',
    placeItems: 'center',
    color: '#7c6d62',
    border: '1px solid #eadccd',
    borderRadius: '8px',
    background: '#fffdf9',
  }}>
    {text}
  </div>
)

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 700,
  color: '#5a4030',
  margin: '0 0 8px',
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: '8px',
  border: '1px solid #e6d8c9',
  background: '#fffaf4',
  color: '#514238',
  cursor: 'pointer',
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: '8px',
  border: '1px solid #b56b2a',
  background: '#b56b2a',
  color: '#fffaf4',
  cursor: 'pointer',
}

function firstMeaningfulLine(markdown: string): string {
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim()
    if (line) return line.slice(0, 160)
  }
  return ''
}

async function fetchDiaryEntries(apiBaseUrl: string, periodType: PeriodType, diaryDate?: string): Promise<DiaryEntry[]> {
  const params = new URLSearchParams({
    period_type: periodType,
    limit: diaryDate ? '1' : '20',
  })
  if (diaryDate) params.set('diary_date', diaryDate)
  const diaryUrl = `${apiBaseUrl}/api/diaries?${params.toString()}`
  const diaryResp = await fetch(diaryUrl)
  if (diaryResp.ok) {
    return await diaryResp.json() as DiaryEntry[]
  }

  const diaryErrorBody = await readErrorBody(diaryResp)
  if (!isCompatiblyMissingDiaryBackend(diaryResp.status, diaryErrorBody)) {
    throw new Error(`diaries fetch failed: ${diaryResp.status}`)
  }

  const legacyResp = await fetch(`${apiBaseUrl}/api/profiles?type=${periodType}&limit=${diaryDate ? 500 : 20}`)
  if (legacyResp.ok) {
    const legacy = await legacyResp.json() as LegacyProfileEntry[]
    return legacy
      .filter(profile => !diaryDate || profile.snapshot_date === diaryDate)
      .map(profileToDiary)
  }

  const legacyErrorBody = await readErrorBody(legacyResp)
  if (isCompatiblyMissingDiaryBackend(legacyResp.status, legacyErrorBody)) {
    return []
  }

  throw new Error(`legacy profiles fetch failed: ${legacyResp.status}`)
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    return await resp.text()
  } catch {
    return ''
  }
}

function isCompatiblyMissingDiaryBackend(status: number, body: string): boolean {
  if (status === 404) return true
  return status === 500 && /no such table:\s*(diaries|user_profiles)/i.test(body)
}

function profileToDiary(profile: LegacyProfileEntry): DiaryEntry {
  return {
    id: profile.id,
    period_type: profile.snapshot_type,
    period_start: profile.snapshot_date,
    period_end: profile.snapshot_date,
    diary_date: profile.snapshot_date,
    content: profile.content || {},
    source_timeline_ids: [],
    source_diary_ids: [],
    generation_status: 'ready',
    is_system_generated: profile.is_system_generated,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  }
}

function findMissingRecentDailyDates(entries: DiaryEntry[]): string[] {
  const availableDates = new Set(
    entries
      .filter(entry => entry.period_type === 'daily')
      .map(entry => entry.diary_date),
  )
  const recentDates = recentCompletedLocalDates(RECENT_DAILY_CATCHUP_DAYS)
  const latestCompletedDate = recentDates[recentDates.length - 1]
  if (availableDates.has(latestCompletedDate)) return []
  return recentDates.filter(date => !availableDates.has(date))
}

function recentCompletedLocalDates(days: number, now = new Date()): string[] {
  const dates: string[] = []
  for (let offset = days; offset >= 1; offset -= 1) {
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - offset)
    dates.push(formatLocalDate(day))
  }
  return dates
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function triggerDailyJournalTask(apiBaseUrl: string): Promise<boolean> {
  const tasksResp = await fetch(`${apiBaseUrl}/api/tasks`)
  if (!tasksResp.ok) return false

  const data = await tasksResp.json() as { tasks?: ScheduledTaskSummary[] }
  const task = (data.tasks || []).find(task => task.enabled && isDailyJournalTask(task))
  if (!task) return false

  const triggerResp = await fetch(`${apiBaseUrl}/api/tasks/${task.id}/trigger`, { method: 'POST' })
  return triggerResp.ok
}

function isDailyJournalTask(task: ScheduledTaskSummary): boolean {
  if (task.template_id === 'daily_journal') return true
  const text = `${task.name || ''} ${task.user_instruction || ''}`.toLowerCase()
  return text.includes('工作日记') || text.includes('daily journal')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

export default DiaryPanel
