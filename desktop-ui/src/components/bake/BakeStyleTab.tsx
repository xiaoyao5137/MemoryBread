import React, { useEffect, useMemo, useState } from 'react'
import type { WritingStyleConfig } from '../../types'
import { BakeButton, BakeCard } from './BakeShared'

const toLineSeparated = (items: string[]) => items.join('\n')
const parseLines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)

const BakeStyleTab: React.FC<{
  config: WritingStyleConfig
  onSave: (config: WritingStyleConfig) => Promise<void>
  isSaving: boolean
}> = ({ config, onSave, isSaving }) => {
  const replacementRuleText = useMemo(
    () => config.replacementRules.map(rule => `${rule.from} => ${rule.to}`).join('\n'),
    [config.replacementRules]
  )

  const [preferredPhrases, setPreferredPhrases] = useState(toLineSeparated(config.preferredPhrases))
  const [replacementRules, setReplacementRules] = useState(replacementRuleText)
  const [styleSamples, setStyleSamples] = useState(toLineSeparated(config.styleSamples))

  useEffect(() => {
    setPreferredPhrases(toLineSeparated(config.preferredPhrases))
    setReplacementRules(replacementRuleText)
    setStyleSamples(toLineSeparated(config.styleSamples))
  }, [config, replacementRuleText])

  const handleSave = async () => {
    await onSave({
      preferredPhrases: parseLines(preferredPhrases),
      replacementRules: parseLines(replacementRules).map(line => {
        const [from, to] = line.split('=>').map(item => item.trim())
        return { from: from || line, to: to || '' }
      }),
      styleSamples: parseLines(styleSamples),
      applyToCreation: config.applyToCreation,
      applyToTemplateEditing: config.applyToTemplateEditing,
    })
  }

  return (
    <div className="bake-grid-2">
      <BakeCard>
        <div className="bake-section-title">常用口语词</div>
        <textarea value={preferredPhrases} onChange={(event) => setPreferredPhrases(event.target.value)} className="bake-textarea" rows={8} />
        <div className="bake-muted" style={{ marginTop: 8 }}>每行一个短语，生成内容时会优先参考。</div>
      </BakeCard>
      <BakeCard>
        <div className="bake-section-title">AI 替代词</div>
        <textarea value={replacementRules} onChange={(event) => setReplacementRules(event.target.value)} className="bake-textarea" rows={8} />
        <div className="bake-muted" style={{ marginTop: 8 }}>每行一个规则，格式：原词 =&gt; 替代词。</div>
      </BakeCard>
      <BakeCard>
        <div className="bake-section-title">风格样本</div>
        <textarea value={styleSamples} onChange={(event) => setStyleSamples(event.target.value)} className="bake-textarea" rows={8} />
        <div className="bake-muted" style={{ marginTop: 8 }}>每行一个示例句，帮助稳定输出语气。</div>
      </BakeCard>
      <BakeCard>
        <div className="bake-section-title">应用范围</div>
        <div className="bake-list">
          <div className="bake-muted">内容创作：{config.applyToCreation ? '开启' : '关闭'}</div>
          <div className="bake-muted">模板编辑：{config.applyToTemplateEditing ? '开启' : '关闭'}</div>
          <div className="bake-muted">系统问答会默认参考已启用模板能力，无需单独配置。</div>
        </div>
        <div style={{ marginTop: 16 }} className="bake-actions">
          <BakeButton primary onClick={() => void handleSave()}>{isSaving ? '保存中…' : '保存配置'}</BakeButton>
        </div>
      </BakeCard>
    </div>
  )
}

export default BakeStyleTab
