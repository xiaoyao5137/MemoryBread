import React, { useMemo, useState } from 'react'
import type { DataExtractionSummary, DataSnapshot, DataSource } from '../../types'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './BakeShared'

type DataMetricRow = {
  dimension: string
  metric: string
  value: string
  note: string
}

type DataPresentation = {
  summary: string
  rows: DataMetricRow[]
}

const formatTimestamp = (timestamp?: number | null) => {
  if (!timestamp) return '尚未采集'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

const sourceKindLabel = (kind: DataSource['source_kind']) => (
  kind === 'report_url' ? '实时报表' : '工作记录'
)

const accessModeLabel = (mode: DataSource['access_mode']) => {
  if (mode === 'browser_session') return '浏览器会话'
  if (mode === 'direct_http') return '直接访问'
  return '本地记忆'
}

const freshnessLabel = (source: DataSource) => {
  if (!source.latest_snapshot) return '待采集'
  const ageMs = Date.now() - source.latest_snapshot.collected_at
  if (source.source_kind === 'report_url') {
    const ttlMs = Math.max(1, source.latest_snapshot.freshness_ttl_seconds) * 1000
    return ageMs <= ttlMs ? '当前可用' : '建议刷新'
  }
  if (ageMs <= 24 * 60 * 60 * 1000) return '近期数据'
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return '可能过期'
  return '历史数据'
}

const normalizeText = (value: unknown) => {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

const presentSnapshot = (snapshot: DataSnapshot): DataPresentation => {
  const structured = snapshot.structured_data ?? {}
  const rows = Array.isArray(structured.metric_rows)
    ? structured.metric_rows.flatMap((value): DataMetricRow[] => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return []
        const row = value as Record<string, unknown>
        const metric = normalizeText(row.metric)
        const metricValue = normalizeText(row.value)
        if (!metric || !metricValue) return []
        return [{
          dimension: normalizeText(row.dimension),
          metric,
          value: metricValue,
          note: normalizeText(row.note),
        }]
      })
    : []
  return {
    summary: normalizeText(structured.summary) || '这条数据尚未形成可理解的摘要',
    rows,
  }
}

const sourcePresentation = (source?: DataSource | null) => (
  source?.latest_snapshot ? presentSnapshot(source.latest_snapshot) : null
)

const BakeDataTab: React.FC<{
  items: DataSource[]
  total: number
  pendingItems?: DataSource[]
  pendingTotal?: number
  limit: number
  offset: number
  draftQuery: string
  selectedId: number | null
  loading: boolean
  extracting: boolean
  refreshingId: number | null
  deletingId?: number | null
  lastExtraction?: DataExtractionSummary | null
  onDraftQueryChange: (query: string) => void
  onSearch: () => void
  onClearSearch: () => void
  onSelect: (id: number) => void
  onPageChange: (offset: number) => void
  onLimitChange: (limit: number) => void
  onExtract: () => void
  onRefresh: (id: number) => void
  onDelete?: (id: number) => void
  onViewTimeline?: (timelineId: number) => void
}> = ({
  items,
  total,
  pendingItems = [],
  pendingTotal = pendingItems.length,
  limit,
  offset,
  draftQuery,
  selectedId,
  loading,
  extracting,
  refreshingId,
  deletingId,
  lastExtraction,
  onDraftQueryChange,
  onSearch,
  onClearSearch,
  onSelect,
  onPageChange,
  onLimitChange,
  onExtract,
  onRefresh,
  onDelete,
  onViewTimeline,
}) => {
  const allSelectableItems = useMemo(() => [...items, ...pendingItems], [items, pendingItems])
  const selected = allSelectableItems.find(item => item.id === selectedId) ?? items[0] ?? pendingItems[0]
  const selectedPresentation = sourcePresentation(selected)
  const selectedTimelineIds = selected?.latest_snapshot?.source_timeline_ids ?? []
  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const [pageInput, setPageInput] = useState('')
  const pageRowCount = useMemo(
    () => items.reduce((sum, item) => sum + (sourcePresentation(item)?.rows.length ?? 0), 0),
    [items],
  )
  const latestCollectedAt = useMemo(
    () => items.reduce((latest, item) => Math.max(latest, item.latest_snapshot?.collected_at ?? 0), 0),
    [items],
  )

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <BakeCard>
        <BakeSectionHeader
          title="数据"
          subtitle="每个数据来源只保留一份最新快照；新采集会覆盖旧值。每条数据都说明指标含义，无法解释含义的孤立数字不会保留。"
          right={(
            <BakeButton primary disabled={extracting} onClick={onExtract}>
              {extracting ? '提取中…' : '从记忆提取数据'}
            </BakeButton>
          )}
        />
        <form
          className="bake-list-toolbar bake-list-toolbar--repository"
          onSubmit={(event) => {
            event.preventDefault()
            onSearch()
          }}
        >
          <div className="bake-list-toolbar__repository">
            <div className="bake-list-toolbar__repository-row bake-list-toolbar__repository-row--search">
              <label className="bake-form-field bake-filter-field bake-filter-field--search">
                <span className="bake-filter-label">关键词</span>
                <input
                  className="bake-input"
                  value={draftQuery}
                  onChange={(event) => onDraftQueryChange(event.target.value)}
                  placeholder="搜索数据含义、指标、数值或来源"
                />
              </label>
              <div className="bake-list-toolbar__repository-actions bake-list-toolbar__repository-actions--search">
                <BakeButton compact primary type="submit">搜索</BakeButton>
                {draftQuery && <BakeButton compact type="button" onClick={onClearSearch}>清除</BakeButton>}
              </div>
            </div>
          </div>
        </form>

        <div className="bake-data-overview" aria-label="本页数据概况">
          <div className="bake-data-overview__item">
            <span>本页数据记录</span>
            <strong>{items.length}</strong>
          </div>
          <div className="bake-data-overview__item">
            <span>本页指标行</span>
            <strong>{pageRowCount}</strong>
          </div>
          <div className="bake-data-overview__item">
            <span>最近采集</span>
            <strong className="bake-data-overview__time">{formatTimestamp(latestCollectedAt)}</strong>
          </div>
        </div>

        {lastExtraction && (
          <div className="bake-muted" style={{ marginTop: 10 }}>
            最近处理：扫描 {lastExtraction.scanned_count} 条记忆，发现 {lastExtraction.source_created_count} 个新来源，更新 {lastExtraction.source_updated_count} 个来源，更新 {lastExtraction.snapshot_created_count} 份最新数据快照。
          </div>
        )}
      </BakeCard>

      <div className="bake-split-list-detail bake-split-list-detail--knowledge">
        <BakeCard className="bake-knowledge-list-card bake-data-list-card">
          {loading ? (
            <div className="bake-muted">正在加载数据记录…</div>
          ) : items.length === 0 && pendingItems.length === 0 ? (
            <div className="bake-muted">尚未提取到含义明确的数据。浏览包含指标和数值的报表、文档或工作消息后，可重新提取。</div>
          ) : (
            <div className="bake-data-list-sections">
              <section className="bake-data-list-group" aria-labelledby="bake-data-records-title">
                <div className="bake-data-list-group__heading">
                  <span id="bake-data-records-title">数据记录</span>
                  <span>{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <div className="bake-muted">当前没有含义明确的数据记录。</div>
                ) : (
                  <div className="bake-list bake-knowledge-list">
                    {items.map((item) => {
                      const presentation = sourcePresentation(item)!
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onSelect(item.id)}
                          className={`bake-list-item bake-knowledge-list-item bake-data-record-item ${item.id === selected?.id ? 'bake-list-item--active' : ''}`.trim()}
                        >
                          <div className="bake-data-record-item__eyebrow">数据 #{item.id}</div>
                          <div className="bake-data-record-item__summary bake-line-clamp-3">{presentation.summary}</div>
                          <div className="bake-data-record-item__source bake-line-clamp-1">来源：{item.title}</div>
                          <div className="bake-memory-list-item__meta">
                            <span>{presentation.rows.length} 行指标</span>
                            <span>{freshnessLabel(item)}</span>
                            <span>{formatTimestamp(item.latest_snapshot?.collected_at)}</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>

              {pendingItems.length > 0 && (
                <details className="bake-data-pending" open={items.length === 0}>
                  <summary>待采集来源 <span>{pendingTotal}</span></summary>
                  <div className="bake-list bake-data-pending__list">
                    {pendingItems.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onSelect(item.id)}
                        className={`bake-list-item bake-knowledge-list-item bake-data-source-item ${item.id === selected?.id ? 'bake-list-item--active' : ''}`.trim()}
                      >
                        <div className="bake-data-record-item__eyebrow">来源 #{item.id}</div>
                        <div className="bake-list-item__title bake-line-clamp-2">{item.title}</div>
                        <div className="bake-memory-list-item__meta">
                          <span>{sourceKindLabel(item.source_kind)}</span>
                          <span>尚无数据快照</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          <div className="bake-pagination bake-pagination--extended">
            <div className="bake-pagination__controls">
              <BakeButton compact disabled={offset === 0} onClick={() => onPageChange(Math.max(0, offset - limit))}>上一页</BakeButton>
              <BakeButton compact disabled={offset + limit >= total} onClick={() => onPageChange(offset + limit)}>下一页</BakeButton>
            </div>
            <div className="bake-pagination__summary-group bake-muted">
              <span className="bake-pagination__summary">共 {total} 条数据</span>
              <span className="bake-pagination__summary">第 {page}/{totalPages} 页</span>
            </div>
            <div className="bake-pagination__right">
              <label className="bake-pagination__field">
                <span className="bake-muted">每页</span>
                <select className="bake-input bake-pagination__select" value={String(limit)} onChange={(event) => onLimitChange(Number(event.target.value))}>
                  {[10, 20, 50, 100].map(option => <option key={option} value={option}>{option} 条</option>)}
                </select>
              </label>
              <div className="bake-pagination__jump">
                <span className="bake-muted">第</span>
                <input
                  className="bake-input bake-pagination__input"
                  type="number"
                  min={1}
                  max={totalPages}
                  value={pageInput}
                  onChange={(event) => setPageInput(event.target.value)}
                  placeholder={String(page)}
                  aria-label="页码"
                />
                <span className="bake-muted">页</span>
                <BakeButton compact onClick={() => {
                  const target = Number(pageInput)
                  if (!Number.isFinite(target) || target < 1) return
                  onPageChange((Math.min(totalPages, Math.floor(target)) - 1) * limit)
                  setPageInput('')
                }}>前往</BakeButton>
              </div>
            </div>
          </div>
        </BakeCard>

        <BakeCard className="bake-knowledge-detail-card bake-data-detail-card">
          {selected && selectedPresentation && selected.latest_snapshot ? (
            <div className="bake-kv bake-capture-detail bake-knowledge-detail">
              <div className="bake-data-detail-heading">
                <div className="bake-data-detail-heading__label">数据 #{selected.id}</div>
                <div className="bake-data-detail-heading__summary">{selectedPresentation.summary}</div>
                <div className="bake-inline-pills" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                  <BakePill text={`${selectedPresentation.rows.length} 行指标`} />
                  <BakePill text={freshnessLabel(selected)} />
                  <BakePill text={`数据时间 ${formatTimestamp(selected.latest_snapshot.observed_at ?? selected.latest_snapshot.collected_at)}`} />
                </div>
              </div>

              <div className="bake-knowledge-detail__section bake-data-detail-section">
                <div className="bake-kv__title">数据表</div>
                {selectedPresentation.rows.length > 0 ? (
                  <div className="bake-data-table-wrap">
                    <table className="bake-data-table">
                      <thead>
                        <tr>
                          <th scope="col">对象 / 范围</th>
                          <th scope="col">指标</th>
                          <th scope="col">数值</th>
                          <th scope="col">说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedPresentation.rows.map((row, index) => (
                          <tr key={`${row.dimension}-${row.metric}-${row.value}-${index}`}>
                            <td>{row.dimension || '整体'}</td>
                            <th scope="row">{row.metric}</th>
                            <td className="bake-data-table__value">{row.value}</td>
                            <td>{row.note || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="bake-muted">这条数据需要重新提炼，当前不参与有效数据召回。</div>
                )}
              </div>

              <div className="bake-knowledge-detail__section bake-data-detail-section">
                <div className="bake-kv__title">来源与关联</div>
                <dl className="bake-data-source-meta">
                  <div><dt>数据 ID</dt><dd>#{selected.id}</dd></div>
                  <div><dt>快照 ID</dt><dd>#{selected.latest_snapshot.id}</dd></div>
                  <div><dt>来源</dt><dd>{selected.title}</dd></div>
                  <div><dt>类型</dt><dd>{sourceKindLabel(selected.source_kind)}</dd></div>
                  <div><dt>采集方式</dt><dd>{accessModeLabel(selected.access_mode)}</dd></div>
                  <div><dt>采集时间</dt><dd>{formatTimestamp(selected.latest_snapshot.collected_at)}</dd></div>
                </dl>
                <div className="bake-data-timeline-links">
                  <span className="bake-muted">关联时间线</span>
                  {selectedTimelineIds.length > 0 ? selectedTimelineIds.map(timelineId => (
                    <button
                      key={timelineId}
                      type="button"
                      className="bake-stat-chip bake-stat-chip--button"
                      onClick={() => onViewTimeline?.(timelineId)}
                    >
                      时间线 #{timelineId}
                    </button>
                  )) : <span className="bake-muted">暂无</span>}
                </div>
                <div className="bake-muted bake-data-source-note">
                  {selected.source_kind === 'report_url'
                    ? '需要当前数据时可即时刷新。登录态页面会在原浏览器安全上下文中读取，Cookie 不会保存到记忆面包。'
                    : '这份数据从本地文档或工作消息中提取，时间较久时应结合来源时间线核对统计周期与口径。'}
                </div>
                {selected.last_error_code && <div className="bake-data-error">最近刷新失败：{selected.last_error_code}</div>}
              </div>

              <details className="bake-data-disclosure">
                <summary>查看完整采集内容</summary>
                <div className="bake-data-content">{selected.latest_snapshot.content_text || '暂无完整采集内容'}</div>
              </details>

              <div className="bake-actions--primary">
                {selectedTimelineIds[0] && (
                  <BakeButton onClick={() => onViewTimeline?.(selectedTimelineIds[0])}>关联时间线</BakeButton>
                )}
                {selected.source_kind === 'report_url' && (
                  <BakeButton primary disabled={refreshingId === selected.id} onClick={() => onRefresh(selected.id)}>
                    {refreshingId === selected.id ? '刷新中…' : '即时刷新数据'}
                  </BakeButton>
                )}
                {selected.source_url && (
                  <BakeButton onClick={() => window.open(selected.source_url!, '_blank', 'noopener,noreferrer')}>打开原始来源</BakeButton>
                )}
                {onDelete && (
                  <BakeButton danger disabled={deletingId === selected.id} onClick={() => onDelete(selected.id)}>
                    {deletingId === selected.id ? '删除中…' : '删除数据'}
                  </BakeButton>
                )}
              </div>
            </div>
          ) : selected ? (
            <div className="bake-kv bake-capture-detail bake-knowledge-detail">
              <div>
                <div className="bake-data-record-item__eyebrow">来源 #{selected.id}</div>
                <div className="bake-title" style={{ fontSize: 18 }}>尚未采集到数据</div>
                <div className="bake-muted" style={{ marginTop: 6 }}>该地址仅作为待采集来源，不计入数据条数和分页。</div>
              </div>
              <div className="bake-knowledge-detail__section bake-data-detail-section">
                <div className="bake-kv__title">待采集来源</div>
                <dl className="bake-data-source-meta">
                  <div><dt>来源 ID</dt><dd>#{selected.id}</dd></div>
                  <div><dt>来源</dt><dd>{selected.title}</dd></div>
                  <div><dt>类型</dt><dd>{sourceKindLabel(selected.source_kind)}</dd></div>
                  <div><dt>访问方式</dt><dd>{accessModeLabel(selected.access_mode)}</dd></div>
                  <div><dt>发现时间</dt><dd>{formatTimestamp(selected.last_seen_at)}</dd></div>
                </dl>
                {selected.source_url && <div className="bake-data-source-url">{selected.source_url}</div>}
              </div>
              <div className="bake-actions--primary">
                {selected.source_kind === 'report_url' && (
                  <BakeButton primary disabled={refreshingId === selected.id} onClick={() => onRefresh(selected.id)}>
                    {refreshingId === selected.id ? '采集中…' : '采集数据'}
                  </BakeButton>
                )}
                {selected.source_url && (
                  <BakeButton onClick={() => window.open(selected.source_url!, '_blank', 'noopener,noreferrer')}>打开原始来源</BakeButton>
                )}
                {onDelete && (
                  <BakeButton danger disabled={deletingId === selected.id} onClick={() => onDelete(selected.id)}>
                    {deletingId === selected.id ? '删除中…' : '删除来源'}
                  </BakeButton>
                )}
              </div>
            </div>
          ) : <div className="bake-muted">选择一条数据记录查看摘要、数据表和来源。</div>}
        </BakeCard>
      </div>
    </div>
  )
}

export default BakeDataTab
