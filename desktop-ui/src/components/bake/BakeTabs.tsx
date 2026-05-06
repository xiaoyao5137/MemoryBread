import React from 'react'
import type { BakeTab } from '../../types'
import { BakeButton } from './BakeShared'

const tabs: Array<{ key: BakeTab; label: string }> = [
  { key: 'overview', label: '总览' },
  { key: 'memories', label: '时间线' },
  { key: 'knowledge', label: '知识' },
  { key: 'templates', label: '设计' },
  { key: 'sop', label: '操作手册' },
  { key: 'style', label: '写作自然感提升' },
]

const BakeTabs: React.FC<{
  current: BakeTab
  onChange: (tab: BakeTab) => void
}> = ({ current, onChange }) => {
  return (
    <section className="bake-tabs bake-tabs--scroll">
      {tabs.map(tab => (
        <BakeButton key={tab.key} active={current === tab.key} onClick={() => onChange(tab.key)}>
          {tab.label}
        </BakeButton>
      ))}
    </section>
  )
}

export default BakeTabs
