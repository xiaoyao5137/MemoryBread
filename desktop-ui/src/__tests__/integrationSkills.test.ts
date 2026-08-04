import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listIntegrationSkills,
  selectedFilesToIntegrationInput,
  startIntegrationSkillRun,
} from '../utils/integrationSkills'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('integration skill API', () => {
  it('读取本机 Skill 目录并按约定启动异步执行', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'obsidian', inputKind: 'folder' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'integration-1',
        skillId: 'obsidian',
        mode: 'preview',
        status: 'queued',
        inputSummary: { fileCount: 0 },
        logs: [],
        createdAtMs: 10,
      }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listIntegrationSkills('http://127.0.0.1:7070')).resolves.toEqual([
      { id: 'obsidian', inputKind: 'folder' },
    ])
    await expect(startIntegrationSkillRun('http://127.0.0.1:7070', 'obsidian', {
      mode: 'preview',
      files: [],
    })).resolves.toMatchObject({ id: 'integration-1', status: 'queued', skillId: 'obsidian' })

    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:7070/api/integration-skills/obsidian/runs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'preview', files: [], config: {} }),
      }),
    )
  })

  it('移除文件夹根目录并把本地文件编码为 Base64', async () => {
    const note = new File(['# Note'], 'Note.md', { type: 'text/markdown' })
    Object.defineProperty(note, 'webkitRelativePath', { value: 'Vault/Projects/Note.md' })
    Object.defineProperty(note, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('# Note').buffer,
    })

    await expect(selectedFilesToIntegrationInput([note])).resolves.toEqual([{
      path: 'Projects/Note.md',
      mediaType: 'text/markdown',
      contentBase64: 'IyBOb3Rl',
      sizeBytes: 6,
    }])
  })
})
