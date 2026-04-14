import React, { useMemo } from 'react'
import type { BakeOverview, EpisodicMemoryItem } from '../../types'
import { BakeButton, BakeCard, BakePill, BakeSectionHeader } from './BakeShared'

const BakeOverviewTab: React.FC<{
  memories: EpisodicMemoryItem[]
  overview: BakeOverview
  onOpenMemory: (id: string) => void
  onOpenTab: (tab: 'knowledge' | 'templates' | 'sop') => void
  onOpenRepository: (tab: 'memory' | 'capture') => void
}> = ({ memories, overview, onOpenMemory, onOpenTab, onOpenRepository }) => {
  const pendingItems = useMemo(() => memories.filter(item => item.status === 'candidate').slice(0, 3), [memories])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="bake-grid-4">
        <BakeCard><div className="bake-muted">情节记忆</div><div className="bake-stat-value">{overview.memoryCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">知识</div><div className="bake-stat-value">{overview.knowledgeCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">文档模板（面包片）</div><div className="bake-stat-value">{overview.templateCount}</div></BakeCard>
        <BakeCard><div className="bake-muted">记忆片段</div><div className="bake-stat-value">{overview.captureCount}</div></BakeCard>
      </div>

      <BakeCard>
        <BakeSectionHeader title="生产关系" subtitle="情节记忆可提炼为知识/模板/SOP；醒发箱只承接情节记忆与记忆片段回溯" right={<BakePill text="情节记忆 → 知识 / 面包片 / 火腿；醒发箱 → 情节记忆 / 记忆片段" />} />
        <div className="bake-list">
          <div className="bake-list-item">
            <div className="bake-inline-meta">
              <div style={{ minWidth: 0 }}>
                <div className="bake-list-item__title">醒发箱导航</div>
                <div className="bake-muted" style={{ lineHeight: 1.7 }}>在烤面包里继续做知识/模板/SOP 提炼；在醒发箱里浏览情节记忆与记忆片段，回溯原始上下文。</div>
              </div>
            </div>
            <div className="bake-actions--secondary" style={{ marginTop: 12 }}>
              <BakeButton compact onClick={() => onOpenRepository('memory')}>情节记忆</BakeButton>
              <BakeButton compact onClick={() => onOpenRepository('capture')}>记忆片段</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('knowledge')}>知识</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('templates')}>文档模板</BakeButton>
              <BakeButton compact onClick={() => onOpenTab('sop')}>操作手册</BakeButton>
            </div>
          </div>
        </div>
      </BakeCard>

      <div className="bake-split-overview">
        <BakeCard>
          <BakeSectionHeader title="待处理情节记忆" subtitle="优先把最近最有价值的情节记忆提炼出来" right={<BakePill text="先识别，再提炼" />} />
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
              <div className="bake-muted">情节记忆 {overview.memoryCount}</div>
              <div className="bake-muted">知识 {overview.knowledgeCount}</div>
              <div className="bake-muted">文档模板 {overview.templateCount}</div>
              <div className="bake-muted">记忆片段 {overview.captureCount}</div>
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
