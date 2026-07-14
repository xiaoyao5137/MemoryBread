import React from 'react'
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'

interface HistorySearchProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  total: number
  loading: boolean
}

export const HistorySearch = ({
  value,
  onChange,
  placeholder,
  ariaLabel,
  total,
  loading,
}: HistorySearchProps) => (
  <div className="history-browser__toolbar">
    <label className="history-browser__search">
      <Search size={16} aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="清空搜索">
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </label>
    <span className="history-browser__count" role="status" aria-live="polite">
      {loading ? '正在加载…' : value.trim() ? `找到 ${total} 条` : `共 ${total} 条`}
    </span>
  </div>
)

interface HistoryPaginationProps {
  page: number
  pageSize: number
  total: number
  loading: boolean
  onPageChange: (page: number) => void
}

export const HistoryPagination = ({
  page,
  pageSize,
  total,
  loading,
  onPageChange,
}: HistoryPaginationProps) => {
  if (total === 0) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <nav className="history-browser__pagination" aria-label="记录分页">
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={loading || page <= 1}
      >
        <ChevronLeft size={15} aria-hidden="true" />
        上一页
      </button>
      <span>第 {page} / {totalPages} 页</span>
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={loading || page >= totalPages}
      >
        下一页
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </nav>
  )
}
