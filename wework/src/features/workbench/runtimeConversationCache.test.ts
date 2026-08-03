import { afterEach, describe, expect, test } from 'vitest'
import {
  appendOptimisticRuntimeConversationGuidance,
  applyRuntimeConversationGoalContinuation,
  applyRuntimeConversationSubagentActivity,
  applyRuntimeConversationAction,
  cacheConversationScrollSnapshot,
  cacheConversationVirtualMeasurements,
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
  evictRuntimeConversation,
  getConversationScrollSnapshot,
  getConversationVirtualMeasurements,
  getRuntimeConversationCacheStats,
  getRuntimeConversationMetadata,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationQueuePaused,
  markRuntimeConversationGuidanceInterrupted,
  optimisticallyInterruptRuntimeConversation,
  removeOptimisticRuntimeConversationGuidance,
  markRuntimeConversationAssistantStarted,
  runtimeConversationSnapshotSettlesLatestTurn,
  settleRuntimeConversationGuidance,
  settleRuntimeConversationSubagents,
  setRuntimeConversationGoal,
  setRuntimeConversationTaskPlan,
  takeAppliedRuntimeConversationGuidance,
  takeInterruptedRuntimeConversationGuidance,
  restoreOptimisticallyInterruptedRuntimeConversation,
} from './runtimeConversationCache'

const address = {
  deviceId: 'device-1',
  taskId: 'task-1',
  workspacePath: '/workspace/one',
}

describe('runtimeConversationCache', () => {
  afterEach(clearRuntimeConversationCacheForTests)

  test('keeps transcript data independently from a mounted pane', () => {
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    })

    expect(getRuntimeConversationMessages(address)).toHaveLength(1)
  })

  test('keeps goal, plan, and subagent state independently from a mounted pane', () => {
    setRuntimeConversationGoal(address, {
      threadId: 'thread-1',
      objective: 'Finish the fix',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    setRuntimeConversationTaskPlan(address, {
      deviceId: address.deviceId,
      taskId: address.taskId,
      turnId: 'turn-1',
      plan: [{ step: 'Implement', status: 'inProgress' }],
    })
    applyRuntimeConversationSubagentActivity(address, {
      deviceId: address.deviceId,
      taskId: address.taskId,
      agentId: 'agent-1',
      agentPath: 'agents/agent-1',
      status: 'running',
    })
    markRuntimeConversationAssistantStarted(address)
    applyRuntimeConversationGoalContinuation(address, {
      deviceId: address.deviceId,
      taskId: address.taskId,
      turnId: 'turn-1',
      status: 'started',
    })

    expect(getRuntimeConversationMetadata(address)).toMatchObject({
      goal: { objective: 'Finish the fix', status: 'active' },
      goalContinuation: { turnId: 'turn-1', status: 'started' },
      taskPlan: {
        turnId: 'turn-1',
        plan: [{ step: 'Implement', status: 'inProgress' }],
      },
      subagentStatuses: [
        {
          id: 'agent-1',
          agentPath: 'agents/agent-1',
          status: 'running',
        },
      ],
    })

    settleRuntimeConversationSubagents(address)

    expect(getRuntimeConversationMetadata(address).subagentStatuses[0]?.status).toBe('done')
  })

  test('uses device and task identity across normalized workspace paths', () => {
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'user-1',
        role: 'user',
        content: 'stable identity',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    })

    expect(
      getRuntimeConversationMessages({
        ...address,
        workspacePath: '/workspace/normalized-path',
      })
    ).toHaveLength(1)
  })

  test('reports and evicts canonical conversation entries', () => {
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'user-1',
        role: 'user',
        content: 'retained until archive',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    })

    expect(getRuntimeConversationCacheStats().messageEntries).toBe(1)

    evictRuntimeConversation(address)

    expect(getRuntimeConversationCacheStats().messageEntries).toBe(0)
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
      itemId: 'assistant-item-1',
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

  test('settles an optimistic turn only by its exact client user message id', () => {
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'client-user-2',
        role: 'user',
        content: 'same content',
        status: 'done',
        createdAt: '2026-07-30T00:00:00.000Z',
      },
    })

    expect(
      runtimeConversationSnapshotSettlesLatestTurn(address, [
        {
          id: 'turn-1',
          clientUserMessageId: 'client-user-1',
          items: [],
          status: 'done',
        },
      ])
    ).toBe(false)
    expect(
      runtimeConversationSnapshotSettlesLatestTurn(address, [
        {
          id: 'turn-2',
          clientUserMessageId: 'client-user-2',
          items: [],
          status: 'done',
        },
      ])
    ).toBe(true)
  })

  test('settles a bound turn only when the same real turn id is complete', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'turn-2',
    })

    expect(
      runtimeConversationSnapshotSettlesLatestTurn(address, [
        { id: 'turn-1', items: [], status: 'done' },
      ])
    ).toBe(false)
    expect(
      runtimeConversationSnapshotSettlesLatestTurn(address, [
        { id: 'turn-2', items: [], status: 'streaming' },
      ])
    ).toBe(false)
    expect(
      runtimeConversationSnapshotSettlesLatestTurn(address, [
        { id: 'turn-2', items: [], status: 'done' },
      ])
    ).toBe(true)
  })

  test('settles background guidance into the conversation cache until transcript refresh', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'subtask-1',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      itemId: 'assistant-item-1',
      content: 'working',
    })
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
      subtaskId: 'subtask-1',
      guidanceId: 'runtime-guidance-1',
      clientGuidanceId: 'client-guidance-1',
      message: 'follow the updated direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
    })

    expect(settled?.id).toBe('client-guidance-1')
    expect(getRuntimeConversationQueuedMessages(address)).toEqual([])
    expect(getRuntimeConversationMessages(address)).toMatchObject([
      {
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
        role: 'assistant',
        content: '',
        status: 'streaming',
        subtaskId: 'subtask-1',
        runtimeGuidanceContinuation: true,
      },
    ])

    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      itemId: 'assistant-item-2',
      content: ' after guidance',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'subtask-1',
    })

    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      'working',
      'follow the updated direction',
      ' after guidance',
    ])
  })

  test('places executor-originated guidance at its applied position without a frontend queue item', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'subtask-1',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      itemId: 'assistant-item-1',
      content: 'working',
    })

    const settled = settleRuntimeConversationGuidance(address, {
      taskId: address.taskId,
      deviceId: address.deviceId,
      subtaskId: 'subtask-1',
      guidanceId: 'runtime-guidance-1',
      clientGuidanceId: 'supervisor-correction-1',
      message: 'Return to the required language.',
      appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
    })

    expect(settled?.id).toBe('supervisor-correction-1')
    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      'working',
      'Return to the required language.',
      '',
    ])
  })

  test('settles an optimistic guidance message into the active turn without duplicating its id', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'subtask-1',
    })
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'client-guidance-1',
        role: 'user',
        content: 'follow the updated direction',
        status: 'done',
        createdAt: '2026-07-27T00:00:01.000Z',
      },
    })
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
      subtaskId: 'subtask-1',
      guidanceId: 'runtime-guidance-1',
      clientGuidanceId: 'client-guidance-1',
      message: 'follow the updated direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
    })

    const guidanceMessages = getRuntimeConversationMessages(address).filter(
      message => message.id === 'client-guidance-1'
    )
    expect(guidanceMessages).toHaveLength(1)
    expect(guidanceMessages[0]).toMatchObject({
      runtimeGuidance: true,
      subtaskId: 'subtask-1',
      turnId: 'subtask-1',
    })
  })

  test('inserts guidance optimistically and rebinds it to the accepted turn', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'turn-stale',
    })
    const guidance = {
      id: 'client-guidance-rebound',
      content: 'Use the safer approach',
      status: 'sending' as const,
      deliveryMode: 'guidance' as const,
      createdAt: '2026-08-02T12:00:00.000Z',
    }

    appendOptimisticRuntimeConversationGuidance(address, 'turn-stale', guidance)
    expect(
      getRuntimeConversationMessages(address).find(
        message => message.id === 'client-guidance-rebound'
      )
    ).toMatchObject({
      status: 'pending',
      runtimeGuidance: true,
      turnId: 'turn-stale',
    })

    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'turn-actual',
    })
    appendOptimisticRuntimeConversationGuidance(address, 'turn-actual', guidance)

    const rebound = getRuntimeConversationMessages(address).filter(
      message => message.id === 'client-guidance-rebound'
    )
    expect(rebound).toHaveLength(1)
    expect(rebound[0]).toMatchObject({
      status: 'pending',
      runtimeGuidance: true,
      turnId: 'turn-actual',
    })
    expect(
      getRuntimeConversationMessages(address)
        .flatMap(message => message.blocks ?? [])
        .find(block => block.toolName === 'conversation_guidance')
    ).toMatchObject({
      status: 'streaming',
    })

    removeOptimisticRuntimeConversationGuidance(address, guidance.id)
    expect(
      getRuntimeConversationMessages(address).some(message => message.id === guidance.id)
    ).toBe(false)
  })

  test('optimistically interrupts the active turn and can restore it after rejection', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'turn-running',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      taskId: address.taskId,
      subtaskId: 'turn-running',
      itemId: 'assistant-1',
      content: 'Working',
    })

    const interruption = optimisticallyInterruptRuntimeConversation(address)
    expect(interruption).toMatchObject({
      turnId: 'turn-running',
      status: 'streaming',
    })
    expect(getRuntimeConversationMessages(address).at(-1)).toMatchObject({
      runtimeStatus: 'cancelled',
      stoppedNotice: true,
    })

    restoreOptimisticallyInterruptedRuntimeConversation(address, interruption!)
    expect(getRuntimeConversationMessages(address).at(-1)).toMatchObject({
      runtimeStatus: 'streaming',
    })
  })

  test('preserves multiple guidance messages applied during one assistant turn', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'subtask-1',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      itemId: 'assistant-item-1',
      content: 'working',
    })
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
      subtaskId: 'subtask-1',
      guidanceId: 'client-guidance-1',
      clientGuidanceId: 'client-guidance-1',
      message: 'first direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      itemId: 'assistant-item-2',
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
      subtaskId: 'subtask-1',
      guidanceId: 'client-guidance-2',
      clientGuidanceId: 'client-guidance-2',
      message: 'second direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:04.000Z'),
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      itemId: 'assistant-item-3',
      content: ' after second',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'subtask-1',
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
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'subtask-1',
    })
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
        subtaskId: 'subtask-1',
        guidanceId: 'client-guidance-1',
        clientGuidanceId: 'client-guidance-1',
        message: 'follow the updated direction',
        appliedAtMs: Number.NaN,
      })
    ).not.toThrow()

    const [guidanceMessage] = getRuntimeConversationMessages(address)
    expect(guidanceMessage?.runtimeGuidance).toBe(true)
    expect(Number.isFinite(Date.parse(guidanceMessage?.createdAt ?? ''))).toBe(true)
  })

  test('keeps a canonical guided turn warm under cache pressure', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'subtask-1',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      itemId: 'assistant-item-1',
      content: 'working',
    })
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
      subtaskId: 'subtask-1',
      guidanceId: 'runtime-guidance-1',
      clientGuidanceId: 'client-guidance-1',
      message: 'follow the updated direction',
      appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
    })

    for (let index = 0; index < 50; index += 1) {
      const otherAddress = { ...address, taskId: `other-task-${index}` }
      applyRuntimeConversationAction(otherAddress, {
        type: 'assistant_started',
        taskId: otherAddress.taskId,
        subtaskId: `other-subtask-${index}`,
      })
      applyRuntimeConversationAction(otherAddress, {
        type: 'assistant_chunk',
        subtaskId: `other-subtask-${index}`,
        itemId: `other-assistant-${index}`,
        content: 'other output',
      })
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
        clientGuidanceId: `other-guidance-${index}`,
        message: 'other guidance',
        appliedAtMs: Date.parse('2026-07-27T00:00:02.000Z'),
      })
      applyRuntimeConversationAction(address, {
        type: 'assistant_chunk',
        subtaskId: 'subtask-1',
        itemId: 'assistant-item-2',
        content: ` update ${index}`,
      })
    }

    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'subtask-1',
    })

    const messages = getRuntimeConversationMessages(address)
    expect(messages.slice(0, 2).map(message => message.content)).toEqual([
      'working',
      'follow the updated direction',
    ])
    expect(messages[2].content).toContain(' update 0')
    expect(messages[2].content).toContain(' update 49')
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
      clientGuidanceId: 'client-guidance-1',
      message: 'follow the updated direction',
      appliedAtMs: Date.now(),
    }

    expect(takeAppliedRuntimeConversationGuidance(address, payload)).not.toBeNull()
    expect(takeAppliedRuntimeConversationGuidance(address, payload)).toBeNull()
    expect(getRuntimeConversationMessages(address)).toEqual([])
  })

  test('bounds cached transcripts when many conversations are opened', () => {
    for (let index = 0; index <= 50; index += 1) {
      applyRuntimeConversationAction(
        { ...address, taskId: `task-${index}` },
        {
          type: 'user_added',
          message: {
            id: `user-${index}`,
            role: 'user',
            content: `message ${index}`,
            status: 'done',
            createdAt: '2026-07-24T00:00:00.000Z',
          },
        }
      )
    }

    expect(getRuntimeConversationMessages({ ...address, taskId: 'task-0' })).toEqual([])
    expect(getRuntimeConversationMessages({ ...address, taskId: 'task-50' })).toHaveLength(1)
  })

  test('evicts transcript and view state immediately when a task is archived', () => {
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'user-1',
        role: 'user',
        content: 'archived content',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    })
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
    markRuntimeConversationGuidanceInterrupted(address, ['client-guidance-1'])

    evictRuntimeConversation(address)

    expect(getRuntimeConversationMessages(address)).toEqual([])
    expect(getRuntimeConversationQueuedMessages(address)).toEqual([])
    expect(getRuntimeConversationQueuePaused(address)).toBe(false)
    expect(getConversationScrollSnapshot('device-1:task-1')).toBeUndefined()
    expect(getConversationVirtualMeasurements('device-1:task-1')).toBeUndefined()
    expect(takeInterruptedRuntimeConversationGuidance(address, 'client-guidance-1')).toBe(false)
  })
})
