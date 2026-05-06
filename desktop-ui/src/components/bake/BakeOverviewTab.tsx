import React, { useMemo } from 'react'
import type { BakeOverview, TimelineItem } from '../../types'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './BakeShared'

const BakeOverviewTab: React.FC<{
  memories: TimelineItem[]
  overview: BakeOverview
  onOpenMemory: (id: string) => void
  onOpenTab: (tab: 'knowledge' | 'templates' | 'sop') => void
  onOpenRepository: (tab: 'memory' | 'capture') => void
}> = ({ memories, overview, onOpenMemory, onOpenTab, onOpenRepository }) => {
  const pendingItems = useMemo(() => memories.filter(item => item.status === 'candidate').slice(0, 3), [memories])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="bake-grid-4">
        <BakeCard><div className="bake-muted">时间线</div><div className="bake-stat-value">{overview.memoryCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">知识</div><div className="bake-stat-value">{overview.knowledgeCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">设计</div><div className="bake-stat-value">{overview.templateCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">采集记录</div><div className="bake-stat-value">{overview.captureCount}</div></BakeCard>
      </div>

      <BakeCard>
        <BakeSectionHeader title="生产关系" subtitle="时间线可提炼为知识/设计/操作手册；采集只承接时间线与采集记录回溯" right={<BakePill text="时间线 → 知识 / 设计 / 操作手册；采集 → 时间线 / 采集记录" />} />
        <div className="bake-list">
          <div className="bake-list-item">
            <div className="bake-inline-meta">
              <div style={{ minWidth: 0 }}>
                <div className="bake-list-item__title">采集导航</div>
                <div className="bake-muted" style={{ lineHeight: 1.7 }}>在收藏里继续做知识/设计/操作手册提炼；在采集里浏览时间线与采集记录，回溯原始上下文。</div>
              </div>
            </div>
            <div className="bake-actions--secondary" style={{ marginTop: 12 }}>
              <BakeButton compact onClick={() => onOpenRepository('memory')}>时间线</BakeButton>
              <BakeButton compact onClick={() => onOpenRepository('capture')}>采集记录</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('knowledge')}>知识</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('templates')}>设计</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('sop')}>操作手册</BakeButton>
            </div>
          </div>
        </div>
      </BakeCard>

      <div className="bake-split-overview">
        <BakeCard>
          <BakeSectionHeader title="待处理时间线" subtitle="优先把最近最有价值的时间线提炼出来" right={<BakePill text="先识别，再提炼" />} />
          <div className="bake-list">
            {pendingItems.map(item => (
              <div key={item.id} className="bake-list-item">
                <div className="bake-inline-meta">
                  <div style={{ minWidth: 0 }}>
                    <div className="bake-list-item__title bake-line-clamp-2">{item.title}</div>
                    <div className="bake-muted bake-line-clamp-2">{item.summary}</div>
                    <div className="bake-muted" style={{ marginTop: 8 }}>
                      停留 {item.dwellSeconds}s · 打开 {item.openCount} 次 · 重复观察 {item.knowledgeRefCount} 次
                    </div>
                  </div>
                  <BakeButton primary onClick={() => onOpenMemory(item.id)}>去提炼</BakeButton>
                </div>
              </div>
            ))}
          </div>
        </BakeCard>

        <div style={{ display: 'grid', gap: 16 }}>
          <BakeCard>
            <div className="bake-section-title">仓库概览</div>
            <div className="bake-list">
              <div className="bake-muted">时间线 {overview.memoryCount}</div>
              <div className="bake-muted">知识 {overview.knowledgeCount}</div>
              <div className="bake-muted">文档模板 {overview.templateCount}</div>
              <div className="bake-muted">采集记录 {overview.captureCount}</div>
            </div>
          </BakeCard>
          <BakeCard>
            <div className="bake-section-title">最近处理流水</div>
            <div className="bake-list">
              {overview.recentActivities.map(item => (
                <div key={item} className="bake-muted">• {item}</div>
              ))}
            </div>
          </BakeCard>
        </div>
      </div>
    </div>
  )
}

export default BakeOverviewTab
