import { fetchWithLocalhostFallback } from '../hooks/useApi'
import { serviceEnvironmentHeaders } from '../store/useAppStore'
import { OFFLINE_CREATION_SKILL_CATEGORIES } from '../data/creationSkillCategories'

export type CreationSkillSourceKind = 'creation_history' | 'bake_document' | 'market'

export interface CreationSkillSource {
  kind: CreationSkillSourceKind
  id: string
  title: string
  content: string
  docType: string
}

export interface CreationSkillContent {
  commonTitles: string[]
  titleStyle: string
  textStyle: string
  diagramStyle: string
  structurePattern: string[]
  writingGuidelines: string[]
  sectionHeadings: CreationSkillSectionHeadings
  fieldExamples: CreationSkillFieldExamples
  exampleDocument: string
}

export interface CreationSkillSectionHeadings {
  commonTitles: string
  titleStyle: string
  textStyle: string
  diagramStyle: string
  structurePattern: string
  writingGuidelines: string
}

export interface CreationSkillFieldExamples {
  commonTitles: string[]
  titleStyle: string[]
  textStyle: string[]
  diagramStyle: string[]
  structurePattern: string[]
  writingGuidelines: string[]
}

export interface CreationSkillAnalysis extends CreationSkillContent {
  title: string
  summary: string
  suggestedCategoryKeywords: string[]
  analysisMode: 'local_model' | 'heuristic_fallback' | string
}

export interface LocalCreationSkill extends CreationSkillContent {
  id: number
  clientSkillKey: string
  cloudSkillId?: string | null
  sourceKind: CreationSkillSourceKind
  sourceId: string
  title: string
  summary: string
  categoryId?: string | null
  status: 'draft' | 'saved'
  installed: boolean
  published: boolean
  createdAt: number
  updatedAt: number
}

export interface LocalCreationSkillQuery {
  sourceKind?: CreationSkillSourceKind
  sourceId?: string
  installed?: boolean
}

export interface MatchedCreationSkill {
  skill: LocalCreationSkill
  reason: 'mentioned' | 'automatic'
  score: number
}

export interface CreationSkillCategory {
  id: string
  key: string
  name: string
  level: 1 | 2 | 3 | 4
  parentId?: string | null
  sortOrder: number
}

export interface CreationSkillCategoryOption extends CreationSkillCategory {
  depth: number
}

export interface CreationSkillMarketAuthor {
  id: string
  nickname: string
}

export interface CreationSkillMarketItem extends CreationSkillContent {
  id: string
  title: string
  summary: string
  categoryId: string
  categoryPath: CreationSkillCategory[]
  author: CreationSkillMarketAuthor
  publishedAt?: string | null
  updatedAt: string
}

export interface CreationSkillMarketPage {
  items: CreationSkillMarketItem[]
  total: number
  limit: number
  offset: number
}

export interface CreationSkillMarketQuery {
  query?: string
  categoryId?: string
  limit?: number
  offset?: number
}

const parseError = async (response: Response, fallback: string) => {
  const payload = await response.json().catch(() => null)
  return payload?.error?.message || payload?.message || fallback
}

export const DEFAULT_CREATION_SKILL_SECTION_HEADINGS: CreationSkillSectionHeadings = {
  commonTitles: '这类文档标题通常怎么命名',
  titleStyle: '标题如何传递重点',
  textStyle: '正文怎样组织和表达',
  diagramStyle: '图示怎样服务于内容',
  structurePattern: '从开篇到结论的章节骨架',
  writingGuidelines: '保持这份风格的关键约束',
}

export const DEFAULT_CREATION_SKILL_FIELD_EXAMPLES: CreationSkillFieldExamples = {
  commonTitles: ['协作流程优化方案', '阶段复盘与后续行动报告'],
  titleStyle: ['协作流程优化方案：明确目标、范围与交付边界'],
  textStyle: ['本方案先明确适用范围，再说明关键步骤、责任边界与验收方式。'],
  diagramStyle: ['用泳道图展示提出、处理、复核三个阶段，并用统一图例标注责任角色。'],
  structurePattern: ['背景与目标 → 现状与约束 → 方案设计 → 实施计划 → 风险与验证'],
  writingGuidelines: ['把“提升效率”改写为“减少交接步骤，并设置可核验的完成标准”'],
}

export const DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT = `# 跨团队知识交接优化方案

## 摘要

本示例围绕通用的知识交接场景，说明如何明确范围、责任角色、执行步骤与验收方式。

## 背景与目标

相关团队需要在任务变化时稳定传递必要信息，目标是减少遗漏并让接手者能够独立完成后续工作。

## 方案设计

建立“准备、讲解、确认、复核”四个阶段；每个阶段明确输入、责任角色、输出和完成标准。

## 风险与验证

重点检查资料缺失、理解偏差和权限不当三类风险，并以清单完成情况作为验收依据。`

const inFlightCreationSkillAnalyses = new Map<string, Promise<CreationSkillAnalysis>>()

async function requestCreationSkillAnalysis(
  apiBaseUrl: string,
  source: CreationSkillSource,
): Promise<CreationSkillAnalysis> {
  try {
    const response = await fetchWithLocalhostFallback(`${apiBaseUrl}/api/creation/skills/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_kind: source.kind,
        source_id: source.id,
        document_title: source.title,
        document_content: source.content,
        doc_type: source.docType,
      }),
    })
    if (!response.ok) throw new Error(await parseError(response, '沉淀 Skill 失败'))
    const data = await response.json()
    if (!data.section_headings || !data.field_examples || !String(data.example_document || '').trim()) {
      return buildClientCreationSkillFallback(source)
    }
    return {
      title: normalizeCreationSkillTitle(data.title, source),
      summary: data.summary,
      commonTitles: data.common_titles || [],
      titleStyle: data.title_style || '',
      textStyle: data.text_style || '',
      diagramStyle: data.diagram_style || '',
      structurePattern: data.structure_pattern || [],
      writingGuidelines: data.writing_guidelines || [],
      sectionHeadings: mapSectionHeadings(data.section_headings),
      fieldExamples: mapFieldExamples(data.field_examples),
      exampleDocument: data.example_document?.trim() || DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
      suggestedCategoryKeywords: data.suggested_category_keywords || [],
      analysisMode: data.analysis_mode || 'local_model',
    }
  } catch {
    return buildClientCreationSkillFallback(source)
  }
}

export function analyzeCreationSkill(
  apiBaseUrl: string,
  source: CreationSkillSource,
): Promise<CreationSkillAnalysis> {
  const requestKey = JSON.stringify([
    apiBaseUrl,
    source.kind,
    source.id,
    source.title,
    source.docType,
    source.content,
  ])
  const inFlight = inFlightCreationSkillAnalyses.get(requestKey)
  if (inFlight) return inFlight

  let request: Promise<CreationSkillAnalysis>
  request = requestCreationSkillAnalysis(apiBaseUrl, source).finally(() => {
    if (inFlightCreationSkillAnalyses.get(requestKey) === request) {
      inFlightCreationSkillAnalyses.delete(requestKey)
    }
  })
  inFlightCreationSkillAnalyses.set(requestKey, request)
  return request
}

export async function listLocalCreationSkills(
  apiBaseUrl: string,
  query: LocalCreationSkillQuery = {},
): Promise<LocalCreationSkill[]> {
  const search = new URLSearchParams()
  if (query.sourceKind && query.sourceId) {
    search.set('source_kind', query.sourceKind)
    search.set('source_id', query.sourceId)
  }
  if (query.installed !== undefined) search.set('installed', String(query.installed))
  const suffix = search.toString()
  const response = await fetchWithLocalhostFallback(`${apiBaseUrl}/api/creation/skills${suffix ? `?${suffix}` : ''}`)
  if (!response.ok) throw new Error(await parseError(response, '读取创作 Skill 失败'))
  return (await response.json()).map(mapLocalSkill)
}

export async function saveLocalCreationSkill(
  apiBaseUrl: string,
  input: Omit<LocalCreationSkill, 'id' | 'createdAt' | 'updatedAt'>,
  id?: number,
): Promise<LocalCreationSkill> {
  const response = await fetchWithLocalhostFallback(
    `${apiBaseUrl}/api/creation/skills${id ? `/${id}` : ''}`,
    {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeLocalSkill(input)),
    },
  )
  if (!response.ok) throw new Error(await parseError(response, '保存创作 Skill 失败'))
  return mapLocalSkill(await response.json())
}

export async function deleteLocalCreationSkill(apiBaseUrl: string, id: number): Promise<void> {
  const response = await fetchWithLocalhostFallback(`${apiBaseUrl}/api/creation/skills/${id}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 204) throw new Error(await parseError(response, '删除创作 Skill 失败'))
}

export async function fetchCreationSkillCategories(adminApiBaseUrl: string): Promise<CreationSkillCategory[]> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), 3500)
  try {
    const response = await fetch(`${adminApiBaseUrl}/v1/creation-skill-categories`, {
      headers: serviceEnvironmentHeaders(),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await parseError(response, '读取创作类目失败'))
    const payload = await response.json()
    const categories = (payload.data || []).map((item: any) => ({
      id: item.id,
      key: item.key,
      name: item.name,
      level: item.level,
      parentId: item.parent_id,
      sortOrder: item.sort_order,
    })) as CreationSkillCategory[]
    return categories.some(item => item.level === 4)
      ? categories
      : OFFLINE_CREATION_SKILL_CATEGORIES
  } catch {
    return OFFLINE_CREATION_SKILL_CATEGORIES
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

export async function searchCreationSkillMarket(
  adminApiBaseUrl: string,
  query: CreationSkillMarketQuery = {},
): Promise<CreationSkillMarketPage> {
  const search = new URLSearchParams()
  if (query.query?.trim()) search.set('q', query.query.trim())
  if (query.categoryId) search.set('category_id', query.categoryId)
  search.set('limit', String(query.limit ?? 24))
  search.set('offset', String(query.offset ?? 0))
  const response = await fetch(`${adminApiBaseUrl}/v1/creation-skills?${search}`, {
    headers: serviceEnvironmentHeaders(),
  })
  if (!response.ok) throw new Error(await parseError(response, '读取创作 Skill 市场失败'))
  const payload = await response.json()
  return {
    items: Array.isArray(payload?.data?.items)
      ? payload.data.items.map(mapMarketSkill)
      : [],
    total: Number(payload?.data?.total || 0),
    limit: Number(payload?.data?.limit || query.limit || 24),
    offset: Number(payload?.data?.offset || query.offset || 0),
  }
}

export function marketCreationSkillToLocalInput(
  skill: CreationSkillMarketItem,
): Omit<LocalCreationSkill, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    clientSkillKey: `market-${skill.id}`,
    cloudSkillId: skill.id,
    sourceKind: 'market',
    sourceId: skill.id,
    title: skill.title,
    summary: skill.summary,
    categoryId: skill.categoryId,
    commonTitles: [...skill.commonTitles],
    titleStyle: skill.titleStyle,
    textStyle: skill.textStyle,
    diagramStyle: skill.diagramStyle,
    structurePattern: [...skill.structurePattern],
    writingGuidelines: [...skill.writingGuidelines],
    sectionHeadings: { ...skill.sectionHeadings },
    fieldExamples: cloneFieldExamples(skill.fieldExamples),
    exampleDocument: skill.exampleDocument,
    status: 'saved',
    installed: true,
    published: false,
  }
}

export async function publishCreationSkill(
  adminApiBaseUrl: string,
  token: string,
  skill: Omit<LocalCreationSkill, 'id' | 'createdAt' | 'updatedAt'>,
  published: boolean,
): Promise<{ id: string; published: boolean }> {
  if (!skill.categoryId) throw new Error('请选择第四级具体文档类型')
  if (!published && !skill.cloudSkillId) throw new Error('未发布的本地 Skill 草稿不会上传')
  const response = await fetch(
    `${adminApiBaseUrl}/v1/creation-skills${skill.cloudSkillId ? `/${skill.cloudSkillId}` : ''}`,
    {
      method: skill.cloudSkillId ? 'PUT' : 'POST',
      headers: {
        ...serviceEnvironmentHeaders(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_skill_key: skill.clientSkillKey,
        title: skill.title,
        summary: skill.summary,
        category_id: skill.categoryId,
        content: {
          common_titles: skill.commonTitles,
          title_style: skill.titleStyle,
          text_style: skill.textStyle,
          diagram_style: skill.diagramStyle,
          structure_pattern: skill.structurePattern,
          writing_guidelines: skill.writingGuidelines,
          section_headings: {
            common_titles: '这类文档标题通常怎么命名',
            title_style: skill.sectionHeadings.titleStyle,
            text_style: skill.sectionHeadings.textStyle,
            diagram_style: skill.sectionHeadings.diagramStyle,
            structure_pattern: skill.sectionHeadings.structurePattern,
            writing_guidelines: skill.sectionHeadings.writingGuidelines,
          },
          field_examples: {
            common_titles: skill.fieldExamples.commonTitles,
            title_style: skill.fieldExamples.titleStyle,
            text_style: skill.fieldExamples.textStyle,
            diagram_style: skill.fieldExamples.diagramStyle,
            structure_pattern: skill.fieldExamples.structurePattern,
            writing_guidelines: skill.fieldExamples.writingGuidelines,
          },
          example_document: skill.exampleDocument,
        },
        published,
      }),
    },
  )
  if (!response.ok) throw new Error(await parseError(response, published ? '发布 Skill 失败' : '下架 Skill 失败'))
  const payload = await response.json()
  return { id: payload.data.id, published: payload.data.published }
}

export function categoryPathFor(categories: CreationSkillCategory[], leafId?: string | null) {
  if (!leafId) return []
  const byId = new Map(categories.map(item => [item.id, item]))
  const path: CreationSkillCategory[] = []
  let cursor = byId.get(leafId)
  while (cursor) {
    path.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return path
}

export function creationSkillCategoryOptions(
  categories: CreationSkillCategory[],
): CreationSkillCategoryOption[] {
  const categoryIds = new Set(categories.map(category => category.id))
  const childrenByParent = new Map<string | null, CreationSkillCategory[]>()
  const originalIndex = new Map(categories.map((category, index) => [category.id, index]))
  const compareCategories = (left: CreationSkillCategory, right: CreationSkillCategory) =>
    left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, 'zh-CN')
    || (originalIndex.get(left.id) || 0) - (originalIndex.get(right.id) || 0)

  categories.forEach(category => {
    const parentId = category.parentId && categoryIds.has(category.parentId)
      ? category.parentId
      : null
    const siblings = childrenByParent.get(parentId) || []
    siblings.push(category)
    childrenByParent.set(parentId, siblings)
  })
  childrenByParent.forEach(children => children.sort(compareCategories))

  const options: CreationSkillCategoryOption[] = []
  const visited = new Set<string>()
  const appendCategory = (category: CreationSkillCategory, depth: number) => {
    if (visited.has(category.id)) return
    visited.add(category.id)
    options.push({ ...category, depth })
    const children = childrenByParent.get(category.id) || []
    children.forEach(child => {
      appendCategory(child, depth + 1)
    })
  }

  const roots = childrenByParent.get(null) || []
  roots.forEach(category => appendCategory(category, 0))
  const remainingCategories = [...categories].sort(compareCategories)
  remainingCategories.forEach(category => {
    appendCategory(category, Math.max(0, category.level - 1))
  })
  return options
}

export function suggestCreationSkillCategory(
  categories: CreationSkillCategory[],
  analysis: CreationSkillAnalysis,
  source?: CreationSkillSource | null,
): CreationSkillCategory | undefined {
  const text = [
    source?.title,
    source?.docType,
    source?.content.slice(0, 8_000),
    analysis.title,
    analysis.summary,
    ...analysis.commonTitles,
    ...analysis.structurePattern,
    ...analysis.suggestedCategoryKeywords,
  ].filter(Boolean).join('\n').toLowerCase()
  const leaves = categories.filter(item => item.level === 4)
  const scoringRules: Array<{ pattern: RegExp; keys: string[]; score: number }> = [
    { pattern: /电商|零售|商品|订单|购物|履约|交易链路/, keys: ['internet-ecommerce', 'ecommerce-'], score: 14 },
    { pattern: /企业服务|saas|b端|后台|平台|系统|软件/, keys: ['internet-enterprise-service', 'enterprise-'], score: 8 },
    { pattern: /银行|支付|信贷|金融|风控/, keys: ['finance-banking-payment', 'bank-'], score: 14 },
    { pattern: /保险|保单|理赔|精算/, keys: ['finance-insurance', 'insurance-'], score: 16 },
    { pattern: /智能制造|产线|工艺|工业软件/, keys: ['manufacturing-smart', 'smart-'], score: 15 },
    { pattern: /消费品|质量策划|工业设计/, keys: ['manufacturing-consumer', 'consumer-'], score: 12 },
    { pattern: /咨询|行业研究|项目建议书/, keys: ['professional-consulting', 'consulting-'], score: 14 },
    { pattern: /品牌|内容策划|视觉规范/, keys: ['professional-brand-media', 'brand-'], score: 14 },
    { pattern: /云计算|数据平台|人工智能|大模型|机器学习/, keys: ['internet-cloud-data-ai'], score: 16 },
    { pattern: /网络安全|信息安全|威胁建模|安全事件/, keys: ['internet-cybersecurity'], score: 16 },
    { pattern: /证券|基金|资管|投资研究|估值/, keys: ['finance-securities-fund'], score: 16 },
    { pattern: /汽车|零部件|半导体|电子|机械|装备|航空航天/, keys: ['manufacturing-'], score: 13 },
    { pattern: /农业|种植|畜牧|养殖|林业|渔业|水产/, keys: ['agriculture-forestry-fishery'], score: 16 },
    { pattern: /建筑|施工|工程造价|房地产|物业|设施管理/, keys: ['construction-realestate'], score: 16 },
    { pattern: /煤矿|矿山|石油|天然气|电网|电力|新能源|储能/, keys: ['energy-mining'], score: 16 },
    { pattern: /公路|铁路|航空运输|航运|港口|仓储|物流|快递|配送/, keys: ['transport-logistics'], score: 16 },
    { pattern: /商超|百货|批发|进出口|跨境贸易|经销/, keys: ['wholesale-retail-trade'], score: 16 },
    { pattern: /课程|教学|教研|学校|高校|职业教育|培训/, keys: ['education-training'], score: 16 },
    { pattern: /医院|临床|护理|药品|生物科技|医疗器械|康养|养老/, keys: ['healthcare-life-science'], score: 16 },
    { pattern: /新闻|出版|影视|音视频|广告|公关|赛事|博物馆|展览/, keys: ['culture-media-sports'], score: 16 },
    { pattern: /旅游|旅行|酒店|餐饮|景区|度假/, keys: ['tourism-hospitality-catering'], score: 16 },
    { pattern: /政策|政府|事业单位|社区服务|应急管理|公共安全/, keys: ['government-public-service'], score: 16 },
    { pattern: /电信|通信网络|卫星通信|数据中心/, keys: ['telecom-communication'], score: 16 },
    { pattern: /环保|污水|固废|环卫|环境治理|供水|燃气|供热/, keys: ['environment-utilities'], score: 16 },
    { pattern: /科研|实验室|检验检测|认证审核/, keys: ['research-testing'], score: 16 },
    { pattern: /基金会|慈善|公益|行业协会|商会|社会工作/, keys: ['social-nonprofit'], score: 16 },
    { pattern: /家政|美容美发|维修服务|婚庆|宠物服务/, keys: ['life-personal-service'], score: 16 },
    { pattern: /企业战略|经营管理|财务预算|人才发展|市场营销|采购|数据治理/, keys: ['corporate-functions'], score: 12 },
    { pattern: /技术架构|总体架构|系统边界|关键链路|组件设计/, keys: ['architect', 'architecture'], score: 24 },
    { pattern: /接口设计|\bapi\b/, keys: ['software-engineer', 'api-design'], score: 22 },
    { pattern: /技术设计|软件设计|实现方案/, keys: ['software-engineer', 'technical-design', 'system-design'], score: 18 },
    { pattern: /产品需求|\bprd\b/, keys: ['product-manager', 'prd'], score: 24 },
    { pattern: /产品设计|产品方案/, keys: ['product-manager', 'product-design'], score: 20 },
    { pattern: /\bui\b|界面设计|交互稿/, keys: ['designer', 'ui-design'], score: 24 },
    { pattern: /\bux\b|用户体验/, keys: ['designer', 'ux-design'], score: 24 },
    { pattern: /运营方案|活动运营|增长运营/, keys: ['operator', 'operation-plan'], score: 20 },
    { pattern: /风险策略|风控策略/, keys: ['risk-manager', 'risk-policy'], score: 22 },
    { pattern: /数据分析|指标分析/, keys: ['data-analyst', 'data-analysis'], score: 20 },
    { pattern: /实施方案|客户交付/, keys: ['customer-success', 'implementation-plan'], score: 20 },
  ]

  const scored = leaves.map(item => {
    const path = categoryPathFor(categories, item.id)
    const keys = path.map(part => part.key).join(' ')
    let score = 0
    for (const part of path) {
      if (text.includes(part.name.toLowerCase())) score += part.level * 7
    }
    for (const rule of scoringRules) {
      if (rule.pattern.test(text) && rule.keys.some(key => keys.includes(key))) score += rule.score
    }
    return { item, score }
  })
  scored.sort((left, right) => right.score - left.score || left.item.sortOrder - right.item.sortOrder)
  return scored[0]?.score > 0 ? scored[0].item : undefined
}

export function matchCreationSkills(
  prompt: string,
  skills: LocalCreationSkill[],
  categories: CreationSkillCategory[] = OFFLINE_CREATION_SKILL_CATEGORIES,
  limit = 3,
): MatchedCreationSkill[] {
  const normalizedPrompt = normalizeMatchText(prompt)
  if (!normalizedPrompt) return []
  const promptGrams = meaningfulNgrams(prompt)
  const matches = skills
    .filter(skill => skill.status === 'saved' && skill.installed)
    .map(skill => {
      const mention = `@${skill.title}`
      const mentioned = prompt.includes(mention)
      const path = categoryPathFor(categories, skill.categoryId)
      let score = mentioned ? 1_000 : 0
      const normalizedTitle = normalizeMatchText(skill.title)
      const titlePurpose = normalizedTitle.replace(/(?:创作)?(?:skill|文档|方案|报告|规范|指南)$/i, '')
      if (normalizedTitle && normalizedPrompt.includes(normalizedTitle)) score += 120
      if (titlePurpose.length >= 4 && normalizedPrompt.includes(titlePurpose)) score += 70
      for (const commonTitle of skill.commonTitles) {
        const common = normalizeMatchText(commonTitle)
        if (common.length >= 4 && normalizedPrompt.includes(common)) score += 45
      }
      for (const item of path) {
        if (normalizedPrompt.includes(normalizeMatchText(item.name))) score += item.level * 8
      }
      score += overlapScore(promptGrams, meaningfulNgrams(skill.title), 5, 40)
      score += overlapScore(promptGrams, meaningfulNgrams(skill.summary), 3, 36)
      score += overlapScore(promptGrams, meaningfulNgrams(skill.commonTitles.join('\n')), 2, 24)
      return { skill, reason: mentioned ? 'mentioned' as const : 'automatic' as const, score }
    })
    .filter(match => match.reason === 'mentioned' || match.score >= 14)
    .sort((left, right) => right.score - left.score || right.skill.updatedAt - left.skill.updatedAt)

  const explicit = matches.filter(match => match.reason === 'mentioned')
  const automatic = matches.filter(match => match.reason === 'automatic')
  return [...explicit, ...automatic].slice(0, Math.max(1, limit))
}

export function buildCreationSkillInstruction(
  matches: MatchedCreationSkill[],
  categories: CreationSkillCategory[] = OFFLINE_CREATION_SKILL_CATEGORIES,
): string {
  if (matches.length === 0) return ''
  const recipes = matches.map(({ skill, reason }, index) => {
    const category = categoryPathFor(categories, skill.categoryId).map(item => item.name).join(' / ')
    return [
      `S#${index + 1} ${skill.title}（${reason === 'mentioned' ? '用户明确选择' : '根据需求自动匹配'}）`,
      `适用场景与目标：${skill.summary}`,
      category ? `创作类目：${category}` : '',
      `常见标题｜这类文档标题通常怎么命名：${skill.commonTitles.join('；')}`,
      `常见标题示例：${skill.fieldExamples.commonTitles.join('；')}`,
      `标题风格｜${skill.sectionHeadings.titleStyle}：${skill.titleStyle}`,
      `标题风格示例：${skill.fieldExamples.titleStyle.join('；')}`,
      `内容文本风格｜${skill.sectionHeadings.textStyle}：${skill.textStyle}`,
      `内容文本风格示例：${skill.fieldExamples.textStyle.join('；')}`,
      `画图风格｜${skill.sectionHeadings.diagramStyle}：${skill.diagramStyle}`,
      `画图风格示例：${skill.fieldExamples.diagramStyle.join('；')}`,
      `常用结构｜${skill.sectionHeadings.structurePattern}：${skill.structurePattern.join(' → ')}`,
      `常用结构示例：${skill.fieldExamples.structurePattern.join('；')}`,
      skill.writingGuidelines.length ? `写作规则｜${skill.sectionHeadings.writingGuidelines}：${skill.writingGuidelines.join('；')}` : '',
      `写作规则示例：${skill.fieldExamples.writingGuidelines.join('；')}`,
      `完全脱离源文档的 few-shot 示例文档：\n${skill.exampleDocument}`,
    ].filter(Boolean).join('\n')
  })
  return `\n\n已安装并匹配的创作 Skill：\n${recipes.join('\n\n')}\n请结合本次具体需求采用这些写法；示例只作为 few-shot 学习结构与表达，不得照抄其中主题；Skill 只约束表达与结构，不要虚构业务事实。`
}

export function buildClientCreationSkillFallback(source: CreationSkillSource): CreationSkillAnalysis {
  const title = source.title.trim() || '未命名文档'
  const docType = source.docType.trim() || inferDocumentType(source.content, title)
  const structure = extractDocumentStructure(source.content)
  const genericType = docType.replace(/(?:文档|报告)$/, '')
  const commonTitles = Array.from(new Set([
    `${genericType}方案`,
    `${genericType}设计与实施说明`,
    `${genericType}复盘与后续行动`,
  ])).slice(0, 6)
  return {
    title: inferAbstractSkillTitle(source, docType),
    summary: `提炼这类${docType}的标题组织、正文表达、章节结构与图示规范，可作为下一次创作的本地草稿。`,
    commonTitles,
    titleStyle: '标题先说明业务或设计对象，再用副标题限定范围、阶段或关键约束；章节标题保持简短并使用一致的名词结构。',
    textStyle: '正文采用结论先行的短段落，先交代背景和约束，再说明方案、取舍与验证方式；关键术语保持一致。',
    diagramStyle: '优先使用结构图、流程图或时序图表达关系；统一配色和图例，明确系统边界、数据流向及关键节点，避免无信息装饰。',
    structurePattern: structure.length > 0 ? structure : defaultStructureFor(docType),
    writingGuidelines: [
      '每个关键结论都补充依据、约束或适用范围。',
      '方案描述同时写明取舍、风险和验证标准。',
      '图示与正文使用相同术语，并在正文中解释图的阅读顺序。',
      '公开前删除业务敏感事实，用抽象角色或占位符替代。',
    ],
    sectionHeadings: { ...DEFAULT_CREATION_SKILL_SECTION_HEADINGS },
    fieldExamples: cloneFieldExamples(DEFAULT_CREATION_SKILL_FIELD_EXAMPLES),
    exampleDocument: DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
    suggestedCategoryKeywords: detectCategoryKeywords(`${title}\n${docType}\n${source.content.slice(0, 8_000)}`),
    analysisMode: 'client_heuristic_fallback',
  }
}

export function normalizeCreationSkillTitle(candidate: unknown, source: CreationSkillSource): string {
  const docType = source.docType.trim() || inferDocumentType(source.content, source.title)
  const sourceText = `${source.title}\n${source.content.slice(0, 6_000)}`
  if (/(?:跨部门|跨团队|多团队)/.test(sourceText) && /(?:技术|架构|研发|系统)/.test(sourceText) && /(?:会议|沟通|评审|纪要)/.test(sourceText)) {
    return '跨部门技术沟通会文档'
  }
  let title = String(candidate || '').trim()
  const organizationNames = (source.title.match(/[\p{L}\p{N}·_-]{1,12}?(?:事业群|事业部|委员会|项目组|工作组|部门|团队|小组|中心|部)/gu) || [])
    .filter(name => !/^(?:跨|多|各|相关)(?:部门|团队|小组)$/.test(name))
  for (const organization of organizationNames.sort((left, right) => right.length - left.length)) {
    title = title.split(organization).join('')
  }
  title = title
    .replace(/(?:创作|写作)\s*Skill$/i, '')
    .replace(/Skill$/i, '')
    .replace(/沟通会(?:会议)?纪要$/u, '沟通会文档')
    .replace(/会议纪要$/u, '会议文档')
    .replace(/^[\s·—_:：-]+|[\s·—_:：-]+$/g, '')
  if (title.length < 4 || organizationNames.some(name => title.includes(name))) {
    return inferAbstractSkillTitle(source, docType)
  }
  return title.slice(0, 80)
}

function extractDocumentStructure(content: string): string[] {
  const headings = content
    .split(/\r?\n/)
    .map(line => line.match(/^\s*(?:#{1,6}\s+|(?:\d+\.)+\s*)([^#].*?)\s*$/)?.[1]?.trim() || '')
    .map(canonicalSkillHeading)
    .filter(item => item.length >= 2 && item.length <= 60)
  return Array.from(new Set(headings)).slice(0, 12)
}

function canonicalSkillHeading(heading: string) {
  const mappings: Array<[RegExp, string]> = [
    [/背景|现状|概述/, '背景与目标'],
    [/目标|范围/, '目标与范围'],
    [/约束|原则/, '约束与设计原则'],
    [/架构|总体设计/, '总体方案'],
    [/流程|步骤/, '核心流程'],
    [/功能|模块/, '核心设计'],
    [/接口|数据/, '接口与数据'],
    [/实施|计划|里程碑/, '实施计划'],
    [/风险|保障/, '风险与保障'],
    [/验证|验收|指标/, '验证与验收'],
    [/结论|总结|后续/, '结论与后续'],
  ]
  return mappings.find(([pattern]) => pattern.test(heading))?.[1] || ''
}

function inferDocumentType(content: string, title: string) {
  const text = `${title}\n${content.slice(0, 4_000)}`.toLowerCase()
  if (/技术架构|总体架构|系统架构/.test(text)) return '技术架构设计文档'
  if (/接口设计|\bapi\b/.test(text)) return '接口设计文档'
  if (/产品需求|\bprd\b/.test(text)) return '产品需求文档'
  if (/\bui\b|界面设计/.test(text)) return 'UI 设计文档'
  if (/用户体验|\bux\b/.test(text)) return '用户体验设计文档'
  if (/行业研究|调研报告/.test(text)) return '行业研究报告'
  if (/运营方案|活动方案/.test(text)) return '运营方案'
  return '创作文档'
}

function inferAbstractSkillTitle(source: CreationSkillSource, docType: string) {
  const text = `${source.title}\n${source.content.slice(0, 6_000)}`
  if (/跨部门|跨团队|多团队/.test(text) && /技术|架构|研发|系统/.test(text) && /会议|沟通|评审|纪要/.test(text)) {
    return '跨部门技术沟通会文档'
  }
  if (/跨部门|跨团队|多团队/.test(text) && /会议|沟通|协作|纪要/.test(text)) return '跨部门协作会议文档'
  if (/架构评审|技术评审|方案评审/.test(text)) return '技术方案评审文档'
  if (/复盘|总结会/.test(text)) return '项目复盘总结文档'
  if (/客户|交付|实施/.test(text) && /沟通|汇报|会议/.test(text)) return '客户交付沟通文档'
  const purposeByType: Array<[RegExp, string]> = [
    [/技术架构|系统架构/, '技术架构设计文档'],
    [/接口设计/, '系统接口设计文档'],
    [/产品需求|PRD/i, '产品需求沟通文档'],
    [/产品设计/, '产品方案设计文档'],
    [/UI|用户体验/i, '产品体验设计文档'],
    [/运营/, '运营方案策划文档'],
    [/行业研究|数据分析/, '业务分析研究报告'],
    [/品牌|内容策划/, '品牌内容策划文档'],
  ]
  return purposeByType.find(([pattern]) => pattern.test(docType))?.[1]
    || `${docType.replace(/文档$/, '').replace(/报告$/, '')}创作文档`
}

const MATCH_STOP_GRAMS = new Set([
  '文档', '创作', '写作', '方案', '内容', '一个', '一份', '帮我', '需要', '用于', '适合', '帮助', '生成', '总结', '设计',
])

function normalizeMatchText(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function meaningfulNgrams(value: string) {
  const compact = normalizeMatchText(value)
  const grams = new Set<string>()
  for (const size of [2, 3, 4]) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      const gram = compact.slice(index, index + size)
      if (!MATCH_STOP_GRAMS.has(gram) && !/^\d+$/.test(gram)) grams.add(gram)
    }
  }
  return grams
}

function overlapScore(left: Set<string>, right: Set<string>, weight: number, maximum: number) {
  let overlap = 0
  for (const value of right) {
    if (left.has(value)) overlap += weight
    if (overlap >= maximum) return maximum
  }
  return overlap
}

function defaultStructureFor(docType: string) {
  if (/架构|技术|接口|软件/.test(docType)) {
    return ['背景与目标', '范围与约束', '总体方案', '关键设计', '风险与验证', '实施与演进']
  }
  if (/产品|需求|体验|UI/.test(docType)) {
    return ['背景与目标', '用户与场景', '需求或设计方案', '关键流程', '验收标准', '后续计划']
  }
  return ['背景与目标', '现状与问题', '核心方案', '执行计划', '风险与度量', '结论']
}

function detectCategoryKeywords(text: string) {
  const rules: Array<[RegExp, string]> = [
    [/电商|零售|商品|订单/, '电商零售'],
    [/银行|支付|信贷|金融/, '银行与支付'],
    [/保险|理赔|精算/, '保险'],
    [/制造|产线|工艺|工业/, '智能制造'],
    [/咨询|研究报告/, '咨询与研究'],
    [/品牌|内容策划/, '品牌与内容'],
    [/云计算|数据平台|人工智能|大模型|机器学习/, '云计算、数据与人工智能'],
    [/网络安全|信息安全|威胁建模/, '网络安全'],
    [/证券|基金|资管|投资研究|估值/, '证券、基金与资产管理'],
    [/农业|种植|畜牧|养殖|林业|渔业|水产/, '农林牧渔'],
    [/建筑|施工|工程造价|房地产|物业/, '建筑与房地产'],
    [/煤矿|矿山|石油|天然气|电网|电力|新能源|储能/, '能源与矿业'],
    [/公路|铁路|航空运输|航运|港口|仓储|物流|快递|配送/, '交通运输与物流'],
    [/商超|百货|批发|进出口|跨境贸易|经销/, '批发零售与贸易'],
    [/课程|教学|教研|学校|高校|职业教育|培训/, '教育与培训'],
    [/医院|临床|护理|药品|生物科技|医疗器械|康养|养老/, '医疗健康与生命科学'],
    [/新闻|出版|影视|广告|公关|赛事|博物馆|展览/, '文化传媒与文体娱乐'],
    [/旅游|旅行|酒店|餐饮|景区|度假/, '旅游、酒店与餐饮'],
    [/政策|政府|事业单位|社区服务|应急管理|公共安全/, '政府与公共服务'],
    [/电信|通信网络|卫星通信|数据中心/, '电信与通信'],
    [/环保|污水|固废|环卫|环境治理|供水|燃气|供热/, '环保与公用事业'],
    [/科研|实验室|检验检测|认证审核/, '科研、检测与认证'],
    [/基金会|慈善|公益|行业协会|商会|社会工作/, '社会组织与非营利'],
    [/家政|美容美发|维修服务|婚庆|宠物服务/, '生活与个人服务'],
    [/技术架构|总体架构|系统架构/, '技术架构设计文档'],
    [/接口|\bapi\b/i, '接口设计文档'],
    [/产品需求|\bprd\b/i, '产品需求文档'],
    [/\bui\b|界面设计/i, 'UI 设计文档'],
    [/用户体验|\bux\b/i, '用户体验设计文档'],
    [/运营方案/, '运营方案'],
  ]
  return Array.from(new Set(rules.filter(([pattern]) => pattern.test(text)).map(([, keyword]) => keyword)))
}

function serializeLocalSkill(skill: Omit<LocalCreationSkill, 'id' | 'createdAt' | 'updatedAt'>) {
  return {
    client_skill_key: skill.clientSkillKey,
    cloud_skill_id: skill.cloudSkillId || null,
    source_kind: skill.sourceKind,
    source_id: skill.sourceId,
    title: skill.title,
    summary: skill.summary,
    category_id: skill.categoryId || null,
    common_titles: skill.commonTitles,
    title_style: skill.titleStyle,
    text_style: skill.textStyle,
    diagram_style: skill.diagramStyle,
    structure_pattern: skill.structurePattern,
    writing_guidelines: skill.writingGuidelines,
    section_headings: {
      common_titles: '这类文档标题通常怎么命名',
      title_style: skill.sectionHeadings.titleStyle,
      text_style: skill.sectionHeadings.textStyle,
      diagram_style: skill.sectionHeadings.diagramStyle,
      structure_pattern: skill.sectionHeadings.structurePattern,
      writing_guidelines: skill.sectionHeadings.writingGuidelines,
    },
    field_examples: {
      common_titles: skill.fieldExamples.commonTitles,
      title_style: skill.fieldExamples.titleStyle,
      text_style: skill.fieldExamples.textStyle,
      diagram_style: skill.fieldExamples.diagramStyle,
      structure_pattern: skill.fieldExamples.structurePattern,
      writing_guidelines: skill.fieldExamples.writingGuidelines,
    },
    example_document: skill.exampleDocument,
    status: skill.status,
    installed: skill.installed,
    published: skill.published,
  }
}

function mapLocalSkill(item: any): LocalCreationSkill {
  const legacyContent = !item.section_headings || !item.field_examples || !String(item.example_document || '').trim()
  const legacyDefaults = buildLegacyGeneralizedContent(String(item.title || ''))
  return {
    id: Number(item.id),
    clientSkillKey: item.client_skill_key,
    cloudSkillId: item.cloud_skill_id,
    sourceKind: item.source_kind,
    sourceId: item.source_id,
    title: item.title,
    summary: item.summary,
    categoryId: item.category_id,
    commonTitles: legacyContent ? legacyDefaults.commonTitles : item.common_titles || [],
    titleStyle: legacyContent ? legacyDefaults.titleStyle : item.title_style || '',
    textStyle: legacyContent ? legacyDefaults.textStyle : item.text_style || '',
    diagramStyle: legacyContent ? legacyDefaults.diagramStyle : item.diagram_style || '',
    structurePattern: legacyContent ? legacyDefaults.structurePattern : item.structure_pattern || [],
    writingGuidelines: legacyContent ? legacyDefaults.writingGuidelines : item.writing_guidelines || [],
    sectionHeadings: mapSectionHeadings(item.section_headings),
    fieldExamples: mapFieldExamples(item.field_examples),
    exampleDocument: item.example_document?.trim() || DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
    status: item.status === 'draft' ? 'draft' : 'saved',
    installed: Boolean(item.installed),
    published: Boolean(item.published),
    createdAt: Number(item.created_at),
    updatedAt: Number(item.updated_at),
  }
}

function mapMarketSkill(item: any): CreationSkillMarketItem {
  const content = item?.content || {}
  return {
    id: String(item.id || ''),
    title: String(item.title || ''),
    summary: String(item.summary || ''),
    categoryId: String(item.category_id || ''),
    categoryPath: Array.isArray(item.category_path)
      ? item.category_path.map((category: any) => ({
        id: String(category.id || ''),
        key: String(category.key || ''),
        name: String(category.name || ''),
        level: Number(category.level) as 1 | 2 | 3 | 4,
        parentId: category.parent_id ? String(category.parent_id) : undefined,
        sortOrder: Number(category.sort_order || 0),
      }))
      : [],
    author: {
      id: String(item?.author?.id || ''),
      nickname: String(item?.author?.nickname || '匿名面包师'),
    },
    commonTitles: Array.isArray(content.common_titles) ? content.common_titles : [],
    titleStyle: String(content.title_style || ''),
    textStyle: String(content.text_style || ''),
    diagramStyle: String(content.diagram_style || ''),
    structurePattern: Array.isArray(content.structure_pattern) ? content.structure_pattern : [],
    writingGuidelines: Array.isArray(content.writing_guidelines) ? content.writing_guidelines : [],
    sectionHeadings: mapSectionHeadings(content.section_headings),
    fieldExamples: mapFieldExamples(content.field_examples),
    exampleDocument: String(content.example_document || '').trim() || DEFAULT_CREATION_SKILL_EXAMPLE_DOCUMENT,
    publishedAt: item.published_at || null,
    updatedAt: String(item.updated_at || ''),
  }
}

function buildLegacyGeneralizedContent(title: string) {
  const kind = /技术|架构|系统|接口/i.test(title)
    ? '技术方案'
    : /复盘|总结|报告/.test(title)
      ? '阶段复盘'
      : /运营|活动|内容/.test(title)
        ? '运营方案'
        : '专业协作'
  return {
    commonTitles: [`${kind}说明`, `${kind}设计与实施方案`, `${kind}复盘与后续行动`],
    titleStyle: '主标题说明交付物，副标题只限定通用范围、阶段或关键约束；避免真实组织、项目、产品、日期和指标。',
    textStyle: '正文采用结论先行的短段落，先说明目标与约束，再给出方案、依据、风险和验证方式；所有角色与事实均使用通用表达。',
    diagramStyle: '只在结构或流程需要快速理解时绘图，优先使用分层图、流程图或对比表，并以抽象角色标注边界与流向。',
    structurePattern: ['背景与目标', '约束与设计原则', '总体方案', '实施计划', '风险与验证', '结论与后续'],
    writingGuidelines: [
      '使用抽象角色和虚构场景，不保留真实组织或业务名称。',
      '每个关键结论补充依据、适用范围或验证方式。',
      '避免源文档中的日期、指标、金额和专有术语组合。',
      '图示与正文使用一致的通用术语。',
    ],
  }
}

function mapSectionHeadings(item: any): CreationSkillSectionHeadings {
  return {
    commonTitles: '这类文档标题通常怎么命名',
    titleStyle: item?.title_style?.trim() || DEFAULT_CREATION_SKILL_SECTION_HEADINGS.titleStyle,
    textStyle: item?.text_style?.trim() || DEFAULT_CREATION_SKILL_SECTION_HEADINGS.textStyle,
    diagramStyle: item?.diagram_style?.trim() || DEFAULT_CREATION_SKILL_SECTION_HEADINGS.diagramStyle,
    structurePattern: item?.structure_pattern?.trim() || DEFAULT_CREATION_SKILL_SECTION_HEADINGS.structurePattern,
    writingGuidelines: item?.writing_guidelines?.trim() || DEFAULT_CREATION_SKILL_SECTION_HEADINGS.writingGuidelines,
  }
}

function mapFieldExamples(item: any): CreationSkillFieldExamples {
  const normalize = (value: unknown, fallback: string[]) =>
    Array.isArray(value) && value.some(entry => String(entry).trim())
      ? value.map(entry => String(entry).trim()).filter(Boolean)
      : [...fallback]
  return {
    commonTitles: normalize(item?.common_titles, DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.commonTitles),
    titleStyle: normalize(item?.title_style, DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.titleStyle),
    textStyle: normalize(item?.text_style, DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.textStyle),
    diagramStyle: normalize(item?.diagram_style, DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.diagramStyle),
    structurePattern: normalize(item?.structure_pattern, DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.structurePattern),
    writingGuidelines: normalize(item?.writing_guidelines, DEFAULT_CREATION_SKILL_FIELD_EXAMPLES.writingGuidelines),
  }
}

function cloneFieldExamples(examples: CreationSkillFieldExamples): CreationSkillFieldExamples {
  return {
    commonTitles: [...examples.commonTitles],
    titleStyle: [...examples.titleStyle],
    textStyle: [...examples.textStyle],
    diagramStyle: [...examples.diagramStyle],
    structurePattern: [...examples.structurePattern],
    writingGuidelines: [...examples.writingGuidelines],
  }
}
