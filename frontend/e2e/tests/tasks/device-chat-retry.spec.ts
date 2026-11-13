// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { checked, expect, test } from '../../fixtures/recent-team-history'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'

test('a failed retry stays retryable until the device reconnects', async ({ history }) => {
  const team = await history.teamWithModes('device-retry', ['chat'])
  const deviceId = `${history.prefix}-device`
  const connect = (namespace: string) =>
    createAuthenticatedSocketClient({
      socketBaseUrl: () => API_URL,
      getToken: () => history.token,
      namespace,
    })
  const chat = connect('/chat')
  let device = connect('/local-executor')
  let recordId: number | undefined
  let taskId: number | undefined
  const register = async () => {
    await device.ensureConnected()
    const socket = device.getRawSocket()!
    expect(
      await socket.timeout(10_000).emitWithAck('device:register', {
        device_id: deviceId,
        device_type: 'local',
        name: deviceId,
        bind_shell: 'claudecode',
      })
    ).toMatchObject({ success: true, device_route_id: deviceId })
    return socket
  }
  const deviceRecord = async () => {
    const list = checked(
      await history.api.get<{ items: { id: number; device_id: string; status: string }[] }>(
        '/api/devices'
      )
    )
    return list.items.find(item => item.device_id === deviceId)
  }

  try {
    const runtime = await register()
    recordId = (await deviceRecord())?.id
    expect(recordId).toEqual(expect.any(Number))
    await chat.ensureConnected()
    const socket = chat.getRawSocket()!
    const initialDelivery = new Promise<{ subtask_id: number }>(resolve =>
      runtime.once('task:execute', resolve)
    )
    const send = (await socket.timeout(10_000).emitWithAck('chat:send', {
      team_id: team.id,
      task_type: 'chat',
      device_id: deviceId,
      message: 'Retry this device turn',
    })) as { task_id: number; error?: string }
    expect(send.error).toBeUndefined()
    taskId = send.task_id
    expect(taskId).toBeGreaterThan(0)
    const { subtask_id: subtaskId } = await initialDelivery
    expect(subtaskId).toBeGreaterThan(0)

    const state = async () => {
      const task = checked(
        await history.api.get<{ status: string; subtasks: { id: number; status: string }[] }>(
          `/api/tasks/${taskId}`
        )
      )
      return [task.status, task.subtasks.find(row => row.id === subtaskId)?.status]
    }
    const turn = { task_id: taskId, subtask_id: subtaskId }
    expect(await socket.timeout(10_000).emitWithAck('chat:cancel', turn)).toMatchObject({
      success: true,
    })
    await expect.poll(state).toEqual(['CANCELLED', 'CANCELLED'])

    device.dispose()
    await expect.poll(async () => (await deviceRecord())?.status).toBe('offline')
    expect(await socket.timeout(10_000).emitWithAck('chat:retry', turn)).toEqual({
      error: 'Internal server error',
    })
    await expect.poll(state).toEqual(['FAILED', 'FAILED'])

    device = connect('/local-executor')
    const replacement = await register()
    const nextDelivery = new Promise<{ subtask_id: number; task_id: number }>(resolve =>
      replacement.once('task:execute', resolve)
    )
    expect(await socket.timeout(10_000).emitWithAck('chat:retry', turn)).toEqual({ success: true })
    expect(await nextDelivery).toMatchObject(turn)
    await expect.poll(state).toEqual(['RUNNING', 'RUNNING'])
    expect(await socket.timeout(10_000).emitWithAck('chat:cancel', turn)).toMatchObject({
      success: true,
    })
    await expect.poll(state).toEqual(['CANCELLED', 'CANCELLED'])
  } finally {
    chat.dispose()
    device.dispose()
    if (taskId) checked(await history.api.delete(`/api/tasks/${taskId}`))
    if (recordId) {
      await expect.poll(async () => (await deviceRecord())?.status).toBe('offline')
      checked(await history.api.delete(`/api/devices/records/${recordId}`))
    }
  }
})
