import { afterEach, describe, expect, test } from 'vitest'
import {
  applyRuntimeConversationAction,
  cacheConversationScrollSnapshot,
  cacheConversationVirtualMeasurements,
  cacheRuntimeConversationMessages,
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
  dispatchRuntimeConversationQueueEvent,
  evictRuntimeConversation,
  getConversationScrollSnapshot,
  getConversationVirtualMeasurements,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationQueuePaused,
  settleRuntimeConversationGuidance,
  takeAppliedRuntimeConversationGuidance,
} from './runtimeConversationCache'
import { transformRuntimePaneActionForGuidanceSplits } from './runtimeGuidanceMessages'

const address = {
  deviceId: 'device-1',
  taskId: 'task-1',
  workspacePath: '/workspace/one',
}

describe('runtimeConversationCache', () => {
  afterEach(clearRuntimeConversationCacheForTests)

  test('keeps transcript data independently from a mounted pane', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ])

    expect(getRuntimeConversationMessages(address)).toHaveLength(1)
  })

  test('uses device and task identity across normalized workspace paths', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'user-1',
        role: 'user',
        content: 'stable identity',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ])

    expect(
      getRuntimeConversationMessages({
        ...address,
        workspacePath: '/workspace/normalized-path',
      })
    ).toHaveLength(1)
  })

  test('continues reducing assistant stream events while the pane is unmounted', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: 'task-1',
      subtaskId: 'subtask-1',
      shellType: 'Codex',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      content: 'background output',
    })

    expect(getRuntimeConversationMessages(address)).toMatchObject([
      {
        role: 'assistant',
        content: 'background output',
        status: 'streaming',
      },
    ])
  })

  test('settles applied guidance while the pane is unmounted', () => {
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'guidance-1',
        content: 'follow the updated direction',
        status: 'sending',
        deliveryMode: 'guidance',
        notice: '正在引导当前对话',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
      {
        id: 'queued-2',
        content: 'send this next',
        status: 'queued',
        createdAt: '2026-07-27T00:00:01.000Z',
      },
    ])

    dispatchRuntimeConversationQueueEvent(address, {
      type: 'guidance_applied',
      payload: {
        taskId: address.taskId,
        deviceId: address.deviceId,
        guidanceId: 'guidance-1',
        message: 'follow the updated direction',
        appliedAtMs: Date.now(),
      },
    })

    expect(getRuntimeConversationQueuedMessages(address)).toMatchObject([
      {
        id: 'queued-2',
        status: 'queued',
      },
    ])
  })

  test('matches an applied guidance by content when the runtime replaces its id', () => {
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'client-guidance-1',
        content: 'follow the updated direction',
        status: 'sending',
        deliveryMode: 'guidance',
        notice: '正在引导当前对话',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ])

    dispatchRuntimeConversationQueueEvent(address, {
      type: 'guidance_applied',
      payload: {
        taskId: address.taskId,
        deviceId: address.deviceId,
        guidanceId: 'runtime-guidance-1',
        message: 'follow the updated direction',
        appliedAtMs: Date.now(),
      },
    })

    expect(getRuntimeConversationQueuedMessages(address)).toEqual([])
  })

  test('settles background guidance into the conversation cache until transcript refresh', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'working',
        status: 'streaming',
        subtaskId: 'subtask-1',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ])
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'client-guidance-1',
        content: 'follow the updated direction',
        status: 'sending',
        deliveryMode: 'guidance',
        createdAt: '2026-07-27T00:00:01.000Z',
      },
    ])

    const settled = settleRuntimeConversationGuidance(address, {
      taskId: address.taskId,
      deviceId: address.deviceId,
      guidanceId: 'runtime-guidance-1',
      message: 'follow the updated direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
    })

    expect(settled?.id).toBe('client-guidance-1')
    expect(getRuntimeConversationQueuedMessages(address)).toEqual([])
    expect(getRuntimeConversationMessages(address)).toMatchObject([
      {
        id: 'assistant-1-before-guidance-client-guidance-1',
        role: 'assistant',
        content: 'working',
        status: 'done',
        runtimeGuidanceSplitBefore: true,
      },
      {
        id: 'client-guidance-1',
        role: 'user',
        content: 'follow the updated direction',
        status: 'done',
        createdAt: '2026-07-27T00:00:02.000Z',
        runtimeGuidance: true,
      },
      {
        id: 'assistant-1-after-guidance-client-guidance-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        subtaskId: 'subtask-1',
        runtimeGuidanceContinuation: true,
      },
    ])

    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'subtask-1',
      content: 'working after guidance',
    })

    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      'working',
      'follow the updated direction',
      ' after guidance',
    ])
  })

  test('keeps guidance action transforms repeatable across foreground and background listeners', () => {
    const boundaries = new Map([['subtask-1', { prefix: 'working' }]])
    const action = {
      type: 'assistant_done' as const,
      subtaskId: 'subtask-1',
      content: 'working after guidance',
    }

    expect(transformRuntimePaneActionForGuidanceSplits(action, boundaries)).toMatchObject({
      content: ' after guidance',
    })
    expect(transformRuntimePaneActionForGuidanceSplits(action, boundaries)).toMatchObject({
      content: ' after guidance',
    })
    expect(boundaries.get('subtask-1')).toEqual({ prefix: 'working' })
  })

  test('preserves multiple guidance messages applied during one assistant turn', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'working',
        status: 'streaming',
        subtaskId: 'subtask-1',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ])
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'client-guidance-1',
        content: 'first direction',
        status: 'sending',
        deliveryMode: 'guidance',
        createdAt: '2026-07-27T00:00:01.000Z',
      },
    ])
    settleRuntimeConversationGuidance(address, {
      taskId: address.taskId,
      deviceId: address.deviceId,
      guidanceId: 'client-guidance-1',
      message: 'first direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      content: ' after first',
    })

    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'client-guidance-2',
        content: 'second direction',
        status: 'sending',
        deliveryMode: 'guidance',
        createdAt: '2026-07-27T00:00:03.000Z',
      },
    ])
    settleRuntimeConversationGuidance(address, {
      taskId: address.taskId,
      deviceId: address.deviceId,
      guidanceId: 'client-guidance-2',
      message: 'second direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:04.000Z'),
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'subtask-1',
      content: 'working after first after second',
    })

    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      'working',
      'first direction',
      ' after first',
      'second direction',
      ' after second',
    ])
  })

  test('uses a valid timestamp when the runtime guidance timestamp is non-finite', () => {
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'client-guidance-1',
        content: 'follow the updated direction',
        status: 'sending',
        deliveryMode: 'guidance',
        createdAt: '2026-07-27T00:00:01.000Z',
      },
    ])

    expect(() =>
      settleRuntimeConversationGuidance(address, {
        taskId: address.taskId,
        deviceId: address.deviceId,
        guidanceId: 'client-guidance-1',
        message: 'follow the updated direction',
        appliedAtMs: Number.NaN,
      })
    ).not.toThrow()

    const [guidanceMessage] = getRuntimeConversationMessages(address)
    expect(guidanceMessage?.runtimeGuidance).toBe(true)
    expect(Number.isFinite(Date.parse(guidanceMessage?.createdAt ?? ''))).toBe(true)
  })

  test('keeps guidance split boundaries warm with their streaming conversation', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'working',
        status: 'streaming',
        subtaskId: 'subtask-1',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ])
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'client-guidance-1',
        content: 'follow the updated direction',
        status: 'sending',
        deliveryMode: 'guidance',
        createdAt: '2026-07-27T00:00:01.000Z',
      },
    ])
    settleRuntimeConversationGuidance(address, {
      taskId: address.taskId,
      deviceId: address.deviceId,
      guidanceId: 'runtime-guidance-1',
      message: 'follow the updated direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
    })

    for (let index = 0; index < 50; index += 1) {
      const otherAddress = { ...address, taskId: `other-task-${index}` }
      cacheRuntimeConversationMessages(otherAddress, [
        {
          id: `other-assistant-${index}`,
          role: 'assistant',
          content: 'other output',
          status: 'streaming',
          subtaskId: `other-subtask-${index}`,
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ])
      cacheRuntimeConversationQueuedMessages(otherAddress, [
        {
          id: `other-guidance-${index}`,
          content: 'other guidance',
          status: 'sending',
          deliveryMode: 'guidance',
          createdAt: '2026-07-27T00:00:01.000Z',
        },
      ])
      settleRuntimeConversationGuidance(otherAddress, {
        taskId: otherAddress.taskId,
        deviceId: otherAddress.deviceId,
        guidanceId: `other-guidance-${index}`,
        message: 'other guidance',
        appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
      })
      applyRuntimeConversationAction(address, {
        type: 'assistant_chunk',
        subtaskId: 'subtask-1',
        content: ` update ${index}`,
      })
    }

    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'subtask-1',
      content: 'working after guidance',
    })

    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      'working',
      'follow the updated direction',
      ' after guidance',
    ])
  })

  test('returns an applied guidance to only one subscriber', () => {
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'client-guidance-1',
        content: 'follow the updated direction',
        status: 'sending',
        deliveryMode: 'guidance',
        createdAt: '2026-07-27T00:00:01.000Z',
      },
    ])
    const payload = {
      taskId: address.taskId,
      deviceId: address.deviceId,
      guidanceId: 'client-guidance-1',
      message: 'follow the updated direction',
      appliedAtMs: Date.now(),
    }

    expect(takeAppliedRuntimeConversationGuidance(address, payload)).not.toBeNull()
    expect(takeAppliedRuntimeConversationGuidance(address, payload)).toBeNull()
    expect(getRuntimeConversationMessages(address)).toEqual([])
  })

  test('bounds cached transcripts when many conversations are opened', () => {
    for (let index = 0; index <= 50; index += 1) {
      cacheRuntimeConversationMessages({ ...address, taskId: `task-${index}` }, [
        {
          id: `user-${index}`,
          role: 'user',
          content: `message ${index}`,
          status: 'done',
          createdAt: '2026-07-24T00:00:00.000Z',
        },
      ])
    }

    expect(getRuntimeConversationMessages({ ...address, taskId: 'task-0' })).toEqual([])
    expect(getRuntimeConversationMessages({ ...address, taskId: 'task-50' })).toHaveLength(1)
  })

  test('evicts transcript and view state immediately when a task is archived', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'user-1',
        role: 'user',
        content: 'archived content',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ])
    cacheConversationScrollSnapshot('device-1:task-1', {
      distanceFromBottomPx: 240,
      pinnedToBottom: false,
    })
    cacheConversationVirtualMeasurements('device-1:task-1', [
      { index: 0, key: 'user-1', start: 0, end: 120, size: 120, lane: 0 },
    ])
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'queued-1',
        content: 'follow up',
        status: 'queued',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ])
    cacheRuntimeConversationQueuePaused(address, true)

    evictRuntimeConversation(address)

    expect(getRuntimeConversationMessages(address)).toEqual([])
    expect(getRuntimeConversationQueuedMessages(address)).toEqual([])
    expect(getRuntimeConversationQueuePaused(address)).toBe(false)
    expect(getConversationScrollSnapshot('device-1:task-1')).toBeUndefined()
    expect(getConversationVirtualMeasurements('device-1:task-1')).toBeUndefined()
  })
})
