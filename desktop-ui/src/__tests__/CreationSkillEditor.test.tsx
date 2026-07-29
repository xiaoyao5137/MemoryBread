import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import CreationSkillEditor from '../components/CreationSkillEditor'
import { OFFLINE_CREATION_SKILL_CATEGORIES } from '../data/creationSkillCategories'
import { useAppStore } from '../store/useAppStore'
import {
  DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
  DEFAULT_CREATION_SKILL_FIELD_EXAMPLES,
  DEFAULT_CREATION_SKILL_SECTION_HEADINGS,
} from '../utils/creationSkills'

const analysis = {
  title: '跨部门技术沟通会文档',
  summary: '适合架构师组织跨部门技术沟通，目标是统一系统边界、技术取舍和行动项。',
  common_titles: ['技术方案沟通会材料'],
  title_style: '标题明确场景与交付目标。',
  text_style: '结论先行，取舍有据。',
  diagram_style: '使用分层架构图和关键链路图。',
  structure_pattern: ['背景与目标', '方案边界', '关键取舍', '行动项'],
  writing_guidelines: ['每个结论写明负责人和下一步。'],
  suggested_category_keywords: ['互联网', '企业服务', '架构师', '技术架构设计文档'],
  analysis_mode: 'local_model',
}

beforeEach(() => {
  useAppStore.getState().reset()
  useAppStore.getState().setApiBaseUrl('http://127.0.0.1:7070')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('沉淀技能', () => {
  it('模型输出格式异常时不误报为模型服务不可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/creation-skill-categories') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/api/creation/skills/analyze') {
        return Response.json({
          ...analysis,
          section_headings: DEFAULT_CREATION_SKILL_SECTION_HEADINGS,
          field_examples: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES,
          example_document: DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
          analysis_mode: 'heuristic_fallback',
          fallback_reason: 'invalid_model_output',
        })
      }
      if (url.pathname === '/api/creation/skills' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        return Response.json(
          { ...body, id: 29, created_at: 1, updated_at: 2 },
          { status: 201 },
        )
      }
      return new Response('', { status: 404 })
    }))

    render(<CreationSkillEditor
      source={{
        kind: 'bake_document',
        id: 'doc-invalid-json',
        title: '协作流程说明',
        content: '# 背景与目标\n说明协作问题。\n## 方案设计\n明确角色、动作与验收证据。',
        docType: '实施方案',
      }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />)

    expect(await screen.findByText(/本地模型已完成推理，但返回格式未通过校验/)).toBeInTheDocument()
    expect(screen.queryByText(/本地模型服务暂时不可用/)).not.toBeInTheDocument()
  })

  it('展示百分比分析进度，并自动保存为未安装草稿后由用户完成保存', async () => {
    const savedBodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/creation-skill-categories') {
        return new Response(JSON.stringify({
          data: OFFLINE_CREATION_SKILL_CATEGORIES.map(item => ({
            id: item.id,
            key: item.key,
            name: item.name,
            level: item.level,
            parent_id: item.parentId,
            sort_order: item.sortOrder,
          })),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.pathname === '/api/creation/skills/analyze') {
        await new Promise(resolve => window.setTimeout(resolve, 40))
        return new Response(JSON.stringify(analysis), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.pathname === '/api/creation/skills' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        savedBodies.push(body)
        return new Response(JSON.stringify({ ...body, id: 17, created_at: 1, updated_at: savedBodies.length + 1 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.pathname === '/api/creation/skills/17' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        savedBodies.push(body)
        return new Response(JSON.stringify({ ...body, id: 17, created_at: 1, updated_at: savedBodies.length + 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('', { status: 404 })
    }))
    const onSaved = vi.fn()

    render(<CreationSkillEditor
      source={{
        kind: 'bake_document',
        id: 'doc-17',
        title: '研发中心跨部门技术沟通会纪要',
        content: '# 目标\n统一系统边界。\n## 方案\n讨论关键取舍与行动项。',
        docType: '技术架构设计文档',
      }}
      onClose={vi.fn()}
      onSaved={onSaved}
    />)

    expect(screen.getByRole('progressbar', { name: '本机分析进度' })).toHaveAttribute('aria-valuenow', '6')

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft', installed: false }))
    }, { timeout: 2500 })
    expect(screen.queryByText('把这份文档的写法提炼成可复用的创作配方；所有分析先在本机完成。')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.getByRole('option', { name: '互联网' })).toHaveAttribute('aria-selected', 'true')
    expect(savedBodies[0]).toMatchObject({ status: 'draft', installed: false })
    expect(screen.getByRole('heading', { name: '标题设计风格' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '行文设计思路' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '图片生成方式' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '话术表达风格' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '章节组织骨架' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('常用结构提炼结果')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('标题风格提炼结果')).not.toBeInTheDocument()
    const exampleDocument = (screen.getByLabelText('完整示例文档') as HTMLTextAreaElement).value
    expect(exampleDocument).toContain('共享评审空间预约流程优化方案')
    expect(exampleDocument.length).toBeGreaterThanOrEqual(1000)
    expect(exampleDocument.match(/^##\s+/gm)?.length).toBeGreaterThanOrEqual(6)
    expect(screen.getByText(/草稿已自动保存在本机/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    await waitFor(() => {
      expect(savedBodies.some(body => body.status === 'saved' && body.installed === false)).toBe(true)
    })
  })

  it('编辑已有内容时显示“编辑技能”并使用级联选项卡', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/creation-skill-categories') {
        return new Response(JSON.stringify({
          data: OFFLINE_CREATION_SKILL_CATEGORIES.map(item => ({
            id: item.id,
            key: item.key,
            name: item.name,
            level: item.level,
            parent_id: item.parentId,
            sort_order: item.sortOrder,
          })),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('', { status: 404 })
    }))
    const categoryId = OFFLINE_CREATION_SKILL_CATEGORIES.find(item => item.key === 'enterprise-architecture-design-doc')!.id

    render(<CreationSkillEditor
      initialSkill={{
        id: 21,
        clientSkillKey: 'skill-21',
        cloudSkillId: 'cloud-skill-21',
        sourceKind: 'bake_document',
        sourceId: 'doc-21',
        title: '技术架构创作方法',
        summary: '用于技术架构设计。',
        categoryId,
        skillDescription: {
          purpose: '用于把目标、约束和证据组织成技术架构设计文档。',
          documentTypes: ['技术架构设计文档'],
          problems: ['澄清系统边界与关键取舍'],
          domains: ['软件架构'],
          deliverables: ['可评审的架构设计文档'],
        },
        executionSteps: [{
          id: 'design-solution',
          title: '设计总体方案',
          objective: '把约束和证据转化为架构方案。',
          output: '总体方案与关键设计',
          agents: ['solution_design_agent'],
          skills: [],
          tools: ['plantuml_diagram'],
        }],
        commonTitles: ['总体架构设计'],
        titleStyle: '结论先行。',
        textStyle: '清晰正式。',
        diagramStyle: '分层架构图。',
        structurePattern: ['背景', '总体设计'],
        writingGuidelines: [],
        distinctiveSections: [{
          title: '定义先行',
          description: '先说明核心对象是什么。',
          guidance: '对象首次出现时先给通俗解释，再补边界。',
          examples: ['协作工作台可以理解为任务流转的统一入口。'],
        }],
        sectionHeadings: { ...DEFAULT_CREATION_SKILL_SECTION_HEADINGS },
        fieldExamples: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES,
        exampleDocument: DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
        status: 'saved',
        installed: false,
        published: true,
        createdAt: 1,
        updatedAt: 2,
      }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />)

    expect(screen.getByRole('heading', { name: '编辑技能' })).toBeInTheDocument()
    expect(screen.queryByText('把这份文档的写法提炼成可复用的创作配方；所有分析先在本机完成。')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('option', { name: '企业服务' })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /发布|开放到市场|更新市场版本|下架市场/ })).not.toBeInTheDocument()
    expect(screen.queryByText('发布边界')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('定义先行')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除特色亮点 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加特色章节' })).toBeInTheDocument()
  })
})
