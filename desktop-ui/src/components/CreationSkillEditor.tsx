import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronRight, Loader2, Plus, Save, Trash2, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import {
  analyzeCreationSkill,
  categoryPathFor,
  CREATION_SKILL_AGENT_OPTIONS,
  CREATION_SKILL_TOOL_OPTIONS,
  fetchCreationSkillCategories,
  saveLocalCreationSkill,
  suggestCreationSkillCategory,
  type CreationSkillAnalysis,
  type CreationSkillCategory,
  type CreationSkillSource,
  type LocalCreationSkill,
} from '../utils/creationSkills'
import { toUserFacingError } from '../utils/userFacingError'
import './CreationSkillEditor.css'

interface CreationSkillEditorProps {
  source?: CreationSkillSource | null
  initialSkill?: LocalCreationSkill | null
  onClose: () => void
  onSaved: (skill: LocalCreationSkill) => void
}

interface SkillForm {
  title: string
  summary: string
  purpose: string
  documentTypes: string
  problems: string
  domains: string
  deliverables: string
  executionSteps: Array<{
    id: string
    title: string
    objective: string
    output: string
    agents: string[]
    skills: string
    tools: string[]
  }>
  categoryId: string
  commonTitles: string
  titleStyle: string
  textStyle: string
  diagramStyle: string
  structurePattern: string
  writingGuidelines: string
  titleStyleHeading: string
  textStyleHeading: string
  diagramStyleHeading: string
  structurePatternHeading: string
  writingGuidelinesHeading: string
  commonTitleExamples: string
  titleStyleExamples: string
  textStyleExamples: string
  diagramStyleExamples: string
  structurePatternExamples: string
  writingGuidelineExamples: string
  distinctiveSections: Array<{
    title: string
    description: string
    guidance: string
    examples: string
  }>
  exampleDocument: string
}

const emptyForm: SkillForm = {
  title: '',
  summary: '',
  purpose: '',
  documentTypes: '',
  problems: '',
  domains: '',
  deliverables: '',
  executionSteps: [],
  categoryId: '',
  commonTitles: '',
  titleStyle: '',
  textStyle: '',
  diagramStyle: '',
  structurePattern: '',
  writingGuidelines: '',
  titleStyleHeading: '',
  textStyleHeading: '',
  diagramStyleHeading: '',
  structurePatternHeading: '',
  writingGuidelinesHeading: '',
  commonTitleExamples: '',
  titleStyleExamples: '',
  textStyleExamples: '',
  diagramStyleExamples: '',
  structurePatternExamples: '',
  writingGuidelineExamples: '',
  distinctiveSections: [],
  exampleDocument: '',
}

const toForm = (skill: LocalCreationSkill): SkillForm => ({
  title: skill.title,
  summary: skill.summary,
  purpose: skill.skillDescription.purpose,
  documentTypes: skill.skillDescription.documentTypes.join('\n'),
  problems: skill.skillDescription.problems.join('\n'),
  domains: skill.skillDescription.domains.join('\n'),
  deliverables: skill.skillDescription.deliverables.join('\n'),
  executionSteps: skill.executionSteps.map(step => ({
    ...step,
    agents: [...step.agents],
    skills: step.skills.join('\n'),
    tools: [...step.tools],
  })),
  categoryId: skill.categoryId || '',
  commonTitles: skill.commonTitles.join('\n'),
  titleStyle: skill.titleStyle,
  textStyle: skill.textStyle,
  diagramStyle: skill.diagramStyle,
  structurePattern: skill.structurePattern.join('\n'),
  writingGuidelines: skill.writingGuidelines.join('\n'),
  titleStyleHeading: skill.sectionHeadings.titleStyle,
  textStyleHeading: skill.sectionHeadings.textStyle,
  diagramStyleHeading: skill.sectionHeadings.diagramStyle,
  structurePatternHeading: skill.sectionHeadings.structurePattern,
  writingGuidelinesHeading: skill.sectionHeadings.writingGuidelines,
  commonTitleExamples: skill.fieldExamples.commonTitles.join('\n'),
  titleStyleExamples: skill.fieldExamples.titleStyle.join('\n'),
  textStyleExamples: skill.fieldExamples.textStyle.join('\n'),
  diagramStyleExamples: skill.fieldExamples.diagramStyle.join('\n'),
  structurePatternExamples: skill.fieldExamples.structurePattern.join('\n'),
  writingGuidelineExamples: skill.fieldExamples.writingGuidelines.join('\n'),
  distinctiveSections: (skill.distinctiveSections || []).map(section => ({
    title: section.title,
    description: section.description,
    guidance: section.guidance,
    examples: section.examples.join('\n'),
  })),
  exampleDocument: skill.exampleDocument,
})

const analysisToForm = (analysis: CreationSkillAnalysis): SkillForm => ({
  title: analysis.title,
  summary: analysis.summary,
  purpose: analysis.skillDescription.purpose,
  documentTypes: analysis.skillDescription.documentTypes.join('\n'),
  problems: analysis.skillDescription.problems.join('\n'),
  domains: analysis.skillDescription.domains.join('\n'),
  deliverables: analysis.skillDescription.deliverables.join('\n'),
  executionSteps: analysis.executionSteps.map(step => ({
    ...step,
    agents: [...step.agents],
    skills: step.skills.join('\n'),
    tools: [...step.tools],
  })),
  categoryId: '',
  commonTitles: analysis.commonTitles.join('\n'),
  titleStyle: analysis.titleStyle,
  textStyle: analysis.textStyle,
  diagramStyle: analysis.diagramStyle,
  structurePattern: analysis.structurePattern.join('\n'),
  writingGuidelines: analysis.writingGuidelines.join('\n'),
  titleStyleHeading: analysis.sectionHeadings.titleStyle,
  textStyleHeading: analysis.sectionHeadings.textStyle,
  diagramStyleHeading: analysis.sectionHeadings.diagramStyle,
  structurePatternHeading: analysis.sectionHeadings.structurePattern,
  writingGuidelinesHeading: analysis.sectionHeadings.writingGuidelines,
  commonTitleExamples: analysis.fieldExamples.commonTitles.join('\n'),
  titleStyleExamples: analysis.fieldExamples.titleStyle.join('\n'),
  textStyleExamples: analysis.fieldExamples.textStyle.join('\n'),
  diagramStyleExamples: analysis.fieldExamples.diagramStyle.join('\n'),
  structurePatternExamples: analysis.fieldExamples.structurePattern.join('\n'),
  writingGuidelineExamples: analysis.fieldExamples.writingGuidelines.join('\n'),
  distinctiveSections: (analysis.distinctiveSections || []).map(section => ({
    title: section.title,
    description: section.description,
    guidance: section.guidance,
    examples: section.examples.join('\n'),
  })),
  exampleDocument: analysis.exampleDocument,
})

const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)

const fallbackNotice = (analysis: CreationSkillAnalysis) => {
  switch (analysis.fallbackReason) {
    case 'invalid_model_output':
      return '本地模型已完成推理，但返回格式未通过校验；已自动生成完整规则草稿并分析类目，请检查后保存。'
    case 'model_timeout':
      return '本地模型分析超时；已自动生成完整规则草稿并分析类目，请检查后保存。'
    case 'model_request_failed':
      return '本地模型请求未完成；已自动生成完整规则草稿并分析类目，请检查模型状态后保存。'
    case 'invalid_service_response':
      return '本地分析结果格式不完整；已自动生成完整规则草稿并分析类目，请检查后保存。'
    case 'analysis_request_failed':
      return '本地分析请求未完成；已自动生成完整规则草稿并分析类目，请检查本地服务后保存。'
    default:
      return '本地模型分析未完成；已自动生成完整规则草稿并分析类目，请检查后保存。'
  }
}

export default function CreationSkillEditor({ source, initialSkill, onClose, onSaved }: CreationSkillEditorProps) {
  const apiBaseUrl = useAppStore(state => state.apiBaseUrl)
  const adminApiBaseUrl = useAppStore(state => state.adminApiBaseUrl)
  const [form, setForm] = useState<SkillForm>(() => initialSkill ? toForm(initialSkill) : emptyForm)
  const [analysis, setAnalysis] = useState<CreationSkillAnalysis | null>(null)
  const [categories, setCategories] = useState<CreationSkillCategory[]>([])
  const [selectedPath, setSelectedPath] = useState<string[]>([])
  const [working, setWorking] = useState<'analyzing' | 'saving' | null>(initialSkill ? null : 'analyzing')
  const [categoryLoading, setCategoryLoading] = useState(true)
  const [categoryError, setCategoryError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [savedSkill, setSavedSkill] = useState<LocalCreationSkill | null>(initialSkill || null)
  const [analysisProgress, setAnalysisProgress] = useState(initialSkill ? 100 : 6)
  const [draftSyncing, setDraftSyncing] = useState(false)
  const draftSignatureRef = useRef('')
  const clientSkillKeyRef = useRef(
    initialSkill?.clientSkillKey || `creation-skill-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
  )

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !working) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, working])

  useEffect(() => {
    let cancelled = false
    setCategoryLoading(true)
    fetchCreationSkillCategories(adminApiBaseUrl)
      .then(items => {
        if (!cancelled) setCategories(items)
      })
      .catch(err => {
        if (!cancelled) setCategoryError(toUserFacingError(err, '创作类目加载失败'))
      })
      .finally(() => {
        if (!cancelled) setCategoryLoading(false)
      })
    return () => { cancelled = true }
  }, [adminApiBaseUrl])

  useEffect(() => {
    if (initialSkill || !source) return
    let cancelled = false
    let revealTimer: number | undefined
    setWorking('analyzing')
    setAnalysisProgress(6)
    setError('')
    analyzeCreationSkill(apiBaseUrl, source)
      .then(result => {
        if (cancelled) return
        setAnalysis(result)
        setForm(analysisToForm(result))
        setAnalysisProgress(100)
        revealTimer = window.setTimeout(() => {
          if (!cancelled) setWorking(null)
        }, 240)
      })
      .catch(err => {
        if (cancelled) return
        setError(toUserFacingError(err, '沉淀技能失败'))
        setWorking(null)
      })
    return () => {
      cancelled = true
      if (revealTimer) window.clearTimeout(revealTimer)
    }
  }, [apiBaseUrl, initialSkill, source])

  useEffect(() => {
    if (working !== 'analyzing' || analysisProgress >= 100) return
    const timer = window.setInterval(() => {
      setAnalysisProgress(current => {
        if (current >= 92) return current
        const increment = current < 32 ? 4 : current < 68 ? 2 : 1
        return Math.min(92, current + increment)
      })
    }, 420)
    return () => window.clearInterval(timer)
  }, [analysisProgress, working])

  useEffect(() => {
    if (!categories.length) return
    const path = categoryPathFor(categories, form.categoryId)
    if (path.length) {
      setSelectedPath(path.map(item => item.id))
      return
    }
    if (!analysis || form.categoryId) return
    const leaf = suggestCreationSkillCategory(categories, analysis, source)
    if (leaf) {
      const matchedPath = categoryPathFor(categories, leaf.id)
      setSelectedPath(matchedPath.map(item => item.id))
      setForm(prev => ({ ...prev, categoryId: leaf.id }))
    }
  }, [analysis, categories, form.categoryId, source?.docType])

  const optionsByLevel = useMemo(() => [1, 2, 3, 4].map(level => categories.filter(category => {
    if (category.level !== level) return false
    if (level === 1) return !category.parentId
    return category.parentId === selectedPath[level - 2]
  }).sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'))), [categories, selectedPath])

  const selectedCategories = useMemo(() => selectedPath
    .map(id => categories.find(category => category.id === id))
    .filter((category): category is CreationSkillCategory => Boolean(category)), [categories, selectedPath])

  const updateField = <K extends keyof SkillForm,>(field: K, value: SkillForm[K]) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const updateDistinctiveSection = (
    index: number,
    field: 'title' | 'description' | 'guidance' | 'examples',
    value: string,
  ) => setForm(prev => ({
    ...prev,
    distinctiveSections: prev.distinctiveSections.map((section, sectionIndex) => (
      sectionIndex === index ? { ...section, [field]: value } : section
    )),
  }))

  const updateExecutionStep = (
    index: number,
    field: 'title' | 'objective' | 'output' | 'skills',
    value: string,
  ) => setForm(prev => ({
    ...prev,
    executionSteps: prev.executionSteps.map((step, stepIndex) => (
      stepIndex === index ? { ...step, [field]: value } : step
    )),
  }))

  const toggleExecutionResource = (
    index: number,
    field: 'agents' | 'tools',
    resourceId: string,
  ) => setForm(prev => ({
    ...prev,
    executionSteps: prev.executionSteps.map((step, stepIndex) => {
      if (stepIndex !== index) return step
      const selected = step[field].includes(resourceId)
      if (!selected && step.agents.length + step.tools.length >= 4) return step
      return {
        ...step,
        [field]: selected
          ? step[field].filter(id => id !== resourceId)
          : [...step[field], resourceId],
      }
    }),
  }))

  const addExecutionStep = () => setForm(prev => ({
    ...prev,
    executionSteps: [
      ...prev.executionSteps,
      {
        id: `custom-step-${prev.executionSteps.length + 1}`,
        title: '',
        objective: '',
        output: '',
        agents: [],
        skills: '',
        tools: [],
      },
    ],
  }))

  const removeExecutionStep = (index: number) => setForm(prev => ({
    ...prev,
    executionSteps: prev.executionSteps.filter((_, stepIndex) => stepIndex !== index),
  }))

  const addDistinctiveSection = () => setForm(prev => ({
    ...prev,
    distinctiveSections: [
      ...prev.distinctiveSections,
      { title: '', description: '', guidance: '', examples: '' },
    ],
  }))

  const removeDistinctiveSection = (index: number) => setForm(prev => ({
    ...prev,
    distinctiveSections: prev.distinctiveSections.filter((_, sectionIndex) => sectionIndex !== index),
  }))

  const selectCategory = (levelIndex: number, value: string) => {
    const next = [...selectedPath.slice(0, levelIndex), value].filter(Boolean)
    setSelectedPath(next)
    setForm(prev => ({ ...prev, categoryId: levelIndex === 3 ? value : '' }))
  }

  const buildLocalInput = (
    published: boolean,
    cloudSkillId = savedSkill?.cloudSkillId,
    status: LocalCreationSkill['status'] = savedSkill?.status || 'draft',
    installed = savedSkill?.installed || false,
  ) => {
    const resolvedSource: CreationSkillSource = source || {
      kind: savedSkill!.sourceKind,
      id: savedSkill!.sourceId,
      title: savedSkill!.title,
      content: '',
      docType: '',
    }
    const titleDesign = lines(form.commonTitles)
    const titleExamples = lines(form.commonTitleExamples)
    return {
      clientSkillKey: savedSkill?.clientSkillKey || clientSkillKeyRef.current,
      cloudSkillId: cloudSkillId || null,
      sourceKind: resolvedSource.kind,
      sourceId: resolvedSource.id,
      title: form.title.trim(),
      summary: form.summary.trim(),
      categoryId: form.categoryId || null,
      skillDescription: {
        purpose: form.purpose.trim(),
        documentTypes: lines(form.documentTypes),
        problems: lines(form.problems),
        domains: lines(form.domains),
        deliverables: lines(form.deliverables),
      },
      executionSteps: form.executionSteps.map((step, index) => ({
        id: step.id.trim() || `custom-step-${index + 1}`,
        title: step.title.trim(),
        objective: step.objective.trim(),
        output: step.output.trim(),
        agents: [...step.agents],
        skills: lines(step.skills),
        tools: [...step.tools],
      })),
      commonTitles: titleDesign,
      // 旧版协议仍要求 titleStyle；新界面不再展示独立字段，只镜像标题设计风格。
      titleStyle: titleDesign.join('；').slice(0, 1200),
      textStyle: form.textStyle.trim(),
      diagramStyle: form.diagramStyle.trim(),
      structurePattern: lines(form.structurePattern),
      writingGuidelines: lines(form.writingGuidelines),
      distinctiveSections: form.distinctiveSections.map(section => ({
        title: section.title.trim(),
        description: section.description.trim(),
        guidance: section.guidance.trim(),
        examples: lines(section.examples),
      })),
      sectionHeadings: {
        commonTitles: '标题设计风格',
        titleStyle: '标题设计风格',
        textStyle: '行文设计思路',
        diagramStyle: '图片生成方式',
        structurePattern: '内部章节推进信息',
        writingGuidelines: '话术表达风格',
      },
      fieldExamples: {
        commonTitles: titleExamples,
        titleStyle: titleExamples,
        textStyle: lines(form.textStyleExamples),
        diagramStyle: lines(form.diagramStyleExamples),
        structurePattern: lines(form.structurePatternExamples),
        writingGuidelines: lines(form.writingGuidelineExamples),
      },
      exampleDocument: form.exampleDocument.trim(),
      status,
      installed,
      published,
    }
  }

  const validate = (
    requiresCategory: boolean,
    status: LocalCreationSkill['status'] = savedSkill?.status || 'draft',
  ) => {
    const input = buildLocalInput(Boolean(savedSkill?.published), savedSkill?.cloudSkillId, status)
    const headingsComplete = Object.values(input.sectionHeadings).every(Boolean)
    const examplesComplete = Object.values(input.fieldExamples).every(items => items.length > 0)
    const distinctiveSectionsComplete = input.distinctiveSections.every(section => (
      section.title && section.description && section.guidance && section.examples.length > 0
    ))
    const descriptionComplete = input.skillDescription.purpose
      && input.skillDescription.documentTypes.length
      && input.skillDescription.problems.length
      && input.skillDescription.deliverables.length
    const executionComplete = input.executionSteps.length > 0
      && input.executionSteps.every(step => (
        step.title
        && step.objective
        && step.output
        && step.agents.length + step.tools.length <= 4
      ))
    if (!input.title || !input.summary || !descriptionComplete || !executionComplete || !input.commonTitles.length || !input.titleStyle || !input.textStyle || !input.diagramStyle || !input.structurePattern.length || !headingsComplete || !examplesComplete || !distinctiveSectionsComplete || input.exampleDocument.length < 100) {
      throw new Error('请补全 Skill 描述、执行步骤、写作配方和完整示例文档')
    }
    if (requiresCategory && !input.categoryId) throw new Error('请选择第四级具体文档类型')
    return input
  }

  useEffect(() => {
    const isDraft = savedSkill?.status === 'draft' || (!savedSkill && Boolean(analysis))
    if (!isDraft || working) return
    const input = buildLocalInput(false, savedSkill?.cloudSkillId, 'draft', false)
    const headingsComplete = Object.values(input.sectionHeadings).every(Boolean)
    const examplesComplete = Object.values(input.fieldExamples).every(items => items.length > 0)
    const distinctiveSectionsComplete = input.distinctiveSections.every(section => (
      section.title && section.description && section.guidance && section.examples.length > 0
    ))
    const descriptionComplete = input.skillDescription.purpose
      && input.skillDescription.documentTypes.length
      && input.skillDescription.problems.length
      && input.skillDescription.deliverables.length
    const executionComplete = input.executionSteps.length > 0
      && input.executionSteps.every(step => (
        step.title
        && step.objective
        && step.output
        && step.agents.length + step.tools.length <= 4
      ))
    if (!input.title || !input.summary || !descriptionComplete || !executionComplete || !input.commonTitles.length || !input.titleStyle || !input.textStyle || !input.diagramStyle || !input.structurePattern.length || !headingsComplete || !examplesComplete || !distinctiveSectionsComplete || input.exampleDocument.length < 100) return
    const signature = JSON.stringify(input)
    if (signature === draftSignatureRef.current) return
    const timer = window.setTimeout(() => {
      draftSignatureRef.current = signature
      setDraftSyncing(true)
      saveLocalCreationSkill(apiBaseUrl, input, savedSkill?.id)
        .then(saved => {
          setSavedSkill(saved)
          onSaved(saved)
        })
        .catch(err => {
          draftSignatureRef.current = ''
          setError(toUserFacingError(err, '自动保存技能草稿失败'))
        })
        .finally(() => setDraftSyncing(false))
    }, 700)
    return () => window.clearTimeout(timer)
  }, [analysis, apiBaseUrl, form, onSaved, savedSkill, working])

  const saveSkill = async () => {
    setWorking('saving')
    setError('')
    setMessage('')
    try {
      const input = validate(false, 'saved')
      const saved = await saveLocalCreationSkill(apiBaseUrl, input, savedSkill?.id)
      setSavedSkill(saved)
      onSaved(saved)
      setMessage('技能已保存，默认不安装；可到「技能」页面安装后使用。')
    } catch (err) {
      setError(toUserFacingError(err, '保存技能失败'))
    } finally {
      setWorking(null)
    }
  }

  const sourceLabel = source?.title || initialSkill?.title || '既有文档'
  const busy = working !== null
  const progressLabel = analysisProgress < 30
    ? '正在读取标题与章节层级'
    : analysisProgress < 68
      ? '正在提炼标题句式、行文思路与惯用话术'
      : analysisProgress < 94
        ? '正在归纳适用场景与创作类目'
        : '正在生成可编辑草稿'

  return (
    <div className="creation-skill-modal" role="dialog" aria-modal="true" aria-labelledby="creation-skill-title">
      <div className="creation-skill-editor">
        <header className="creation-skill-editor__header">
          <div>
            <span>沉淀自：{sourceLabel}</span>
            <h2 id="creation-skill-title">{initialSkill ? '编辑技能' : '沉淀技能'}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭技能编辑器"><X /></button>
        </header>

        {working === 'analyzing' ? (
          <div className="creation-skill-editor__state" aria-live="polite">
            <Loader2 className="spin" />
            <strong>正在本机分析文档写法</strong>
            <span>{progressLabel}</span>
            <div
              className="creation-skill-analysis-progress"
              role="progressbar"
              aria-label="本机分析进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={analysisProgress}
            >
              <div><span style={{ width: `${analysisProgress}%` }} /></div>
              <strong>{analysisProgress}%</strong>
            </div>
          </div>
        ) : (
          <div className="creation-skill-editor__body">
            {analysis?.analysisMode && analysis.analysisMode !== 'local_model' && (
              <div className="creation-skill-notice creation-skill-notice--warning">
                <AlertCircle size={17} /> {fallbackNotice(analysis)}
              </div>
            )}
            <div className="creation-skill-form-grid">
              <label><span>技能标题</span><input value={form.title} maxLength={80} onChange={event => updateField('title', event.target.value)} /></label>
              <label className="creation-skill-field--wide"><span>技能简介</span><textarea rows={3} value={form.summary} maxLength={400} onChange={event => updateField('summary', event.target.value)} /></label>
            </div>

            <section className="creation-skill-description">
              <header>
                <div>
                  <span>Agent 触发与执行契约</span>
                  <h3>Skill 描述</h3>
                  <p>说明何时应调用这枚 Skill，以及它如何从需求和证据产出同类文档。</p>
                </div>
              </header>
              <div className="creation-skill-description__grid">
                <label className="creation-skill-field--wide">
                  <span>能力目标 <small>描述适用场景、对象和总体作用</small></span>
                  <textarea aria-label="Skill 能力目标" rows={3} maxLength={1200} value={form.purpose} onChange={event => updateField('purpose', event.target.value)} />
                </label>
                <label>
                  <span>适用文档 <small>每行一种</small></span>
                  <textarea aria-label="Skill 适用文档" rows={4} value={form.documentTypes} onChange={event => updateField('documentTypes', event.target.value)} />
                </label>
                <label>
                  <span>解决的问题 <small>每行一个</small></span>
                  <textarea aria-label="Skill 解决的问题" rows={4} value={form.problems} onChange={event => updateField('problems', event.target.value)} />
                </label>
                <label>
                  <span>涉及领域 <small>每行一个；不限领域时可为空</small></span>
                  <textarea aria-label="Skill 涉及领域" rows={4} value={form.domains} onChange={event => updateField('domains', event.target.value)} />
                </label>
                <label>
                  <span>目标产物 <small>每行一个可验收交付物</small></span>
                  <textarea aria-label="Skill 目标产物" rows={4} value={form.deliverables} onChange={event => updateField('deliverables', event.target.value)} />
                </label>
              </div>

              <div className="creation-skill-workflow-heading">
                <div>
                  <span>按顺序执行</span>
                  <h4>执行工作流</h4>
                  <p>创作 Agent 会按步骤读取目标与产出，并只调度当前可用、已启用的能力；每步最多选择四个 Agent 与 Tool。</p>
                </div>
                <button type="button" onClick={addExecutionStep} disabled={form.executionSteps.length >= 12}>
                  <Plus size={15} /> 添加步骤
                </button>
              </div>

              <div className="creation-skill-workflow">
                {form.executionSteps.map((step, index) => (
                  <article className="creation-skill-workflow-step" key={`${step.id}-${index}`}>
                    <header>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <input
                        aria-label={`执行步骤 ${index + 1} 标题`}
                        value={step.title}
                        maxLength={80}
                        placeholder="例如：开展行业调研"
                        onChange={event => updateExecutionStep(index, 'title', event.target.value)}
                      />
                      <button type="button" aria-label={`删除执行步骤 ${index + 1}`} onClick={() => removeExecutionStep(index)} disabled={form.executionSteps.length <= 1}>
                        <Trash2 size={14} />
                      </button>
                    </header>
                    <label>
                      <span>步骤目标</span>
                      <textarea rows={3} maxLength={500} value={step.objective} onChange={event => updateExecutionStep(index, 'objective', event.target.value)} />
                    </label>
                    <label>
                      <span>步骤产出</span>
                      <textarea rows={2} maxLength={240} value={step.output} onChange={event => updateExecutionStep(index, 'output', event.target.value)} />
                    </label>
                    <fieldset className="creation-skill-resource-group">
                      <legend>可调用 Agent</legend>
                      <div>
                        {CREATION_SKILL_AGENT_OPTIONS.map(option => (
                          <label key={option.id}>
                            <input
                              type="checkbox"
                              checked={step.agents.includes(option.id)}
                              disabled={!step.agents.includes(option.id) && step.agents.length + step.tools.length >= 4}
                              onChange={() => toggleExecutionResource(index, 'agents', option.id)}
                            />
                            <span>{option.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset className="creation-skill-resource-group">
                      <legend>可调用 Tool</legend>
                      <div>
                        {CREATION_SKILL_TOOL_OPTIONS.map(option => (
                          <label key={option.id}>
                            <input
                              type="checkbox"
                              checked={step.tools.includes(option.id)}
                              disabled={!step.tools.includes(option.id) && step.agents.length + step.tools.length >= 4}
                              onChange={() => toggleExecutionResource(index, 'tools', option.id)}
                            />
                            <span>{option.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <label className="creation-skill-field--wide">
                      <span>可调用其它 Skill <small>每行一个已安装 Skill 的名称或稳定标识</small></span>
                      <textarea
                        rows={2}
                        maxLength={647}
                        placeholder="例如：evidence-brief"
                        value={step.skills}
                        onChange={event => updateExecutionStep(index, 'skills', event.target.value)}
                      />
                    </label>
                  </article>
                ))}
              </div>
            </section>

            <fieldset className="creation-skill-categories">
              <legend>所属创作类目</legend>
              <p>一级行业 → 二级细分行业 → 三级工种 → 四级具体文档类型</p>
              {categoryLoading ? (
                <div className="creation-skill-category-skeleton" aria-live="polite" aria-label="正在加载创作类目">
                  {[0, 1, 2, 3].map(column => (
                    <div key={column}>
                      <span />
                      <i /><i /><i />
                    </div>
                  ))}
                </div>
              ) : categoryError ? (
                <span className="creation-skill-inline-state creation-skill-inline-state--error">{categoryError}</span>
              ) : (
                <div className="creation-skill-category-grid" aria-label="创作类目四级选择">
                  {['一级行业', '二级细分行业', '三级工种', '四级文档类型'].map((label, index) => (
                    <section
                      className={`creation-skill-category-level${index > 0 && !selectedPath[index - 1] ? ' is-disabled' : ''}`}
                      key={label}
                      aria-labelledby={`creation-skill-category-level-${index + 1}`}
                    >
                      <header>
                        <span id={`creation-skill-category-level-${index + 1}`}><b>{index + 1}</b>{label}</span>
                        <small>{optionsByLevel[index].length} 项</small>
                      </header>
                      <div className="creation-skill-category-options" role="listbox" aria-label={label}>
                        {index > 0 && !selectedPath[index - 1] ? (
                          <span className="creation-skill-category-empty">请先选择上一级</span>
                        ) : optionsByLevel[index].length === 0 ? (
                          <span className="creation-skill-category-empty">暂无可选类目</span>
                        ) : optionsByLevel[index].map(item => {
                          const selected = selectedPath[index] === item.id
                          return (
                            <button
                              type="button"
                              className={`creation-skill-category-option${selected ? ' is-selected' : ''}`}
                              role="option"
                              aria-selected={selected}
                              key={item.id}
                              onClick={() => selectCategory(index, item.id)}
                            >
                              <span>{item.name}</span>
                              {selected
                                ? <Check size={15} aria-hidden="true" />
                                : index < 3 && <ChevronRight size={14} aria-hidden="true" />}
                            </button>
                          )
                        })}
                      </div>
                    </section>
                  ))}
                  <div className={`creation-skill-category-path${form.categoryId ? ' is-complete' : ''}`} aria-live="polite">
                    <strong>{form.categoryId ? '已选类目' : '当前路径'}</strong>
                    <span>{selectedCategories.length > 0 ? selectedCategories.map(item => item.name).join(' / ') : '请选择一级行业'}</span>
                    {form.categoryId && <Check size={15} aria-hidden="true" />}
                  </div>
                </div>
              )}
            </fieldset>

            <div className="creation-skill-recipe-grid">
              <section className="creation-skill-recipe-field">
                <header><span>01 / 标题写法</span><h3>标题设计风格</h3></header>
                <label><span>源文档特征 <small>每行一条</small></span><textarea aria-label="标题设计风格提炼结果" rows={5} value={form.commonTitles} onChange={event => updateField('commonTitles', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>源标题脱敏仿写 <small>只替换敏感主客体</small></span><textarea aria-label="标题设计风格示例" rows={3} value={form.commonTitleExamples} onChange={event => updateField('commonTitleExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field">
                <header><span>02 / 组织逻辑</span><h3>行文设计思路</h3></header>
                <label><span>源文档如何推进</span><textarea aria-label="行文设计思路提炼结果" rows={5} value={form.textStyle} onChange={event => updateField('textStyle', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>行文仿写示例 <small>每行一个</small></span><textarea aria-label="行文设计思路示例" rows={3} value={form.textStyleExamples} onChange={event => updateField('textStyleExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field">
                <header><span>03 / 配图实现</span><h3>图片生成方式</h3></header>
                <label><span>启用条件、选型、信息、布局、视觉、图文衔接与自检</span><textarea aria-label="图片生成方式提炼结果" rows={8} value={form.diagramStyle} onChange={event => updateField('diagramStyle', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>代码生图示例 <small>当前支持 PlantUML、Mermaid 等</small></span><textarea aria-label="图片生成方式示例" rows={3} value={form.diagramStyleExamples} onChange={event => updateField('diagramStyleExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field">
                <header><span>04 / 作者话术</span><h3>话术表达风格</h3></header>
                <label><span>原词证据、使用位置、表达作用与边界 <small>每行一条完整规则</small></span><textarea aria-label="话术表达风格提炼结果" rows={8} value={form.writingGuidelines} onChange={event => updateField('writingGuidelines', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>话术迁移示例 <small>每行一个</small></span><textarea aria-label="话术表达风格示例" rows={3} value={form.writingGuidelineExamples} onChange={event => updateField('writingGuidelineExamples', event.target.value)} /></label>
              </section>
              <div className="creation-skill-distinctive-heading">
                <div>
                  <span>动态提炼</span>
                  <h3>源文档特色亮点</h3>
                  <p>模型只在发现固定配方之外的高辨识度写法时生成，可保留多个，也可以手动增删。</p>
                </div>
                <button type="button" onClick={addDistinctiveSection} disabled={form.distinctiveSections.length >= 6}>
                  <Plus size={15} /> 添加特色章节
                </button>
              </div>
              {form.distinctiveSections.map((section, index) => (
                <section className="creation-skill-recipe-field creation-skill-recipe-field--distinctive" key={index}>
                  <header>
                    <span>{String(index + 5).padStart(2, '0')} / 特色亮点</span>
                    <div>
                      <input
                        aria-label={`特色亮点 ${index + 1} 标题`}
                        value={section.title}
                        maxLength={80}
                        placeholder="例如：定义先行的概念建立"
                        onChange={event => updateDistinctiveSection(index, 'title', event.target.value)}
                      />
                      <button type="button" aria-label={`删除特色亮点 ${index + 1}`} onClick={() => removeDistinctiveSection(index)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </header>
                  <label>
                    <span>特征说明</span>
                    <textarea rows={4} value={section.description} onChange={event => updateDistinctiveSection(index, 'description', event.target.value)} />
                  </label>
                  <label>
                    <span>复刻指引 <small>包含适用位置、步骤与边界</small></span>
                    <textarea rows={4} value={section.guidance} onChange={event => updateDistinctiveSection(index, 'guidance', event.target.value)} />
                  </label>
                  <label className="creation-skill-example-field">
                    <span>完整仿写示例 <small>每行一个</small></span>
                    <textarea rows={3} value={section.examples} onChange={event => updateDistinctiveSection(index, 'examples', event.target.value)} />
                  </label>
                </section>
              ))}
              <section className="creation-skill-recipe-field creation-skill-recipe-field--document">
                <header><span>{String(form.distinctiveSections.length + 5).padStart(2, '0')} / 完整示例文档</span><h3>用全新虚构主题展示这份技能的实际效果</h3></header>
                <p>这份 Markdown 文档会随技能保存、发布并作为创作 few-shot；不得包含源文档原文或真实业务信息。</p>
                <label><span>脱离原文的完整示例</span><textarea aria-label="完整示例文档" rows={18} value={form.exampleDocument} onChange={event => updateField('exampleDocument', event.target.value)} /></label>
              </section>
            </div>

            {error && <div className="creation-skill-feedback creation-skill-feedback--error" role="alert">{error}</div>}
            {message && <div className="creation-skill-feedback"><Check size={16} /> {message}</div>}
            {(savedSkill?.status === 'draft' || draftSyncing) && (
              <div className="creation-skill-draft-state" aria-live="polite">
                {draftSyncing ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                <span>{draftSyncing ? '正在自动保存草稿…' : '草稿已自动保存在本机，点击「保存技能」后才会进入可安装状态。'}</span>
              </div>
            )}
          </div>
        )}

        <footer className="creation-skill-editor__footer">
          <button type="button" className="creation-skill-button" onClick={() => void saveSkill()} disabled={busy || working === 'analyzing'}>
            {working === 'saving' ? <Loader2 className="spin" /> : <Save />} {savedSkill?.status === 'saved' ? '保存修改' : '保存技能'}
          </button>
        </footer>
      </div>
    </div>
  )
}
