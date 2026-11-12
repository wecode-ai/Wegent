// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from '@playwright/test'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { checked, expectSelected, test } from '../../fixtures/recent-team-history'

// The default chromium project runs this spec in e2e-tests.yml's existing shards.
// Only the model is mocked; authentication, Redis, persistence and sockets are real.
const MODEL_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'

test('group chat stores a plain message and starts an assistant only on mention', async ({
  history,
}) => {
  const team = await history.teamWithModes('group-mention', ['chat'])
  const client = createAuthenticatedSocketClient({
    socketBaseUrl: () => process.env.E2E_API_URL || 'http://localhost:8000',
    getToken: () => history.token,
    namespace: '/chat',
  })
  try {
    await client.ensureConnected()
    const socket = client.getRawSocket()!
    const first = (await socket.timeout(10_000).emitWithAck('chat:send', {
      team_id: team.id,
      task_type: 'chat',
      is_group_chat: true,
      message: 'A group message without a mention',
    })) as { task_id: number; subtask_id: number; error?: string }
    expect(first.error).toBeUndefined()
    expect(first.subtask_id).toEqual(expect.any(Number))
    const subtasks = async () =>
      checked(
        await history.api.get<{ subtasks: Array<{ id: number; role: string }> }>(
          `/api/tasks/${first.task_id}`
        )
      ).subtasks
    expect(await subtasks()).toEqual([
      expect.objectContaining({ id: first.subtask_id, role: 'USER' }),
    ])

    const second = (await socket.timeout(10_000).emitWithAck('chat:send', {
      task_id: first.task_id,
      team_id: team.id,
      message: `@${team.name} Reply to the group`,
    })) as { subtask_id: number; error?: string }
    expect(second.error).toBeUndefined()
    expect(second.subtask_id).toEqual(expect.any(Number))
    expect((await subtasks()).map(row => row.role)).toEqual(['USER', 'USER', 'ASSISTANT'])
    await expect
      .poll(
        async () =>
          checked(
            await history.api.get<{ task_status: string }>(
              `/api/tasks/${first.task_id}/runtime-check`
            )
          ).task_status,
        { timeout: 45_000 }
      )
      .toBe('COMPLETED')
  } finally {
    client.dispose()
  }
})

type ChatEvent = [string, { task_id?: number; status?: string; title?: string }]

function observeChatSocket(page: Page) {
  const sessions: string[] = []
  const received: ChatEvent[] = []
  const sent: ChatEvent[] = []
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.includes('/socket.io')) return
    socket.on('framereceived', ({ payload }) => {
      const frame = payload.toString()
      if (frame.startsWith('40/chat,')) {
        sessions.push((JSON.parse(frame.slice('40/chat,'.length)) as { sid: string }).sid)
      }
      if (/^42\/chat,\d*\[/.test(frame)) {
        received.push(JSON.parse(frame.slice(frame.indexOf('['))) as ChatEvent)
      }
    })
    socket.on('framesent', ({ payload }) => {
      const frame = payload.toString()
      if (/^42\/chat,\d*\[/.test(frame)) {
        sent.push(JSON.parse(frame.slice(frame.indexOf('['))) as ChatEvent)
      }
    })
  })
  return { sessions, received, sent }
}

for (const reloadObserver of [false, true]) {
  test(`user-room completion reaches another tab ${reloadObserver ? 'after reload' : 'on first connection'}`, async ({
    page,
    context,
    history,
    request,
  }) => {
    test.setTimeout(60_000)
    const team = await history.team('socket-room')
    const prompt = `${history.prefix}-user-room-${reloadObserver ? 'reload' : 'initial'}`
    const marker = `${prompt}-completed`
    const observer = await context.newPage()
    const observerTraffic = observeChatSocket(observer)
    const activeTraffic = observeChatSocket(page)

    const configured = await request.post(`${MODEL_URL}/stream-rules`, {
      data: { matchText: prompt, responseContent: marker, chunkDelayMs: 20 },
    })
    expect(configured.status()).toBe(200)
    try {
      await test.step('Authenticate the observer without joining a task room', async () => {
        await observer.addInitScript(() => {
          localStorage.setItem('user_onboarding_completed', 'true')
        })
        await observer.goto(`/chat?teamId=${team.id}`, { waitUntil: 'domcontentloaded' })
        await expectSelected(observer, team)
        await expect.poll(() => observerTraffic.sessions.length, { timeout: 15_000 }).toBe(1)
        if (reloadObserver) {
          await observer.reload({ waitUntil: 'domcontentloaded' })
          await expectSelected(observer, team)
          await expect.poll(() => observerTraffic.sessions.length, { timeout: 15_000 }).toBe(2)
          expect(observerTraffic.sessions[1]).not.toBe(observerTraffic.sessions[0])
        }
      })

      await test.step('Send a real task from the active tab', async () => {
        await page.goto(`/chat?teamId=${team.id}`, { waitUntil: 'domcontentloaded' })
        await expectSelected(page, team)
        await expect.poll(() => activeTraffic.sessions.length, { timeout: 15_000 }).toBe(1)
        await page.getByTestId('message-input').fill(prompt)
        await expect(page.getByTestId('send-button')).toBeEnabled()
        await page.getByTestId('send-button').click()
        await expect(page).toHaveURL(/[?&]taskId=\d+/)
        await expect(page.getByTestId('messages-container')).toContainText(marker, {
          timeout: 30_000,
        })
      })

      const taskId = Number(new URL(page.url()).searchParams.get('taskId'))
      await test.step('Receive completion in both the task room and user room', async () => {
        await expect
          .poll(
            () =>
              activeTraffic.received.some(
                ([event, data]) => event === 'chat:done' && data.task_id === taskId
              ),
            { timeout: 30_000 }
          )
          .toBe(true)
        await expect
          .poll(
            () =>
              observerTraffic.received.some(
                ([event, data]) =>
                  event === 'task:status' && data.task_id === taskId && data.status === 'COMPLETED'
              ),
            { timeout: 15_000 }
          )
          .toBe(true)

        const created = observerTraffic.received.find(
          ([event, data]) => event === 'task:created' && data.task_id === taskId
        )
        expect(
          created,
          'The observer must receive task creation through its user room'
        ).toBeDefined()
        expect(created![1].title).toBeTruthy()
        const observerTask = observer.getByTestId('task-sidebar').getByText(created![1].title!, {
          exact: true,
        })
        await expect(observerTask).toBeVisible()
        await expect(observerTask.locator('..').locator('.animate-spin')).toHaveCount(0)

        await expect
          .poll(
            async () =>
              checked(
                await history.api.get<{ task_status: string }>(`/api/tasks/${taskId}/runtime-check`)
              ).task_status,
            { timeout: 15_000 }
          )
          .toBe('COMPLETED')
        expect(new URL(observer.url()).searchParams.has('taskId')).toBe(false)
        expect(
          observerTraffic.sent.filter(([event]) => event === 'task:join' || event === 'chat:send')
        ).toEqual([])
        expect(
          observerTraffic.received.filter(
            ([event, data]) => event === 'chat:done' && data.task_id === taskId
          )
        ).toEqual([])
      })
    } finally {
      await test.info().attach('user-room-socket-events', {
        body: JSON.stringify({ active: activeTraffic, observer: observerTraffic }, null, 2),
        contentType: 'application/json',
      })
      await observer.close()
      const removed = await request.delete(
        `${MODEL_URL}/stream-rules?matchText=${encodeURIComponent(prompt)}`
      )
      expect(removed.status()).toBe(200)
    }
  })
}
