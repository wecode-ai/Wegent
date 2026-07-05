import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'
import { createLocalChatStream } from './localChatStream'

describe('createLocalChatStream', () => {
  const subscribe = vi.fn()
  const request = vi.fn()

  beforeEach(() => {
    subscribe.mockReset()
    request.mockReset()
  })

  test('maps executor text delta events to chat chunks', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onChatChunk = vi.fn()
    const stream = createLocalChatStream({ subscribe, request })

    stream.subscribe({ onChatChunk })
    await Promise.resolve()
    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { delta: 'hello', offset: 0 },
      },
    })

    expect(onChatChunk).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '1001',
      deviceId: 'local-device',
      content: 'hello',
      offset: 0,
      result: { delta: 'hello', offset: 0 },
    })
  })

  test('maps executor terminal events to chat done callbacks', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onChatDone = vi.fn()
    const stream = createLocalChatStream({ subscribe, request })

    stream.subscribe({ onChatDone })
    await Promise.resolve()
    listener({
      event: 'response.completed',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { value: 'complete' },
      },
    })

    expect(onChatDone).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '1001',
      deviceId: 'local-device',
      result: { value: 'complete' },
    })
  })

  test('routes guidance and cancel requests through app ipc', async () => {
    request.mockResolvedValueOnce({ success: true, guidance_id: 'guide-1' })
    request.mockResolvedValueOnce({ success: true })
    const stream = createLocalChatStream({ subscribe, request })

    await expect(
      stream.sendGuidance({
        task_id: 0,
        subtask_id: 1001,
        team_id: 0,
        message: 'continue',
      })
    ).resolves.toEqual({ success: true, guidance_id: 'guide-1' })
    await expect(stream.cancelStream({ subtask_id: 1001 })).resolves.toEqual({ success: true })

    expect(request).toHaveBeenNthCalledWith(1, 'runtime.tasks.guidance', {
      task_id: 0,
      subtask_id: 1001,
      team_id: 0,
      message: 'continue',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'runtime.tasks.cancel', { subtask_id: 1001 })
  })
})
