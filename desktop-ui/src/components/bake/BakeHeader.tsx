import React from 'react'
import { BakeCard, BakePill } from './BakeShared'

const BakeHeader: React.FC<{
  title?: string
  subtitle?: string
}> = ({
  title = '记忆',
  subtitle,
}) => {
  return (
    <BakeCard>
      <div className="bake-header">
        <div>
          <h1 className="bake-title">{title}</h1>
          {subtitle && <p className="bake-subtitle">{subtitle}</p>}
        </div>
      </div>
    </BakeCard>
  )
}

export default BakeHeader
