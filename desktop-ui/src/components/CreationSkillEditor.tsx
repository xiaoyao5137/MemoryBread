import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronRight, Loader2, Save, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import {
  analyzeCreationSkill,
  categoryPathFor,
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
  exampleDocument: string
}

const emptyForm: SkillForm = {
  title: '',
  summary: '',
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
  exampleDocument: '',
}

const toForm = (skill: LocalCreationSkill): SkillForm => ({
  title: skill.title,
  summary: skill.summary,
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
  exampleDocument: skill.exampleDocument,
})

const analysisToForm = (analysis: CreationSkillAnalysis): SkillForm => ({
  title: analysis.title,
  summary: analysis.summary,
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
  exampleDocument: analysis.exampleDocument,
})

const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)

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
        setError(toUserFacingError(err, '沉淀 Skill 失败'))
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

  const updateField = (field: keyof SkillForm, value: string) => setForm(prev => ({ ...prev, [field]: value }))

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
    return {
      clientSkillKey: savedSkill?.clientSkillKey || clientSkillKeyRef.current,
      cloudSkillId: cloudSkillId || null,
      sourceKind: resolvedSource.kind,
      sourceId: resolvedSource.id,
      title: form.title.trim(),
      summary: form.summary.trim(),
      categoryId: form.categoryId || null,
      commonTitles: lines(form.commonTitles),
      titleStyle: form.titleStyle.trim(),
      textStyle: form.textStyle.trim(),
      diagramStyle: form.diagramStyle.trim(),
      structurePattern: lines(form.structurePattern),
      writingGuidelines: lines(form.writingGuidelines),
      sectionHeadings: {
        commonTitles: '这类文档标题通常怎么命名',
        titleStyle: form.titleStyleHeading.trim(),
        textStyle: form.textStyleHeading.trim(),
        diagramStyle: form.diagramStyleHeading.trim(),
        structurePattern: form.structurePatternHeading.trim(),
        writingGuidelines: form.writingGuidelinesHeading.trim(),
      },
      fieldExamples: {
        commonTitles: lines(form.commonTitleExamples),
        titleStyle: lines(form.titleStyleExamples),
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
    if (!input.title || !input.summary || !input.commonTitles.length || !input.titleStyle || !input.textStyle || !input.diagramStyle || !input.structurePattern.length || !headingsComplete || !examplesComplete || input.exampleDocument.length < 100) {
      throw new Error('请补全 Skill 内容、两层标题、逐字段示例和完整示例文档')
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
    if (!input.title || !input.summary || !input.commonTitles.length || !input.titleStyle || !input.textStyle || !input.diagramStyle || !input.structurePattern.length || !headingsComplete || !examplesComplete || input.exampleDocument.length < 100) return
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
          setError(toUserFacingError(err, '自动保存 Skill 草稿失败'))
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
      setMessage('Skill 已保存，默认不安装；可到创作 Skill 页面安装后使用。')
    } catch (err) {
      setError(toUserFacingError(err, '保存 Skill 失败'))
    } finally {
      setWorking(null)
    }
  }

  const sourceLabel = source?.title || initialSkill?.title || '既有文档'
  const busy = working !== null
  const progressLabel = analysisProgress < 30
    ? '正在读取标题与章节层级'
    : analysisProgress < 68
      ? '正在提炼表达、结构与图示习惯'
      : analysisProgress < 94
        ? '正在归纳适用场景与创作类目'
        : '正在生成可编辑草稿'

  return (
    <div className="creation-skill-modal" role="dialog" aria-modal="true" aria-labelledby="creation-skill-title">
      <div className="creation-skill-editor">
        <header className="creation-skill-editor__header">
          <div>
            <span>沉淀自：{sourceLabel}</span>
            <h2 id="creation-skill-title">{initialSkill ? '创作Skill' : '沉淀创作 Skill'}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭 Skill 编辑器"><X /></button>
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
                <AlertCircle size={17} /> 本地模型服务暂时不可用，已自动生成完整规则草稿并分析类目，请检查后保存。
              </div>
            )}
            <div className="creation-skill-form-grid">
              <label><span>Skill 标题</span><input value={form.title} maxLength={80} onChange={event => updateField('title', event.target.value)} /></label>
              <label className="creation-skill-field--wide"><span>Skill 简介</span><textarea rows={3} value={form.summary} maxLength={400} onChange={event => updateField('summary', event.target.value)} /></label>
            </div>

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
                <header><span>01 / 常见标题</span><h3>这类文档标题通常怎么命名</h3></header>
                <label><span>提炼结果 <small>每行一个</small></span><textarea aria-label="常见标题提炼结果" rows={5} value={form.commonTitles} onChange={event => updateField('commonTitles', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>脱离原文的示例 <small>每行一个</small></span><textarea aria-label="常见标题示例" rows={3} value={form.commonTitleExamples} onChange={event => updateField('commonTitleExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field">
                <header><span>02 / 标题风格</span><input aria-label="标题风格二级标题" value={form.titleStyleHeading} maxLength={120} onChange={event => updateField('titleStyleHeading', event.target.value)} /></header>
                <label><span>提炼结果</span><textarea aria-label="标题风格提炼结果" rows={5} value={form.titleStyle} onChange={event => updateField('titleStyle', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>脱离原文的示例 <small>每行一个</small></span><textarea aria-label="标题风格示例" rows={3} value={form.titleStyleExamples} onChange={event => updateField('titleStyleExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field">
                <header><span>03 / 内容文本风格</span><input aria-label="内容文本风格二级标题" value={form.textStyleHeading} maxLength={120} onChange={event => updateField('textStyleHeading', event.target.value)} /></header>
                <label><span>提炼结果</span><textarea aria-label="内容文本风格提炼结果" rows={5} value={form.textStyle} onChange={event => updateField('textStyle', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>脱离原文的示例 <small>每行一个</small></span><textarea aria-label="内容文本风格示例" rows={3} value={form.textStyleExamples} onChange={event => updateField('textStyleExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field">
                <header><span>04 / 画图风格</span><input aria-label="画图风格二级标题" value={form.diagramStyleHeading} maxLength={120} onChange={event => updateField('diagramStyleHeading', event.target.value)} /></header>
                <label><span>提炼结果</span><textarea aria-label="画图风格提炼结果" rows={5} value={form.diagramStyle} onChange={event => updateField('diagramStyle', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>脱离原文的示例 <small>每行一个</small></span><textarea aria-label="画图风格示例" rows={3} value={form.diagramStyleExamples} onChange={event => updateField('diagramStyleExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field">
                <header><span>05 / 常用结构</span><input aria-label="常用结构二级标题" value={form.structurePatternHeading} maxLength={120} onChange={event => updateField('structurePatternHeading', event.target.value)} /></header>
                <label><span>提炼结果 <small>每行一个章节</small></span><textarea aria-label="常用结构提炼结果" rows={5} value={form.structurePattern} onChange={event => updateField('structurePattern', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>脱离原文的示例 <small>每行一个</small></span><textarea aria-label="常用结构示例" rows={3} value={form.structurePatternExamples} onChange={event => updateField('structurePatternExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field">
                <header><span>06 / 写作规则</span><input aria-label="写作规则二级标题" value={form.writingGuidelinesHeading} maxLength={120} onChange={event => updateField('writingGuidelinesHeading', event.target.value)} /></header>
                <label><span>提炼结果 <small>每行一条</small></span><textarea aria-label="写作规则提炼结果" rows={5} value={form.writingGuidelines} onChange={event => updateField('writingGuidelines', event.target.value)} /></label>
                <label className="creation-skill-example-field"><span>脱离原文的示例 <small>每行一个</small></span><textarea aria-label="写作规则示例" rows={3} value={form.writingGuidelineExamples} onChange={event => updateField('writingGuidelineExamples', event.target.value)} /></label>
              </section>
              <section className="creation-skill-recipe-field creation-skill-recipe-field--document">
                <header><span>07 / 完整示例文档</span><h3>用全新虚构主题展示这份 Skill 的实际效果</h3></header>
                <p>这份 Markdown 文档会随 Skill 保存、发布并作为创作 few-shot；不得包含源文档原文或真实业务信息。</p>
                <label><span>脱离原文的完整示例</span><textarea aria-label="完整示例文档" rows={18} value={form.exampleDocument} onChange={event => updateField('exampleDocument', event.target.value)} /></label>
              </section>
            </div>

            {error && <div className="creation-skill-feedback creation-skill-feedback--error" role="alert">{error}</div>}
            {message && <div className="creation-skill-feedback"><Check size={16} /> {message}</div>}
            {(savedSkill?.status === 'draft' || draftSyncing) && (
              <div className="creation-skill-draft-state" aria-live="polite">
                {draftSyncing ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                <span>{draftSyncing ? '正在自动保存草稿…' : '草稿已自动保存在本机，点击「保存 Skill」后才会进入可安装状态。'}</span>
              </div>
            )}
          </div>
        )}

        <footer className="creation-skill-editor__footer">
          <button type="button" className="creation-skill-button" onClick={() => void saveSkill()} disabled={busy || working === 'analyzing'}>
            {working === 'saving' ? <Loader2 className="spin" /> : <Save />} {savedSkill?.status === 'saved' ? '保存修改' : '保存 Skill'}
          </button>
        </footer>
      </div>
    </div>
  )
}
