import { APIRequestContext, expect, Page, test } from '@playwright/test'
import { PROVIDER_NATIVE_MARKERS } from '../../fixtures/provider-native-knowledge'
import { ProviderNativeKnowledgePage } from '../../pages/tasks/provider-native-knowledge.page'
import {
  authHeaders,
  clearToolScenario,
  collectTaskToolCalls,
  configureDingTalkService,
  configureToolScenario,
  createProviderNativeResources,
  deleteProviderNativeResources,
  extractTaskAnswer,
  getMcpCalls,
  getScenarioModelBodies,
  getTask,
  modelRequestText,
  openProviderNativeChat,
  PROVIDER_NATIVE_API_URL,
  PROVIDER_NATIVE_MOCK_URL,
  ProviderNativeResources,
  resetMockMcp,
  waitForTaskTerminal,
} from '../../utils/provider-native-test-support'

const TEST_PREFIX = `e2e-provider-claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const CLAUDE_MODEL_SERVER_URL = process.env.E2E_CLAUDE_MODEL_SERVER_URL || PROVIDER_NATIVE_MOCK_URL
const CLAUDE_MODEL_NAME = `${TEST_PREFIX}-claude-model`
const CLAUDE_SHELL_NAME = `${TEST_PREFIX}-claude-shell`
const CLAUDE_BOT_NAME = `${TEST_PREFIX}-claude-bot`
const CLAUDE_TEAM_NAME = `${TEST_PREFIX}-claude-team`
const CLAUDE_EXECUTOR_IMAGE =
  process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const READ_DOCUMENT_TOOL = 'wegent_kb_read_document_content'

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.describe('Provider-native ClaudeCode access', () => {
  let resources: ProviderNativeResources
  let claudeTeamId = 0
  let activePrompt = ''

  test.beforeAll(async ({ request }) => {
    resources = await createProviderNativeResources(request, TEST_PREFIX)
    claudeTeamId = await createClaudeResources(request)
  })

  test.beforeEach(async ({ page }) => {
    activePrompt = ''
    await openClaudeChat(page)
  })

  test.afterEach(async ({ request }) => {
    if (activePrompt) await clearToolScenario(request, activePrompt).catch(() => null)
  })

  test.afterAll(async ({ request }) => {
    await cleanupClaudeResources(request)
    await deleteProviderNativeResources(request, resources)
  })

  test('E2E-A2-010 executes selected knowledge through ClaudeCode Skill and MCP', async ({
    page,
    request,
  }) => {
    const prompt = `${TEST_PREFIX} E2E-A2-010 生成三点评审摘要，并在末尾输出唯一断言标记。`
    activePrompt = prompt
    await configureToolScenario(request, prompt, [
      {
        toolCalls: [
          {
            toolName: 'Skill',
            arguments: { skill: 'wegent-knowledge' },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: READ_DOCUMENT_TOOL,
            arguments: { document_id: resources.fixture.documents.a1.id },
          },
        ],
      },
      {
        responseContent: `1. 原生访问。 2. 范围明确。 3. 双 Shell 同构。 ${PROVIDER_NATIVE_MARKERS.a1}`,
      },
    ])

    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectDocuments(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name,
      [resources.fixture.documents.a1.id]
    )
    await knowledge.sendMessage(prompt)
    const taskId = await knowledge.waitForTaskId()
    const dispatchedTask = await getTask(request, resources.token, taskId)
    expect((dispatchedTask as { model_id?: string }).model_id).toBe(CLAUDE_MODEL_NAME)
    await waitForTaskTerminal(request, resources.token, taskId)
    const task = await getTask(request, resources.token, taskId)
    const bodies = await getScenarioModelBodies(request, prompt)
    const requestText = modelRequestText(bodies)
    const initialRequestText = modelRequestText(bodies.slice(0, 1))
    const requestTextAfterSkillLoad = modelRequestText(bodies.slice(1))

    expect(bodies.length).toBeGreaterThan(1)
    expect(requestText).toContain('<selected_knowledge_sources>')
    expect(requestText).toContain('provider="wegent"')
    expect(requestText).toContain(`resource_id="${resources.fixture.documents.a1.id}"`)
    expect(requestText).toContain('**wegent-knowledge** [USER SELECTED - PRIORITIZE]')
    expect(initialRequestText).not.toContain('# Wegent Knowledge Base Skill')
    expect(requestTextAfterSkillLoad).toContain('# Wegent Knowledge Base Skill')
    expect(requestText).not.toContain(`resource_id="${resources.fixture.documents.a2.id}"`)
    const calls = collectTaskToolCalls(task).filter(call => call.name.endsWith(READ_DOCUMENT_TOOL))
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toEqual({ document_id: resources.fixture.documents.a1.id })
    expect(JSON.stringify(calls[0].output)).toContain(PROVIDER_NATIVE_MARKERS.a1)
    expect(extractTaskAnswer(task)).toContain('1. 原生访问')
    expect(extractTaskAnswer(task)).toContain(PROVIDER_NATIVE_MARKERS.a1)
    await expect(page.getByTestId('messages-container')).toContainText(PROVIDER_NATIVE_MARKERS.a1, {
      timeout: 120_000,
    })
  })

  test('E2E-A2-013 keeps required DingTalk MCP mounted as one atomic ClaudeCode capability', async ({
    page,
    request,
  }) => {
    await resetMockMcp(request)
    await configureDingTalkService(request, resources.token, 'docs', true)
    const prompt = `${TEST_PREFIX} E2E-A2-013 输出唯一断言标记。`
    activePrompt = prompt
    await configureToolScenario(request, prompt, [
      {
        toolCalls: [{ toolName: 'get_document_info', arguments: { nodeId: 'doc-d1' } }],
      },
      {
        toolCalls: [{ toolName: 'get_document_content', arguments: { nodeId: 'doc-d1' } }],
      },
      { responseContent: 'DING-D1-NATIVE-2026' },
    ])
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectDingTalkDocuments(['doc-d1'])
    await knowledge.sendMessage(prompt)
    const taskId = await knowledge.waitForTaskId()
    await waitForTaskTerminal(request, resources.token, taskId)
    const task = await getTask(request, resources.token, taskId)
    const requestText = modelRequestText(await getScenarioModelBodies(request, prompt))

    expect(requestText).toContain('provider="dingtalk"')
    expect(requestText).toContain('dingtalk_docs')
    expect((await getMcpCalls(request)).map(call => call.name)).toEqual([
      'get_document_info',
      'get_document_content',
    ])
    expect(extractTaskAnswer(task)).toBe('DING-D1-NATIVE-2026')
  })

  async function createClaudeResources(request: APIRequestContext): Promise<number> {
    const modelResponse = await request.post(
      `${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/models`,
      {
        headers: authHeaders(resources.token),
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: { name: CLAUDE_MODEL_NAME, namespace: 'default' },
          spec: {
            modelConfig: {
              env: {
                model: 'claude',
                model_id: 'claude-3-5-sonnet-20241022',
                small_model: 'claude-3-5-haiku-20241022',
                api_key: 'mock-api-key',
                ANTHROPIC_API_KEY: 'mock-api-key',
                base_url: `${CLAUDE_MODEL_SERVER_URL}/v1`,
              },
            },
          },
        },
      }
    )
    expect([200, 201]).toContain(modelResponse.status())
    const shellResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/shells`, {
      headers: authHeaders(resources.token),
      data: {
        name: CLAUDE_SHELL_NAME,
        displayName: 'Provider Native E2E ClaudeCode',
        baseShellRef: 'ClaudeCode',
        baseImage: CLAUDE_EXECUTOR_IMAGE,
      },
    })
    expect([200, 201]).toContain(shellResponse.status())
    const botResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/bots`, {
      headers: authHeaders(resources.token),
      data: {
        name: CLAUDE_BOT_NAME,
        shell_name: CLAUDE_SHELL_NAME,
        agent_config: { bind_model: CLAUDE_MODEL_NAME, bind_model_type: 'user' },
        system_prompt: 'Use only explicitly selected provider-native knowledge.',
        namespace: 'default',
        is_active: true,
      },
    })
    expect([200, 201]).toContain(botResponse.status())
    const botId = ((await botResponse.json()) as { id?: number }).id
    expect(botId).toBeTruthy()
    const teamResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/teams`, {
      headers: authHeaders(resources.token),
      data: {
        name: CLAUDE_TEAM_NAME,
        description: 'Provider-native ClaudeCode E2E team',
        bots: [{ bot_id: botId, bot_prompt: '', role: 'worker' }],
        bind_mode: ['chat'],
        namespace: 'default',
        is_active: true,
        requires_workspace: false,
      },
    })
    expect([200, 201]).toContain(teamResponse.status())
    const teamId = ((await teamResponse.json()) as { id?: number }).id
    expect(teamId).toBeTruthy()
    return teamId!
  }

  async function cleanupClaudeResources(request: APIRequestContext): Promise<void> {
    for (const [kind, name] of [
      ['teams', CLAUDE_TEAM_NAME],
      ['bots', CLAUDE_BOT_NAME],
      ['models', CLAUDE_MODEL_NAME],
    ]) {
      await request
        .delete(`${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/${kind}/${name}`, {
          headers: authHeaders(resources.token),
        })
        .catch(() => null)
    }
    await request
      .delete(`${PROVIDER_NATIVE_API_URL}/api/shells/${CLAUDE_SHELL_NAME}`, {
        headers: authHeaders(resources.token),
      })
      .catch(() => null)
  }

  async function openClaudeChat(page: Page): Promise<void> {
    const originalTeamId = resources.teamId
    resources.teamId = claudeTeamId
    try {
      await openProviderNativeChat(page, resources)
    } finally {
      resources.teamId = originalTeamId
    }
    const modelSelector = page.getByTestId('model-selector')
    await expect(modelSelector).toBeEnabled()
    await modelSelector.click()
    await page.getByTestId('model-cascade-search-input').fill(CLAUDE_MODEL_NAME)
    const claudeModelOption = page.getByTestId(`model-option-${CLAUDE_MODEL_NAME}`)
    await expect(claudeModelOption).toBeVisible()
    await claudeModelOption.click()
    await expect(modelSelector).toHaveAttribute('aria-expanded', 'false')
  }
})
