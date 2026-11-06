import { APIRequestContext, expect, test } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MOCK_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const PROVIDER_URL = process.env.E2E_LOCAL_CLAUDE_MODEL_SERVER_URL || MOCK_URL
const DEVICE_ID = process.env.E2E_COMPACTION_DEVICE_ID || 'e2e-claudecode-compaction-device'
const TIMEOUT = 120_000

type Address = {
  deviceId: string
  taskId: string
  workspacePath: string
  runtimeHandle?: Record<string, unknown>
}
type Transcript = {
  running: boolean
  messages: Array<{ role: string; content: string; status?: string }>
  turns: Array<{ status?: string; error?: unknown }>
}
type Capture = {
  kind: string
  body: {
    model: string
    max_tokens: number
    messages: unknown[]
    thinking?: Record<string, unknown>
    tools: Array<{ name: string; defer_loading?: boolean }>
  }
}

test.describe('Real Claude Code cloud-model compaction', () => {
  test.describe.configure({ mode: 'default', timeout: 180_000 })
  let headers: { Authorization: string }
  let userId: number

  test.beforeAll(async ({ request }) => {
    const login = await createApiClient(request).login(ADMIN_USER.username, ADMIN_USER.password)
    expect(login.data?.access_token).toBeTruthy()
    headers = { Authorization: `Bearer ${login.data!.access_token}` }
    const user = await request.get(`${API_URL}/api/users/me`, { headers })
    expect(user.ok(), await user.text()).toBe(true)
    userId = (await user.json()).id
    expect(userId).toBeGreaterThan(0)
    await expect
      .poll(
        async () => {
          const response = await request.get(`${API_URL}/api/devices`, { headers })
          expect(response.ok()).toBe(true)
          const { items } = await response.json()
          return items.find((item: { device_id: string }) => item.device_id === DEVICE_ID)?.status
        },
        { timeout: 30_000 }
      )
      .toBe('online')
  })

  for (const mode of ['proactive', 'overflow-400', 'overflow-460', 'unrelated-error'] as const) {
    test(`${mode}: preserves the cloud output budget through real Claude Code`, async ({
      request,
    }, testInfo) => {
      const model = `e2e-compact-${mode}-${Date.now()}-${testInfo.workerIndex}`
      const modelName = `${model}-resource`
      const botName = `${model}-bot`
      const teamName = `${model}-agent`
      const modelOptions = {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: String(userId),
        weworkCloudModelUpstreamApiFormat: 'anthropic-messages',
      }
      const modelSelection = { modelName, modelType: 'user', options: modelOptions }
      let address: Address | undefined
      try {
        const configured = await request.post(`${MOCK_URL}/claude-compaction-scenarios`, {
          data: { model, mode },
        })
        expect(configured.ok()).toBe(true)
        const created = await request.post(`${API_URL}/api/v1/namespaces/default/models`, {
          headers,
          data: {
            apiVersion: 'agent.wecode.io/v1',
            kind: 'Model',
            metadata: { name: modelName, namespace: 'default' },
            spec: {
              protocol: 'claude',
              modelConfig: {
                context_window: 1_000_000,
                max_output_tokens: 8_000,
                env: {
                  model: 'claude',
                  model_id: model,
                  api_key: 'mock-api-key',
                  base_url: `${PROVIDER_URL}/v1`,
                },
              },
            },
          },
        })
        expect(created.ok(), await created.text()).toBe(true)
        const teamId = await createAgent(request, modelName, botName, teamName)

        // Only the cloud identity is supplied. Backend must resolve both budgets from the CRD.
        const started = await request.post(`${API_URL}/api/runtime-work/create`, {
          headers,
          data: {
            schemaVersion: 3,
            wegentTeamId: teamId,
            deviceId: DEVICE_ID,
            standaloneChatWorkspace: true,
            runtime: 'claude_code',
            // Real history must be large enough for compaction to free space;
            // otherwise Claude Code attributes mock usage to an irreducible system prefix.
            message: `Remember the original seed ${model}.\n${'Earlier conversation context. '.repeat(30_000)}`,
            modelId: modelName,
            modelType: 'user',
            modelOptions,
          },
        })
        expect(started.ok(), await started.text()).toBe(true)
        const task = await started.json()
        expect(task.accepted, JSON.stringify(task)).toBe(true)
        expect(task.runtime).toBe('claude_code')
        address = {
          deviceId: task.deviceId,
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          runtimeHandle: task.runtimeHandle,
        }
        await waitForAnswer(request, address, `SEED_OK_1_${model}`)

        // Keep a second substantial exchange so the CLI can summarize an older
        // assistant response while preserving its recent conversation tail.
        const continued = await request.post(`${API_URL}/api/runtime-work/send`, {
          headers,
          data: {
            address,
            modelSelection,
            message: `Continue remembering ${model}.\n${'More conversation context. '.repeat(30_000)}`,
          },
        })
        expect(continued.ok(), await continued.text()).toBe(true)
        await waitForAnswer(request, address, `SEED_OK_2_${model}`)

        const sent = await request.post(`${API_URL}/api/runtime-work/send`, {
          headers,
          data: { address, modelSelection, message: `Finish the follow-up for ${model}.` },
        })
        expect(sent.ok(), await sent.text()).toBe(true)
        if (mode === 'unrelated-error') {
          await expect
            .poll(
              async () => {
                const transcript = await getTranscript(request, address!)
                return (
                  !transcript.running &&
                  transcript.turns.some(
                    turn =>
                      turn.status === 'failed' &&
                      JSON.stringify(turn).includes(`UNRELATED_ERROR_${model}`)
                  )
                )
              },
              { timeout: TIMEOUT }
            )
            .toBe(true)
        } else {
          await waitForAnswer(request, address, `COMPLETE_OK_${model}`)
        }

        const observed = await request.get(`${MOCK_URL}/claude-compaction-scenarios`, {
          params: { model },
        })
        expect(observed.ok()).toBe(true)
        const captures: Capture[] = (await observed.json()).requests
        await testInfo.attach('claude-compaction-requests', {
          body: JSON.stringify(captures, null, 2),
          contentType: 'application/json',
        })
        const expected =
          mode === 'proactive'
            ? ['seed', 'seed', 'compact', 'complete']
            : mode === 'unrelated-error'
              ? ['seed', 'seed', 'overflow', 'overflow', 'overflow', 'overflow']
              : ['seed', 'seed', 'overflow', 'compact', 'complete']
        expect(captures.map(capture => capture.kind)).toEqual(expected)
        if (mode === 'unrelated-error') {
          // Claude Code 2.1.310 removes thinking.display, then falls back from
          // deferred tools and repeats that negotiation before surfacing the error.
          for (const index of [2, 4]) {
            const { thinking: initialThinking, ...initialRequest } = captures[index].body
            const { thinking: retryThinking, ...retryRequest } = captures[index + 1].body
            expect(initialThinking).toEqual({ type: 'adaptive', display: 'updates' })
            expect(retryThinking).toEqual({ type: 'adaptive' })
            expect(retryRequest).toEqual(initialRequest)
          }
          const deferred = captures[2].body
          const fallback = captures[4].body
          expect(deferred.tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: 'ToolSearch' }),
              expect.objectContaining({ defer_loading: true }),
            ])
          )
          expect(
            fallback.tools.some(tool => tool.name === 'ToolSearch' || tool.defer_loading)
          ).toBe(false)
          expect(fallback.tools).toEqual(
            expect.arrayContaining(
              deferred.tools.filter(
                tool => !['ToolSearch', 'DeferredToolPlaceholder'].includes(tool.name)
              )
            )
          )
          expect(fallback.messages.slice(0, -2)).toEqual(deferred.messages.slice(0, -1))
          expect(fallback.messages.at(-2)).toEqual({
            role: 'user',
            content: `Finish the follow-up for ${model}.`,
          })
          expect(fallback.messages.at(-1)).toEqual({
            role: 'system',
            content: [
              {
                type: 'text',
                text: 'ToolSearch is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly.',
                cache_control: { type: 'ephemeral' },
              },
            ],
          })
        }
        for (const capture of captures) {
          expect(capture.body.model).toBe(model)
          expect(capture.body.max_tokens).toBeGreaterThan(0)
          expect(capture.body.max_tokens).toBeLessThanOrEqual(8_000)
        }
        const completion = captures.find(capture => capture.kind === 'complete')
        if (completion) {
          expect(JSON.stringify(completion.body.messages)).toContain(`COMPACT_SUMMARY_${model}`)
        }
      } finally {
        if (address) {
          const archived = await request.post(`${API_URL}/api/runtime-work/archive`, {
            headers,
            data: address,
          })
          expect(archived.ok(), await archived.text()).toBe(true)
        }
        for (const [kind, name] of [
          ['teams', teamName],
          ['bots', botName],
          ['models', modelName],
        ]) {
          const removed = await request.delete(
            `${API_URL}/api/v1/namespaces/default/${kind}/${name}`,
            { headers }
          )
          expect([200, 204, 404]).toContain(removed.status())
        }
        const cleared = await request.delete(`${MOCK_URL}/claude-compaction-scenarios`, {
          params: { model },
        })
        expect(cleared.ok()).toBe(true)
      }
    })
  }

  async function createAgent(
    request: APIRequestContext,
    modelName: string,
    botName: string,
    teamName: string
  ): Promise<number> {
    const bot = await request.post(`${API_URL}/api/bots`, {
      headers,
      data: {
        name: botName,
        shell_name: 'ClaudeCode',
        agent_config: { bind_model: modelName, bind_model_type: 'user' },
        system_prompt: 'Return deterministic compaction test responses.',
        inherit_base_capabilities: false,
        namespace: 'default',
        is_active: true,
      },
    })
    expect(bot.ok(), await bot.text()).toBe(true)
    const team = await request.post(`${API_URL}/api/teams`, {
      headers,
      data: {
        name: teamName,
        bots: [{ bot_id: (await bot.json()).id, bot_prompt: '', role: 'worker' }],
        bind_mode: ['task'],
        namespace: 'default',
        is_active: true,
        requires_workspace: false,
      },
    })
    expect(team.ok(), await team.text()).toBe(true)
    const id = (await team.json()).id
    expect(id).toBeGreaterThan(0)
    return id
  }

  async function getTranscript(request: APIRequestContext, address: Address): Promise<Transcript> {
    const response = await request.post(`${API_URL}/api/runtime-work/transcript`, {
      headers,
      data: address,
    })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }

  async function waitForAnswer(
    request: APIRequestContext,
    address: Address,
    answer: string
  ): Promise<void> {
    await expect
      .poll(
        async () => {
          const transcript = await getTranscript(request, address)
          const failed = transcript.turns.find(turn => turn.status === 'failed')
          if (failed) throw new Error(`Claude Code failed: ${JSON.stringify(failed.error)}`)
          return (
            !transcript.running &&
            transcript.messages.some(
              message => message.role === 'assistant' && message.content.includes(answer)
            )
          )
        },
        { timeout: TIMEOUT, message: `Claude Code should finish with ${answer}` }
      )
      .toBe(true)
  }
})
