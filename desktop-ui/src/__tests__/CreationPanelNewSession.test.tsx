import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import CreationPanel from '../components/CreationPanel'
import { useAppStore } from '../store/useAppStore'

describe('创作新会话', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    useAppStore.getState().setApiBaseUrl('http://localhost:7070')
    useAppStore.getState().setCreationDraft({
      prompt: '继续补充风险章节',
      docType: '技术方案',
      audience: '研发团队',
      generatedContent: '# 当前文档',
      enableWebSearch: true,
      contentWeight: 35,
      referencePreview: {
        requirement: {
          topic: 'Agent 架构',
          doc_type: '技术方案',
          audience: '研发团队',
          style: '',
          keywords: [],
        },
        references: [],
      },
      sessionId: 'session-existing',
      rootRequest: '设计 Agent 架构方案',
      conversation: [{
        id: 'message-1',
        role: 'user',
        content: '设计 Agent 架构方案',
        createdAt: 1,
      }],
      agentEvents: [{
        schema_version: 'creation.agent.v1',
        event_id: 'event-1',
        session_id: 'session-existing',
        run_id: 'run-1',
        sequence: 1,
        timestamp: 1,
        type: 'run.completed',
        status: 'completed',
        actor: { kind: 'agent', id: 'creation_main_agent', name: '创作 Agent' },
        summary: '本轮创作完成',
        data: {},
      }],
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/creation/skills') return Response.json([])
      if (url.pathname === '/api/creation/history') {
        return Response.json({ items: [], total: 0, limit: 20, offset: 0 })
      }
      return new Response('{}', { status: 404 })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('从页面开启新会话，并保留创作偏好', async () => {
    render(<CreationPanel />)

    fireEvent.click(screen.getByRole('button', { name: '开启新会话' }))

    await waitFor(() => {
      const draft = useAppStore.getState().creationDraft
      expect(draft).toMatchObject({
        prompt: '',
        generatedContent: '',
        referencePreview: null,
        sessionId: null,
        rootRequest: '',
        conversation: [],
        agentEvents: [],
        docType: '技术方案',
        audience: '研发团队',
        enableWebSearch: true,
        contentWeight: 35,
      })
    })
    expect(screen.getByRole('button', { name: '开启新会话' })).toBeDisabled()
    expect(screen.queryByText('当前文档')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('用户消息')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/输入 @ 可选择已安装的技能/)).toHaveFocus()
    })
  })
})
