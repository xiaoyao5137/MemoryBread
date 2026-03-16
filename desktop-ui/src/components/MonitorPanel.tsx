import React, { useEffect, useState } from 'react'
import type { MonitorOverview } from '../types'
import { useAppStore } from '../store/useAppStore'

const API = 'http://localhost:7070'

const CALLER_LABELS: Record<string, string> = {
  rag: 'RAG 问答', task: '定时任务', knowledge: '知识提炼',
}
const CALLER_COLORS: Record<string, string> = {
  rag: '#007AFF', task: '#34C759', knowledge: '#AF52DE',
}
const STATUS_COLOR: Record<string, string> = {
  success: '#34C759', failed: '#FF3B30', running: '#FF9500',
}

function fmt(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtMs(ms: number | null): string {
  if (!ms) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

// ── 迷你折线图（纯 SVG）────────────────────────────────────────────────────
const SparkLine: React.FC<{ data: number[]; color: string; height?: number }> = ({
  data, color, height = 40,
}) => {
  if (!data.length) return null
  const w = 200, h = height, pad = 4
  const max = Math.max(...data, 1)
  const pts = data.map((v, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * (w - pad * 2)
    const y = h - pad - (v / max) * (h - pad * 2)
    return `${x},${y}`
  }).join(' ')
  const area = `${pad},${h - pad} ` + pts + ` ${w - pad},${h - pad}`

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#grad-${color.replace('#', '')})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

// ── 柱状图（纯 SVG）────────────────────────────────────────────────────────
const BarChart: React.FC<{
  data: { label: string; value: number; color?: string }[]
  height?: number
}> = ({ data, height = 80 }) => {
  if (!data.length) return null
  const max = Math.max(...data.map(d => d.value), 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <div style={{
            width: '100%', borderRadius: '3px 3px 0 0',
            height: Math.max((d.value / max) * (height - 20), 2),
            background: d.color || '#007AFF',
            opacity: 0.85,
          }} title={`${d.label}: ${d.value}`} />
          <span style={{ fontSize: 9, color: '#AEAEB2', textAlign: 'center',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>
            {d.label}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── 统计卡片 ────────────────────────────────────────────────────────────────
const StatCard: React.FC<{
  label: string; value: string; sub?: string; color: string
}> = ({ label, value, sub, color }) => (
  <div style={{
    background: `${color}10`, borderRadius: 10, padding: '10px 12px',
    border: `1px solid ${color}20`, flex: 1, minWidth: 0,
  }}>
    <div style={{ fontSize: 11, color: '#6E6E73', marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: '#AEAEB2', marginTop: 3 }}>{sub}</div>}
  </div>
)

// ── 主组件 ──────────────────────────────────────────────────────────────────
const MonitorPanel: React.FC = () => {
  const { apiBaseUrl } = useAppStore()
  const base = apiBaseUrl || API

  const [data, setData] = useState<MonitorOverview | null>(null)
  const [range, setRange] = useState<'1d' | '7d' | '30d'>('7d')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${base}/api/monitor/overview?range=${range}`)
      setData(await res.json())
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [range])

  if (loading && !data) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: '#AEAEB2', fontSize: 13 }}>加载中...</div>
  )

  if (!data) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: '#AEAEB2', fontSize: 13 }}>暂无数据</div>
  )

  const { token_usage, capture_flow, rag_sessions, task_executions } = data
  const trendValues = token_usage.trend.map(t => t.tokens)

  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#F5F5F7', padding: '12px 14px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>监控总览</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {(['1d', '7d', '30d'] as const).map(r => (
            <button key={r} onClick={() => setRange(r)} style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: range === r ? '#007AFF' : 'white',
              color: range === r ? 'white' : '#6E6E73',
            }}>{r === '1d' ? '今天' : r === '7d' ? '7天' : '30天'}</button>
          ))}
          <button onClick={load} style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.1)',
            background: 'white', color: '#6E6E73', cursor: 'pointer',
          }}>刷新</button>
        </div>
      </div>

      {/* 顶部统计卡片 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <StatCard label="Token 用量" value={fmt(token_usage.total_period)}
          sub={`今日 ${fmt(token_usage.total_today)}`} color="#007AFF" />
        <StatCard label="采集记录" value={fmt(capture_flow.period_count)}
          sub={`今日 ${capture_flow.today_count}`} color="#34C759" />
        <StatCard label="RAG 问答" value={String(rag_sessions.period_count)}
          sub={`均 ${fmtMs(rag_sessions.avg_latency_ms)}`} color="#AF52DE" />
        <StatCard label="任务成功率" value={`${(task_executions.success_rate * 100).toFixed(0)}%`}
          sub={`共 ${task_executions.total} 次`} color="#FF9500" />
      </div>

      {/* Token 趋势图 */}
      <div style={cardStyle}>
        <div style={sectionTitle}>Token 用量趋势</div>
        {trendValues.length > 1 ? (
          <>
            <SparkLine data={trendValues} color="#007AFF" height={50} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              {token_usage.trend.map((t, i) => (
                (i === 0 || i === Math.floor(token_usage.trend.length / 2) || i === token_usage.trend.length - 1) ? (
                  <span key={i} style={{ fontSize: 10, color: '#AEAEB2' }}>{t.date}</span>
                ) : null
              ))}
            </div>
          </>
        ) : (
          <div style={{ color: '#AEAEB2', fontSize: 12, textAlign: 'center', padding: '12px 0' }}>暂无趋势数据</div>
        )}
      </div>

      {/* 模型用量 + 来源分布 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div style={{ ...cardStyle, flex: 1 }}>
          <div style={sectionTitle}>模型用量</div>
          {token_usage.by_model.length === 0 ? (
            <div style={{ color: '#AEAEB2', fontSize: 12 }}>暂无数据</div>
          ) : token_usage.by_model.map((m, i) => {
            const pct = token_usage.total_period > 0
              ? (m.total / token_usage.total_period * 100).toFixed(0) : '0'
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: '#333', fontWeight: 500 }}>{m.model}</span>
                  <span style={{ color: '#6E6E73' }}>{fmt(m.total)} ({pct}%)</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: '#E5E5EA' }}>
                  <div style={{ height: '100%', borderRadius: 2, background: '#007AFF',
                    width: `${pct}%`, transition: 'width 0.3s' }} />
                </div>
              </div>
            )
          })}
        </div>

        <div style={{ ...cardStyle, flex: 1 }}>
          <div style={sectionTitle}>按来源分布</div>
          {token_usage.by_caller.length === 0 ? (
            <div style={{ color: '#AEAEB2', fontSize: 12 }}>暂无数据</div>
          ) : token_usage.by_caller.map((c, i) => {
            const color = CALLER_COLORS[c.caller] || '#6E6E73'
            const pct = token_usage.total_period > 0
              ? (c.total / token_usage.total_period * 100).toFixed(0) : '0'
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color, fontWeight: 500 }}>{CALLER_LABELS[c.caller] || c.caller}</span>
                  <span style={{ color: '#6E6E73' }}>{fmt(c.total)} · {c.calls}次</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: '#E5E5EA' }}>
                  <div style={{ height: '100%', borderRadius: 2, background: color,
                    width: `${pct}%`, transition: 'width 0.3s' }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 采集流水 */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={sectionTitle as any}>采集流水（今日按小时）</span>
          <span style={{ fontSize: 11, color: '#6E6E73' }}>
            知识提炼率 {(capture_flow.knowledge_rate * 100).toFixed(0)}%
          </span>
        </div>
        {capture_flow.by_hour.length > 0 ? (
          <BarChart
            data={Array.from({ length: 24 }, (_, h) => ({
              label: h % 4 === 0 ? String(h) : '',
              value: capture_flow.by_hour.find(b => b.hour === h)?.count || 0,
              color: '#34C759',
            }))}
            height={70}
          />
        ) : (
          <div style={{ color: '#AEAEB2', fontSize: 12, textAlign: 'center', padding: '12px 0' }}>今日暂无采集数据</div>
        )}
        {capture_flow.by_app.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: '#6E6E73', marginBottom: 6 }}>应用分布（Top 8）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {capture_flow.by_app.map((a, i) => (
                <div key={i} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 10,
                  background: 'rgba(52,199,89,0.1)', color: '#34C759',
                }}>{a.app} {a.count}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* RAG 问答记录 */}
      <div style={cardStyle}>
        <div style={sectionTitle}>最近问答记录</div>
        {rag_sessions.recent.length === 0 ? (
          <div style={{ color: '#AEAEB2', fontSize: 12 }}>暂无问答记录</div>
        ) : rag_sessions.recent.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 0', borderBottom: i < rag_sessions.recent.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#333', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.query}</div>
              <div style={{ fontSize: 11, color: '#AEAEB2', marginTop: 2 }}>{fmtTs(s.ts)}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {s.latency_ms && (
                <span style={{ fontSize: 11, color: '#6E6E73' }}>{fmtMs(s.latency_ms)}</span>
              )}
              <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4,
                background: 'rgba(0,122,255,0.08)', color: '#007AFF' }}>
                {s.context_count} 条
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* 定时任务执行记录 */}
      <div style={{ ...cardStyle, marginBottom: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={sectionTitle as any}>定时任务执行记录</span>
          <span style={{ fontSize: 11, color: '#6E6E73' }}>
            成功 {task_executions.success} / 失败 {task_executions.failed}
          </span>
        </div>
        {task_executions.recent.length === 0 ? (
          <div style={{ color: '#AEAEB2', fontSize: 12 }}>暂无执行记录</div>
        ) : task_executions.recent.map((e, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 0', borderBottom: i < task_executions.recent.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: STATUS_COLOR[e.status] || '#AEAEB2' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#333', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.task_name}</div>
              <div style={{ fontSize: 11, color: '#AEAEB2', marginTop: 2 }}>{fmtTs(e.started_at)}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0, fontSize: 11, color: '#6E6E73' }}>
              {e.latency_ms && <span>{fmtMs(e.latency_ms)}</span>}
              {e.knowledge_count && <span>{e.knowledge_count} 条知识</span>}
            </div>
          </div>
        ))}
      </div>

    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: 'white', borderRadius: 12, padding: '12px 14px',
  border: '1px solid rgba(0,0,0,0.07)', marginBottom: 10,
}

const sectionTitle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 10, display: 'block',
}

export default MonitorPanel
