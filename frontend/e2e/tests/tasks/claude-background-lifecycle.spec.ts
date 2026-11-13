import { APIRequestContext } from '@playwright/test'
import { test, expect, EXECUTOR_USER, executorMockUrl } from '../../fixtures/executor-test'
import { createApiClient, createBackendRequestHeaders } from '../../utils/api-client'
import { collectTaskToolCalls, extractTaskAnswer } from '../../utils/provider-native-test-support'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MOCK_URL = executorMockUrl()
const PROVIDER_URL = executorMockUrl(process.env.E2E_CLAUDE_MODEL_SERVER_URL)
const EXECUTOR_IMAGE =
  process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const INHERITED_CEILING_MS = 500

type Capture = {
  kind: string
  timestamp: number
  body: { messages: unknown[]; system?: unknown }
}
type TaskDetail = {
  status: string
  model_id?: string
  subtasks: Array<{
    role: string
    status: string
    error_message?: string
    result?: {
      blocks?: Array<{ type: string; parent_tool_use_id?: string; content?: string }>
    }
  }>
}

test.describe('Real Claude background subagent lifecycle', () => {
  test.describe.configure({ timeout: 180_000 })

  for (const scenarioName of ['complete', 'stop', 'coordinate'] as const) {
    const mode = scenarioName === 'stop' ? 'stop' : 'complete'
    const title =
      scenarioName === 'coordinate'
        ? 'Web coordinate chat runs a configured team member as a Claude subagent'
        : `background subagent ${mode === 'complete' ? 'outlives the inherited ceiling and completes' : 'stopped by the parent cannot complete the task'}`
    test(title, async ({ page, request }, testInfo) => {
      const model = `e2e-claude-bg-${scenarioName}-${Date.now()}`
      const shellName = `${model}-shell`
      const botName = `${model}-bot`
      const teamName = `${model}-team`
      const workerName = scenarioName === 'coordinate' ? `${model}-worker` : undefined
      const login = await createApiClient(request).login(
        EXECUTOR_USER.username,
        EXECUTOR_USER.password,
        1
      )
      expect(login.status).toBe(200)
      const headers = createBackendRequestHeaders(login.data!.access_token)
      let taskId: number | undefined
      try {
        const { teamId, subagentType } = await createAgent(
          request,
          headers,
          model,
          shellName,
          botName,
          teamName,
          workerName
        )
        const configured = await request.post(`${MOCK_URL}/claude-background-scenarios`, {
          data: { model, mode, subagentType },
        })
        expect(configured.ok(), await configured.text()).toBe(true)
        await page.addInitScript(id => {
          localStorage.setItem('user_onboarding_completed', 'true')
          localStorage.setItem('wegent_last_team_id', String(id))
          localStorage.setItem('wegent_last_team_id_chat', String(id))
        }, teamId)
        await page.goto(`/chat?teamId=${teamId}`, { waitUntil: 'domcontentloaded' })
        const input = page.getByTestId('message-input')
        await expect(input).toBeVisible()
        const modelSelector = page.getByTestId('model-selector')
        await expect(modelSelector).toBeEnabled()
        await modelSelector.click()
        await page.getByTestId('model-cascade-search-input').fill(model)
        await page.getByTestId(`model-option-${model}`).click()
        await expect(modelSelector).toHaveAttribute('aria-expanded', 'false')
        await input.fill(`Run the background lifecycle regression ${model}.`)
        await page.getByTestId('send-button').click()
        await expect
          .poll(() => new URL(page.url()).searchParams.get('taskId'), { timeout: 20_000 })
          .not.toBeNull()
        taskId = Number(new URL(page.url()).searchParams.get('taskId'))
        expect(taskId).toBeGreaterThan(0)

        // Stop on any terminal state so a false completion fails immediately.
        let terminal = ''
        await expect
          .poll(
            async () => {
              const response = await request.get(`${API_URL}/api/tasks/${taskId}/runtime-check`, {
                headers,
              })
              expect(response.ok(), await response.text()).toBe(true)
              terminal = (await response.json()).task_status
              return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(terminal)
            },
            { timeout: 120_000 }
          )
          .toBe(true)
        const detailResponse = await request.get(`${API_URL}/api/tasks/${taskId}`, { headers })
        expect(detailResponse.ok(), await detailResponse.text()).toBe(true)
        const detail = (await detailResponse.json()) as TaskDetail
        const observed = await request.get(`${MOCK_URL}/claude-background-scenarios`, {
          params: { model },
        })
        expect(observed.ok()).toBe(true)
        const scenario = (await observed.json()) as { childFinished: boolean; requests: Capture[] }
        await testInfo.attach('background-lifecycle-evidence', {
          body: JSON.stringify({ terminal, detail, scenario }, null, 2),
          contentType: 'application/json',
        })

        const expected = mode === 'complete' ? 'COMPLETED' : 'FAILED'
        expect(terminal).toBe(expected)
        expect(detail.status).toBe(expected)
        const assistants = detail.subtasks.filter(subtask => subtask.role === 'ASSISTANT')
        expect(assistants).toHaveLength(1)
        expect(assistants[0].status).toBe(expected)
        if (mode === 'complete') {
          expect(scenario.childFinished).toBe(true)
          const parentWaiting = scenario.requests.find(capture => capture.kind === 'parent-1')!
          const childDone = scenario.requests.find(capture => capture.kind === 'child-1')!
          if (workerName) {
            expect(subagentType).toBeTruthy()
            expect(JSON.stringify(childDone.body.system)).toContain(`TEAM_MEMBER_${workerName}`)
          }
          expect(childDone.timestamp - parentWaiting.timestamp).toBeGreaterThan(
            INHERITED_CEILING_MS
          )
          // The actual Bash result proves Executor replaced both inherited settings.
          expect(JSON.stringify(childDone.body.messages)).toContain(
            'BG_WAIT=86400000 REPORT=1 CHILD_PROBE_OK'
          )
          expect(extractTaskAnswer(detail)).toContain(`BG_PARENT_DONE_${model}`)
          await expect(page.getByTestId('messages-container')).toContainText(
            `BG_PARENT_DONE_${model}`
          )
        } else {
          expect(scenario.childFinished).toBe(false)
          const afterStop = scenario.requests.find(capture => capture.kind === 'parent-3')!
          expect(JSON.stringify(afterStop.body.messages)).toContain('Successfully stopped task')
          expect(assistants[0].error_message).toContain('the task was not completed')
        }
      } finally {
        if (taskId) {
          const removed = await request.delete(`${API_URL}/api/tasks/${taskId}`, { headers })
          expect([200, 204, 404]).toContain(removed.status())
        }
        for (const [kind, name] of [
          ['teams', teamName],
          ['bots', botName],
          ...(workerName ? [['bots', workerName]] : []),
          ['models', model],
        ]) {
          const removed = await request.delete(
            `${API_URL}/api/v1/namespaces/default/${kind}/${name}`,
            { headers }
          )
          expect([200, 204, 404]).toContain(removed.status())
        }
        const shell = await request.delete(`${API_URL}/api/shells/${shellName}`, { headers })
        expect([200, 204, 404]).toContain(shell.status())
        const cleared = await request.delete(`${MOCK_URL}/claude-background-scenarios`, {
          params: { model },
        })
        expect(cleared.ok()).toBe(true)
      }
    })
  }

  test('ClaudeCode persists a child message above 1 MiB and completes after a real background notification', async ({
    page,
    request,
  }, testInfo) => {
    const model = `e2e-claude-bg-large-${Date.now()}`
    const shellName = `${model}-shell`
    const botName = `${model}-bot`
    const teamName = `${model}-team`
    const childMarker = `BG_LARGE_CHILD_${model}`
    const finalMarker = `BG_LARGE_PARENT_DONE_${model}`
    const login = await createApiClient(request).login(
      EXECUTOR_USER.username,
      EXECUTOR_USER.password,
      1
    )
    expect(login.status).toBe(200)
    const headers = createBackendRequestHeaders(login.data!.access_token)
    let taskId: number | undefined
    try {
      const configured = await request.post(`${MOCK_URL}/claude-background-scenarios`, {
        data: { model, mode: 'large-output' },
      })
      expect(configured.ok(), await configured.text()).toBe(true)
      const { teamId } = await createAgent(request, headers, model, shellName, botName, teamName)
      await page.addInitScript(id => {
        localStorage.setItem('user_onboarding_completed', 'true')
        localStorage.setItem('wegent_last_team_id', String(id))
        localStorage.setItem('wegent_last_team_id_chat', String(id))
      }, teamId)
      await page.goto(`/chat?teamId=${teamId}`, { waitUntil: 'domcontentloaded' })
      const input = page.getByTestId('message-input')
      await expect(input).toBeVisible()
      const modelSelector = page.getByTestId('model-selector')
      await expect(modelSelector).toBeEnabled()
      await modelSelector.click()
      await page.getByTestId('model-cascade-search-input').fill(model)
      await page.getByTestId(`model-option-${model}`).click()
      await expect(modelSelector).toHaveAttribute('aria-expanded', 'false')
      await input.fill(`Run the large background output regression ${model}.`)
      await page.getByTestId('send-button').click()
      await expect
        .poll(() => new URL(page.url()).searchParams.get('taskId'), { timeout: 20_000 })
        .not.toBeNull()
      taskId = Number(new URL(page.url()).searchParams.get('taskId'))
      expect(taskId).toBeGreaterThan(0)

      let terminal = ''
      await expect
        .poll(
          async () => {
            const response = await request.get(`${API_URL}/api/tasks/${taskId}/runtime-check`, {
              headers,
            })
            expect(response.ok(), await response.text()).toBe(true)
            terminal = (await response.json()).task_status
            return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(terminal)
          },
          { timeout: 120_000 }
        )
        .toBe(true)
      const detailResponse = await request.get(`${API_URL}/api/tasks/${taskId}`, { headers })
      expect(detailResponse.ok(), await detailResponse.text()).toBe(true)
      const detail = (await detailResponse.json()) as TaskDetail
      expect(terminal).toBe('COMPLETED')
      expect(detail.status).toBe('COMPLETED')
      expect(detail.model_id).toBe(model)
      const assistants = detail.subtasks.filter(subtask => subtask.role === 'ASSISTANT')
      expect(assistants).toHaveLength(1)
      expect(assistants[0].status).toBe('COMPLETED')
      const calls = collectTaskToolCalls(detail)
      const agents = calls.filter(call => call.name === 'Agent')
      expect(agents).toHaveLength(1)
      expect(agents[0].input.run_in_background).toBe(true)
      expect(calls.map(call => call.name)).toEqual(['Agent'])

      const child = assistants[0].result?.blocks?.find(
        block =>
          block.type === 'text' &&
          block.parent_tool_use_id === agents[0].id &&
          block.content?.startsWith(childMarker)
      )
      expect(child).toBeDefined()
      const childBytes = Buffer.byteLength(child!.content!, 'utf8')
      expect(childBytes).toBeGreaterThan(1024 * 1024)
      expect(childBytes).toBeLessThan(10 * 1024 * 1024)
      expect(child!.content!.endsWith(`${childMarker}_END`)).toBe(true)
      expect(extractTaskAnswer(detail)).toContain(finalMarker)
      await expect(page.getByTestId('messages-container')).toContainText(finalMarker)
      const observed = await request.get(`${MOCK_URL}/claude-background-scenarios`, {
        params: { model },
      })
      expect(observed.ok()).toBe(true)
      const scenario = (await observed.json()) as {
        childFinished: boolean
        parentYielded: boolean
        completionReceived: boolean
        requests: Capture[]
      }
      expect(scenario.childFinished).toBe(true)
      expect(scenario.parentYielded).toBe(true)
      expect(scenario.completionReceived).toBe(true)
      expect(scenario.requests.filter(capture => capture.kind.startsWith('child-'))).toHaveLength(1)
      const parentTurns = scenario.requests.filter(capture => capture.kind.startsWith('parent-'))
      expect(parentTurns).toHaveLength(3)
      expect(JSON.stringify(parentTurns[2].body.messages)).toContain('<task-notification>')
      await testInfo.attach('large-background-output-evidence', {
        body: JSON.stringify({
          taskId,
          terminal,
          model,
          childBytes,
          calls: calls.map(call => call.name),
        }),
        contentType: 'application/json',
      })
    } finally {
      if (taskId) {
        const removed = await request.delete(`${API_URL}/api/tasks/${taskId}`, { headers })
        expect([200, 204, 404]).toContain(removed.status())
      }
      for (const [kind, name] of [
        ['teams', teamName],
        ['bots', botName],
        ['models', model],
      ]) {
        const removed = await request.delete(
          `${API_URL}/api/v1/namespaces/default/${kind}/${name}`,
          { headers }
        )
        expect([200, 204, 404]).toContain(removed.status())
      }
      const shell = await request.delete(`${API_URL}/api/shells/${shellName}`, { headers })
      expect([200, 204, 404]).toContain(shell.status())
      const cleared = await request.delete(`${MOCK_URL}/claude-background-scenarios`, {
        params: { model },
      })
      expect(cleared.ok()).toBe(true)
    }
  })
})

async function createAgent(
  request: APIRequestContext,
  headers: Record<string, string>,
  model: string,
  shellName: string,
  botName: string,
  teamName: string,
  workerName?: string
): Promise<{ teamId: number; subagentType?: string }> {
  const created = await request.post(`${API_URL}/api/v1/namespaces/default/models`, {
    headers,
    data: {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: { name: model, namespace: 'default' },
      spec: {
        protocol: 'claude',
        modelConfig: {
          context_window: 200_000,
          env: {
            model: 'claude',
            model_id: model,
            small_model: model,
            api_key: 'mock-api-key',
            base_url: `${PROVIDER_URL}/v1`,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            CLAUDE_CODE_SUBAGENT_MODEL: model,
            // Accelerate the old ten-minute ceiling without a ten-minute CI sleep.
            CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(INHERITED_CEILING_MS),
            CLAUDE_CODE_BG_TASKS_REPORT_RUNNING: '0',
          },
        },
      },
    },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const shell = await request.post(`${API_URL}/api/shells`, {
    headers,
    data: { name: shellName, baseShellRef: 'ClaudeCode', baseImage: EXECUTOR_IMAGE },
  })
  expect(shell.ok(), await shell.text()).toBe(true)
  const botId = await createBot(request, headers, model, shellName, botName)
  const workerId = workerName
    ? await createBot(request, headers, model, shellName, workerName)
    : undefined
  const team = await request.post(`${API_URL}/api/teams`, {
    headers,
    data: {
      name: teamName,
      bots: workerId
        ? [
            { bot_id: botId, bot_prompt: '', role: 'leader' },
            { bot_id: workerId, bot_prompt: `TEAM_MEMBER_${workerName}`, role: 'worker' },
          ]
        : [{ bot_id: botId, bot_prompt: '', role: 'worker' }],
      ...(workerId ? { workflow: { mode: 'coordinate' } } : {}),
      bind_mode: ['chat'],
      namespace: 'default',
      is_active: true,
      requires_workspace: false,
    },
  })
  expect(team.ok(), await team.text()).toBe(true)
  const teamId = (await team.json()).id
  expect(teamId).toBeTruthy()
  return { teamId, subagentType: workerId ? `${workerName}-${workerId}` : undefined }
}

async function createBot(
  request: APIRequestContext,
  headers: Record<string, string>,
  model: string,
  shellName: string,
  name: string
): Promise<number> {
  const bot = await request.post(`${API_URL}/api/bots`, {
    headers,
    data: {
      name,
      shell_name: shellName,
      agent_config: { bind_model: model, bind_model_type: 'user' },
      inherit_base_capabilities: false,
      system_prompt: 'Execute the requested background lifecycle scenario.',
      namespace: 'default',
      is_active: true,
    },
  })
  expect(bot.ok(), await bot.text()).toBe(true)
  const botId = (await bot.json()).id
  expect(botId).toBeTruthy()
  return botId
}
