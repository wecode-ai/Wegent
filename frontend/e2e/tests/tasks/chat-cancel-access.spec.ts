// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { checked, test, type HistoryAccount } from '../../fixtures/recent-team-history'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MODEL_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'

type TaskDetail = {
  status: string
  subtasks: Array<{ id: number; role: string; status: string }>
}

type Subscription = {
  id: number
  enabled: boolean
  trigger_type: string
  trigger_config: Record<string, unknown>
  next_execution_time: string | null
}
type PersistedTask = TaskDetail & {
  task_id: number
  is_active: number
  execution_status: string
  schedule: Record<string, unknown>
}

function subscriptionState(
  history: HistoryAccount,
  subscriptionId: number,
  operation: 'prepare' | 'inspect',
  taskId?: number
): Promise<PersistedTask>
function subscriptionState(
  history: HistoryAccount,
  subscriptionId: number,
  operation: 'cleanup',
  taskId?: number
): Promise<{ removed_task_ids: number[] }>
async function subscriptionState(
  history: HistoryAccount,
  subscriptionId: number,
  operation: 'prepare' | 'inspect' | 'cleanup',
  taskId?: number
): Promise<PersistedTask | { removed_task_ids: number[] }> {
  if (!process.env.DATABASE_URL)
    throw new Error('Cancellation E2E requires the isolated service DATABASE_URL')
  const child = promisify(execFile)(
    'uv',
    [
      'run',
      '--no-sync',
      '--no-env-file',
      'python',
      resolve(__dirname, '../../fixtures/subscription-chat-cancel-state.py'),
    ],
    {
      cwd: resolve(__dirname, '../../../../backend'),
      env: { ...process.env, PYTHONPATH: '.:..' },
      timeout: 45_000,
    }
  )
  child.child.stdin!.end(
    JSON.stringify({
      operation,
      prefix: history.prefix,
      subscription_id: subscriptionId,
      task_id: taskId,
    })
  )
  const line = (await child).stdout.split('\n').find(row => row.startsWith('CANCEL_E2E_STATE '))
  expect(line, 'The real subscription fixture must return its persisted state').toBeTruthy()
  return JSON.parse(line!.slice('CANCEL_E2E_STATE '.length))
}

async function holdModel(request: APIRequestContext, prompt: string): Promise<() => Promise<void>> {
  expect(
    (
      await request.post(`${MODEL_URL}/stream-rules`, {
        data: { matchText: prompt, responseContent: 'Held response', holdResponse: true },
      })
    ).status()
  ).toBe(200)
  return async () => {
    const removed = await request.delete(`${MODEL_URL}/stream-rules`, {
      params: { matchText: prompt },
    })
    expect(removed.status()).toBe(200)
  }
}

async function expectHeldModel(request: APIRequestContext, prompt: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${MODEL_URL}/stream-rules`)
        expect(response.status()).toBe(200)
        const rules = (await response.json()) as Array<{
          matchText: string
          pendingResponses: number
        }>
        return rules.find(rule => rule.matchText === prompt)?.pendingResponses
      },
      { message: 'The real Chat Shell must reach the held model request', timeout: 15_000 }
    )
    .toBe(1)
}

async function sendFromBrowser(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('message-input').fill(prompt)
  await expect(page.getByTestId('send-button')).toBeEnabled()
  await page.getByTestId('send-button').click()
}

function schedule(subscription: Subscription) {
  return {
    enabled: subscription.enabled,
    trigger_type: subscription.trigger_type,
    trigger_config: subscription.trigger_config,
    next_execution_time: subscription.next_execution_time,
  }
}

// The existing Chromium CI shards discover this spec. Only the model is mocked.
test('only an authorized caller can cancel a running Chat turn', async ({
  history,
  createHistoryAccount,
  request,
}) => {
  const foreign = await createHistoryAccount()
  const team = await history.teamWithModes('cancel-access', ['chat'])
  const prompt = `${history.prefix}-cancel-access`
  const connect = (token: string) =>
    createAuthenticatedSocketClient({
      socketBaseUrl: () => API_URL,
      getToken: () => token,
      namespace: '/chat',
    })
  const ownerClient = connect(history.token)
  const foreignClient = connect(foreign.token)
  const configured = await request.post(`${MODEL_URL}/stream-rules`, {
    data: { matchText: prompt, responseContent: 'Held response', holdResponse: true },
  })
  expect(configured.status()).toBe(200)
  try {
    await Promise.all([ownerClient.ensureConnected(), foreignClient.ensureConnected()])
    const ownerSocket = ownerClient.getRawSocket()!
    const foreignSocket = foreignClient.getRawSocket()!
    const sent = (await ownerSocket.timeout(10_000).emitWithAck('chat:send', {
      team_id: team.id,
      task_type: 'chat',
      message: prompt,
    })) as { task_id: number; error?: string }
    expect(sent.error).toBeUndefined()
    expect(sent.task_id).toBeGreaterThan(0)
    const detail = async () =>
      checked(await history.api.get<TaskDetail>(`/api/tasks/${sent.task_id}`))
    const state = async () => {
      const task = await detail()
      return [task.status, task.subtasks.find(row => row.role === 'ASSISTANT')?.status]
    }
    await expect.poll(state, { timeout: 30_000 }).toEqual(['RUNNING', 'RUNNING'])
    const assistant = (await detail()).subtasks.find(row => row.role === 'ASSISTANT')!
    for (const shellType of ['Chat', 'Codex']) {
      expect(
        await foreignSocket.timeout(10_000).emitWithAck('chat:cancel', {
          subtask_id: assistant.id,
          shell_type: shellType,
        })
      ).toEqual({ error: 'Access denied' })
      expect(await state()).toEqual(['RUNNING', 'RUNNING'])
    }
    expect(
      await ownerSocket.timeout(10_000).emitWithAck('chat:cancel', {
        subtask_id: assistant.id,
        shell_type: 'Chat',
      })
    ).toMatchObject({ success: true, finalized: true })
    await expect.poll(state, { timeout: 15_000 }).toEqual(['CANCELLED', 'CANCELLED'])
  } finally {
    ownerClient.dispose()
    foreignClient.dispose()
    const removed = await request.delete(
      `${MODEL_URL}/stream-rules?matchText=${encodeURIComponent(prompt)}`
    )
    expect(removed.status()).toBe(200)
  }
})

for (const enabled of [true, false]) {
  test(`browser Stop persists a subscription turn and preserves its ${enabled ? 'enabled' : 'disabled'} schedule`, async ({
    page,
    history,
    request,
  }) => {
    const team = await history.teamWithModes('subscription-cancel', ['chat'])
    const subscription = checked(
      await history.api.post<Subscription>('/api/subscriptions', {
        name: `${history.prefix}-subscription`,
        display_name: `${history.prefix}-subscription`,
        team_id: team.id,
        trigger_type: 'cron',
        trigger_config: { expression: '0 9 1 1 *', timezone: 'Asia/Shanghai' },
        prompt_template: 'Reply with a short subscription setup confirmation.',
        enabled,
      }),
      201
    )
    const subscriptionPath = `/api/subscriptions/${subscription.id}`
    const prompt = `${history.prefix}-held-subscription-turn`
    const release = await holdModel(request, prompt)
    let taskId: number | undefined
    try {
      const seeded = await subscriptionState(history, subscription.id, 'prepare')
      taskId = seeded.task_id
      expect(seeded).toMatchObject({
        status: 'COMPLETED',
        execution_status: 'COMPLETED',
        is_active: 2,
      })
      const before = schedule(checked(await history.api.get<Subscription>(subscriptionPath)))
      expect(before.enabled).toBe(enabled)
      const taskPath = `/api/tasks/${seeded.task_id}`
      const detail = async () => checked(await history.api.get<TaskDetail>(taskPath))
      await page.goto(`/chat?taskId=${seeded.task_id}`, { waitUntil: 'domcontentloaded' })
      await sendFromBrowser(page, prompt)
      await expectHeldModel(request, prompt)
      await expect.poll(async () => (await detail()).status).toBe('RUNNING')
      const assistant = (await detail()).subtasks.filter(row => row.role === 'ASSISTANT').at(-1)!
      expect(assistant.status).toBe('RUNNING')
      await page.getByTestId('stop-stream-button').click()
      await expect.poll(async () => (await detail()).status, { timeout: 15_000 }).toBe('CANCELLED')
      const stopped = await subscriptionState(history, subscription.id, 'inspect', seeded.task_id)
      expect(stopped).toMatchObject({ status: 'CANCELLED', is_active: 2 })
      expect(stopped.schedule).toEqual(seeded.schedule)
      expect(stopped.subtasks.find(row => row.id === assistant.id)?.status).toBe('CANCELLED')
      expect(schedule(checked(await history.api.get<Subscription>(subscriptionPath)))).toEqual(
        before
      )

      await release()
      const continuation = `${history.prefix}-continue-after-stop`
      await sendFromBrowser(page, continuation)
      await expect.poll(async () => (await detail()).status, { timeout: 30_000 }).toBe('COMPLETED')
      await expect(page).toHaveURL(new RegExp(`[?&]taskId=${seeded.task_id}(?:&|$)`))
      const continued = await subscriptionState(history, subscription.id, 'inspect', seeded.task_id)
      expect(continued.is_active).toBe(2)
      expect(continued.schedule).toEqual(seeded.schedule)
      const assistants = continued.subtasks.filter(row => row.role === 'ASSISTANT')
      expect(assistants.find(row => row.id === assistant.id)?.status).toBe('CANCELLED')
      expect(assistants.at(-1)).toMatchObject({ status: 'COMPLETED' })
      expect(assistants.at(-1)!.id).toBeGreaterThan(assistant.id)
      expect(schedule(checked(await history.api.get<Subscription>(subscriptionPath)))).toEqual(
        before
      )
    } finally {
      const failures: unknown[] = []
      for (const cleanup of [
        release,
        () => subscriptionState(history, subscription.id, 'cleanup', taskId),
        async () => {
          checked(await history.api.delete(subscriptionPath), 204)
        },
      ]) {
        try {
          await cleanup()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Subscription cancellation cleanup failed')
    }
  })
}

test('SocketProvider leaves a pending cancellation on disconnect and retries after reconnect', async ({
  page,
  history,
  request,
}) => {
  const team = await history.teamWithModes('cancel-reconnect', ['chat'])
  const prompt = `${history.prefix}-held-cancel-reconnect`
  const release = await holdModel(request, prompt)
  const namespaceSessions: string[] = []
  let droppedCancellation = false
  let forwardedCancellations = 0
  let cancellationFailedOnDisconnect = false
  page.on('console', message => {
    if (message.text().includes('Connection lost before cancellation was acknowledged')) {
      cancellationFailedOnDisconnect = true
    }
  })
  // Relay the real connection. Lose the first cancel frame at the transport
  // boundary, before the server can acknowledge or mutate the running turn.
  await page.routeWebSocket(/\/socket\.io\/.*transport=websocket/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(async message => {
      const frame = message.toString()
      if (/^42\/chat,\d+\["chat:cancel",/.test(frame)) {
        if (!droppedCancellation) {
          droppedCancellation = true
          await Promise.all([
            ws.close({ code: 1012, reason: 'Cancellation transport interrupted' }),
            server.close({ code: 1012, reason: 'Cancellation transport interrupted' }),
          ])
          return
        }
        forwardedCancellations += 1
      }
      server.send(message)
    })
    server.onMessage(message => {
      const frame = message.toString()
      if (frame.startsWith('40/chat,')) {
        namespaceSessions.push((JSON.parse(frame.slice('40/chat,'.length)) as { sid: string }).sid)
      }
      ws.send(message)
    })
  })
  try {
    await page.goto(`/chat?teamId=${team.id}`, { waitUntil: 'domcontentloaded' })
    await expect.poll(() => namespaceSessions.length, { timeout: 15_000 }).toBe(1)
    await sendFromBrowser(page, prompt)
    await expect(page).toHaveURL(/[?&]taskId=\d+/)
    const taskId = Number(new URL(page.url()).searchParams.get('taskId'))
    const detail = async () => checked(await history.api.get<TaskDetail>(`/api/tasks/${taskId}`))
    await expectHeldModel(request, prompt)
    await expect.poll(async () => (await detail()).status).toBe('RUNNING')
    await page.getByTestId('stop-stream-button').click()
    await expect
      .poll(() => cancellationFailedOnDisconnect, {
        message:
          'The actual SocketProvider must exit ACK waiting on disconnect, before its 20s timeout',
        timeout: 5000,
      })
      .toBe(true)
    expect(droppedCancellation).toBe(true)
    expect(forwardedCancellations).toBe(0)
    expect((await detail()).status).toBe('RUNNING')
    await expect(page.getByTestId('stop-stream-button')).toBeEnabled({ timeout: 5000 })
    await expect.poll(() => namespaceSessions.length, { timeout: 15_000 }).toBe(2)
    expect(namespaceSessions[1]).not.toBe(namespaceSessions[0])
    await page.getByTestId('stop-stream-button').click()
    await expect.poll(async () => (await detail()).status, { timeout: 15_000 }).toBe('CANCELLED')
    expect(forwardedCancellations).toBe(1)
    await expect(page.getByTestId('stop-stream-button')).toHaveCount(0)
    await expect(page.getByTestId('message-input')).toBeEnabled()
  } finally {
    await release()
  }
})
