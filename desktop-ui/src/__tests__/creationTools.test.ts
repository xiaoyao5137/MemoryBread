import { beforeEach, describe, expect, it } from 'vitest'
import {
  CREATION_TOOLS_STORAGE_KEY,
  enabledCreationToolIds,
  loadCreationTools,
  normalizeCreationTools,
  saveCreationTools,
  setCreationToolEnabled,
  setCreationToolInstalled,
} from '../utils/creationTools'

describe('创作 Tool 配置', () => {
  beforeEach(() => {
    window.localStorage.removeItem(CREATION_TOOLS_STORAGE_KEY)
  })

  it('始终安装并开启互联网检索、记忆搜索与数据工具', () => {
    const tools = normalizeCreationTools([
      { id: 'internet_search', installed: false, enabled: false },
      { id: 'memory_search', installed: false, enabled: false },
      { id: 'data_search', installed: false, enabled: false },
      { id: 'webpage_scrape', installed: false, enabled: false },
    ])

    expect(tools.find(tool => tool.id === 'internet_search')).toMatchObject({
      installed: true,
      enabled: true,
    })
    expect(tools.find(tool => tool.id === 'memory_search')).toMatchObject({
      installed: true,
      enabled: true,
    })
    expect(tools.find(tool => tool.id === 'data_search')).toMatchObject({ installed: true, enabled: true })
    expect(tools.find(tool => tool.id === 'webpage_scrape')).toMatchObject({ installed: true, enabled: true })
    expect(enabledCreationToolIds(tools)).toEqual([
      'internet_search',
      'memory_search',
      'data_search',
      'webpage_scrape',
    ])
  })

  it('可选 Tool 支持分别安装、开启、关闭、重新加载和卸载', () => {
    let tools = loadCreationTools()
    tools = setCreationToolInstalled(tools, 'plantuml_diagram', true)
    expect(tools.find(tool => tool.id === 'plantuml_diagram')).toMatchObject({
      installed: true,
      enabled: false,
    })
    expect(enabledCreationToolIds(tools)).not.toContain('plantuml_diagram')

    tools = setCreationToolEnabled(tools, 'plantuml_diagram', true)
    expect(enabledCreationToolIds(tools)).toContain('plantuml_diagram')

    tools = setCreationToolEnabled(tools, 'plantuml_diagram', false)
    expect(enabledCreationToolIds(tools)).not.toContain('plantuml_diagram')
    saveCreationTools(tools)
    expect(loadCreationTools().find(tool => tool.id === 'plantuml_diagram')).toMatchObject({
      installed: true,
      enabled: false,
    })

    tools = setCreationToolInstalled(tools, 'plantuml_diagram', false)
    expect(tools.find(tool => tool.id === 'plantuml_diagram')).toMatchObject({
      installed: false,
      enabled: false,
    })
  })
})
