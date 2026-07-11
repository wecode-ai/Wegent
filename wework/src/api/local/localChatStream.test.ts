import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'
import { createLocalChatStream, setLocalChatStreamDebugEnabled } from './localChatStream'

describe('createLocalChatStream', () => {
  const subscribe = vi.fn()
  const request = vi.fn()

  beforeEach(() => {
    subscribe.mockReset()
    request.mockReset()
    localStorage.clear()
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

  test('forwards task-plan events outside a subscription scope for task-level caching', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onRuntimePlanUpdated = vi.fn()
    const stream = createLocalChatStream({ subscribe, request })

    stream.subscribe({
      scope: { deviceId: 'local-device', taskId: 'previous-task' },
      onRuntimePlanUpdated,
    })
    await Promise.resolve()
    listener({
      event: 'runtime.plan.updated',
      payload: {
        taskId: 'new-task',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: {
          plan: [{ step: 'Inspect', status: 'inProgress' }],
        },
      },
    })

    expect(onRuntimePlanUpdated).toHaveBeenCalledWith({
      taskId: 'new-task',
      subtaskId: '1001',
      deviceId: 'local-device',
      threadId: undefined,
      turnId: undefined,
      explanation: undefined,
      plan: [{ step: 'Inspect', status: 'inProgress' }],
    })
  })

  test('does not log every text delta event', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const stream = createLocalChatStream({ subscribe, request })

    stream.subscribe({ onChatChunk: vi.fn() })
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

    expect(
      consoleDebug.mock.calls.some(call => call[0] === '[Wework] Local chat stream event')
    ).toBe(false)

    consoleDebug.mockRestore()
  })

  test('does not log every block update event', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const stream = createLocalChatStream({ subscribe, request })

    stream.subscribe({ onBlockUpdated: vi.fn() })
    await Promise.resolve()
    listener({
      event: 'response.block.updated',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { block: { id: 'block-1', type: 'tool', status: 'running' } },
      },
    })

    expect(
      consoleDebug.mock.calls.some(call => call[0] === '[Wework] Local chat stream event')
    ).toBe(false)

    consoleDebug.mockRestore()
  })

  test('logs local stream lifecycle only when stream debug is enabled', async () => {
    subscribe.mockImplementation(async () => vi.fn())
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const stream = createLocalChatStream({ subscribe, request })

    const cleanupWithoutDebug = stream.subscribe({ onChatChunk: vi.fn() })
    cleanupWithoutDebug()
    expect(consoleDebug).not.toHaveBeenCalledWith(
      '[Wework] Local chat stream subscription',
      expect.anything()
    )

    setLocalChatStreamDebugEnabled(true)
    const cleanupWithDebug = stream.subscribe({ onChatChunk: vi.fn() })
    cleanupWithDebug()

    expect(consoleDebug).toHaveBeenCalledWith(
      '[Wework] Local chat stream subscription',
      expect.objectContaining({ action: 'subscribed' })
    )

    consoleDebug.mockRestore()
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

  test('does not open a local executor listener for device-only subscriptions', () => {
    const stream = createLocalChatStream({ subscribe, request })
    const cleanup = stream.subscribe({ onDeviceStatus: vi.fn() })

    expect(subscribe).not.toHaveBeenCalled()

    cleanup()
    expect(subscribe).not.toHaveBeenCalled()
  })

  test('shares one native event listener across multiple stream subscribers', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    const unlisten = vi.fn()
    subscribe.mockImplementation(async handler => {
      listener = handler
      return unlisten
    })
    const firstChunk = vi.fn()
    const secondChunk = vi.fn()
    const stream = createLocalChatStream({ subscribe, request })

    const cleanupFirst = stream.subscribe({ onChatChunk: firstChunk })
    const cleanupSecond = stream.subscribe({ onChatChunk: secondChunk })
    await Promise.resolve()

    expect(subscribe).toHaveBeenCalledTimes(1)
    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { delta: 'hello', offset: 0 },
      },
    })

    expect(firstChunk).toHaveBeenCalledTimes(1)
    expect(secondChunk).toHaveBeenCalledTimes(1)

    cleanupFirst()
    expect(unlisten).not.toHaveBeenCalled()
    cleanupSecond()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  test('routes scoped events only to matching stream subscribers', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const firstChunk = vi.fn()
    const secondChunk = vi.fn()
    const stream = createLocalChatStream({ subscribe, request })

    stream.subscribe({
      scope: { deviceId: 'local-device', taskId: 'task-1' },
      onChatChunk: firstChunk,
    })
    stream.subscribe({
      scope: { deviceId: 'local-device', taskId: 'task-2' },
      onChatChunk: secondChunk,
    })
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

    expect(firstChunk).toHaveBeenCalledTimes(1)
    expect(secondChunk).not.toHaveBeenCalled()
  })

  test('cleans up a late native listener when all subscribers release before it is ready', async () => {
    let resolveSubscribe!: (unlisten: () => void) => void
    const unlisten = vi.fn()
    subscribe.mockImplementation(
      () =>
        new Promise<() => void>(resolve => {
          resolveSubscribe = resolve
        })
    )
    const stream = createLocalChatStream({ subscribe, request })

    const cleanup = stream.subscribe({ onChatChunk: vi.fn() })
    cleanup()
    resolveSubscribe(unlisten)
    await Promise.resolve()

    expect(unlisten).toHaveBeenCalledTimes(1)
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
