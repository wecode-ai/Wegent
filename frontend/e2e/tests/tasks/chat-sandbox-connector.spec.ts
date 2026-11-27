// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { BOOTSTRAP_ADMIN_USER } from '../../config/test-users'
import { executorMockUrl, expect, test } from '../../fixtures/executor-test'
import { checked } from '../../fixtures/recent-team-history'
import { type ApiClient, createApiClient } from '../../utils/api-client'
import { modelToolDefinitions, modelToolMatches } from '../../utils/model-tool-discovery'
import {
  clearToolScenario,
  configureToolScenario,
  extractTaskAnswer,
  getScenarioModelBodies,
  getTask,
} from '../../utils/provider-native-test-support'

const API = process.env.E2E_API_URL || 'http://localhost:8000'
const MANAGER = `${process.env.E2E_EXECUTOR_RECOVERY_URL || 'http://localhost:8191'}/executor-manager/e2b`
const CONNECTOR_UPSTREAM = 'http://127.0.0.1:8191/fixture/sandbox-connector/mcp'
const CONNECTOR_TOOL = 'sandbox_connector_probe'
const E2B_HEADERS = { 'X-API-KEY': 'test-api-key' }
const KINDS = '/api/v1/namespaces/default'

type Resource = { api: ApiClient; path: string; status: number }
type Activation = 'preload' | 'manual' | 'history'

async function createChatTeam(api: ApiClient, name: string, resources: Resource[]) {
  checked(
    await api.post(`${KINDS}/models`, {
      kind: 'Model',
      metadata: { name, namespace: 'default' },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: 'e2e-chat-sandbox',
            api_key: 'mock-api-key',
            base_url: `${executorMockUrl()}/v1`,
          },
        },
      },
    }),
    201
  )
  resources.push({ api, path: `${KINDS}/models/${name}`, status: 200 })
  const bot = checked(
    await api.post<{ id: number }>('/api/bots', {
      name,
      namespace: 'default',
      shell_name: 'Chat',
      agent_config: { bind_model: name, bind_model_type: 'user' },
      system_prompt: 'Use the available tools to check the connector and sandbox.',
      skills: ['sandbox'],
      preload_skills: ['sandbox'],
    }),
    201
  )
  resources.push({ api, path: `/api/bots/${bot.id}`, status: 200 })
  const team = checked(
    await api.post<{ id: number }>('/api/teams', {
      name,
      namespace: 'default',
      bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
      bind_mode: ['chat'],
      requires_workspace: false,
    }),
    201
  )
  resources.push({ api, path: `${KINDS}/teams/${name}`, status: 200 })
  return team.id
}

function toolMessages(body: Record<string, unknown>): string[] {
  const messages = body.messages as Array<{ role: string; content: unknown }>
  return messages
    .filter(message => message.role === 'tool')
    .flatMap(({ content }) => {
      if (typeof content === 'string') return [content]
      if (Array.isArray(content)) return content.map(part => part.text).filter(Boolean)
      return []
    })
}

async function expectTurnResults(
  request: APIRequestContext,
  prompt: string,
  activation: Activation,
  stdout: string
) {
  const bodies = await getScenarioModelBodies(request, prompt)
  expect(bodies.length, `${activation} model requests`).toBeGreaterThan(1)
  const exposed = (body: unknown, name: string) =>
    modelToolDefinitions(body).some(tool => modelToolMatches(tool, name))
  expect(exposed(bodies[0], CONNECTOR_TOOL), `${activation} initial Connector tools`).toBe(
    activation !== 'manual'
  )
  if (activation === 'manual') {
    expect(exposed(bodies[1], CONNECTOR_TOOL), 'Connector tool after load_skill').toBe(true)
  }
  const outputs = toolMessages(bodies.at(-1)!)
  expect(
    outputs.some(
      output => output.includes('sandbox-connector-e2e') && output.includes(`probe-${stdout}`)
    ),
    'Real MCP tool result'
  ).toBe(true)
  const commandOutput = outputs.find(
    output => output.includes('"stdout"') && output.includes(stdout)
  )
  expect(commandOutput, `${activation} command stdout for ${stdout}`).toMatch(
    /"success"\s*:\s*true/
  )
  expect(commandOutput).toMatch(/"exit_code"\s*:\s*0/)
  expect(commandOutput).toContain(`"stdout": "${stdout}\\n"`)
}

test('Chat executes sandbox commands with a lazy Connector and rejects missing required Skills', async ({
  request,
  executorAccount,
}) => {
  test.setTimeout(150_000)
  const { token } = executorAccount
  const api = createApiClient(request, API, token)
  const adminLogin = checked(
    await createApiClient(request, API).login(
      BOOTSTRAP_ADMIN_USER.username,
      BOOTSTRAP_ADMIN_USER.password,
      1
    )
  )
  const admin = createApiClient(request, API, adminLogin.access_token)
  const prefix = `e2e-sandbox-${randomUUID().slice(0, 8)}`
  const keyword = `${prefix}-preload-keyword`
  const connectorSkill = `wegent-connector-${prefix}`
  const resources: Resource[] = []
  const taskIds = new Set<number>()
  const client = createAuthenticatedSocketClient({
    socketBaseUrl: () => API,
    getToken: () => token,
    namespace: '/chat',
  })

  try {
    const connector = checked(
      await admin.post<{ id: number }>('/api/admin/connector-apps', {
        slug: prefix,
        name: 'Sandbox Connector E2E',
        mcp_url: CONNECTOR_UPSTREAM,
        auth_type: 'none',
        transport: 'streamable-http',
        tool_loading_mode: 'lazy',
        tool_allowlist: [CONNECTOR_TOOL],
        keywords: [keyword],
      }),
      201
    )
    resources.push({ api: admin, path: `/api/admin/connector-apps/${connector.id}`, status: 204 })
    const teamId = await createChatTeam(api, prefix, resources)
    await client.ensureConnected()
    const socket = client.getRawSocket()!

    async function runTurn(activation: Activation, existingTaskId?: number): Promise<number> {
      const prompt = activation === 'preload' ? keyword : `${prefix}-${activation}-turn`
      const stdout = `SANDBOX_${activation.toUpperCase()}_${randomUUID().slice(0, 8)}`
      const answer = `Completed ${activation} sandbox check.`
      await configureToolScenario(request, prompt, [
        ...(activation === 'manual'
          ? [{ toolCalls: [{ toolName: 'load_skill', arguments: { skill_name: connectorSkill } }] }]
          : []),
        { toolCalls: [{ toolName: CONNECTOR_TOOL, arguments: { nonce: `probe-${stdout}` } }] },
        {
          toolCalls: [
            {
              toolName: 'exec',
              arguments: {
                command: `/usr/bin/printf '%s\\n' ${stdout}`,
                working_dir: '/tmp',
                timeout_seconds: 10,
              },
            },
          ],
        },
        { responseContent: answer },
      ])
      try {
        const ack = (await socket.timeout(10_000).emitWithAck('chat:send', {
          team_id: teamId,
          task_type: 'chat',
          ...(existingTaskId === undefined ? {} : { task_id: existingTaskId }),
          message: prompt,
        })) as { task_id: number; error?: string }
        expect(ack.error, `${activation} chat:send`).toBeUndefined()
        expect(ack.task_id).toBeGreaterThan(0)
        taskIds.add(ack.task_id)
        if (existingTaskId !== undefined) expect(ack.task_id).toBe(existingTaskId)
        await expect
          .poll(async () => extractTaskAnswer(await getTask(request, token, ack.task_id)), {
            timeout: 55_000,
            message: `${activation} chat turn should persist its final answer`,
          })
          .toBe(answer)
        await expectTurnResults(request, prompt, activation, stdout)
        return ack.task_id
      } finally {
        await clearToolScenario(request, prompt)
      }
    }

    const restoredTask = await runTurn('manual')
    await runTurn('history', restoredTask)
    const preloadedTask = await runTurn('preload')

    // Reuse a proven running sandbox. Its previous successful plan must not
    // bypass validation when a later activation requests a missing Skill.
    const missing = `${prefix}-missing-skill`
    const user = checked(await api.get<{ id: number; user_name: string }>('/api/users/me'))
    const refused = await request.post(`${MANAGER}/sandboxes`, {
      timeout: 10_000,
      headers: E2B_HEADERS,
      data: {
        templateId: 'ClaudeCode',
        timeout: 60,
        metadata: {
          task_id: preloadedTask,
          user_id: user.id,
          user_name: user.user_name,
          auth_token: token,
          required_skills: [missing],
        },
      },
    })
    const error = await refused.json()
    expect(refused.status(), JSON.stringify(error)).toBe(503)
    expect(error.detail).toEqual({
      code: 'sandbox_not_ready',
      message: `Required task Skills are unavailable: ${missing}`,
    })
  } finally {
    client.dispose()
    for (const taskId of taskIds) {
      const sandbox = await request.delete(`${MANAGER}/sandboxes/${taskId}`, {
        headers: E2B_HEADERS,
        timeout: 10_000,
      })
      expect.soft([204, 404], `Delete sandbox ${taskId}`).toContain(sandbox.status())
      const task = await api.delete(`/api/tasks/${taskId}`)
      expect.soft(task.status, `Delete task ${taskId}`).toBe(200)
    }
    for (const { api: owner, path, status } of resources.reverse()) {
      const removed = await owner.delete(path)
      expect.soft(removed.status, `DELETE ${path}`).toBe(status)
    }
  }
})
