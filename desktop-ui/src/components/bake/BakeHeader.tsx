import React from 'react'
import { BakeCard, BakePill } from './BakeShared'

const BakeHeader: React.FC<{
  title?: string
  subtitle?: string
}> = ({
  title = '烤面包',
  subtitle = '把高频 capture 和记忆 knowledge 烤成可复用内容资产',
}) => {
  return (
    <BakeCard>
      <div className="bake-header">
        <div>
          <h1 className="bake-title">{title}</h1>
          <p className="bake-subtitle">{subtitle}</p>
        </div>
        <div className="bake-status-group">
          <BakePill text="本地模式" />
          <BakePill text="已接入 knowledge" />
          <BakePill text="仅做提示，不自动执行" />
        </div>
      </div>
    </BakeCard>
  )
}

export default BakeHeader
