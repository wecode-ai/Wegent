import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { test, expect, executorMockUrl } from '../../fixtures/executor-test'
import { createApiClient } from '../../utils/api-client'
import { runtimeProcess, type Runtime } from '../../utils/pipeline-archive-runtime'
import { modelToolDefinitions, modelToolMatches } from '../../utils/model-tool-discovery'

const API = process.env.E2E_API_URL || 'http://localhost:8000'
const MANAGER = `${process.env.EXECUTOR_MANAGER_URL || 'http://localhost:8001'}/executor-manager`
const MOCK = executorMockUrl()
type ChatEvent = [string, { task_id?: number; status?: string; subtask_id?: number }]
type Task = {
  status: string
  error_message?: string | null
  subtasks: Array<{
    id: number
    role: string
    status: string
    executor_name?: string | null
    error_message?: string | null
  }>
}

// This runs in the real disposable sandbox. Release never blocks if the reader
// already exited, so failure cleanup can call it repeatedly.
const TOOL_BARRIER = `
const fs = require('node:fs')
const p = JSON.parse(process.argv[1])
if (p.action === 'inspect') {
  console.log(JSON.stringify({ ready: fs.existsSync(p.directory + '/ready') }))
} else {
  let released = false
  try {
    const fd = fs.openSync(p.directory + '/release', fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    try { fs.writeSync(fd, 'release' + String.fromCharCode(10)); released = true } finally { fs.closeSync(fd) }
  } catch (error) {
    if (!['ENOENT', 'ENXIO'].includes(error.code)) throw error
  }
  console.log(JSON.stringify({ released }))
}
`

function observeEvents(page: Page): ChatEvent[] {
  const events: ChatEvent[] = []
  const record = (body: string) => {
    for (const frame of body.split('\x1e')) {
      if (/^42\/chat,\d*\[/.test(frame)) {
        events.push(JSON.parse(frame.slice(frame.indexOf('['))) as ChatEvent)
      }
    }
  }
  page.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => record(payload.toString()))
  })
  page.on('response', async response => {
    const url = new URL(response.url())
    if (url.pathname.includes('/socket.io') && url.searchParams.get('transport') === 'polling') {
      // A polling response may close during the normal WebSocket upgrade.
      await response.text().then(record, () => {})
    }
  })
  return events
}

test('Chat SSE with a real sandbox survives the stalled-task inspection', async ({
  page,
  request,
  executorAccount,
}, testInfo) => {
  test.setTimeout(90_000)
  const logPath = process.env.E2E_STALLED_BACKEND_LOG
  expect(logPath, 'Run against the dedicated CI short-threshold Backend').toBeTruthy()
  const gatewayLogPath = process.env.E2E_STALLED_GATEWAY_LOG
  expect(gatewayLogPath, 'Read the Rust gateway SSE evidence').toBeTruthy()
  const logStart = (await readFile(logPath!, 'utf8')).length
  const backendLog = async () => (await readFile(logPath!, 'utf8')).slice(logStart)
  const prefix = `e2e-stalled-${randomUUID()}`
  const prompt = `Execute the sandbox command for ${prefix}, then summarize its result.`
  // Keep the marker out of the initial prompt so only the follow-up is gated.
  const marker = `SANDBOX_EXECUTED_${randomUUID().replaceAll('-', '')}`
  const barrierDirectory = `/tmp/${prefix}`
  const command = [
    'set -eu',
    `mkdir -m 700 '${barrierDirectory}'`,
    `mkfifo '${barrierDirectory}/release'`,
    `trap 'rm -f "${barrierDirectory}/release" "${barrierDirectory}/ready"; rmdir "${barrierDirectory}"' EXIT`,
    `exec 3<> '${barrierDirectory}/release'`,
    `printf ready > '${barrierDirectory}/ready'`,
    'IFS= read -r signal <&3',
    'exec 3>&-',
    `printf '%s' '${marker}'`,
  ].join('\n')
  const finalAnswer = `STALLED_INSPECTION_PASSED_${prefix}`
  const api = createApiClient(request)
  api.setToken(executorAccount.token)
  const cleanups: Array<() => Promise<void>> = []
  let taskId: number | undefined
  let runtime: Runtime | undefined
  const events = observeEvents(page)
  const observer = createAuthenticatedSocketClient({
    socketBaseUrl: () => API,
    getToken: () => executorAccount.token,
    namespace: '/chat',
  })
  const releaseTool = async () =>
    runtime &&
    runtimeProcess<{ released: boolean }>(request, runtime, TOOL_BARRIER, {
      directory: barrierDirectory,
      action: 'release',
    })
  const post = async <T = { id: number }>(path: string, data: unknown): Promise<T> => {
    const response = await api.post<T>(path, data)
    expect([200, 201], path).toContain(response.status)
    return response.data!
  }
  const resource = async (kind: string, name: string, data: unknown) => {
    const result = await post(`/api/v1/namespaces/default/${kind}`, data)
    cleanups.push(async () => {
      expect((await api.delete(`/api/v1/namespaces/default/${kind}/${name}`)).status).toBe(200)
    })
    return result
  }
  const detail = async (): Promise<Task> => {
    const response = await api.get<Task>(`/api/tasks/${taskId}`)
    expect(response.status).toBe(200)
    return response.data!
  }
  const assertNoFailure = () => {
    expect(
      events.filter(
        ([name, data]) =>
          data.task_id === taskId &&
          (name === 'chat:error' || (name === 'task:status' && data.status === 'FAILED'))
      )
    ).toEqual([])
  }

  try {
    await resource('models', prefix, {
      kind: 'Model',
      metadata: { name: prefix, namespace: 'default' },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: 'mock-stalled-chat',
            api_key: 'mock-api-key',
            base_url: `${MOCK}/v1`,
          },
        },
      },
    })
    const bot = await post('/api/bots', {
      name: prefix,
      namespace: 'default',
      shell_name: 'Chat',
      agent_config: { bind_model: prefix, bind_model_type: 'user' },
      system_prompt: 'Use the sandbox exec tool, then summarize the result.',
      skills: ['sandbox'],
      preload_skills: ['sandbox'],
    })
    cleanups.push(async () => {
      expect((await api.delete(`/api/v1/namespaces/default/bots/${prefix}`)).status).toBe(200)
    })
    const team = await post('/api/teams', {
      name: prefix,
      namespace: 'default',
      bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
      bind_mode: ['chat'],
      requires_workspace: false,
    })
    cleanups.push(async () => {
      expect((await api.delete(`/api/v1/namespaces/default/teams/${prefix}`)).status).toBe(200)
    })
    expect(
      (
        await request.post(`${MOCK}/tool-scenarios`, {
          data: {
            matchText: prompt,
            steps: [
              {
                toolCalls: [{ toolName: 'exec', arguments: { command, timeout_seconds: 45 } }],
              },
              { responseContent: finalAnswer },
            ],
          },
        })
      ).status()
    ).toBe(200)
    expect(
      (
        await request.post(`${MOCK}/stream-rules`, {
          data: { matchText: marker, responseContent: finalAnswer, holdResponse: true },
        })
      ).status()
    ).toBe(200)
    await page.addInitScript(() => {
      localStorage.setItem('user_onboarding_completed', 'true')
      localStorage.setItem('hasSeenCodeTour', 'true')
    })
    await page.goto(`/chat?teamId=${team.id}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('message-input')).toBeVisible()
    await page.getByTestId('message-input').fill(prompt)
    await page.getByTestId('send-button').click()
    await expect(page).toHaveURL(/[?&]taskId=\d+/)
    taskId = Number(new URL(page.url()).searchParams.get('taskId'))
    expect(taskId).toBeGreaterThan(0)
    await expect
      .poll(
        async () => {
          const response = await request.get(`${MANAGER}/sandboxes/${taskId}`)
          if (response.status() === 404) return false
          expect(response.status()).toBe(200)
          const sandbox = await response.json()
          if (sandbox.status !== 'running') return false
          expect(sandbox).toMatchObject({
            sandbox_id: String(taskId),
            status: 'running',
            container_name: expect.stringMatching(/^wegent-task-/),
          })
          runtime = { ...sandbox, executor_namespace: '' }
          return true
        },
        { timeout: 45_000 }
      )
      .toBe(true)
    await expect
      .poll(
        async () =>
          (
            await runtimeProcess<{ ready: boolean }>(request, runtime!, TOOL_BARRIER, {
              directory: barrierDirectory,
              action: 'inspect',
            })
          ).ready
      )
      .toBe(true)
    const running = await detail()
    expect(running.status).toBe('RUNNING')
    const subtask = running.subtasks.find(item => item.role === 'ASSISTANT')!
    expect(subtask).toBeTruthy()
    expect(subtask.status).toBe('RUNNING')
    expect(subtask.executor_name || '').toBe('')
    // Require a fresh sweep while the real first command is blocked. Existing
    // post-START tool activity protects it even without text or thinking output;
    // activity itself does not prove that the command succeeded.
    const pendingLogStart = (await backendLog()).length
    await expect
      .poll(
        async () => {
          // Only the real worker emits this after selecting the candidate
          // past its threshold, with dispatch-state pending=False.
          const log = (await backendLog()).slice(pendingLogStart)
          return log
            .split('\n')
            .find(
              line =>
                line.includes('[StalledTasks] Exempting subtask') &&
                line.includes(`task_id=${taskId} subtask_id=${subtask.id} `) &&
                line.includes('reason=execution_evidence ')
            )
        },
        { timeout: 20_000 }
      )
      .toBeTruthy()
    const streamOpened = new RegExp(
      `Chat Shell SSE stream opened task_id=${taskId} subtask_id=${subtask.id}(?:\\s|$)`
    )
    await expect.poll(() => readFile(gatewayLogPath!, 'utf8')).toMatch(streamOpened)
    const inspected = await detail()
    expect(inspected.status).toBe('RUNNING')
    const inspectedSubtask = inspected.subtasks.find(item => item.id === subtask.id)!
    expect(inspectedSubtask.status).toBe('RUNNING')
    expect(inspectedSubtask.executor_name || '').toBe('')
    expect(inspectedSubtask.error_message || '').toBe('')
    expect(inspected.error_message || '').toBe('')
    // Read the same Redis recovery snapshot consumed by the real frontend.
    await observer.ensureConnected()
    const joined = (await observer.getRawSocket()!.timeout(10_000).emitWithAck('task:join', {
      task_id: taskId,
    })) as {
      error?: string
      streaming?: {
        subtask_id: number
        cached_content: string
        started_at: string
        last_activity_at: string
        blocks: Array<{ type: string; tool_name?: string; status?: string }>
      }
    }
    expect(joined.error).toBeUndefined()
    expect(joined.streaming?.subtask_id).toBe(subtask.id)
    expect(joined.streaming?.cached_content).toBe('')
    expect(joined.streaming!.started_at).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/)
    expect(joined.streaming!.last_activity_at).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/)
    // Both fields use the existing UTC ISO writer. Preserve their raw
    // distinction because Date.parse discards sub-millisecond activity.
    expect(joined.streaming!.last_activity_at).not.toBe(joined.streaming!.started_at)
    expect(Date.parse(joined.streaming!.last_activity_at)).toBeGreaterThanOrEqual(
      Date.parse(joined.streaming!.started_at)
    )
    const blocks = joined.streaming!.blocks
    expect(blocks.filter(block => block.type === 'text' || block.type === 'thinking')).toEqual([])
    expect(blocks.length).toBeGreaterThan(0)
    expect(
      blocks.every(
        block =>
          block.type === 'tool' &&
          block.tool_name === 'exec' &&
          ['pending', 'generating_arguments'].includes(block.status || '')
      )
    ).toBe(true)
    const firstRequests = await request.get(`${MOCK}/captured-requests`)
    expect(firstRequests.status()).toBe(200)
    const modelRequests = (await firstRequests.json()) as Array<{
      url: string
      body?: { messages?: Array<{ role: string; content?: unknown }> }
    }>
    const modelCalls = modelRequests.filter(
      capture =>
        capture.url.includes('/chat/completions') &&
        modelToolDefinitions(capture.body).some(tool => modelToolMatches(tool, 'exec'))
    )
    expect(modelCalls).toHaveLength(1)
    expect(modelCalls[0].body?.messages?.some(message => message.role === 'tool')).toBe(false)
    assertNoFailure()
    await expect(page.getByTestId('messages-container')).not.toContainText(
      '任务已进入运行状态但执行器始终未就绪'
    )
    expect((await releaseTool())?.released).toBe(true)

    // Now let the first real tool finish and reach the existing second-model
    // gate. Its successful output must arrive in both the model and frontend.
    await expect
      .poll(async () => {
        const response = await request.get(`${MOCK}/captured-requests`)
        expect(response.status()).toBe(200)
        const captures = (await response.json()) as Array<{
          body?: { messages?: Array<{ role: string; content?: unknown }> }
        }>
        return captures.some(capture =>
          capture.body?.messages?.some(message => {
            const output = JSON.stringify(message.content)
            return (
              message.role === 'tool' && output.includes(marker) && /exit_code[^0-9]*0/.test(output)
            )
          })
        )
      })
      .toBe(true)
    await expect
      .poll(() =>
        events.some(
          ([name, data]) =>
            name === 'chat:block_updated' &&
            data.task_id === taskId &&
            data.status === 'done' &&
            JSON.stringify(data).includes(marker)
        )
      )
      .toBe(true)
    const afterTool = await detail()
    expect(afterTool.status).toBe('RUNNING')
    expect(afterTool.error_message || '').toBe('')
    const afterToolSubtask = afterTool.subtasks.find(item => item.id === subtask.id)!
    expect(afterToolSubtask.status).toBe('RUNNING')
    expect(afterToolSubtask.error_message || '').toBe('')
    assertNoFailure()
    await expect(page.getByTestId('messages-container')).not.toContainText(
      '任务已进入运行状态但执行器始终未就绪'
    )
    await expect(page.getByTestId('messages-container')).not.toContainText(finalAnswer)
    await testInfo.attach('stalled-worker-evidence', {
      body: (await backendLog())
        .split('\n')
        .filter(line => line.includes('[StalledTasks]') && line.includes(`task_id=${taskId} `))
        .join('\n'),
      contentType: 'text/plain',
    })
    const released = await request.post(`${MOCK}/stream-rules/release`, {
      data: { matchText: marker },
    })
    expect(released.status()).toBe(200)
    expect((await released.json()).released).toBeGreaterThan(0)
    await expect.poll(async () => (await detail()).status, { timeout: 20_000 }).toBe('COMPLETED')
    await expect(page.getByTestId('messages-container')).toContainText(finalAnswer)
    assertNoFailure()
  } finally {
    // Deleting a rule releases the existing gate idempotently, including failed
    // assertions and cancellation. Always attempt every real resource cleanup.
    const cleanupErrors: unknown[] = []
    const attempt = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    observer.dispose()
    await attempt(releaseTool)
    await attempt(async () => {
      expect((await request.delete(`${MOCK}/stream-rules?matchText=${marker}`)).status()).toBe(200)
    })
    await attempt(async () => {
      expect(
        (
          await request.delete(`${MOCK}/tool-scenarios?matchText=${encodeURIComponent(prompt)}`)
        ).status()
      ).toBe(200)
    })
    taskId ??= events.find(([name]) => name === 'chat:start')?.[1].task_id
    if (taskId) {
      await attempt(async () => {
        expect((await api.delete(`/api/tasks/${taskId}`)).status).toBe(200)
      })
      await attempt(async () => {
        const response = await request.delete(`${MANAGER}/sandboxes/${taskId}`)
        expect([200, 404]).toContain(response.status())
        expect((await request.get(`${MANAGER}/sandboxes/${taskId}`)).status()).toBe(404)
      })
    }
    for (const cleanup of cleanups.reverse()) await attempt(cleanup)
    expect.soft(cleanupErrors, 'Stalled chat cleanup failed').toEqual([])
  }
})
