import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BakeTemplatesTab from '../components/bake/BakeTemplatesTab'
import BakeSopTab from '../components/bake/BakeSopTab'
import type { ArticleTemplate, SopCandidate } from '../types'

const noop = vi.fn()

const template: ArticleTemplate = {
  id: 'tpl-1',
  title: '周报模板',
  docType: 'weekly_report',
  status: 'enabled',
  tags: ['周报'],
  applicableTasks: ['creation'],
  sourceMemoryIds: ['m-1'],
  linkedKnowledgeIds: ['k-1'],
  sections: [
    { title: '背景', keywords: ['背景'] },
    { title: '进展', keywords: ['进展'] },
  ],
  stylePhrases: ['整体看', '先结论后展开'],
  replacementRules: [{ from: '综上所述', to: '整体看' }],
  promptHint: '先总结再细化',
  usageCount: 3,
  reviewStatus: 'confirmed',
}

const sop: SopCandidate = {
  id: 'sop-1',
  sourceCaptureId: 'c-1',
  sourceTitle: '启动失败排查',
  triggerKeywords: ['启动失败', 'health'],
  confidence: 'high',
  extractedProblem: '服务无法启动',
  steps: ['检查 /health', '检查端口', '查看日志'],
  linkedKnowledgeIds: ['101', '202'],
  linkedKnowledgeSummaries: [
    { id: '101', summary: '排查服务健康检查失败' },
    { id: '202', summary: '启动端口冲突的处理步骤' },
  ],
  status: 'confirmed',
}

describe('Bake 详情展示优化', () => {
  it('模板详情使用更明确的结构/风格说明文案', () => {
    render(
      <BakeTemplatesTab
        templates={[template]}
        total={1}
        limit={20}
        offset={0}
        query=""
        selectedTemplateId={template.id}
        onSelectTemplate={noop}
        onCreateTemplate={noop}
        onUpdateTemplate={noop}
        onToggleTemplateStatus={noop}
        onAdoptTemplate={noop}
        onDeleteTemplate={noop}
        onViewSourceMemory={noop}
        onPageChange={noop}
        onLimitChange={noop}
        onQueryChange={noop}
      />,
    )

    expect(screen.getByText('结构骨架（决定输出结构）')).toBeInTheDocument()
    expect(screen.getByText('表达风格（决定措辞）')).toBeInTheDocument()
    expect(screen.getByText('常用短语：整体看、先结论后展开')).toBeInTheDocument()
  })

  it('SOP详情不展示原始关联ID与工作提示预览', () => {
    render(
      <BakeSopTab
        candidates={[sop]}
        total={1}
        limit={20}
        offset={0}
        query=""
        selectedSopId={sop.id}
        onSelectSop={noop}
        onDeleteSop={noop}
        onViewLinkedKnowledge={noop}
        onCopySteps={noop}
        onPageChange={noop}
        onLimitChange={noop}
        onQueryChange={noop}
      />,
    )

    expect(screen.getByText('关联知识')).toBeInTheDocument()
    expect(screen.getByText('已关联 2 条知识（用于补充背景和术语）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '排查服务健康检查失败' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '启动端口冲突的处理步骤' })).toBeInTheDocument()
    expect(screen.queryByText('101、202')).not.toBeInTheDocument()
    expect(screen.queryByText('工作提示预览')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制工作提示' })).not.toBeInTheDocument()
  })

  it('SOP关联知识摘要支持点击查看', () => {
    const onViewLinkedKnowledge = vi.fn()

    render(
      <BakeSopTab
        candidates={[sop]}
        total={1}
        limit={20}
        offset={0}
        query=""
        selectedSopId={sop.id}
        onSelectSop={noop}
        onDeleteSop={noop}
        onViewLinkedKnowledge={onViewLinkedKnowledge}
        onCopySteps={noop}
        onPageChange={noop}
        onLimitChange={noop}
        onQueryChange={noop}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '排查服务健康检查失败' }))
    expect(onViewLinkedKnowledge).toHaveBeenCalledWith('101')
  })
})
