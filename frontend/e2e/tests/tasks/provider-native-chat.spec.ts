import { APIRequestContext, expect, Page, test } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import {
  createProviderNativeKnowledgeFixture,
  deleteProviderNativeKnowledgeFixture,
  PROVIDER_NATIVE_MARKERS,
  ProviderNativeKnowledgeFixture,
} from '../../fixtures/provider-native-knowledge'
import { ProviderNativeKnowledgePage } from '../../pages/tasks/provider-native-knowledge.page'
import { ApiClient, createApiClient } from '../../utils/api-client'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MOCK_MODEL_SERVER_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const TEST_PREFIX = `e2e-provider-native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TEST_MODEL_NAME = `${TEST_PREFIX}-model`
const TEST_BOT_NAME = `${TEST_PREFIX}-bot`
const TEST_TEAM_NAME = `${TEST_PREFIX}-team`
const LIST_KNOWLEDGE_BASES_TOOL = 'wegent_kb_list_knowledge_bases'
const LIST_DOCUMENTS_TOOL = 'wegent_kb_list_documents'
const READ_DOCUMENT_TOOL = 'wegent_kb_read_document_content'
const SEARCH_KNOWLEDGE_BASE_TOOL = 'wegent_kb_search_knowledge_base'
const WEGENT_SKILL_HEADING = '# Wegent Knowledge Base Skill'

interface RuntimeCheckResponse {
  task_status: string
}

interface RecordedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  output: unknown
}

interface CapturedModelRequest {
  tools?: Array<{
    name?: string
    function?: { name?: string }
  }>
  [key: string]: unknown
}

interface BoundKnowledgeBase {
  id: number
  name: string
}

interface ToolScenarioStep {
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>
  responseContent?: string
}

test.describe.configure({ mode: 'serial' })

test.describe('Provider-native Wegent knowledge access', () => {
  let apiClient: ApiClient
  let token = ''
  let fixture: ProviderNativeKnowledgeFixture
  let createdModel = false
  let createdBotId: number | null = null
  let createdTeamId: number | null = null
  let configuredScenarioMatchText: string | null = null

  test.beforeAll(async ({ request }) => {
    apiClient = createApiClient(request)
    const loginResponse = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    token = loginResponse.data?.access_token || ''
    expect(token, 'Admin login should return an access token').toBeTruthy()

    const mockHealth = await request.get(`${MOCK_MODEL_SERVER_URL}/health`)
    expect(mockHealth.status(), 'Mock model server should be running').toBe(200)

    fixture = await createProviderNativeKnowledgeFixture(request, {
      apiBaseUrl: API_BASE_URL,
      token,
      nameSuffix: TEST_PREFIX,
    })
    await createChatResources(request)
  })

  test.beforeEach(async ({ page }) => {
    configuredScenarioMatchText = null
    await skipOnboardingTour(page)
    await page.goto(`/chat?teamId=${createdTeamId}`)
    await page.waitForLoadState('domcontentloaded')
    await dismissOnboardingTour(page)
    await ensureTestTeamSelected(page)
  })

  test.afterEach(async ({ request }) => {
    await clearConfiguredToolScenario(request)
  })

  test.afterAll(async ({ request }) => {
    await clearConfiguredToolScenario(request)
    if (fixture?.knowledgeBase.id) {
      await deleteProviderNativeKnowledgeFixture(
        request,
        API_BASE_URL,
        token,
        fixture.knowledgeBase.id
      ).catch(() => {})
    }
    if (fixture?.otherKnowledgeBase.id) {
      await deleteProviderNativeKnowledgeFixture(
        request,
        API_BASE_URL,
        token,
        fixture.otherKnowledgeBase.id
      ).catch(() => {})
    }
    await cleanupChatResources(request)
  })

  test('E2E-A2-001 selects a whole Wegent knowledge base', async ({ page, request }) => {
    const prompt = `${TEST_PREFIX} 输出所选知识库中每份文档的标题和唯一断言标记。`
    const selectedDocuments = [fixture.documents.a1, fixture.documents.a2, fixture.documents.a3]
    const expectedMarkers = [
      PROVIDER_NATIVE_MARKERS.a1,
      PROVIDER_NATIVE_MARKERS.a2,
      PROVIDER_NATIVE_MARKERS.a3,
    ]
    await configureToolScenario(request, prompt, [
      {
        toolCalls: [
          {
            toolName: LIST_DOCUMENTS_TOOL,
            arguments: { knowledge_base_id: fixture.knowledgeBase.id },
          },
        ],
      },
      {
        toolCalls: selectedDocuments.map(document => ({
          toolName: READ_DOCUMENT_TOOL,
          arguments: { document_id: document.id },
        })),
      },
      {
        responseContent: selectedDocuments
          .map((document, index) => `${document.name} ${expectedMarkers[index]}`)
          .join('\n'),
      },
    ])

    const knowledgePage = new ProviderNativeKnowledgePage(page)
    await knowledgePage.selectWholeKnowledgeBase(
      fixture.knowledgeBase.id,
      fixture.knowledgeBase.name
    )
    const taskId = await sendAndWait(knowledgePage, page, request, prompt)

    const evidence = await collectEvidence(request, taskId, prompt)
    expectBoundKnowledgeBase(evidence.boundKnowledgeBases, fixture.knowledgeBase)
    expect(evidence.externalKnowledgeRefs).toEqual([])
    expectSingleSource(evidence.modelBodies, fixture.knowledgeBase.id)
    expectSelectedResources(evidence.modelBodies, [])
    expect(evidence.modelText).not.toContain('<resource ')
    expectWegentSkillLoaded(evidence.modelBodies)
    expectProviderToolInventory(evidence.modelBodies)
    expectProviderToolOrder(evidence.toolCalls, [
      LIST_DOCUMENTS_TOOL,
      READ_DOCUMENT_TOOL,
      READ_DOCUMENT_TOOL,
      READ_DOCUMENT_TOOL,
    ])
    expectToolCall(evidence.toolCalls, LIST_DOCUMENTS_TOOL, {
      knowledge_base_id: fixture.knowledgeBase.id,
    })
    expectToolOutputContains(
      evidence.toolCalls,
      LIST_DOCUMENTS_TOOL,
      [fixture.documents.a1.name, fixture.documents.a2.name, fixture.documents.a3.name],
      [fixture.documents.b1.name]
    )
    expectReadDocuments(
      evidence.toolCalls,
      selectedDocuments.map(item => item.id)
    )
    expectReadDocumentOutputs(evidence.toolCalls, [
      [fixture.documents.a1.id, PROVIDER_NATIVE_MARKERS.a1],
      [fixture.documents.a2.id, PROVIDER_NATIVE_MARKERS.a2],
      [fixture.documents.a3.id, PROVIDER_NATIVE_MARKERS.a3],
    ])
    selectedDocuments.forEach((document, index) => {
      expect(evidence.finalAnswer).toContain(document.name)
      expect(evidence.finalAnswer).toContain(expectedMarkers[index])
    })
    await expectMarkers(page, expectedMarkers)
  })

  test('E2E-A2-002 selects a folder including descendants', async ({ page, request }) => {
    const prompt = `${TEST_PREFIX} 输出新版方案和旧版方案的唯一断言标记与结论。`
    await configureToolScenario(request, prompt, [
      {
        toolCalls: [
          {
            toolName: LIST_DOCUMENTS_TOOL,
            arguments: {
              knowledge_base_id: fixture.knowledgeBase.id,
              folder_id: fixture.folders.requirements.id,
            },
          },
        ],
      },
      {
        toolCalls: [fixture.documents.a1, fixture.documents.a2].map(document => ({
          toolName: READ_DOCUMENT_TOOL,
          arguments: { document_id: document.id },
        })),
      },
      {
        responseContent: `${fixture.documents.a1.name} ${PROVIDER_NATIVE_MARKERS.a1} 结论：采用 Provider 原生能力。 ${fixture.documents.a2.name} ${PROVIDER_NATIVE_MARKERS.a2} 结论：统一知识控制面聚合。`,
      },
    ])

    const knowledgePage = new ProviderNativeKnowledgePage(page)
    await knowledgePage.selectFolder(
      fixture.knowledgeBase.id,
      fixture.knowledgeBase.name,
      fixture.folders.requirements.id
    )
    const taskId = await sendAndWait(knowledgePage, page, request, prompt)

    const evidence = await collectEvidence(request, taskId, prompt)
    expect(evidence.boundKnowledgeBases.total).toBe(0)
    expect(evidence.boundKnowledgeBases.items).toHaveLength(0)
    expectSingleSource(evidence.modelBodies, fixture.knowledgeBase.id)
    expectSelectedResources(evidence.modelBodies, [fixture.folders.requirements.id])
    expect(evidence.modelText).toContain(
      `scope_type=\"folder\" resource_id=\"${fixture.folders.requirements.id}\"`
    )
    expectWegentSkillLoaded(evidence.modelBodies)
    expectProviderToolInventory(evidence.modelBodies)
    expectProviderToolOrder(evidence.toolCalls, [
      LIST_DOCUMENTS_TOOL,
      READ_DOCUMENT_TOOL,
      READ_DOCUMENT_TOOL,
    ])
    expectToolCall(evidence.toolCalls, LIST_DOCUMENTS_TOOL, {
      knowledge_base_id: fixture.knowledgeBase.id,
      folder_id: fixture.folders.requirements.id,
    })
    expectToolOutputContains(
      evidence.toolCalls,
      LIST_DOCUMENTS_TOOL,
      [fixture.documents.a1.name, fixture.documents.a2.name],
      [fixture.documents.a3.name, fixture.documents.b1.name]
    )
    expectReadDocuments(evidence.toolCalls, [fixture.documents.a1.id, fixture.documents.a2.id])
    expectReadDocuments(
      evidence.toolCalls,
      [fixture.documents.a3.id, fixture.documents.b1.id],
      false
    )
    expectReadDocumentOutputs(evidence.toolCalls, [
      [fixture.documents.a1.id, PROVIDER_NATIVE_MARKERS.a1],
      [fixture.documents.a2.id, PROVIDER_NATIVE_MARKERS.a2],
    ])
    expect(evidence.finalAnswer).toContain(PROVIDER_NATIVE_MARKERS.a1)
    expect(evidence.finalAnswer).toContain('采用 Provider 原生能力')
    expect(evidence.finalAnswer).toContain(PROVIDER_NATIVE_MARKERS.a2)
    expect(evidence.finalAnswer).toContain('统一知识控制面聚合')
    await expectMarkers(page, [PROVIDER_NATIVE_MARKERS.a1, PROVIDER_NATIVE_MARKERS.a2])
    await expect(page.getByTestId('messages-container')).not.toContainText(
      PROVIDER_NATIVE_MARKERS.a3
    )
    await expect(page.getByTestId('messages-container')).not.toContainText(
      PROVIDER_NATIVE_MARKERS.b1
    )
  })

  test('E2E-A2-003 selects one exact document', async ({ page, request }) => {
    const prompt = `${TEST_PREFIX} 输出唯一断言标记。`
    await configureToolScenario(request, prompt, [
      {
        toolCalls: [
          {
            toolName: READ_DOCUMENT_TOOL,
            arguments: { document_id: fixture.documents.a1.id },
          },
        ],
      },
      { responseContent: PROVIDER_NATIVE_MARKERS.a1 },
    ])

    const knowledgePage = new ProviderNativeKnowledgePage(page)
    await knowledgePage.selectDocuments(fixture.knowledgeBase.id, fixture.knowledgeBase.name, [
      fixture.documents.a1.id,
    ])
    const taskId = await sendAndWait(knowledgePage, page, request, prompt)

    const evidence = await collectEvidence(request, taskId, prompt)
    expectBoundKnowledgeBase(evidence.boundKnowledgeBases, fixture.knowledgeBase)
    expectSingleSource(evidence.modelBodies, fixture.knowledgeBase.id)
    expectSelectedResources(evidence.modelBodies, [fixture.documents.a1.id])
    expect(evidence.modelText).toContain(
      `scope_type=\"document\" resource_id=\"${fixture.documents.a1.id}\"`
    )
    expectWegentSkillLoaded(evidence.modelBodies)
    expectProviderToolInventory(evidence.modelBodies)
    expectProviderToolOrder(evidence.toolCalls, [READ_DOCUMENT_TOOL])
    expectNoToolCalls(evidence.toolCalls, [
      LIST_KNOWLEDGE_BASES_TOOL,
      LIST_DOCUMENTS_TOOL,
      SEARCH_KNOWLEDGE_BASE_TOOL,
    ])
    expectReadDocuments(evidence.toolCalls, [fixture.documents.a1.id])
    expectReadDocuments(
      evidence.toolCalls,
      [fixture.documents.a2.id, fixture.documents.a3.id, fixture.documents.b1.id],
      false
    )
    expectNoKnowledgeBaseAccess(evidence.toolCalls, fixture.otherKnowledgeBase.id)
    expectReadDocumentOutputs(evidence.toolCalls, [
      [fixture.documents.a1.id, PROVIDER_NATIVE_MARKERS.a1],
    ])
    expectFinalAnswer(evidence.finalAnswer, [PROVIDER_NATIVE_MARKERS.a1])
    await expectMarkers(page, [PROVIDER_NATIVE_MARKERS.a1])
    await expect(page.getByTestId('messages-container')).not.toContainText(
      PROVIDER_NATIVE_MARKERS.a2
    )
    await expect(page.getByTestId('messages-container')).not.toContainText(
      PROVIDER_NATIVE_MARKERS.a3
    )
    await expect(page.getByTestId('messages-container')).not.toContainText(
      PROVIDER_NATIVE_MARKERS.b1
    )
  })

  test('E2E-A2-004 groups multiple documents under one source', async ({ page, request }) => {
    const prompt = `${TEST_PREFIX} 按标题输出各自的唯一断言标记。`
    await configureToolScenario(request, prompt, [
      {
        toolCalls: [fixture.documents.a1, fixture.documents.a3].map(document => ({
          toolName: READ_DOCUMENT_TOOL,
          arguments: { document_id: document.id },
        })),
      },
      {
        responseContent: `${fixture.documents.a1.name} ${PROVIDER_NATIVE_MARKERS.a1}\n${fixture.documents.a3.name} ${PROVIDER_NATIVE_MARKERS.a3}`,
      },
    ])

    const knowledgePage = new ProviderNativeKnowledgePage(page)
    await knowledgePage.selectDocuments(fixture.knowledgeBase.id, fixture.knowledgeBase.name, [
      fixture.documents.a1.id,
      fixture.documents.a3.id,
    ])
    const taskId = await sendAndWait(knowledgePage, page, request, prompt)

    const evidence = await collectEvidence(request, taskId, prompt)
    expectBoundKnowledgeBase(evidence.boundKnowledgeBases, fixture.knowledgeBase)
    expectSingleSource(evidence.modelBodies, fixture.knowledgeBase.id)
    expectSelectedResources(evidence.modelBodies, [
      fixture.documents.a1.id,
      fixture.documents.a3.id,
    ])
    expect(evidence.modelText).toContain(
      `scope_type=\"document\" resource_id=\"${fixture.documents.a1.id}\"`
    )
    expect(evidence.modelText).toContain(
      `scope_type=\"document\" resource_id=\"${fixture.documents.a3.id}\"`
    )
    expectWegentSkillLoaded(evidence.modelBodies)
    expectProviderToolInventory(evidence.modelBodies)
    expectProviderToolOrder(evidence.toolCalls, [READ_DOCUMENT_TOOL, READ_DOCUMENT_TOOL])
    expectReadDocuments(evidence.toolCalls, [fixture.documents.a1.id, fixture.documents.a3.id])
    expectReadDocuments(
      evidence.toolCalls,
      [fixture.documents.a2.id, fixture.documents.b1.id],
      false
    )
    expectReadDocumentOutputs(evidence.toolCalls, [
      [fixture.documents.a1.id, PROVIDER_NATIVE_MARKERS.a1],
      [fixture.documents.a3.id, PROVIDER_NATIVE_MARKERS.a3],
    ])
    expect(evidence.finalAnswer).toContain(fixture.documents.a1.name)
    expect(evidence.finalAnswer).toContain(PROVIDER_NATIVE_MARKERS.a1)
    expect(evidence.finalAnswer).toContain(fixture.documents.a3.name)
    expect(evidence.finalAnswer).toContain(PROVIDER_NATIVE_MARKERS.a3)
    await expectMarkers(page, [PROVIDER_NATIVE_MARKERS.a1, PROVIDER_NATIVE_MARKERS.a3])
    await expect(page.getByTestId('messages-container')).not.toContainText(
      PROVIDER_NATIVE_MARKERS.a2
    )
    await expect(page.getByTestId('messages-container')).not.toContainText(
      PROVIDER_NATIVE_MARKERS.b1
    )
  })

  async function createChatResources(request: APIRequestContext): Promise<void> {
    const modelResponse = await request.post(`${API_BASE_URL}/api/v1/namespaces/default/models`, {
      headers: authHeaders(),
      data: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: { name: TEST_MODEL_NAME, namespace: 'default' },
        spec: {
          modelConfig: {
            env: {
              model: 'openai',
              model_id: 'mock-provider-native-model',
              api_key: 'mock-api-key',
              base_url: `${MOCK_MODEL_SERVER_URL}/v1`,
            },
          },
        },
      },
    })
    expect([200, 201]).toContain(modelResponse.status())
    createdModel = true

    const botResponse = await request.post(`${API_BASE_URL}/api/bots`, {
      headers: authHeaders(),
      data: {
        name: TEST_BOT_NAME,
        shell_name: 'Chat',
        agent_config: { bind_model: TEST_MODEL_NAME, bind_model_type: 'user' },
        system_prompt: 'Use only explicitly selected provider-native knowledge.',
        namespace: 'default',
        is_active: true,
      },
    })
    expect([200, 201]).toContain(botResponse.status())
    createdBotId = ((await botResponse.json()) as { id?: number }).id ?? null
    expect(createdBotId).not.toBeNull()

    const teamResponse = await request.post(`${API_BASE_URL}/api/teams`, {
      headers: authHeaders(),
      data: {
        name: TEST_TEAM_NAME,
        description: 'Provider-native knowledge E2E team',
        bots: [{ bot_id: createdBotId, bot_prompt: '', role: 'worker' }],
        bind_mode: ['chat'],
        namespace: 'default',
        is_active: true,
      },
    })
    expect([200, 201]).toContain(teamResponse.status())
    createdTeamId = ((await teamResponse.json()) as { id?: number }).id ?? null
    expect(createdTeamId).not.toBeNull()
  }

  async function cleanupChatResources(request: APIRequestContext): Promise<void> {
    if (createdTeamId) {
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/teams/${TEST_TEAM_NAME}`, {
          headers: authHeaders(),
        })
        .catch(() => {})
    }
    if (createdBotId) {
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/bots/${TEST_BOT_NAME}`, {
          headers: authHeaders(),
        })
        .catch(() => {})
    }
    if (createdModel) {
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/models/${TEST_MODEL_NAME}`, {
          headers: authHeaders(),
        })
        .catch(() => {})
    }
  }

  async function configureToolScenario(
    request: APIRequestContext,
    matchText: string,
    steps: ToolScenarioStep[]
  ): Promise<void> {
    const response = await request.post(`${MOCK_MODEL_SERVER_URL}/tool-scenarios`, {
      data: { matchText, steps },
    })
    expect(response.status(), await response.text()).toBe(200)
    configuredScenarioMatchText = matchText
  }

  async function clearConfiguredToolScenario(request: APIRequestContext): Promise<void> {
    if (!configuredScenarioMatchText) return
    const matchText = encodeURIComponent(configuredScenarioMatchText)
    await request
      .delete(`${MOCK_MODEL_SERVER_URL}/tool-scenarios?matchText=${matchText}`)
      .catch(() => {})
    configuredScenarioMatchText = null
  }

  async function sendAndWait(
    knowledgePage: ProviderNativeKnowledgePage,
    page: Page,
    request: APIRequestContext,
    prompt: string
  ): Promise<number> {
    await knowledgePage.sendMessage(prompt)
    const taskId = await knowledgePage.waitForTaskId()
    await waitForBackendTerminal(request, taskId)
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30000 })
    return taskId
  }

  async function waitForBackendTerminal(request: APIRequestContext, taskId: number): Promise<void> {
    const deadline = Date.now() + 60000
    let status = 'UNKNOWN'
    while (Date.now() < deadline) {
      const response = await request.get(`${API_BASE_URL}/api/tasks/${taskId}/runtime-check`, {
        headers: authHeaders(),
      })
      status =
        response.status() === 200
          ? ((await response.json()) as RuntimeCheckResponse).task_status.toUpperCase()
          : `HTTP_${response.status()}`
      if (status.startsWith('COMPLETED')) return
      if (status.startsWith('FAILED') || status.startsWith('CANCELLED')) {
        throw new Error(`Task ${taskId} reached terminal status ${status}`)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    expect(status, `Task ${taskId} should complete`).toMatch(/^COMPLETED/)
  }

  async function collectEvidence(request: APIRequestContext, taskId: number, prompt: string) {
    const matchText = encodeURIComponent(prompt)
    const scenarioResponse = await request.get(
      `${MOCK_MODEL_SERVER_URL}/tool-scenarios?matchText=${matchText}`
    )
    expect(scenarioResponse.status(), await scenarioResponse.text()).toBe(200)
    const scenario = (await scenarioResponse.json()) as {
      capturedRequests: CapturedModelRequest[]
    }
    const modelBodies = scenario.capturedRequests.filter(item =>
      JSON.stringify(item).includes(prompt)
    )
    expect(modelBodies.length).toBeGreaterThan(0)

    const taskResponse = await request.get(`${API_BASE_URL}/api/tasks/${taskId}`, {
      headers: authHeaders(),
    })
    expect(taskResponse.status(), await taskResponse.text()).toBe(200)
    const task = (await taskResponse.json()) as unknown

    const boundKnowledgeResponse = await request.get(
      `${API_BASE_URL}/api/tasks/${taskId}/knowledge-bases`,
      { headers: authHeaders() }
    )
    expect(boundKnowledgeResponse.status(), await boundKnowledgeResponse.text()).toBe(200)
    const boundKnowledge = (await boundKnowledgeResponse.json()) as {
      items: BoundKnowledgeBase[]
      total: number
    }
    return {
      modelBodies,
      modelText: JSON.stringify(modelBodies).replace(/\\\"/g, '\"'),
      toolCalls: collectToolCalls(task),
      boundKnowledgeBases: boundKnowledge,
      finalAnswer: extractFinalAnswer(task),
      externalKnowledgeRefs: extractExternalKnowledgeRefs(task),
    }
  }

  function extractExternalKnowledgeRefs(task: unknown): unknown[] {
    if (!task || typeof task !== 'object') return []
    const refs = (task as { external_knowledge_refs?: unknown }).external_knowledge_refs
    return Array.isArray(refs) ? refs : []
  }

  function extractFinalAnswer(task: unknown): string {
    if (!task || typeof task !== 'object') return ''
    const subtasks = (task as { subtasks?: unknown[] }).subtasks
    if (!Array.isArray(subtasks)) return ''
    for (const subtask of [...subtasks].reverse()) {
      if (!subtask || typeof subtask !== 'object') continue
      const result = (subtask as { result?: unknown }).result
      if (!result || typeof result !== 'object') continue
      const value = (result as { value?: unknown }).value
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  function collectToolCalls(value: unknown): RecordedToolCall[] {
    const calls = new Map<string, RecordedToolCall>()
    const visit = (current: unknown) => {
      if (Array.isArray(current)) {
        current.forEach(visit)
        return
      }
      if (!current || typeof current !== 'object') return
      const item = current as Record<string, unknown>
      if (
        typeof item.tool_name === 'string' &&
        item.tool_input &&
        typeof item.tool_input === 'object'
      ) {
        const id = String(
          item.tool_use_id || item.id || `${item.tool_name}:${JSON.stringify(item.tool_input)}`
        )
        const existing = calls.get(id)
        calls.set(id, {
          id,
          name: item.tool_name,
          input: item.tool_input as Record<string, unknown>,
          output: item.tool_output ?? existing?.output,
        })
      }
      Object.values(item).forEach(visit)
    }
    visit(value)
    return [...calls.values()]
  }

  function expectSingleSource(modelBodies: unknown[], knowledgeBaseId: number): void {
    expect(modelBodies.length).toBeGreaterThan(0)
    for (const modelBody of modelBodies) {
      const selections = collectSelectedKnowledgeSources(modelBody)
      expect(selections).toHaveLength(1)
      const selection = selections[0]
      expect(countOccurrences(selection, '<source ')).toBe(1)
      expect(selection).toContain('provider=\"wegent\"')
      expect(selection).toContain(`knowledge_base_id=\"${knowledgeBaseId}\"`)
    }
  }

  function expectSelectedResources(modelBodies: unknown[], resourceIds: number[]): void {
    for (const modelBody of modelBodies) {
      const selections = collectSelectedKnowledgeSources(modelBody)
      expect(selections).toHaveLength(1)
      const selection = selections[0]
      expect(countOccurrences(selection, '<resource ')).toBe(resourceIds.length)
      for (const resourceId of resourceIds) {
        expect(selection).toContain(`resource_id=\"${resourceId}\"`)
      }
    }
  }

  function collectSelectedKnowledgeSources(value: unknown): string[] {
    const selections: string[] = []
    const visit = (current: unknown) => {
      if (typeof current === 'string') {
        const match = current.match(
          /<selected_knowledge_sources>[\s\S]*?<\/selected_knowledge_sources>/g
        )
        if (match) selections.push(...match)
        return
      }
      if (Array.isArray(current)) {
        current.forEach(visit)
        return
      }
      if (current && typeof current === 'object') {
        Object.values(current).forEach(visit)
      }
    }
    visit(value)
    return selections
  }

  function expectWegentSkillLoaded(modelBodies: CapturedModelRequest[]): void {
    for (const modelBody of modelBodies) {
      const requestText = JSON.stringify(modelBody)
      expect(countOccurrences(requestText, WEGENT_SKILL_HEADING)).toBe(1)
    }
  }

  function expectProviderToolInventory(modelBodies: CapturedModelRequest[]): void {
    for (const modelBody of modelBodies) {
      const toolNames = getToolDefinitionNames(modelBody)
      expect(toolNames.length).toBeGreaterThan(0)
      expect(new Set(toolNames).size).toBe(toolNames.length)
      for (const toolSuffix of [LIST_DOCUMENTS_TOOL, READ_DOCUMENT_TOOL]) {
        const toolName = toolNames.find(name => name.endsWith(toolSuffix))
        expect(toolName, `Missing model tool definition ending with ${toolSuffix}`).toBeTruthy()
        expect(toolName).toContain('wegent-knowledge')
      }
      expect(toolNames.some(name => isToolName(name, 'knowledge_search'))).toBe(false)
    }
  }

  function getToolDefinitionNames(modelBody: CapturedModelRequest): string[] {
    return (modelBody.tools || [])
      .map(tool => tool.function?.name || tool.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
  }

  function expectProviderToolOrder(calls: RecordedToolCall[], expectedSuffixes: string[]): void {
    const providerCalls = calls.filter(call => call.name.includes('wegent_kb_'))
    expect(providerCalls).toHaveLength(expectedSuffixes.length)
    expectedSuffixes.forEach((suffix, index) => {
      expect(providerCalls[index].name).toMatch(new RegExp(`${suffix}$`))
    })
  }

  function expectNoToolCalls(calls: RecordedToolCall[], forbiddenSuffixes: string[]): void {
    for (const suffix of forbiddenSuffixes) {
      expect(
        calls.some(call => call.name.endsWith(suffix)),
        `Unexpected tool call ending with ${suffix}: ${JSON.stringify(calls)}`
      ).toBe(false)
    }
  }

  function expectNoKnowledgeBaseAccess(calls: RecordedToolCall[], knowledgeBaseId: number): void {
    expect(
      calls.some(call => call.input.knowledge_base_id === knowledgeBaseId),
      `Knowledge base ${knowledgeBaseId} must remain outside the selected scope`
    ).toBe(false)
  }

  function expectToolCall(
    calls: RecordedToolCall[],
    toolSuffix: string,
    expectedInput: Record<string, unknown>
  ): void {
    expect(
      calls.some(call => call.name.endsWith(toolSuffix) && matchesInput(call.input, expectedInput)),
      `Expected ${toolSuffix} with ${JSON.stringify(expectedInput)}; got ${JSON.stringify(calls)}`
    ).toBe(true)
  }

  function expectToolOutputContains(
    calls: RecordedToolCall[],
    toolSuffix: string,
    expectedValues: string[],
    forbiddenValues: string[] = []
  ): void {
    const matchingCalls = calls.filter(call => call.name.endsWith(toolSuffix))
    expect(matchingCalls, `${toolSuffix} should be called exactly once`).toHaveLength(1)
    const outputText = JSON.stringify(matchingCalls[0].output)
    for (const value of expectedValues) expect(outputText).toContain(value)
    for (const value of forbiddenValues) expect(outputText).not.toContain(value)
  }

  function expectReadDocuments(
    calls: RecordedToolCall[],
    documentIds: number[],
    expected = true
  ): void {
    for (const documentId of documentIds) {
      const found = calls.some(
        call => call.name.endsWith(READ_DOCUMENT_TOOL) && call.input.document_id === documentId
      )
      expect(found, `Document ${documentId} read expectation should be ${expected}`).toBe(expected)
    }
  }

  function expectReadDocumentOutputs(
    calls: RecordedToolCall[],
    expectedDocuments: Array<[documentId: number, marker: string]>
  ): void {
    for (const [documentId, marker] of expectedDocuments) {
      const matchingCalls = calls.filter(
        call => call.name.endsWith(READ_DOCUMENT_TOOL) && call.input.document_id === documentId
      )
      expect(matchingCalls, `Document ${documentId} should be read exactly once`).toHaveLength(1)
      const outputText = JSON.stringify(matchingCalls[0].output)
      expect(outputText).toContain(marker)
    }
  }

  function expectBoundKnowledgeBase(
    response: { items: BoundKnowledgeBase[]; total: number },
    knowledgeBase: BoundKnowledgeBase
  ): void {
    expect(response.total).toBe(1)
    expect(response.items).toHaveLength(1)
    expect(response.items[0].id).toBe(knowledgeBase.id)
    expect(response.items[0].name).toBe(knowledgeBase.name)
  }

  function expectFinalAnswer(finalAnswer: string, markers: string[]): void {
    expect(finalAnswer).toBe(markers.join(' '))
  }

  function isToolName(actualName: string, expectedName: string): boolean {
    return actualName === expectedName || actualName.endsWith(`_${expectedName}`)
  }

  function matchesInput(
    actual: Record<string, unknown>,
    expected: Record<string, unknown>
  ): boolean {
    return Object.entries(expected).every(([key, value]) => actual[key] === value)
  }

  async function expectMarkers(page: Page, markers: string[]): Promise<void> {
    for (const marker of markers) {
      await expect(page.getByTestId('messages-container')).toContainText(marker)
    }
  }

  function countOccurrences(value: string, fragment: string): number {
    return value.split(fragment).length - 1
  }

  async function skipOnboardingTour(page: Page): Promise<void> {
    await page.addInitScript(() => {
      localStorage.setItem('user_onboarding_completed', 'true')
      localStorage.removeItem('onboarding_in_progress')
      localStorage.removeItem('onboarding_current_step')
    })
  }

  async function dismissOnboardingTour(page: Page): Promise<void> {
    const overlay = page.locator('.driver-overlay, .driver-popover')
    if (await overlay.isVisible({ timeout: 1000 }).catch(() => false)) {
      await page.keyboard.press('Escape')
    }
  }

  async function ensureTestTeamSelected(page: Page): Promise<void> {
    const messageInput = page.getByTestId('message-input')
    if (await messageInput.isVisible({ timeout: 5000 }).catch(() => false)) return

    const selector = page
      .locator('[data-testid="agent-skill-selector-button"], [data-testid="team-selector"]')
      .first()
    await expect(selector).toBeVisible()
    await selector.click({ force: true })
    const option = page
      .locator(
        `[data-testid="team-option-${TEST_TEAM_NAME}"], [role="button"]:has-text("${TEST_TEAM_NAME}"), [role="option"]:has-text("${TEST_TEAM_NAME}")`
      )
      .first()
    await expect(option).toBeVisible()
    await option.click({ force: true })
    await expect(messageInput).toBeVisible()
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }
})
