import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalExecutorEvent } from '@/desktop/localExecutor'
import { createRuntimeChatStream, setRuntimeChatStreamDebugEnabled } from './runtimeChatStream'

describe('createRuntimeChatStream', () => {
  const subscribe = vi.fn()
  const request = vi.fn()

  beforeEach(() => {
    subscribe.mockReset()
    subscribe.mockResolvedValue(vi.fn())
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
    const stream = createRuntimeChatStream({ subscribe, request })

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

  test('coalesces a burst of text deltas before delivering terminal events', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const calls: string[] = []
    const onChatChunk = vi.fn(payload => calls.push(`chunk:${payload.content}`))
    const onChatDone = vi.fn(() => calls.push('done'))
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onChatChunk, onChatDone })
    await Promise.resolve()
    for (let offset = 0; offset < 2200; offset += 1) {
      listener({
        event: 'response.output_text.delta',
        payload: {
          taskId: 'task-1',
          subtaskId: '1001',
          deviceId: 'local-device',
          data: {
            item_id: 'message-1',
            delta: 'x',
            offset,
          },
        },
      })
    }
    listener({
      event: 'response.output_text.done',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: {
          item_id: 'message-1',
          text: 'complete',
        },
      },
    })
    listener({
      event: 'response.completed',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { value: 'complete' },
      },
    })

    expect(onChatChunk).toHaveBeenCalledTimes(3)
    expect(onChatChunk.mock.calls[0]?.[0]).toMatchObject({ content: 'x', offset: 0 })
    expect(onChatChunk.mock.calls[1]?.[0]).toMatchObject({
      content: 'x'.repeat(2199),
      offset: 1,
    })
    expect(onChatChunk.mock.calls[2]?.[0]).toMatchObject({
      content: 'complete',
      contentMode: 'snapshot',
    })
    expect(calls.at(-1)).toBe('done')
  })

  test('coalesces cumulative block content snapshots before terminal events', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const calls: string[] = []
    const onBlockUpdated = vi.fn(payload => calls.push(`block:${payload.content}`))
    const onChatDone = vi.fn(() => calls.push('done'))
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onBlockUpdated, onChatDone })
    await Promise.resolve()
    for (let count = 1; count <= 2200; count += 1) {
      listener({
        event: 'response.block.updated',
        payload: {
          taskId: 'task-1',
          subtaskId: '1001',
          deviceId: 'local-device',
          data: {
            block_id: 'message-1',
            updates: {
              content: 'x'.repeat(count),
              status: 'streaming',
            },
          },
        },
      })
    }
    listener({
      event: 'response.completed',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { value: 'complete' },
      },
    })

    expect(onBlockUpdated).toHaveBeenCalledTimes(2)
    expect(onBlockUpdated.mock.calls[0]?.[0]).toMatchObject({
      blockId: 'message-1',
      content: 'x',
      status: 'streaming',
    })
    expect(onBlockUpdated.mock.calls[1]?.[0]).toMatchObject({
      blockId: 'message-1',
      content: 'x'.repeat(2200),
      status: 'streaming',
    })
    expect(calls.at(-1)).toBe('done')
  })

  test('coalesces block content deltas before terminal events', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const calls: string[] = []
    const onBlockUpdated = vi.fn(payload => calls.push(`block:${payload.contentDelta}`))
    const onChatDone = vi.fn(() => calls.push('done'))
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onBlockUpdated, onChatDone })
    await Promise.resolve()
    for (let count = 0; count < 2200; count += 1) {
      listener({
        event: 'response.block.updated',
        payload: {
          taskId: 'task-1',
          subtaskId: '1001',
          deviceId: 'local-device',
          data: {
            block_id: 'message-1',
            updates: {
              content_delta: 'x',
              status: 'streaming',
            },
          },
        },
      })
    }
    listener({
      event: 'response.completed',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { value: 'complete' },
      },
    })

    expect(onBlockUpdated).toHaveBeenCalledTimes(2)
    expect(onBlockUpdated.mock.calls[0]?.[0]).toMatchObject({
      blockId: 'message-1',
      contentDelta: 'x',
      status: 'streaming',
    })
    expect(onBlockUpdated.mock.calls[1]?.[0]).toMatchObject({
      blockId: 'message-1',
      contentDelta: 'x'.repeat(2199),
      status: 'streaming',
    })
    expect(calls.at(-1)).toBe('done')
  })

  test('delivers project task assignment notifications', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onProjectTaskAssigned = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onProjectTaskAssigned })
    await Promise.resolve()
    listener({
      event: 'project.task.assigned',
      payload: {
        projectId: '91',
        projectName: '运营项目',
        itemId: 'WEG-12',
        itemTitle: '准备周报',
        assignerName: 'Alice',
      },
    })

    expect(onProjectTaskAssigned).toHaveBeenCalledWith({
      projectId: '91',
      projectName: '运营项目',
      itemId: 'WEG-12',
      itemTitle: '准备周报',
      assignerName: 'Alice',
    })
  })

  test('delivers executor lag notifications for lifecycle reconciliation', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onRuntimeEventLagged = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onRuntimeEventLagged })
    await Promise.resolve()
    listener({
      event: 'executor.event_lagged',
      payload: { skipped: 7 },
    })

    expect(onRuntimeEventLagged).toHaveBeenCalledWith({ skipped: 7 })
  })

  test('delivers task-plan events to the global subscription only', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onScopedRuntimePlanUpdated = vi.fn()
    const onGlobalRuntimePlanUpdated = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({
      scope: { deviceId: 'local-device', taskId: 'previous-task' },
      onRuntimePlanUpdated: onScopedRuntimePlanUpdated,
    })
    stream.subscribe({ onRuntimePlanUpdated: onGlobalRuntimePlanUpdated })
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

    expect(onScopedRuntimePlanUpdated).not.toHaveBeenCalled()
    expect(onGlobalRuntimePlanUpdated).toHaveBeenCalledWith({
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
    const stream = createRuntimeChatStream({ subscribe, request })

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
      consoleDebug.mock.calls.some(call => call[0] === '[Wework] Runtime chat stream event')
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
    const stream = createRuntimeChatStream({ subscribe, request })

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
      consoleDebug.mock.calls.some(call => call[0] === '[Wework] Runtime chat stream event')
    ).toBe(false)

    consoleDebug.mockRestore()
  })

  test('logs local stream lifecycle only when stream debug is enabled', async () => {
    subscribe.mockImplementation(async () => vi.fn())
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const stream = createRuntimeChatStream({ subscribe, request })

    const cleanupWithoutDebug = stream.subscribe({ onChatChunk: vi.fn() })
    cleanupWithoutDebug()
    expect(consoleDebug).not.toHaveBeenCalledWith(
      '[Wework] Runtime chat stream subscription',
      expect.anything()
    )

    setRuntimeChatStreamDebugEnabled(true)
    const cleanupWithDebug = stream.subscribe({ onChatChunk: vi.fn() })
    cleanupWithDebug()

    expect(consoleDebug).toHaveBeenCalledWith(
      '[Wework] Runtime chat stream subscription',
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
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const stream = createRuntimeChatStream({ subscribe, request })

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
    expect(consoleInfo).toHaveBeenCalledWith(
      '[Wework] Runtime chat stream terminal event received',
      expect.objectContaining({
        event: 'response.completed',
        taskId: 'task-1',
        matchedSubscriptionCount: 1,
      })
    )
    consoleInfo.mockRestore()
  })

  test('opens the local executor listener before a task pane subscribes', () => {
    const stream = createRuntimeChatStream({ subscribe, request })
    const cleanup = stream.subscribe({ onDeviceStatus: vi.fn() })

    expect(subscribe).toHaveBeenCalledTimes(1)

    cleanup()
    expect(subscribe).toHaveBeenCalledTimes(1)
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
    const stream = createRuntimeChatStream({ subscribe, request })

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
    expect(unlisten).not.toHaveBeenCalled()
  })

  test('routes scoped events only to matching stream subscribers', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const firstChunk = vi.fn()
    const secondChunk = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })

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

  test('keeps a late native listener active when no pane is subscribed', async () => {
    let resolveSubscribe!: (unlisten: () => void) => void
    const unlisten = vi.fn()
    subscribe.mockImplementation(
      () =>
        new Promise<() => void>(resolve => {
          resolveSubscribe = resolve
        })
    )
    const stream = createRuntimeChatStream({ subscribe, request })

    const cleanup = stream.subscribe({ onChatChunk: vi.fn() })
    cleanup()
    resolveSubscribe(unlisten)
    await Promise.resolve()

    expect(unlisten).not.toHaveBeenCalled()
  })

  test('routes guidance and cancel requests through app ipc', async () => {
    request.mockResolvedValueOnce({ success: true, guidance_id: 'guide-1' })
    request.mockResolvedValueOnce({ success: true })
    const stream = createRuntimeChatStream({ subscribe, request })

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
