import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import BakeDataTab from '../components/bake/BakeDataTab'
import type { DataSource } from '../types'

const pendingSource: DataSource = {
  id: 1,
  title: '经营数据看板',
  source_kind: 'report_url',
  source_url: 'https://bi.example.com/dashboard',
  access_mode: 'browser_session',
  refresh_policy: 'on_demand',
  realtime_level: 'live',
  tags: ['report'],
  first_seen_at: 1,
  last_seen_at: 2,
  status: 'active',
  latest_snapshot: null,
}

const gpuSource: DataSource = {
  id: 22,
  title: '容器云 GPU 指标采集项目',
  source_kind: 'work_memory',
  access_mode: 'memory_only',
  refresh_policy: 'never',
  realtime_level: 'observed',
  tags: ['work_memory'],
  first_seen_at: 1,
  last_seen_at: 2,
  last_collected_at: Date.now(),
  status: 'active',
  latest_snapshot: {
    id: 220,
    source_id: 22,
    collected_at: Date.now(),
    observed_at: Date.now(),
    collector: 'memory_extract',
    content_text: '背景显示国内日均 GPU 利用率为 42%，海外为 47%，但 GPUTL 无法反映硅片内 SM 的实际使用情况，存在掩盖低效的事实',
    structured_data: {
      extraction_version: 'data-memory.v2',
      summary: '日均 GPU 利用率：国内 42%，海外 47%；GPUTL 无法反映 SM 实际使用，可能掩盖实际低效',
      metric_rows: [
        { dimension: '国内', metric: '日均 GPU 利用率', value: '42%', note: 'GPUTL 可能掩盖实际低效' },
        { dimension: '海外', metric: '日均 GPU 利用率', value: '47%', note: '' },
      ],
    },
    content_hash: 'gpu-hash',
    freshness_ttl_seconds: 0,
    provenance: { source: 'timeline' },
    source_capture_ids: [42],
    source_timeline_ids: [71],
    status: 'success',
  },
}

const orderSource: DataSource = {
  ...gpuSource,
  id: 23,
  title: '项目群周度数据',
  latest_snapshot: {
    ...gpuSource.latest_snapshot!,
    id: 230,
    source_id: 23,
    content_text: '本周订单 1200，环比增长 8%',
    structured_data: {
      extraction_version: 'data-memory.v2',
      summary: '本周订单 1200，环比增长 8%',
      metric_rows: [
        { dimension: '本周', metric: '订单', value: '1200', note: '' },
        { dimension: '', metric: '环比增长', value: '8%', note: '' },
      ],
    },
    source_timeline_ids: [72],
  },
}

const renderDataTab = (overrides: Partial<React.ComponentProps<typeof BakeDataTab>> = {}) => {
  const props: React.ComponentProps<typeof BakeDataTab> = {
    items: [gpuSource],
    total: 1,
    pendingItems: [pendingSource],
    pendingTotal: 1,
    limit: 20,
    offset: 0,
    draftQuery: '',
    selectedId: 22,
    loading: false,
    extracting: false,
    refreshingId: null,
    deletingId: null,
    onDraftQueryChange: vi.fn(),
    onSearch: vi.fn(),
    onClearSearch: vi.fn(),
    onSelect: vi.fn(),
    onPageChange: vi.fn(),
    onLimitChange: vi.fn(),
    onExtract: vi.fn(),
    onRefresh: vi.fn(),
    onDelete: vi.fn(),
    onViewTimeline: vi.fn(),
    ...overrides,
  }
  render(<BakeDataTab {...props} />)
  return props
}

describe('BakeDataTab', () => {
  it('以可理解的摘要和表格展示数据含义', () => {
    renderDataTab()

    expect(screen.getAllByText(/日均 GPU 利用率：国内 42%，海外 47%/).length).toBeGreaterThanOrEqual(2)
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: '对象 / 范围' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: '指标' })).toBeInTheDocument()
    expect(within(table).getByText('国内')).toBeInTheDocument()
    expect(within(table).getByText('海外')).toBeInTheDocument()
    expect(within(table).getByText('42%')).toBeInTheDocument()
    expect(within(table).getByText('47%')).toBeInTheDocument()
    expect(within(table).getByText('GPUTL 可能掩盖实际低效')).toBeInTheDocument()
  })

  it('展示数据 ID，支持跳转来源时间线和删除', () => {
    const props = renderDataTab()

    expect(screen.getAllByText('数据 #22').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('快照 ID').parentElement).toHaveTextContent('#220')
    fireEvent.click(screen.getAllByRole('button', { name: '时间线 #71' })[0])
    expect(props.onViewTimeline).toHaveBeenCalledWith(71)
    fireEvent.click(screen.getByRole('button', { name: '删除数据' }))
    expect(props.onDelete).toHaveBeenCalledWith(22)
  })

  it('把未采集地址单列为来源且不计入数据分页', () => {
    const props = renderDataTab({
      items: [gpuSource, orderSource],
      total: 2,
      pendingItems: [pendingSource],
      pendingTotal: 1,
      limit: 10,
      selectedId: 1,
    })

    expect(screen.getAllByText('待采集来源').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('来源 #1').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('共 2 条数据')).toBeInTheDocument()
    expect(screen.getByText('第 1/1 页')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '采集数据' }))
    expect(props.onRefresh).toHaveBeenCalledWith(1)
  })

  it('当前页统计直接使用后端返回的数据，不再分页后二次过滤', () => {
    renderDataTab({
      items: [gpuSource, orderSource],
      total: 2,
      pendingItems: [],
      pendingTotal: 0,
    })

    expect(screen.getByLabelText('本页数据概况')).toHaveTextContent('本页数据记录2')
    expect(screen.getByLabelText('本页数据概况')).toHaveTextContent('本页指标行4')
    expect(screen.getAllByText(/本周订单 1200/).length).toBeGreaterThanOrEqual(1)
  })
})
