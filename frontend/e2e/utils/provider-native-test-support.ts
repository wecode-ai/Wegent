import { APIRequestContext, expect, Page } from '@playwright/test'
import { ADMIN_USER } from '../config/test-users'
import {
  createProviderNativeKnowledgeFixture,
  deleteProviderNativeKnowledgeFixture,
  ProviderNativeKnowledgeFixture,
} from '../fixtures/provider-native-knowledge'
import { ApiClient, createApiClient } from './api-client'

export const PROVIDER_NATIVE_API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
export const PROVIDER_NATIVE_MOCK_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const PROVIDER_NATIVE_MCP_URL =
  process.env.E2E_PROVIDER_MCP_URL ||
  process.env.E2E_CLAUDE_MODEL_SERVER_URL ||
  PROVIDER_NATIVE_MOCK_URL

export interface ProviderNativeResources {
  token: string
  prefix: string
  modelName: string
  botName: string
  teamName: string
  teamId: number
  fixture: ProviderNativeKnowledgeFixture
}

export interface RecordedProviderCall {
  timestamp: string
  name: string
  arguments: Record<string, unknown>
  result: unknown
  isError: boolean
}

export interface RecordedTaskToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  output: unknown
}

export interface ToolScenarioStep {
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>
  responseContent?: string
}

export async function createProviderNativeResources(
  request: APIRequestContext,
  prefix: string
): Promise<ProviderNativeResources> {
  const apiClient: ApiClient = createApiClient(request)
  const login = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
  const token = login.data?.access_token || ''
  expect(token).toBeTruthy()
  const fixture = await createProviderNativeKnowledgeFixture(request, {
    apiBaseUrl: PROVIDER_NATIVE_API_URL,
    token,
    nameSuffix: prefix,
  })
  const modelName = `${prefix}-model`
  const botName = `${prefix}-bot`
  const teamName = `${prefix}-team`
  const modelResponse = await request.post(
    `${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/models`,
    {
      headers: authHeaders(token),
      data: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: { name: modelName, namespace: 'default' },
        spec: {
          modelConfig: {
            env: {
              model: 'openai',
              model_id: 'mock-provider-native-model',
              api_key: 'mock-api-key',
              base_url: `${PROVIDER_NATIVE_MOCK_URL}/v1`,
            },
          },
        },
      },
    }
  )
  expect([200, 201]).toContain(modelResponse.status())
  const botResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/bots`, {
    headers: authHeaders(token),
    data: {
      name: botName,
      shell_name: 'Chat',
      agent_config: { bind_model: modelName, bind_model_type: 'user' },
      system_prompt: 'Use only explicitly selected provider-native knowledge.',
      namespace: 'default',
      is_active: true,
    },
  })
  expect([200, 201]).toContain(botResponse.status())
  const botId = ((await botResponse.json()) as { id?: number }).id
  expect(botId).toBeTruthy()
  const teamResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/teams`, {
    headers: authHeaders(token),
    data: {
      name: teamName,
      description: 'Provider-native extended E2E team',
      bots: [{ bot_id: botId, bot_prompt: '', role: 'worker' }],
      bind_mode: ['chat'],
      namespace: 'default',
      is_active: true,
    },
  })
  expect([200, 201]).toContain(teamResponse.status())
  const teamId = ((await teamResponse.json()) as { id?: number }).id
  expect(teamId).toBeTruthy()
  await configureDingTalkService(request, token, 'docs', true)
  await configureDingTalkService(request, token, 'wikispace', true)
  await resetMockMcp(request)
  for (const endpoint of ['dingtalk-docs/sync', 'dingtalk-wikispace/sync']) {
    const response = await request.post(`${PROVIDER_NATIVE_API_URL}/api/${endpoint}`, {
      headers: authHeaders(token),
      timeout: 30_000,
    })
    expect(response.status(), await response.text()).toBe(200)
  }
  await resetMockMcp(request)
  return { token, prefix, modelName, botName, teamName, teamId: teamId!, fixture }
}

export async function deleteProviderNativeResources(
  request: APIRequestContext,
  resources: ProviderNativeResources
): Promise<void> {
  await configureDingTalkService(request, resources.token, 'docs', false).catch(() => null)
  await configureDingTalkService(request, resources.token, 'wikispace', false).catch(() => null)
  await configureDingTalkService(request, resources.token, 'ai_table', false).catch(() => null)
  for (const id of [resources.fixture.knowledgeBase.id, resources.fixture.otherKnowledgeBase.id]) {
    await deleteProviderNativeKnowledgeFixture(
      request,
      PROVIDER_NATIVE_API_URL,
      resources.token,
      id
    ).catch(() => null)
  }
  await request
    .delete(`${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/teams/${resources.teamName}`, {
      headers: authHeaders(resources.token),
    })
    .catch(() => null)
  await request
    .delete(`${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/bots/${resources.botName}`, {
      headers: authHeaders(resources.token),
    })
    .catch(() => null)
  await request
    .delete(`${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/models/${resources.modelName}`, {
      headers: authHeaders(resources.token),
    })
    .catch(() => null)
  await resetMockMcp(request).catch(() => null)
}

export async function configureDingTalkService(
  request: APIRequestContext,
  token: string,
  serviceId: 'docs' | 'wikispace' | 'ai_table',
  enabled: boolean
): Promise<void> {
  const response = await request.put(
    `${PROVIDER_NATIVE_API_URL}/api/users/me/mcps/providers/dingtalk/services/${serviceId}`,
    {
      headers: authHeaders(token),
      data: {
        enabled,
        url: enabled ? `${PROVIDER_NATIVE_MCP_URL}/mcp?service=${serviceId}` : '',
      },
    }
  )
  expect(response.status(), await response.text()).toBe(200)
}

export async function openProviderNativeChat(
  page: Page,
  resources: ProviderNativeResources
): Promise<void> {
  await page.addInitScript(selectedTeamId => {
    localStorage.setItem('user_onboarding_completed', 'true')
    localStorage.setItem('wegent_last_team_id', String(selectedTeamId))
    localStorage.setItem('wegent_last_team_id_chat', String(selectedTeamId))
  }, resources.teamId)
  await page.goto(`/chat?teamId=${resources.teamId}`, { waitUntil: 'domcontentloaded' })
  const input = page.getByTestId('message-input')
  if (!(await input.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const selector = page
      .locator('[data-testid="agent-skill-selector-button"], [data-testid="team-selector"]')
      .first()
    await selector.click({ force: true })
    await page
      .locator(
        `[data-testid="team-option-${resources.teamName}"], [role="button"]:has-text("${resources.teamName}"), [role="option"]:has-text("${resources.teamName}")`
      )
      .first()
      .click({ force: true })
  }
  await expect(input).toBeVisible()
}

export async function configureToolScenario(
  request: APIRequestContext,
  matchText: string,
  steps: ToolScenarioStep[]
): Promise<void> {
  const response = await request.post(`${PROVIDER_NATIVE_MOCK_URL}/tool-scenarios`, {
    data: { matchText, steps },
  })
  expect(response.status(), await response.text()).toBe(200)
}

export async function clearToolScenario(
  request: APIRequestContext,
  matchText: string
): Promise<void> {
  await request.delete(
    `${PROVIDER_NATIVE_MOCK_URL}/tool-scenarios?matchText=${encodeURIComponent(matchText)}`
  )
}

export async function resetMockMcp(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${PROVIDER_NATIVE_MOCK_URL}/mcp-control/reset`)
  expect(response.status(), await response.text()).toBe(200)
}

export async function configureMockMcp(
  request: APIRequestContext,
  config: { deniedNodeIds?: string[]; documentNames?: Record<string, string> }
): Promise<void> {
  const response = await request.post(`${PROVIDER_NATIVE_MOCK_URL}/mcp-control/config`, {
    data: config,
  })
  expect(response.status(), await response.text()).toBe(200)
}

export async function getMcpCalls(request: APIRequestContext): Promise<RecordedProviderCall[]> {
  const response = await request.get(`${PROVIDER_NATIVE_MOCK_URL}/mcp-control/calls`)
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as RecordedProviderCall[]
}

export async function waitForTaskTerminal(
  request: APIRequestContext,
  token: string,
  taskId: number,
  expected: RegExp = /^COMPLETED/
): Promise<string> {
  let finalStatus = ''
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${PROVIDER_NATIVE_API_URL}/api/tasks/${taskId}/runtime-check`,
          { headers: authHeaders(token) }
        )
        if (response.status() !== 200) return `HTTP_${response.status()}`
        const body = (await response.json()) as { task_status: string }
        finalStatus = body.task_status.toUpperCase()
        return finalStatus
      },
      { timeout: 60_000, message: `Task ${taskId} should reach ${expected}` }
    )
    .toMatch(expected)
  return finalStatus
}

export async function getTask(request: APIRequestContext, token: string, taskId: number) {
  const response = await request.get(`${PROVIDER_NATIVE_API_URL}/api/tasks/${taskId}`, {
    headers: authHeaders(token),
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as unknown
}

export function collectTaskToolCalls(value: unknown): RecordedTaskToolCall[] {
  const calls = new Map<string, RecordedTaskToolCall>()
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
      const previous = calls.get(id)
      calls.set(id, {
        id,
        name: item.tool_name,
        input: item.tool_input as Record<string, unknown>,
        output: item.tool_output ?? previous?.output,
      })
    }
    Object.values(item).forEach(visit)
  }
  visit(value)
  return [...calls.values()]
}

export function extractTaskAnswer(task: unknown): string {
  if (!task || typeof task !== 'object') return ''
  const subtasks = (task as { subtasks?: unknown[] }).subtasks
  if (!Array.isArray(subtasks)) return ''
  for (const subtask of [...subtasks].reverse()) {
    if (!subtask || typeof subtask !== 'object') continue
    const result = (subtask as { result?: { value?: unknown } }).result
    if (typeof result?.value === 'string' && result.value.trim()) return result.value.trim()
  }
  return ''
}

export function extractExternalKnowledgeRefs(task: unknown): Record<string, unknown>[] {
  if (!task || typeof task !== 'object') return []
  const refs = (task as { external_knowledge_refs?: unknown }).external_knowledge_refs
  return Array.isArray(refs)
    ? refs.filter((ref): ref is Record<string, unknown> => Boolean(ref) && typeof ref === 'object')
    : []
}

export async function getScenarioModelBodies(
  request: APIRequestContext,
  prompt: string
): Promise<Record<string, unknown>[]> {
  const response = await request.get(
    `${PROVIDER_NATIVE_MOCK_URL}/tool-scenarios?matchText=${encodeURIComponent(prompt)}`
  )
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { capturedRequests: Record<string, unknown>[] }
  return body.capturedRequests.filter(item => JSON.stringify(item).includes(prompt))
}

export function modelRequestText(bodies: unknown[]): string {
  return JSON.stringify(bodies).replace(/\\\"/g, '"')
}

export function modelToolNames(bodies: Record<string, unknown>[]): string[] {
  return bodies.flatMap(body => {
    const tools = Array.isArray(body.tools) ? body.tools : []
    return tools
      .map(tool => {
        if (!tool || typeof tool !== 'object') return ''
        const value = tool as { name?: string; function?: { name?: string } }
        return value.function?.name || value.name || ''
      })
      .filter(Boolean)
  })
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}
