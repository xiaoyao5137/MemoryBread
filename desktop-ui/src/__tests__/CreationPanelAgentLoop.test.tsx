import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import CreationPanel from '../components/CreationPanel'
import { useAppStore } from '../store/useAppStore'

const goal = {
  objective: '生成 Agent 架构方案',
  status: 'active',
  revision: 2,
  remaining_steps: ['文档撰写 Agent'],
  outcome: '',
}

const event = (
  type: string,
  sequence: number,
  summary: string,
  actor = { kind: 'agent', id: 'creation_main_agent', name: '创作 Agent' },
  data: Record<string, unknown> = {},
  environment_patch: Record<string, unknown> = {},
) => ({
  schema_version: 'creation.agent.v1',
  event_id: `event-${sequence}`,
  session_id: 'session-agent-test',
  run_id: `run-${sequence < 20 ? 1 : 2}`,
  sequence,
  timestamp: 1_720_000_000_000 + sequence,
  type,
  status: type.endsWith('.completed') || type === 'document.replaced' ? 'completed' : 'running',
  actor,
  summary,
  goal,
  environment_patch,
  data,
})

const sse = (events: object[]) => new Response(
  events.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''),
  { headers: { 'Content-Type': 'text/event-stream' } },
)

const installedStyleSkill = {
  id: 31,
  client_skill_key: 'agent-architecture-style',
  cloud_skill_id: null,
  source_kind: 'bake_document',
  source_id: 'doc-agent-style',
  title: 'Agent 架构方案风格',
  summary: '适合生成 Agent 架构方案并复刻技术文档写法。',
  category_id: null,
  common_titles: ['子标题使用“对象＋如何＋动作”的问句结构'],
  title_style: '子标题使用“对象＋如何＋动作”的问句结构',
  text_style: '先解释为什么需要，再说明方案如何落地，最后收束风险与验证。',
  diagram_style: '推荐工具：PlantUML。使用组件图表达 Agent、Tool 与 Skill 的调用关系。',
  structure_pattern: ['问题与原因', '方案设计', '风险与验证'],
  writing_guidelines: ['习惯用“基于此”承接依据并转入方案。'],
  section_headings: {
    common_titles: '标题设计风格',
    title_style: '标题设计风格',
    text_style: '行文设计思路',
    diagram_style: '图片生成方式',
    structure_pattern: '章节组织骨架',
    writing_guidelines: '话术表达风格',
  },
  field_examples: {
    common_titles: ['能力如何落到执行'],
    title_style: ['能力如何落到执行'],
    text_style: ['先界定问题，再逐层展开方案。'],
    diagram_style: ['PlantUML 组件图：用箭头标注调用动作。'],
    structure_pattern: ['问题与原因 → 方案设计 → 风险与验证'],
    writing_guidelines: ['基于此，相关角色开始验证关键路径。'],
  },
  example_document: '# 示例架构方案\n\n## 为什么需要调整\n\n先界定问题。\n\n## 方案如何落地\n\n再说明方案。\n\n## 风险与验证\n\n最后完成验证。',
  status: 'saved',
  installed: true,
  published: false,
  created_at: 1,
  updated_at: 2,
}

describe('创作 Agent 多轮 Loop', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    useAppStore.getState().setApiBaseUrl('http://localhost:7070')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('开始创作后展示 Agent、Tool、Skill 轨迹，并基于当前文档继续多轮优化', async () => {
    const agentPayloads: any[] = []
    const savedHistories: any[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/creation/skills') return Response.json([installedStyleSkill])
      if (url.pathname === '/api/creation/history' && (!init?.method || init.method === 'GET')) {
        return Response.json({ items: [], total: 0, limit: 20, offset: 0 })
      }
      if (url.pathname === '/api/creation/history' && init?.method === 'POST') {
        savedHistories.push(JSON.parse(String(init.body || '{}')))
        return Response.json({ id: 1 })
      }
      if (url.pathname === '/api/creation/agent/run') {
        const payload = JSON.parse(String(init?.body || '{}'))
        agentPayloads.push(payload)
        const secondTurn = agentPayloads.length === 2
        const document = secondTurn
          ? '# Agent 架构方案\n\n## 目标\n\n目标驱动并支持持续优化。\n\n## Loop\n\n本轮补充质量门禁。\n\n## 质量门禁\n\n修订必须通过结构和语义检查。\n\n## 验证\n\n覆盖多轮对话和联动修改。'
          : '# Agent 架构方案\n\n## 目标\n\n目标驱动。\n\n## Loop\n\n动态调用能力。\n\n## 验证\n\n覆盖完整链路。'
        const offset = secondTurn ? 20 : 1
        const mutationEvent = secondTurn
          ? {
            ...event(
              'document.patch.applied',
              offset + 5,
              '已按本轮指令完成 3 处调整，涉及目标、Loop、质量门禁、验证',
              { kind: 'agent', id: 'document_writer_agent', name: '文档撰写 Agent' },
              {
                content: document,
                patch: {
                  operation: 'revise_document',
                  target_sections: ['目标', 'Loop', '质量门禁', '验证'],
                  requested_sections: ['质量门禁'],
                  change_count: 3,
                  changes: [
                    {
                      change_type: 'modified',
                      section_title: 'Loop',
                      start_line: 9,
                      end_line: 9,
                      summary: '修改“Loop”中的内容',
                    },
                    {
                      change_type: 'added',
                      section_title: '质量门禁',
                      start_line: 11,
                      end_line: 13,
                      summary: '新增“质量门禁”中的内容',
                    },
                    {
                      change_type: 'modified',
                      section_title: '验证',
                      start_line: 15,
                      end_line: 17,
                      summary: '修改“验证”中的内容',
                    },
                  ],
                  preserved_untouched: true,
                  summary: '已按本轮指令完成 3 处调整，涉及 Loop、质量门禁、验证',
                },
              },
            ),
            status: 'completed',
          }
          : event(
            'document.replaced',
            offset + 5,
            '文档撰写 Agent 已提交完整文档版本',
            { kind: 'agent', id: 'document_writer_agent', name: '文档撰写 Agent' },
            { content: document, operation: 'create_document' },
          )
        return sse([
          event('run.started', offset, '创作 Agent 已接管目标'),
          event(
            'intent.interpreted',
            offset + 1,
            secondTurn ? '理解为围绕“质量门禁”联动修订完整文档' : '理解为新建完整文档',
            undefined,
            {
              operation: secondTurn ? 'revise_document' : 'create_document',
              target_sections: secondTurn ? ['质量门禁'] : [],
              root_request: '设计创作功能的 Agent 架构方案',
              current_instruction: secondTurn ? '补充质量门禁和多轮测试' : '设计创作功能的 Agent 架构方案',
              reasoning_summary: secondTurn
                ? '目标章节仅作为改动线索，并检查全文联动。'
                : '当前没有既有文档。',
            },
          ),
          event(
            'tool.completed',
            offset + 2,
            '记忆搜索完成，召回 1 条本地资料',
            { kind: 'tool', id: 'memory_search', name: '记忆搜索 Tool' },
            { result_count: 1 },
            {
              references: [{
                id: 8,
                title: '既有架构决策',
                doc_type: '架构方案',
                final_weight: 0.88,
                relevance_score: 0.9,
                quality_score: 0.8,
                completeness_score: 0.8,
                usage_score: 0.5,
                format_score: 0.7,
                freshness_score: 0.9,
                usage_count: 3,
                reason: '主题高度相关',
              }],
            },
          ),
          event(
            'skill.completed',
            offset + 3,
            '已把架构方案模板 Skill 写入环境',
            { kind: 'skill', id: 'architecture-solution-template', name: '架构方案模板 Skill' },
          ),
          event(
            'agent.completed',
            offset + 4,
            '方案设计 Agent 已完成',
            { kind: 'agent', id: 'solution_design_agent', name: '方案设计 Agent' },
          ),
          mutationEvent,
          event(
            'agent.started',
            offset + 6,
            '质量审校 Agent 开始执行',
            { kind: 'agent', id: 'quality_review_agent', name: '质量审校 Agent' },
          ),
          {
            ...event(
              'agent.completed',
              offset + 7,
              '质量检查通过',
              { kind: 'agent', id: 'quality_review_agent', name: '质量审校 Agent' },
            ),
            status: 'completed',
          },
          {
            ...event('run.completed', offset + 8, '本轮创作完成'),
            status: 'completed',
          },
        ])
      }
      return new Response('{}', { status: 404 })
    }))

    render(<CreationPanel />)

    const divider = screen.getByRole('separator', { name: '调整生成内容和创作对话的宽度' })
    const workspace = divider.closest('main') as HTMLElement
    vi.spyOn(workspace, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 1000,
      height: 700,
      top: 0,
      right: 1000,
      bottom: 700,
      left: 0,
      toJSON: () => ({}),
    })
    expect(workspace.style.getPropertyValue('--creation-left-pane')).toBe('60%')
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(workspace.style.getPropertyValue('--creation-left-pane')).toBe('58%')

    await screen.findByRole('button', { name: '技能 (1)' })
    const input = screen.getByPlaceholderText(/输入 @ 可选择已安装的技能/)
    fireEvent.change(input, { target: { value: '设计创作功能的 Agent 架构方案' } })
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }))

    await screen.findByRole('heading', { name: 'Agent 架构方案' })
    expect(screen.getByLabelText('用户消息')).toHaveTextContent('设计创作功能')
    expect(screen.getByLabelText('Agent 执行情况')).toHaveTextContent('记忆搜索 Tool')
    expect(screen.getByLabelText('Agent 执行情况')).toHaveTextContent('架构方案模板 Skill')
    expect(screen.getByLabelText('Agent 执行情况')).toHaveTextContent('方案设计 Agent')
    expect(screen.getByLabelText('Agent 执行情况')).toHaveTextContent('原始需求')
    expect(screen.getByLabelText('Agent 执行情况')).toHaveTextContent('当前没有既有文档')

    const followUp = screen.getByPlaceholderText(/继续告诉 Agent 如何修改当前文档/)
    fireEvent.change(followUp, { target: { value: '补充质量门禁和多轮测试' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(agentPayloads).toHaveLength(2))
    expect(agentPayloads[0].selected_skills[0]).toMatchObject({
      titleDesignStyle: installedStyleSkill.common_titles,
      writingDesign: installedStyleSkill.text_style,
      imageGeneration: installedStyleSkill.diagram_style,
      voiceStyle: installedStyleSkill.writing_guidelines,
      fieldExamples: {
        titleDesignStyle: installedStyleSkill.field_examples.common_titles,
        voiceStyle: installedStyleSkill.field_examples.writing_guidelines,
      },
    })
    expect(agentPayloads[1].current_document).toContain('动态调用能力')
    expect(agentPayloads[1].root_request).toBe('设计创作功能的 Agent 架构方案')
    expect(agentPayloads[1].conversation.map((item: any) => item.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    await screen.findByText('本轮补充质量门禁。')
    expect(screen.getByText('本轮补充质量门禁。')).toHaveClass('creation-latest-change')
    expect(screen.getByText(/本轮改动 3 处/)).toBeInTheDocument()
    expect(screen.getByLabelText('本轮改动')).toHaveTextContent('修改 · Loop')
    expect(screen.getByLabelText('本轮改动')).toHaveTextContent('新增 · 质量门禁')
    const userMessages = screen.getAllByLabelText('用户消息')
    const assistantMessages = screen.getAllByLabelText('Agent 消息')
    const executionTraces = screen.getAllByLabelText('Agent 执行情况')
    expect(executionTraces).toHaveLength(2)
    expect(executionTraces[0]).toHaveTextContent('当前没有既有文档')
    expect(executionTraces[0]).not.toHaveTextContent('目标章节仅作为改动线索')
    expect(executionTraces[1]).toHaveTextContent('目标章节仅作为改动线索')
    expect(executionTraces[1]).not.toHaveTextContent('当前没有既有文档')
    expect(executionTraces[1]).toHaveTextContent('创作 Agent')
    expect(executionTraces[1]).not.toHaveTextContent('创作主 Agent')
    expect(within(executionTraces[1]).getAllByText('创作 Agent')).toHaveLength(2)
    const mainAgentStarted = within(executionTraces[1]).getByText('创作 Agent 已接管目标')
    const mainAgentIntent = within(executionTraces[1]).getByText('理解为围绕“质量门禁”联动修订完整文档')
    const mainAgentNode = mainAgentStarted.closest('.creation-agent-event')
    expect(mainAgentNode).toBe(mainAgentIntent.closest('.creation-agent-event'))
    expect(mainAgentNode?.querySelectorAll('.creation-agent-event__icon')).toHaveLength(1)
    expect(mainAgentNode?.querySelectorAll('.creation-agent-event__update')).toHaveLength(2)
    expect(within(executionTraces[1]).getAllByText('质量审校 Agent')).toHaveLength(1)
    expect(userMessages[1].compareDocumentPosition(executionTraces[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(executionTraces[1].compareDocumentPosition(assistantMessages[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(within(executionTraces[1]).getByRole('button', { name: /执行过程/ }))
    expect(within(executionTraces[1]).queryByText('目标章节仅作为改动线索，并检查全文联动。')).not.toBeInTheDocument()
    expect(within(executionTraces[0]).getByText('当前没有既有文档。')).toBeInTheDocument()
    expect(savedHistories).toHaveLength(2)
    expect(savedHistories[0].session_id).toBe('session-agent-test')
    expect(savedHistories[1].session_id).toBe(savedHistories[0].session_id)
    expect(savedHistories[0].history_id).toBeNull()
    expect(savedHistories[1].history_id).toBe(1)
    expect(savedHistories[1].conversation).toHaveLength(4)
    expect(savedHistories[1].agent_trace.length).toBeGreaterThan(savedHistories[0].agent_trace.length)
    expect(savedHistories[1].root_request).toBe('设计创作功能的 Agent 架构方案')
    expect(savedHistories[1].edit_operation).toBe('revise_document')
    expect(savedHistories[1].document_patch.target_sections).toEqual(['目标', 'Loop', '质量门禁', '验证'])
    expect(savedHistories[1].document_patch.changes).toHaveLength(3)
    const storedIntent = savedHistories[1].agent_trace.find((item: any) => item.type === 'intent.interpreted')
    const storedPatch = savedHistories[1].agent_trace.find((item: any) => item.type === 'document.patch.applied')
    expect(storedIntent.data).not.toHaveProperty('root_request')
    expect(storedIntent.data).not.toHaveProperty('current_instruction')
    expect(storedPatch.data).not.toHaveProperty('content')
    expect(savedHistories[1].agent_trace.every((item: any) => !item.goal?.objective)).toBe(true)
  })

  it('Agent 要求确认时暂停，用户确认后从同一目标继续', async () => {
    const payloads: any[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/creation/skills') return Response.json([])
      if (url.pathname === '/api/creation/history' && (!init?.method || init.method === 'GET')) {
        return Response.json({ items: [], total: 0, limit: 20, offset: 0 })
      }
      if (url.pathname === '/api/creation/history' && init?.method === 'POST') {
        return Response.json({ id: 1 })
      }
      if (url.pathname === '/api/creation/agent/run') {
        const payload = JSON.parse(String(init?.body || '{}'))
        payloads.push(payload)
        if (!payload.confirmed) {
          return sse([
            event('run.started', 1, '创作 Agent 已接管目标'),
            {
              ...event(
                'confirmation.required',
                2,
                '需要确认后才能继续',
                undefined,
                {
                  question: '当前要求较简略。是否按现有信息继续？',
                  request_id: 'confirm-1',
                },
              ),
              status: 'waiting',
            },
            {
              ...event('run.paused', 3, '正在等待用户确认', undefined, { reason: 'user_confirmation' }),
              status: 'waiting',
            },
          ])
        }
        return sse([
          event(
            'document.replaced',
            4,
            '文档撰写 Agent 已提交完整文档版本',
            { kind: 'agent', id: 'document_writer_agent', name: '文档撰写 Agent' },
            { content: '# 方案\n\n## 目标\n\n补全合理假设。\n\n## 内容\n\n继续执行。\n\n## 验证\n\n人工确认。' },
          ),
          { ...event('run.completed', 5, '本轮创作完成'), status: 'completed' },
        ])
      }
      return new Response('{}', { status: 404 })
    }))

    render(<CreationPanel />)
    const input = screen.getByPlaceholderText(/输入 @ 可选择已安装的技能/)
    fireEvent.change(input, { target: { value: '写方案' } })
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }))

    const confirmation = await screen.findByRole('group', { name: 'Agent 请求确认' })
    expect(confirmation).toHaveTextContent('当前要求较简略')
    fireEvent.click(screen.getByRole('button', { name: '按当前信息继续' }))

    await waitFor(() => expect(payloads).toHaveLength(2))
    expect(payloads[1].confirmed).toBe(true)
    expect(payloads[1].conversation).toHaveLength(1)
    await screen.findByRole('heading', { name: '方案' })
  })

  it('品牌模型推理通过暂停与恢复续跑，客户端历史不保存模型提示和恢复状态', async () => {
    const agentPayloads: any[] = []
    const gatewayPayloads: any[] = []
    const savedHistories: any[] = []
    useAppStore.getState().setAuthSession({
      access_token: 'test-token',
      expires_at: '2099-01-01T00:00:00Z',
      user: {
        id: 'user-agent-test',
        nickname: '小麦',
        status: 'active',
        roles: ['user'],
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        created_at: '2026-01-01T00:00:00Z',
      },
    })
    useAppStore.getState().setCloudBalance({
      available: '100.0000',
      reserved: '0.0000',
      currency: 'CREDIT',
      as_of: '2026-07-26T00:00:00Z',
    })
    useAppStore.getState().setCreationModelConfig('mbcd-plus-v1', { enabled: true })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/billing/balance') {
        return Response.json({
          data: {
            available: '100.0000',
            reserved: '0.0000',
            currency: 'CREDIT',
            as_of: '2026-07-26T00:00:00Z',
          },
        })
      }
      if (url.pathname === '/api/creation/skills') return Response.json([])
      if (url.pathname === '/api/creation/history' && (!init?.method || init.method === 'GET')) {
        return Response.json({ items: [], total: 0, limit: 20, offset: 0 })
      }
      if (url.pathname === '/api/creation/history' && init?.method === 'POST') {
        savedHistories.push(JSON.parse(String(init.body || '{}')))
        return Response.json({ id: 1 })
      }
      if (url.pathname === '/v1/gateway/chat') {
        gatewayPayloads.push(JSON.parse(String(init?.body || '{}')))
        return Response.json({ content: '方案设计结论' })
      }
      if (url.pathname === '/api/creation/agent/run') {
        const payload = JSON.parse(String(init?.body || '{}'))
        agentPayloads.push(payload)
        if (!payload.resume_state) {
          return sse([
            event(
              'model.request',
              1,
              '方案设计 Agent 请求品牌模型推理',
              { kind: 'agent', id: 'solution_design_agent', name: '方案设计 Agent' },
              {
                request_id: 'model-request-1',
                messages: [
                  { role: 'system', content: '只输出方案结论' },
                  { role: 'user', content: '设计 Agent Loop' },
                ],
              },
            ),
            {
              ...event(
                'run.paused',
                2,
                '等待品牌模型返回',
                undefined,
                { reason: 'external_model', continuation: { cursor: 3, token: 'resume-secret' } },
              ),
              status: 'waiting',
            },
          ])
        }
        return sse([
          event(
            'document.replaced',
            3,
            '文档撰写 Agent 已提交完整文档版本',
            { kind: 'agent', id: 'document_writer_agent', name: '文档撰写 Agent' },
            { content: '# 外部续跑方案\n\n## 目标\n\n保持品牌模型抽象。\n\n## Loop\n\n暂停后恢复。\n\n## 验证\n\n不泄露内部提示。' },
          ),
          { ...event('run.completed', 4, '本轮创作完成'), status: 'completed' },
        ])
      }
      return new Response('{}', { status: 404 })
    }))

    render(<CreationPanel />)
    const input = screen.getByPlaceholderText(/输入 @ 可选择已安装的技能/)
    fireEvent.change(input, { target: { value: '设计支持暂停恢复的创作 Agent Loop' } })
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }))

    await screen.findByRole('heading', { name: '外部续跑方案' })
    expect(screen.getByLabelText('用户消息')).toHaveTextContent('小麦')
    expect(screen.getByLabelText('用户消息')).not.toHaveTextContent('你')
    expect(agentPayloads).toHaveLength(2)
    expect(agentPayloads[0].model_mode).toBe('external')
    expect(agentPayloads[0]).not.toHaveProperty('creation_model')
    expect(agentPayloads[0]).not.toHaveProperty('creation_base_url')
    expect(agentPayloads[1].resume_state).toEqual({ cursor: 3, token: 'resume-secret' })
    expect(agentPayloads[1].model_result).toBe('方案设计结论')
    expect(gatewayPayloads).toHaveLength(1)
    expect(gatewayPayloads[0]).toMatchObject({
      brand_model_id: 'mbcd-plus-v1',
      caller: 'creation_agent',
      privacy: { content_logging: false, client_scrubbed: true },
    })
    expect(gatewayPayloads[0]).not.toHaveProperty('provider')

    expect(savedHistories).toHaveLength(1)
    const storedModelRequest = savedHistories[0].agent_trace.find((item: any) => item.type === 'model.request')
    const storedPause = savedHistories[0].agent_trace.find((item: any) => item.type === 'run.paused')
    expect(storedModelRequest.data).toEqual({ request_id: 'model-request-1' })
    expect(storedPause.data).toEqual({ reason: 'external_model' })
  })

  it('完成事件可恢复最终文档，避免中间文档事件缺失后误报失败', async () => {
    const completedDocument = '# 行业调研方案\n\n## 背景\n\n补充行业现状。\n\n## 调研结论\n\n形成可核验结论。\n\n## 后续动作\n\n持续更新数据。'
    const savedHistories: any[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/creation/skills') return Response.json([])
      if (url.pathname === '/api/creation/history' && (!init?.method || init.method === 'GET')) {
        return Response.json({ items: [], total: 0, limit: 20, offset: 0 })
      }
      if (url.pathname === '/api/creation/history' && init?.method === 'POST') {
        savedHistories.push(JSON.parse(String(init.body || '{}')))
        return Response.json({ id: 1 })
      }
      if (url.pathname === '/api/creation/agent/run') {
        return sse([
          event('run.started', 1, '创作 Agent 已接管目标'),
          event('goal.updated', 2, '已生成满足当前验收条件的文档'),
          {
            ...event(
              'run.completed',
              3,
              '本轮创作完成',
              undefined,
              { document: completedDocument },
            ),
            status: 'completed',
          },
        ])
      }
      return new Response('{}', { status: 404 })
    }))

    render(<CreationPanel />)
    const input = screen.getByPlaceholderText(/输入 @ 可选择已安装的技能/)
    fireEvent.change(input, { target: { value: '增加行业调研' } })
    fireEvent.click(screen.getByRole('button', { name: '开始创作' }))

    await screen.findByRole('heading', { name: '行业调研方案' })
    await waitFor(() => expect(savedHistories).toHaveLength(1))
    expect(savedHistories[0].generated_content).toBe(completedDocument)
    expect(screen.queryByText('生成失败，请稍后重试')).not.toBeInTheDocument()
  })

  it('运行结束前不把中间 patch 标成已完成改动', async () => {
    const intermediateDocument = '# 周年礼物指南\n\n## 原则\n\n中间版本内容。\n\n## 礼物池\n\n等待审校。\n\n## 执行\n\n等待完成。'
    let releaseStream = () => {}
    const encoder = new TextEncoder()
    useAppStore.getState().setCreationDraft({
      generatedContent: '# 周年礼物指南\n\n## 原则\n\n旧版本。\n\n## 礼物池\n\n旧内容。\n\n## 执行\n\n旧流程。',
      sessionId: 'session-agent-test',
      rootRequest: '写一份周年员工的礼物指南',
      conversation: [{
        id: 'user-root',
        role: 'user',
        content: '写一份周年员工的礼物指南',
        createdAt: 1,
      }],
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/creation/skills') return Response.json([])
      if (url.pathname === '/api/creation/history' && (!init?.method || init.method === 'GET')) {
        return Response.json({ items: [], total: 0, limit: 20, offset: 0 })
      }
      if (url.pathname === '/api/creation/history' && init?.method === 'POST') {
        return Response.json({ id: 1 })
      }
      if (url.pathname === '/api/creation/agent/run') {
        const patch = {
          operation: 'revise_document',
          target_sections: ['礼物池'],
          change_count: 1,
          changes: [{
            change_type: 'modified',
            section_title: '礼物池',
            start_line: 7,
            end_line: 9,
            summary: '修改“礼物池”中的内容',
          }],
          summary: '已完成 1 处调整',
        }
        const firstEvents = [
          event('run.started', 20, '创作 Agent 已接管目标'),
          event(
            'agent.started',
            21,
            '文档撰写 Agent 开始执行',
            { kind: 'agent', id: 'document_writer_agent', name: '文档撰写 Agent' },
          ),
          {
            ...event(
              'document.patch.applied',
              22,
              '已完成 1 处调整',
              { kind: 'agent', id: 'document_writer_agent', name: '文档撰写 Agent' },
              { content: intermediateDocument, patch },
            ),
            status: 'completed',
          },
          event(
            'agent.started',
            23,
            '质量审校 Agent 开始执行',
            { kind: 'agent', id: 'quality_review_agent', name: '质量审校 Agent' },
          ),
        ]
        const finalEvents = [
          {
            ...event(
              'agent.completed',
              24,
              '质量检查完成',
              { kind: 'agent', id: 'quality_review_agent', name: '质量审校 Agent' },
            ),
            status: 'completed',
          },
          {
            ...event(
              'run.completed',
              25,
              '本轮创作完成',
              undefined,
              { document: intermediateDocument },
            ),
            status: 'completed',
          },
        ]
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              firstEvents.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''),
            ))
            releaseStream = () => {
              controller.enqueue(encoder.encode(
                finalEvents.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''),
              ))
              controller.close()
            }
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<CreationPanel />)
    const input = screen.getByPlaceholderText(/继续告诉 Agent 如何修改当前文档/)
    fireEvent.change(input, { target: { value: '参考快手员工周年礼物方案' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    const intermediateText = await screen.findByText('中间版本内容。')
    expect(screen.queryByLabelText('本轮改动')).not.toBeInTheDocument()
    expect(intermediateText).not.toHaveClass('creation-latest-change')

    releaseStream()

    await screen.findByLabelText('本轮改动')
    expect(screen.getByText('等待审校。')).toHaveClass('creation-latest-change')
    expect(screen.getByLabelText('本轮改动')).toHaveTextContent('参考快手员工周年礼物方案')
  })
})
