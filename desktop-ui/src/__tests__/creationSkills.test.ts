import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeCreationSkill,
  buildCreationSkillInstruction,
  categoryPathFor,
  creationSkillCategoryOptions,
  DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
  DEFAULT_CREATION_SKILL_FIELD_EXAMPLES,
  DEFAULT_CREATION_SKILL_SECTION_HEADINGS,
  fetchCreationSkillCategories,
  listLocalCreationSkills,
  marketCreationSkillToLocalInput,
  matchCreationSkills,
  normalizeCreationSkillTitle,
  publishCreationSkill,
  searchCreationSkillMarket,
  suggestCreationSkillCategory,
  type CreationSkillCategory,
  type LocalCreationSkill,
} from '../utils/creationSkills'
import { OFFLINE_CREATION_SKILL_CATEGORIES } from '../data/creationSkillCategories'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const localSkill: Omit<LocalCreationSkill, 'id' | 'createdAt' | 'updatedAt'> = {
  clientSkillKey: 'local-skill-1',
  cloudSkillId: null,
  sourceKind: 'creation_history',
  sourceId: 'history-42',
  title: '技术架构设计文档写作法',
  summary: '帮助架构师稳定产出可评审的架构设计文档。',
  categoryId: 'leaf-category',
  commonTitles: ['总体架构设计', '关键链路设计'],
  titleStyle: '结论先行，标题带明确对象。',
  textStyle: '短段落配合约束、方案和取舍。',
  diagramStyle: '统一配色并标注边界与数据流向。',
  structurePattern: ['背景与目标', '架构方案', '风险与演进'],
  writingGuidelines: ['每个决策写明原因', '敏感数据使用占位符'],
  sectionHeadings: { ...DEFAULT_CREATION_SKILL_SECTION_HEADINGS },
  fieldExamples: {
    commonTitles: [...DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.commonTitles],
    titleStyle: [...DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.titleStyle],
    textStyle: [...DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.textStyle],
    diagramStyle: [...DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.diagramStyle],
    structurePattern: [...DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.structurePattern],
    writingGuidelines: [...DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.writingGuidelines],
  },
  exampleDocument: DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
  status: 'saved',
  installed: false,
  published: false,
}

describe('创作 Skill 云端发布边界', () => {
  it('只上传结构化 Skill，不上传来源标识或原文', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({
        client_skill_key: 'local-skill-1',
        title: localSkill.title,
        category_id: 'leaf-category',
        published: true,
      })
      expect(body.content.common_titles).toEqual(localSkill.commonTitles)
      expect(body).not.toHaveProperty('source_id')
      expect(body).not.toHaveProperty('source_kind')
      expect(body).not.toHaveProperty('document_content')
      expect(JSON.stringify(body)).not.toContain('history-42')
      return new Response(JSON.stringify({ data: { id: 'cloud-1', published: true } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishCreationSkill('https://api.example.test', 'token', localSkill, true)

    expect(result).toEqual({ id: 'cloud-1', published: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('把第四级类目还原为完整行业到文档类型路径', () => {
    const categories: CreationSkillCategory[] = [
      { id: '1', key: 'internet', name: '互联网', level: 1, sortOrder: 10 },
      { id: '2', key: 'retail', name: '电商零售', level: 2, parentId: '1', sortOrder: 10 },
      { id: '3', key: 'architect', name: '架构师', level: 3, parentId: '2', sortOrder: 10 },
      { id: '4', key: 'architecture', name: '技术架构设计文档', level: 4, parentId: '3', sortOrder: 10 },
    ]

    expect(categoryPathFor(categories, '4').map(item => item.name)).toEqual([
      '互联网',
      '电商零售',
      '架构师',
      '技术架构设计文档',
    ])
  })

  it('把接口的分级列表还原为父子相邻的下拉选项', () => {
    const options = creationSkillCategoryOptions([
      { id: 'leaf-b', key: 'leaf-b', name: '接口设计文档', level: 4, parentId: 'role-b', sortOrder: 20 },
      { id: 'industry-b', key: 'industry-b', name: '金融', level: 1, sortOrder: 20 },
      { id: 'segment-a', key: 'segment-a', name: '企业服务', level: 2, parentId: 'industry-a', sortOrder: 20 },
      { id: 'industry-a', key: 'industry-a', name: '互联网', level: 1, sortOrder: 10 },
      { id: 'role-b', key: 'role-b', name: '软件工程师', level: 3, parentId: 'segment-a', sortOrder: 20 },
      { id: 'leaf-a', key: 'leaf-a', name: '技术设计文档', level: 4, parentId: 'role-b', sortOrder: 10 },
    ])

    expect(options.map(({ id, depth }) => [id, depth])).toEqual([
      ['industry-a', 0],
      ['segment-a', 1],
      ['role-b', 2],
      ['leaf-a', 3],
      ['leaf-b', 3],
      ['industry-b', 0],
    ])
  })

  it('不会把未发布且没有云端记录的草稿提交到服务端', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCreationSkill('https://api.example.test', 'token', localSkill, false),
    ).rejects.toThrow('未发布的本地 Skill 草稿不会上传')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('按关键词搜索市场并映射为可安装的本地只读副本', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/v1/creation-skills')
      expect(url.searchParams.get('q')).toBe('架构')
      return Response.json({
        data: {
          items: [{
            id: '01900000-0000-7000-8000-000000000021',
            title: '通用架构评审文档',
            summary: '适合架构评审场景。',
            category_id: 'leaf-category',
            category_path: [
              { id: '1', key: 'internet', name: '互联网', level: 1 },
              { id: '4', key: 'architecture', name: '技术架构设计文档', level: 4 },
            ],
            content: {
              common_titles: localSkill.commonTitles,
              title_style: localSkill.titleStyle,
              text_style: localSkill.textStyle,
              diagram_style: localSkill.diagramStyle,
              structure_pattern: localSkill.structurePattern,
              writing_guidelines: localSkill.writingGuidelines,
              section_headings: {
                common_titles: localSkill.sectionHeadings.commonTitles,
                title_style: localSkill.sectionHeadings.titleStyle,
                text_style: localSkill.sectionHeadings.textStyle,
                diagram_style: localSkill.sectionHeadings.diagramStyle,
                structure_pattern: localSkill.sectionHeadings.structurePattern,
                writing_guidelines: localSkill.sectionHeadings.writingGuidelines,
              },
              field_examples: {
                common_titles: localSkill.fieldExamples.commonTitles,
                title_style: localSkill.fieldExamples.titleStyle,
                text_style: localSkill.fieldExamples.textStyle,
                diagram_style: localSkill.fieldExamples.diagramStyle,
                structure_pattern: localSkill.fieldExamples.structurePattern,
                writing_guidelines: localSkill.fieldExamples.writingGuidelines,
              },
              example_document: localSkill.exampleDocument,
            },
            author: { id: 'author-1', nickname: '面包师小麦' },
            published: true,
            published_at: '2026-07-23T08:00:00Z',
            updated_at: '2026-07-23T08:00:00Z',
          }],
          total: 1,
          limit: 18,
          offset: 0,
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const page = await searchCreationSkillMarket('https://api.example.test', {
      query: '架构',
      limit: 18,
    })
    const local = marketCreationSkillToLocalInput(page.items[0])

    expect(page.items[0]).toMatchObject({
      title: '通用架构评审文档',
      author: { nickname: '面包师小麦' },
    })
    expect(local).toMatchObject({
      sourceKind: 'market',
      sourceId: '01900000-0000-7000-8000-000000000021',
      cloudSkillId: '01900000-0000-7000-8000-000000000021',
      installed: true,
      published: false,
    })
  })
})

describe('创作 Skill 本地生成与类目容错', () => {
  it('离线类目覆盖主要行业且每个节点都保持完整四级关系', () => {
    const counts = [1, 2, 3, 4].map(level => OFFLINE_CREATION_SKILL_CATEGORIES.filter(item => item.level === level).length)
    const ids = new Set(OFFLINE_CREATION_SKILL_CATEGORIES.map(item => item.id))
    const keys = new Set(OFFLINE_CREATION_SKILL_CATEGORIES.map(item => item.key))
    const clinicalPath = categoryPathFor(
      OFFLINE_CREATION_SKILL_CATEGORIES,
      OFFLINE_CREATION_SKILL_CATEGORIES.find(item => item.key === 'healthcare-hospital-clinic-clinician-clinical-pathway')?.id,
    )

    expect(counts).toEqual([20, 94, 199, 375])
    expect(ids.size).toBe(OFFLINE_CREATION_SKILL_CATEGORIES.length)
    expect(keys.size).toBe(OFFLINE_CREATION_SKILL_CATEGORIES.length)
    expect(clinicalPath.map(item => item.name)).toEqual([
      '医疗健康与生命科学',
      '医院与基层医疗',
      '临床医师',
      '临床诊疗路径',
    ])
  })

  it('分析接口未升级时仍自动生成完整可编辑草稿', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))

    const analysis = await analyzeCreationSkill('http://127.0.0.1:7070', {
      kind: 'bake_document',
      id: 'doc-1',
      title: '订单中心总体架构设计',
      docType: '技术架构设计文档',
      content: '# 背景与目标\n建设订单中心。\n## 总体架构\n说明系统边界和关键链路。\n## 演进计划\n分阶段实施。',
    })

    expect(analysis.analysisMode).toBe('client_heuristic_fallback')
    expect(analysis.title).toContain('技术架构设计')
    expect(analysis.structurePattern).toEqual(['背景与目标', '总体方案', '实施计划'])
    expect(analysis.titleStyle).not.toBe('')
    expect(analysis.diagramStyle).not.toBe('')
    expect(analysis.commonTitles.join('')).not.toContain('订单中心')
    expect(analysis.exampleDocument).not.toContain('订单中心')
  })

  it('合并同一来源的并发分析，避免开发模式重复占用本地模型', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => {
      resolveFetch = resolve
    }))
    vi.stubGlobal('fetch', fetchMock)
    const source = {
      kind: 'bake_document' as const,
      id: 'doc-concurrent',
      title: '知识交接优化方案',
      docType: '技术方案',
      content: '# 背景与目标\n统一知识交接方式，明确责任边界。\n## 方案设计\n按阶段说明输入、输出和验收标准。',
    }

    const first = analyzeCreationSkill('http://127.0.0.1:7070', source)
    const second = analyzeCreationSkill('http://127.0.0.1:7070', source)

    expect(fetchMock).toHaveBeenCalledOnce()
    resolveFetch?.(Response.json({
      title: '知识交接方案文档',
      summary: '适合需要规范知识交接流程的协作场景。',
      common_titles: ['知识交接优化方案'],
      title_style: '标题明确场景和交付目标。',
      text_style: '先说明边界，再按阶段说明动作。',
      diagram_style: '使用泳道图展示角色和交接节点。',
      structure_pattern: ['背景与目标', '方案设计', '验证与验收'],
      writing_guidelines: ['每个阶段写明输入、输出和完成标准。'],
      section_headings: {
        common_titles: DEFAULT_CREATION_SKILL_SECTION_HEADINGS.commonTitles,
        title_style: DEFAULT_CREATION_SKILL_SECTION_HEADINGS.titleStyle,
        text_style: DEFAULT_CREATION_SKILL_SECTION_HEADINGS.textStyle,
        diagram_style: DEFAULT_CREATION_SKILL_SECTION_HEADINGS.diagramStyle,
        structure_pattern: DEFAULT_CREATION_SKILL_SECTION_HEADINGS.structurePattern,
        writing_guidelines: DEFAULT_CREATION_SKILL_SECTION_HEADINGS.writingGuidelines,
      },
      field_examples: {
        common_titles: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.commonTitles,
        title_style: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.titleStyle,
        text_style: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.textStyle,
        diagram_style: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.diagramStyle,
        structure_pattern: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.structurePattern,
        writing_guidelines: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.writingGuidelines,
      },
      example_document: DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
      suggested_category_keywords: ['互联网', '企业服务', '软件工程师', '技术设计文档'],
      analysis_mode: 'local_model',
    }))

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.analysisMode).toBe('local_model')
    expect(secondResult).toEqual(firstResult)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('云端类目接口失败时使用与服务端同 ID 的四级内置类目', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))

    const categories = await fetchCreationSkillCategories('http://127.0.0.1:8080')

    expect(categories).toHaveLength(OFFLINE_CREATION_SKILL_CATEGORIES.length)
    expect(new Set(categories.map(item => item.level))).toEqual(new Set([1, 2, 3, 4]))
    const architecture = categories.find(item => item.key === 'enterprise-architecture-design-doc')
    expect(categoryPathFor(categories, architecture?.id).map(item => item.name)).toEqual([
      '互联网',
      '企业服务',
      '架构师',
      '技术架构设计文档',
    ])
  })

  it('根据总结、正文和文档类型自动选中完整四级类目', () => {
    const analysis = {
      title: '订单中心架构创作 Skill',
      summary: '用于企业系统的关键链路架构评审。',
      commonTitles: ['订单中心总体架构设计'],
      titleStyle: '结论先行。',
      textStyle: '正式。',
      diagramStyle: '架构图。',
      structurePattern: ['背景', '总体架构'],
      writingGuidelines: [],
      sectionHeadings: { ...DEFAULT_CREATION_SKILL_SECTION_HEADINGS },
      fieldExamples: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES,
      exampleDocument: DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
      suggestedCategoryKeywords: ['互联网', '企业服务', '架构师', '技术架构设计文档'],
      analysisMode: 'local_model',
    }
    const leaf = suggestCreationSkillCategory(OFFLINE_CREATION_SKILL_CATEGORIES, analysis, {
      kind: 'creation_history',
      id: '42',
      title: '订单中心架构设计',
      docType: '技术架构设计文档',
      content: '企业服务平台的系统边界与关键链路。',
    })

    expect(leaf?.key).toBe('enterprise-architecture-design-doc')
  })

  it('能为新增行业内容推荐对应的四级类目', () => {
    const leaf = suggestCreationSkillCategory(OFFLINE_CREATION_SKILL_CATEGORIES, {
      title: '临床诊疗路径创作 Skill',
      summary: '用于医院临床医师整理标准化诊疗流程。',
      commonTitles: ['呼吸科临床诊疗路径'],
      titleStyle: '规范、明确。',
      textStyle: '按临床阶段说明。',
      diagramStyle: '使用诊疗流程图。',
      structurePattern: ['适用范围', '诊疗流程', '质量指标'],
      writingGuidelines: [],
      sectionHeadings: { ...DEFAULT_CREATION_SKILL_SECTION_HEADINGS },
      fieldExamples: DEFAULT_CREATION_SKILL_FIELD_EXAMPLES,
      exampleDocument: DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
      suggestedCategoryKeywords: ['医疗健康与生命科学', '医院与基层医疗', '临床医师', '临床诊疗路径'],
      analysisMode: 'local_model',
    })

    expect(leaf?.key).toBe('healthcare-hospital-clinic-clinician-clinical-pathway')
  })

  it('把具体部门名称归纳为可复用的场景标题', () => {
    const title = normalizeCreationSkillTitle('电商与商业化技术协作会议纪要撰写指南', {
      kind: 'bake_document',
      id: 'doc-2',
      title: '研发中心跨部门技术沟通会纪要',
      docType: '技术设计文档',
      content: '架构师与产品、研发和运维共同确认技术方案与系统边界。',
    })

    expect(title).toBe('跨部门技术沟通会文档')
    expect(title).not.toContain('研发中心')
  })

  it('只匹配已保存且已安装的 Skill，并把简介和类目写入创作指令', () => {
    const installedSkill: LocalCreationSkill = {
      ...localSkill,
      id: 7,
      categoryId: OFFLINE_CREATION_SKILL_CATEGORIES.find(item => item.key === 'enterprise-architecture-design-doc')!.id,
      title: '跨部门技术沟通会文档',
      summary: '适合架构师组织跨部门技术评审，目标是统一方案边界、关键取舍和行动项。',
      installed: true,
      createdAt: 1,
      updatedAt: 2,
    }
    const matches = matchCreationSkills('帮我写一份跨部门架构评审会材料', [
      installedSkill,
      { ...installedSkill, id: 8, title: '未安装版本', installed: false },
      { ...installedSkill, id: 9, title: '草稿版本', status: 'draft' },
    ])
    const instruction = buildCreationSkillInstruction(matches)

    expect(matches.map(item => item.skill.id)).toEqual([7])
    expect(matches[0].reason).toBe('automatic')
    expect(instruction).toContain('适用场景与目标：')
    expect(instruction).toContain('互联网 / 企业服务 / 架构师 / 技术架构设计文档')
    expect(instruction).toContain('完全脱离源文档的 few-shot 示例文档')
    expect(instruction).toContain('这类文档标题通常怎么命名')
  })

  it('支持按来源文档查询关联 Skill 并读取安装状态', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('source_kind=bake_document')
      expect(String(input)).toContain('source_id=doc-42')
      return new Response(JSON.stringify([{
        id: 3,
        client_skill_key: 'doc-skill',
        source_kind: 'bake_document',
        source_id: 'doc-42',
        title: '项目复盘总结文档',
        summary: '适合项目结束后的跨团队复盘。',
        common_titles: ['项目复盘'],
        title_style: '结论先行',
        text_style: '事实清晰',
        diagram_style: '时间线',
        structure_pattern: ['目标', '结果', '行动项'],
        writing_guidelines: [],
        status: 'saved',
        installed: true,
        published: false,
        created_at: 1,
        updated_at: 2,
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const skills = await listLocalCreationSkills('http://127.0.0.1:7070', {
      sourceKind: 'bake_document',
      sourceId: 'doc-42',
    })

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ status: 'saved', installed: true })
  })
})
