import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { BookOpenText, CheckCircle2, UserRound, X } from 'lucide-react'
import type {
  CreationSkillContent,
  CreationSkillMarketItem,
  LocalCreationSkill,
} from '../utils/creationSkills'
import './CreationSkillDetail.css'

export interface CreationSkillDetailData extends CreationSkillContent {
  id: string
  title: string
  summary: string
  categoryPath: string[]
  author?: string
  statusLabel: string
  installed: boolean
  source: 'local' | 'market'
}

interface CreationSkillDetailProps {
  skill: CreationSkillDetailData
  onClose: () => void
  primaryAction?: {
    label: string
    loadingLabel?: string
    loading?: boolean
    disabled?: boolean
    onClick: () => void
  }
}

export function localSkillDetail(
  skill: LocalCreationSkill,
  categoryPath: string[],
): CreationSkillDetailData {
  return {
    ...skill,
    id: String(skill.id),
    categoryPath,
    statusLabel: skill.sourceKind === 'market'
      ? '来自市场'
      : skill.published
        ? '已发布'
        : skill.status === 'draft'
          ? '草稿'
          : '已保存',
    source: skill.sourceKind === 'market' ? 'market' : 'local',
  }
}

export function marketSkillDetail(
  skill: CreationSkillMarketItem,
  installed: boolean,
): CreationSkillDetailData {
  return {
    ...skill,
    categoryPath: skill.categoryPath.map(item => item.name),
    author: skill.author.nickname,
    statusLabel: '市场 Skill',
    installed,
    source: 'market',
  }
}

export default function CreationSkillDetail({
  skill,
  onClose,
  primaryAction,
}: CreationSkillDetailProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    closeButtonRef.current?.focus()
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const recipeSections = [
    {
      heading: skill.sectionHeadings.titleStyle,
      content: skill.titleStyle,
      examples: skill.fieldExamples.titleStyle,
    },
    {
      heading: skill.sectionHeadings.textStyle,
      content: skill.textStyle,
      examples: skill.fieldExamples.textStyle,
    },
    {
      heading: skill.sectionHeadings.diagramStyle,
      content: skill.diagramStyle,
      examples: skill.fieldExamples.diagramStyle,
    },
  ]

  return (
    <div className="creation-skill-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        className="creation-skill-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`creation-skill-detail-title-${skill.id}`}
      >
        <header className="creation-skill-detail__header">
          <div>
            <span>{skill.statusLabel}</span>
            <h2 id={`creation-skill-detail-title-${skill.id}`}>{skill.title}</h2>
            <p>{skill.summary}</p>
            <div className="creation-skill-detail__meta">
              {skill.categoryPath.length > 0 && <span>{skill.categoryPath.join(' / ')}</span>}
              {skill.author && <span><UserRound size={14} /> {skill.author}</span>}
              {skill.installed && <span><CheckCircle2 size={14} /> 已安装</span>}
            </div>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭 Skill 详情">
            <X size={18} />
          </button>
        </header>

        <div className="creation-skill-detail__body">
          <section className="creation-skill-detail__section">
            <span>常见标题</span>
            <h3>{skill.sectionHeadings.commonTitles}</h3>
            <ul>{skill.commonTitles.map(item => <li key={item}>{item}</li>)}</ul>
            <ExampleList items={skill.fieldExamples.commonTitles} />
          </section>

          {recipeSections.map(section => (
            <section className="creation-skill-detail__section" key={section.heading}>
              <span>创作配方</span>
              <h3>{section.heading}</h3>
              <p>{section.content}</p>
              <ExampleList items={section.examples} />
            </section>
          ))}

          <section className="creation-skill-detail__section">
            <span>章节骨架</span>
            <h3>{skill.sectionHeadings.structurePattern}</h3>
            <ol>{skill.structurePattern.map(item => <li key={item}>{item}</li>)}</ol>
            <ExampleList items={skill.fieldExamples.structurePattern} />
          </section>

          <section className="creation-skill-detail__section">
            <span>写作约束</span>
            <h3>{skill.sectionHeadings.writingGuidelines}</h3>
            {skill.writingGuidelines.length > 0
              ? <ul>{skill.writingGuidelines.map(item => <li key={item}>{item}</li>)}</ul>
              : <p>这份 Skill 没有额外写作约束。</p>}
            <ExampleList items={skill.fieldExamples.writingGuidelines} />
          </section>

          <section className="creation-skill-detail__document">
            <div>
              <BookOpenText size={17} />
              <h3>完整示例文档</h3>
            </div>
            <p>示例用于理解结构与表达方式，创作时不会照抄其中主题。</p>
            <article className="creation-skill-detail__markdown">
              <ReactMarkdown>{skill.exampleDocument}</ReactMarkdown>
            </article>
          </section>
        </div>

        <footer className="creation-skill-detail__footer">
          <button type="button" onClick={onClose}>关闭</button>
          {primaryAction && (
            <button
              type="button"
              className="is-primary"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled || primaryAction.loading}
            >
              {primaryAction.loading && primaryAction.loadingLabel
                ? primaryAction.loadingLabel
                : primaryAction.label}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

function ExampleList({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="creation-skill-detail__examples">
      <strong>写法示例</strong>
      <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
    </div>
  )
}
