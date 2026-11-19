// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { checked, test } from '../../fixtures/recent-team-history'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MODEL_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'

type TaskDetail = {
  status: string
  subtasks: Array<{ id: number; role: string; status: string }>
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
