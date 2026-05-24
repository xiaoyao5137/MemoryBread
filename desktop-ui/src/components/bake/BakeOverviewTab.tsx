import React from 'react'
import type { BakeOverview } from '../../types'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './BakeShared'

const BakeOverviewTab: React.FC<{
  overview: BakeOverview
  onOpenTab: (tab: 'knowledge' | 'templates' | 'sop') => void
  onOpenRepository: (tab: 'memory' | 'capture') => void
}> = ({ overview, onOpenTab, onOpenRepository }) => {

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="bake-grid-4">
        <BakeCard><div className="bake-muted">时间线</div><div className="bake-stat-value">{overview.memoryCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">文档</div><div className="bake-stat-value">{overview.templateCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">知识</div><div className="bake-stat-value">{overview.knowledgeCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">采集记录</div><div className="bake-stat-value">{overview.captureCount}</div></BakeCard>
      </div>

      <BakeCard>
        <BakeSectionHeader title="生产关系" subtitle="时间线可提炼为文档/知识/操作手册；采集只承接时间线与采集记录回溯" right={<BakePill text="时间线 → 文档 / 知识 / 操作手册；采集 → 时间线 / 采集记录" />} />
        <div className="bake-list">
          <div className="bake-list-item">
            <div className="bake-inline-meta">
              <div style={{ minWidth: 0 }}>
                <div className="bake-list-item__title">采集导航</div>
                <div className="bake-muted" style={{ lineHeight: 1.7 }}>在收藏里继续做文档/知识/操作手册提炼；在采集里浏览时间线与采集记录，回溯原始上下文。</div>
              </div>
            </div>
            <div className="bake-actions--secondary" style={{ marginTop: 12 }}>
              <BakeButton compact onClick={() => onOpenRepository('memory')}>时间线</BakeButton>
              <BakeButton compact onClick={() => onOpenRepository('capture')}>采集记录</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('templates')}>文档</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('knowledge')}>知识</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('sop')}>操作手册</BakeButton>
            </div>
          </div>
        </div>
      </BakeCard>

      <div className="bake-split-overview">
        <BakeCard>
          <BakeSectionHeader title="快捷操作" subtitle="快速访问各个功能区" />
          <div className="bake-list">
            <div className="bake-list-item">
              <div className="bake-inline-meta">
                <div style={{ minWidth: 0 }}>
                  <div className="bake-list-item__title">查看时间线</div>
                  <div className="bake-muted">浏览和回溯时间线记录</div>
                </div>
                <BakeButton primary onClick={() => onOpenRepository('memory')}>打开</BakeButton>
              </div>
            </div>
            <div className="bake-list-item">
              <div className="bake-inline-meta">
                <div style={{ minWidth: 0 }}>
                  <div className="bake-list-item__title">管理文档</div>
                  <div className="bake-muted">查看和管理文档模板</div>
                </div>
                <BakeButton primary onClick={() => onOpenTab('templates')}>打开</BakeButton>
              </div>
            </div>
            <div className="bake-list-item">
              <div className="bake-inline-meta">
                <div style={{ minWidth: 0 }}>
                  <div className="bake-list-item__title">管理知识</div>
                  <div className="bake-muted">查看和管理已提炼的知识</div>
                </div>
                <BakeButton primary onClick={() => onOpenTab('knowledge')}>打开</BakeButton>
              </div>
            </div>
            <div className="bake-list-item">
              <div className="bake-inline-meta">
                <div style={{ minWidth: 0 }}>
                  <div className="bake-list-item__title">管理操作手册</div>
                  <div className="bake-muted">查看和管理操作手册</div>
                </div>
                <BakeButton primary onClick={() => onOpenTab('sop')}>打开</BakeButton>
              </div>
            </div>
          </div>
        </BakeCard>

        <div style={{ display: 'grid', gap: 16 }}>
          <BakeCard>
            <div className="bake-section-title">仓库概览</div>
            <div className="bake-list">
              <div className="bake-muted">时间线 {overview.memoryCount}</div>
              <div className="bake-muted">文档 {overview.templateCount}</div>
              <div className="bake-muted">知识 {overview.knowledgeCount}</div>
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
