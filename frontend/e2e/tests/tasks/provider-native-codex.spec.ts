import { APIRequestContext, expect, Page, test } from '@playwright/test'
import { PROVIDER_NATIVE_MARKERS } from '../../fixtures/provider-native-knowledge'
import { ProviderNativeKnowledgePage } from '../../pages/tasks/provider-native-knowledge.page'
import {
  authHeaders,
  clearToolScenario,
  collectTaskToolCalls,
  configureToolScenario,
  createProviderNativeResources,
  deleteProviderNativeResources,
  extractTaskAnswer,
  getScenarioModelBodies,
  getTask,
  modelRequestText,
  openProviderNativeChat,
  PROVIDER_NATIVE_API_URL,
  PROVIDER_NATIVE_MOCK_URL,
  ProviderNativeResources,
  waitForTaskTerminal,
} from '../../utils/provider-native-test-support'

const TEST_PREFIX = `e2e-provider-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const CODEX_MODEL_SERVER_URL = process.env.E2E_CODEX_MODEL_SERVER_URL || PROVIDER_NATIVE_MOCK_URL
const CODEX_EXECUTOR_IMAGE =
  process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const CODEX_MODEL_NAME = `${TEST_PREFIX}-codex-model`
const CODEX_SHELL_NAME = `${TEST_PREFIX}-codex-shell`
const CODEX_BOT_NAME = `${TEST_PREFIX}-codex-bot`
const CODEX_TEAM_NAME = `${TEST_PREFIX}-codex-team`
const READ_DOCUMENT_TOOL = 'wegent_kb_read_document_content'

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.describe('Provider-native Codex access', () => {
  let resources: ProviderNativeResources
  let codexTeamId = 0
  let activePrompt = ''

  test.beforeAll(async ({ request }) => {
    resources = await createProviderNativeResources(request, TEST_PREFIX, {
      syncDingTalk: false,
    })
    codexTeamId = await createCodexResources(request)
  })

  test.beforeEach(async ({ page }) => {
    activePrompt = ''
    await openCodexChat(page)
  })

  test.afterEach(async ({ request }) => {
    if (activePrompt) await clearToolScenario(request, activePrompt).catch(() => null)
  })

  test.afterAll(async ({ request }) => {
    if (!resources) return
    await cleanupCodexResources(request)
    await deleteProviderNativeResources(request, resources)
  })

  test('executes a website-created Codex task with the selected Skill and embedded MCP', async ({
    page,
    request,
  }, testInfo) => {
    const prompt = `${TEST_PREFIX} CODEx-WEB-001 读取选中文档并输出唯一断言标记。`
    activePrompt = prompt
    await configureToolScenario(request, prompt, [
      {
        toolCalls: [
          {
            toolName: 'exec_command',
            arguments: { cmd: 'cat .codex/skills/wegent-knowledge/SKILL.md' },
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
        responseContent: `Codex website execution completed. ${PROVIDER_NATIVE_MARKERS.a1}`,
      },
    ])

    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectDocuments(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name,
      [resources.fixture.documents.a1.id]
    )
    await page.screenshot({
      path: testInfo.outputPath('codex-web-01-team-model-and-knowledge-selected.png'),
      fullPage: true,
    })
    await knowledge.sendMessage(prompt)
    const taskId = await knowledge.waitForTaskId()
    const dispatchedTask = await getTask(request, resources.token, taskId)
    expect((dispatchedTask as { model_id?: string }).model_id).toBe(CODEX_MODEL_NAME)

    await waitForTaskTerminal(resources.token, taskId)
    const task = await getTask(request, resources.token, taskId)
    const bodies = await getScenarioModelBodies(request, prompt)
    const requestText = modelRequestText(bodies)

    expect(bodies.length).toBeGreaterThan(1)
    expect(requestText).toContain('<selected_knowledge_sources>')
    expect(requestText).toContain('wegent-knowledge')
    expect(requestText).toContain('# Wegent Knowledge Base Skill')
    const calls = collectTaskToolCalls(task).filter(call => call.name.endsWith(READ_DOCUMENT_TOOL))
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toEqual({ document_id: resources.fixture.documents.a1.id })
    expect(JSON.stringify(calls[0].output)).toContain(PROVIDER_NATIVE_MARKERS.a1)
    expect(extractTaskAnswer(task)).toContain(PROVIDER_NATIVE_MARKERS.a1)
    await expect(page.getByTestId('messages-container')).toContainText(PROVIDER_NATIVE_MARKERS.a1, {
      timeout: 30_000,
    })
    await page.screenshot({
      path: testInfo.outputPath('codex-web-02-skill-mcp-completed.png'),
      fullPage: true,
    })
  })

  async function createCodexResources(request: APIRequestContext): Promise<number> {
    const shellResponse = await request.get(
      `${PROVIDER_NATIVE_API_URL}/api/shells/unified/Codex?shell_type=public`,
      { headers: authHeaders(resources.token) }
    )
    expect(
      shellResponse.status(),
      'Codex must be provisioned as a first-class public Shell before website tasks can use it'
    ).toBe(200)

    const modelResponse = await request.post(
      `${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/models`,
      {
        headers: authHeaders(resources.token),
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: { name: CODEX_MODEL_NAME, namespace: 'default' },
          spec: {
            protocol: 'openai',
            apiFormat: 'chat/completions',
            modelConfig: {
              env: {
                model: 'openai',
                model_id: 'gpt-5-codex',
                api_key: 'mock-api-key',
                OPENAI_API_KEY: 'mock-api-key',
                base_url: `${CODEX_MODEL_SERVER_URL}/v1`,
              },
            },
          },
        },
      }
    )
    expect([200, 201], `Codex model creation failed: ${await modelResponse.text()}`).toContain(
      modelResponse.status()
    )
    const customShellResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/shells`, {
      headers: authHeaders(resources.token),
      data: {
        name: CODEX_SHELL_NAME,
        displayName: 'Provider Native E2E Codex',
        baseShellRef: 'Codex',
        baseImage: CODEX_EXECUTOR_IMAGE,
      },
    })
    expect(
      [200, 201],
      `Codex custom Shell creation failed: ${await customShellResponse.text()}`
    ).toContain(customShellResponse.status())
    const botResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/bots`, {
      headers: authHeaders(resources.token),
      data: {
        name: CODEX_BOT_NAME,
        shell_name: CODEX_SHELL_NAME,
        agent_config: { bind_model: CODEX_MODEL_NAME, bind_model_type: 'user' },
        system_prompt: 'Use the selected Wegent Skill and its MCP tools.',
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
        name: CODEX_TEAM_NAME,
        description: 'Provider-native Codex website E2E team',
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

  async function cleanupCodexResources(request: APIRequestContext): Promise<void> {
    for (const [kind, name] of [
      ['teams', CODEX_TEAM_NAME],
      ['bots', CODEX_BOT_NAME],
      ['models', CODEX_MODEL_NAME],
    ]) {
      await request
        .delete(`${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/${kind}/${name}`, {
          headers: authHeaders(resources.token),
        })
        .catch(() => null)
    }
    await request
      .delete(`${PROVIDER_NATIVE_API_URL}/api/shells/${CODEX_SHELL_NAME}`, {
        headers: authHeaders(resources.token),
      })
      .catch(() => null)
  }

  async function openCodexChat(page: Page): Promise<void> {
    await openProviderNativeChat(page, {
      ...resources,
      teamId: codexTeamId,
      teamName: CODEX_TEAM_NAME,
    })
    const modelSelector = page.getByTestId('model-selector')
    await expect(modelSelector).toBeEnabled()
    await modelSelector.click()
    const modelSearch = page.getByTestId('model-cascade-search-input')
    await modelSearch.fill(CODEX_MODEL_NAME)
    const modelOption = page.getByTestId(`model-option-${CODEX_MODEL_NAME}`)
    await expect(modelOption).toBeVisible()
    await modelOption.click()
    await expect(modelSelector).toHaveAttribute('aria-expanded', 'false')
  }
})
