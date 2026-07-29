import { Check, ChevronDown, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CreationSkillCategoryOption } from '../utils/creationSkills'

interface CreationSkillCategoryComboboxProps {
  value: string
  options: CreationSkillCategoryOption[]
  onChange: (value: string) => void
}

const normalizeSearchText = (value: string) =>
  value.toLocaleLowerCase('zh-CN').replace(/[\s/\\|·、，,。._-]+/g, '')

export const fuzzyCreationSkillCategoryMatch = (candidate: string, query: string) => {
  const normalizedCandidate = normalizeSearchText(candidate)
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return true
  if (normalizedCandidate.includes(normalizedQuery)) return true
  if (normalizedQuery.length < 2) return false

  let queryIndex = 0
  for (const character of normalizedCandidate) {
    if (character === normalizedQuery[queryIndex]) queryIndex += 1
    if (queryIndex === normalizedQuery.length) return true
  }
  return false
}

const CreationSkillCategoryCombobox = ({
  value,
  options,
  onChange,
}: CreationSkillCategoryComboboxProps) => {
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const optionDetails = useMemo(() => {
    const byId = new Map(options.map(option => [option.id, option]))
    return options.map(option => {
      const names: string[] = []
      const visited = new Set<string>()
      let cursor: CreationSkillCategoryOption | undefined = option
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id)
        names.unshift(cursor.name)
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
      }
      return { option, path: names.join(' / ') }
    })
  }, [options])

  const selected = optionDetails.find(({ option }) => option.id === value)
  const filteredOptions = useMemo(
    () => optionDetails.filter(({ path }) => fuzzyCreationSkillCategoryMatch(path, query)),
    [optionDetails, query],
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  const selectOption = (id: string) => {
    onChange(id)
    setOpen(false)
    setQuery('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(current => open
        ? Math.min(current + 1, Math.max(0, filteredOptions.length - 1))
        : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(current => open ? Math.max(current - 1, 0) : 0)
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      const activeOption = filteredOptions[activeIndex]
      if (activeOption) selectOption(activeOption.option.id)
      else if (!query) selectOption('')
    } else if (event.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div className="creation-skill-category-combobox" ref={rootRef}>
      <span className="creation-skill-category-combobox__control">
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={open && filteredOptions[activeIndex]
            ? `${listboxId}-${filteredOptions[activeIndex].option.id}`
            : undefined}
          autoComplete="off"
          placeholder="搜索行业、工种或文档类型"
          value={open ? query : selected?.path || ''}
          onFocus={() => {
            setOpen(true)
            setQuery('')
          }}
          onChange={event => {
            setQuery(event.target.value)
            onChange('')
            setOpen(true)
          }}
          onKeyDown={handleKeyDown}
        />
        <ChevronDown className={open ? 'is-open' : ''} size={16} aria-hidden="true" />
      </span>

      {open && (
        <div className="creation-skill-category-combobox__menu" id={listboxId} role="listbox">
          {!query && (
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onMouseDown={event => event.preventDefault()}
              onClick={() => selectOption('')}
            >
              <span><strong>全部行业与工种</strong><small>不限制创作类目</small></span>
              {!value && <Check size={15} aria-hidden="true" />}
            </button>
          )}
          {filteredOptions.map(({ option, path }, index) => (
            <button
              id={`${listboxId}-${option.id}`}
              key={option.id}
              type="button"
              role="option"
              aria-selected={value === option.id}
              className={index === activeIndex ? 'is-active' : ''}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => selectOption(option.id)}
            >
              <span><strong>{option.name}</strong><small>{path}</small></span>
              {value === option.id && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
          {filteredOptions.length === 0 && query && (
            <div className="creation-skill-category-combobox__empty">没有匹配类目，换个关键词试试</div>
          )}
        </div>
      )}
    </div>
  )
}

export default CreationSkillCategoryCombobox
