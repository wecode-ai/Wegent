import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, executorMockUrl } from '../../fixtures/executor-test'
import { DataBuilders } from '../../fixtures/data-builders'
import { createApiClient, type ApiResponse } from '../../utils/api-client'
import { modelToolDefinitions } from '../../utils/model-tool-discovery'
import { resolveRuntime } from '../../utils/pipeline-archive-runtime'

const MOCK = executorMockUrl()
const PROVIDER = executorMockUrl(process.env.E2E_CLAUDE_MODEL_SERVER_URL)
const IMAGE = process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const MANAGER = `${process.env.EXECUTOR_MANAGER_URL || 'http://localhost:8001'}/executor-manager`

type BotSummary = { id: number; shell_type: string }
type Subtask = {
  id: number
  role: string
  status: string
  executor_name?: string | null
  bots: BotSummary[]
}
type TaskDetail = {
  status: string
  model_id?: string
  team: { agent_type: string; bots: Array<{ bot: BotSummary }> }
  subtasks: Subtask[]
}
type BotResource = {
  spec: {
    ghostRef: { name: string; namespace: string }
    shellRef: { name: string; namespace: string }
  }
}
type ChatEvent = [string, { subtask_id?: number; shell_type?: string }]

function checked<T>(response: ApiResponse<T>): T {
  expect([200, 201], JSON.stringify(response.data)).toContain(response.status)
  expect(response.data).not.toBeNull()
  return response.data!
}

function observeChat(page: Page) {
  const sent: ChatEvent[] = []
  const joins: Array<{ subtasks: Subtask[] }> = []
  const record = (body: string, incoming: boolean) => {
    for (const frame of body.split('\x1e')) {
      if (!incoming && /^42\/chat,\d*\[/.test(frame)) {
        sent.push(JSON.parse(frame.slice(frame.indexOf('['))) as ChatEvent)
      } else if (incoming && /^43\/chat,\d+\[/.test(frame)) {
        const [ack] = JSON.parse(frame.slice(frame.indexOf('['))) as Array<{
          subtasks?: Subtask[]
        }>
        if (Array.isArray(ack?.subtasks)) joins.push({ subtasks: ack.subtasks })
      }
    }
  }
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => record(payload.toString(), false))
    socket.on('framereceived', ({ payload }) => record(payload.toString(), true))
  })
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.searchParams.get('transport') === 'polling') {
      record(request.postData() || '', false)
    }
  })
  page.on('response', async response => {
    const url = new URL(response.url())
    if (url.pathname.includes('/socket.io') && url.searchParams.get('transport') === 'polling') {
      // Polling can close normally during the WebSocket upgrade or page reload.
      await response.text().then(
        body => record(body, true),
        () => {}
      )
    }
  })
  return { sent, joins }
}

// One real ClaudeCode execution in the existing executor-chromium CI project.
// Only the model is mocked; groups, references, persistence, sockets and cancellation are real.
test('stops ClaudeCode through a cross-namespace Shell reference after refresh', async ({
  page,
  request,
  executorAccount,
}, testInfo) => {
  test.setTimeout(180_000)
  const prefix = `e2e-shell-cancel-${randomUUID().slice(0, 8)}`
  const source = `${prefix}-source`
  const target = `${prefix}-target`
  const model = `${prefix}-model`
  const shell = `${prefix}-custom-shell`
  const bot = `${prefix}-bot`
  const team = `${prefix}-team`
  const prompt = `Wait for the model response for ${prefix}.`
  const api = createApiClient(request)
  api.setToken(executorAccount.token)
  const cleanup: Array<() => Promise<void>> = []
  const traffic = observeChat(page)
  let taskId: number | undefined
  let assistantId: number | undefined
  const remove = async (path: string) => {
    const response = await api.delete(path)
    expect([200, 204, 404], `${path}: ${JSON.stringify(response.data)}`).toContain(response.status)
  }
  const detail = async () => checked(await api.get<TaskDetail>(`/api/tasks/${taskId}`))
  const pendingResponses = async () => {
    const response = await request.get(`${MOCK}/stream-rules`)
    expect(response.ok(), await response.text()).toBe(true)
    const rules = (await response.json()) as Array<{
      matchText: string
      holdResponse: boolean
      pendingResponses: number
    }>
    const rule = rules.find(rule => rule.matchText === prompt)
    expect(rule?.holdResponse).toBe(true)
    return rule!.pendingResponses
  }
  const publish = (groups: string[]) => ({
    resource_type: 'shell',
    source_name: shell,
    source_namespace: source,
    display_name: shell,
    status: 'archived',
    target_groups: groups,
    allow_personal_install: false,
    allow_group_install: true,
  })

  try {
    for (const name of [source, target]) {
      checked(await api.createGroup(DataBuilders.group({ name, visibility: 'private' })))
      cleanup.push(() => remove(`/api/groups/${name}`))
    }
    checked(
      await api.post('/api/v1/namespaces/default/models', {
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
              base_url: `${PROVIDER}/v1`,
              ANTHROPIC_DEFAULT_OPUS_MODEL: model,
              ANTHROPIC_DEFAULT_SONNET_MODEL: model,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            },
          },
        },
      })
    )
    cleanup.push(() => remove(`/api/v1/namespaces/default/models/${model}`))
    checked(
      await api.post(`/api/shells?group_name=${source}`, {
        name: shell,
        baseShellRef: 'ClaudeCode',
        baseImage: IMAGE,
      })
    )
    cleanup.push(() => remove(`/api/shells/${shell}`))
    checked(await api.post('/api/resource-library/listings', publish([target])))
    cleanup.push(async () => {
      checked(await api.post('/api/resource-library/listings', publish([])))
    })

    const sourceShell = checked(
      await api.get<{
        metadata: { namespace: string }
        spec: { shellType: string; baseImage: string }
      }>(`/api/v1/namespaces/${source}/shells/${shell}`)
    )
    expect(sourceShell.metadata.namespace).toBe(source)
    expect(sourceShell.spec).toMatchObject({ shellType: 'ClaudeCode', baseImage: IMAGE })
    const targetShells = checked(
      await api.get<{ data: Array<{ name: string; namespace: string; isReference: boolean }> }>(
        `/api/shells/unified?scope=group&group_name=${target}`
      )
    )
    expect(targetShells.data.filter(item => item.name === shell)).toEqual([
      expect.objectContaining({ namespace: target, isReference: true }),
    ])

    const createdBot = checked(
      await api.post<{ id: number }>('/api/bots', {
        name: bot,
        namespace: source,
        shell_name: shell,
        agent_config: { bind_model: model, bind_model_type: 'user' },
        inherit_base_capabilities: false,
        system_prompt: 'Answer the user directly without invoking tools.',
      })
    )
    let ghost = `${bot}-ghost`
    cleanup.push(async () => {
      await remove(`/api/v1/namespaces/${source}/bots/${bot}`)
      await remove(`/api/v1/namespaces/${source}/ghosts/${ghost}`)
    })
    // Keep Bot and Team in the source group, as in the reported task. The
    // reference points into the target group while the Shell stays in source.
    const botPath = `/api/v1/namespaces/${source}/bots/${bot}`
    const botResource = checked(await api.get<BotResource>(botPath))
    ghost = botResource.spec.ghostRef.name
    botResource.spec.shellRef = { name: shell, namespace: target }
    expect(checked(await api.put<BotResource>(botPath, botResource)).spec.shellRef).toEqual({
      name: shell,
      namespace: target,
    })
    const createdTeam = checked(
      await api.post<{ id: number }>('/api/teams', {
        name: team,
        namespace: source,
        bots: [{ bot_id: createdBot.id, bot_prompt: '', role: 'worker' }],
        bind_mode: ['chat'],
        requires_workspace: false,
      })
    )
    cleanup.push(() => remove(`/api/v1/namespaces/${source}/teams/${team}`))
    const held = await request.post(`${MOCK}/stream-rules`, {
      data: {
        matchText: prompt,
        responseContent: `${prefix}-unexpected-completion`,
        holdResponse: true,
      },
    })
    expect(held.ok(), await held.text()).toBe(true)

    await page.addInitScript(id => {
      localStorage.setItem('user_onboarding_completed', 'true')
      localStorage.setItem('wegent_last_team_id', String(id))
      localStorage.setItem('wegent_last_team_id_chat', String(id))
    }, createdTeam.id)
    await page.goto(`/chat?teamId=${createdTeam.id}`, { waitUntil: 'domcontentloaded' })
    const input = page.getByTestId('message-input')
    await expect(input).toBeVisible()
    await page.getByTestId('model-selector').click()
    await page.getByTestId('model-cascade-search-input').fill(model)
    await page.getByTestId(`model-option-${model}`).click()
    await input.fill(prompt)
    await page.getByTestId('send-button').click()
    await expect(page).toHaveURL(/[?&]taskId=\d+/)
    taskId = Number(new URL(page.url()).searchParams.get('taskId'))
    expect(taskId).toBeGreaterThan(0)
    cleanup.push(() => remove(`/api/tasks/${taskId}`))

    await expect
      .poll(
        async () => {
          const response = await request.get(`${MOCK}/captured-requests`)
          expect(response.ok(), await response.text()).toBe(true)
          const captures = (await response.json()) as Array<{
            url: string
            body?: { model?: string; stream?: boolean }
          }>
          return captures.some(
            capture =>
              /\/messages(?:\?|$)/.test(capture.url) &&
              capture.body?.model === model &&
              capture.body.stream === true &&
              JSON.stringify(capture.body).includes(prompt) &&
              modelToolDefinitions(capture.body).some(tool => tool.name === 'Bash')
          )
        },
        { timeout: 120_000, message: 'The real ClaudeCode CLI must reach the held model request' }
      )
      .toBe(true)
    await expect.poll(pendingResponses).toBeGreaterThan(0)
    await expect
      .poll(async () => {
        const current = await detail()
        const assistant = current.subtasks.find(item => item.role === 'ASSISTANT')
        assistantId = assistant?.id
        return assistant?.status === 'RUNNING' && Boolean(assistant.executor_name)
      })
      .toBe(true)
    const executorName = (await detail()).subtasks.find(
      item => item.id === assistantId
    )?.executor_name
    expect(executorName).not.toMatch(/^(?:device-|inprocess[-_])/)
    const runtime = await resolveRuntime(
      request,
      MANAGER,
      taskId,
      { Authorization: `Bearer ${executorAccount.token}` },
      'executor'
    )
    expect(runtime.container_name).toBe(executorName)
    expect(runtime.base_url).toMatch(/^https?:\/\//)

    traffic.joins.length = 0
    await page.reload({ waitUntil: 'domcontentloaded' })
    const restored = await detail()
    expect(restored.model_id).toBe(model)
    expect(restored.team.agent_type).toBe('claude')
    expect(restored.team.bots.map(item => item.bot.shell_type)).toEqual(['ClaudeCode'])
    expect(
      restored.subtasks.find(item => item.id === assistantId)?.bots.map(item => item.shell_type)
    ).toEqual(['ClaudeCode'])
    await expect
      .poll(
        () =>
          traffic.joins.some(ack =>
            ack.subtasks.some(
              item =>
                item.id === assistantId && item.bots.some(bot => bot.shell_type === 'ClaudeCode')
            )
          ),
        { message: 'The real task:join recovery snapshot must resolve the same referenced Shell' }
      )
      .toBe(true)
    await expect(page.getByTestId('messages-container')).toContainText(prompt)

    const stop = page.getByTestId('stop-stream-button')
    await expect(stop).toBeEnabled()
    await stop.click()
    await expect
      .poll(
        () =>
          traffic.sent.find(
            ([name, data]) => name === 'chat:cancel' && data.subtask_id === assistantId
          )?.[1]
      )
      .toMatchObject({ subtask_id: assistantId, shell_type: 'ClaudeCode' })
    // The backend can also finalize a stale stream locally. Require both the
    // terminal assistant and native model disconnect before releasing the gate.
    await expect
      .poll(async () => (await detail()).subtasks.find(item => item.id === assistantId)?.status, {
        timeout: 30_000,
      })
      .toBe('CANCELLED')
    await expect.poll(pendingResponses, { timeout: 30_000 }).toBe(0)
    expect((await detail()).subtasks.find(item => item.id === assistantId)?.status).toBe(
      'CANCELLED'
    )
    await expect(stop).toHaveCount(0)
    await testInfo.attach('shell-reference-cancel-evidence', {
      body: JSON.stringify(
        { taskId, assistantId, runtime, detail: await detail(), traffic },
        null,
        2
      ),
      contentType: 'application/json',
    })
  } finally {
    // Deleting a rule releases its gate and is safe after cancellation closes
    // the model connection. Release first even if an assertion failed.
    const failures: unknown[] = []
    try {
      const released = await request.delete(`${MOCK}/stream-rules`, {
        params: { matchText: prompt },
      })
      expect(released.ok(), await released.text()).toBe(true)
    } catch (error) {
      failures.push(error)
    }
    for (const action of cleanup.reverse()) {
      try {
        await action()
      } catch (error) {
        failures.push(error)
      }
    }
    expect.soft(failures, 'All test-owned resources and model gates must be cleaned up').toEqual([])
  }
})
