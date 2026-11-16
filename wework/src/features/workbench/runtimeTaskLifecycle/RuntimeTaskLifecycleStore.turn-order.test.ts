// @vitest-environment node

import { expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

test('a delayed list snapshot cannot revive an earlier turn after a follow-up completes', () => {
  const store = new RuntimeTaskLifecycleStore('delayed-follow-up-snapshot')
  const address = { deviceId: 'device-1', taskId: 'task-1' }
  const task: RuntimeTaskSummary = {
    taskId: address.taskId,
    title: 'Plugin authorization',
    workspacePath: '/repo',
    runtime: 'codex',
    continuable: true,
    running: false,
    status: 'done',
    completedAt: 1793117763000,
    updatedAt: 1793117763014,
    runtimeHandle: { lastTurnId: 'turn-1' },
  }
  store.syncRuntimeTask(address, task)
  store.turnStarted(address, 'turn-1')
  store.turnSettled(address, 'turn-1', 'succeeded')
  store.sendRequested(address)
  store.sendAccepted(address)
  store.turnStarted(address, 'turn-2')
  store.turnSettled(address, 'turn-2', 'succeeded')
  store.syncRuntimeTranscriptSnapshot(address, {
    running: false,
    turns: [{ id: 'turn-2', status: 'completed', completedAt: 1793117765000 }],
  })
  store.syncRuntimeTask(address, {
    ...task,
    running: true,
    status: 'running',
    turnStatus: 'inProgress',
    completedAt: null,
    updatedAt: 1793117765722,
  })

  expect(store.getTask(address)?.derived.isBusy).toBe(false)
  expect(store.getTask(address)?.turn.latestId).toBe('turn-2')

  store.syncRuntimeTask(address, {
    ...task,
    running: true,
    status: 'running',
    completedAt: null,
    goalStatus: 'active',
    goalExecutionStatus: 'running',
    updatedAt: 1793117766000,
  })
  expect(store.getTask(address)?.derived.isRunning).toBe(true)
})

test('an earlier completion cannot settle a later live turn while task metadata catches up', () => {
  const store = new RuntimeTaskLifecycleStore('delayed-prior-completion')
  const address = { deviceId: 'device-1', taskId: 'task-1' }
  const task: RuntimeTaskSummary = {
    taskId: address.taskId,
    title: 'Task',
    workspacePath: '/repo',
    runtime: 'codex',
    continuable: true,
    running: true,
    status: 'running',
    updatedAt: 1793117765722,
    runtimeHandle: { lastTurnId: 'turn-1' },
  }
  store.syncRuntimeTask(address, task)
  store.turnStarted(address, 'turn-1')
  store.turnSettled(address, 'turn-1', 'succeeded')
  store.turnStarted(address, 'turn-2')
  store.syncRuntimeTask(address, {
    ...task,
    running: false,
    status: 'done',
    completedAt: 1793117763000,
  })

  expect(store.getTask(address)?.turn.id).toBe('turn-2')
  expect(store.getTask(address)?.derived.isRunning).toBe(true)
})

test('stale streaming history cannot replace the known turn after a reload', () => {
  const store = new RuntimeTaskLifecycleStore('reloaded-goal-turn')
  const address = { deviceId: 'device-1', taskId: 'task-1' }
  store.syncRuntimeTask(address, {
    taskId: address.taskId,
    title: 'Goal',
    workspacePath: '/repo',
    runtime: 'codex',
    running: true,
    status: 'running',
    goalStatus: 'active',
    runtimeHandle: { lastTurnId: 'real-turn' },
  })
  store.syncTranscript(address, {
    messages: [],
    running: false,
    turns: [{ id: 'stale-turn', items: [], status: 'streaming' }],
  })
  store.goalStatusReceived(address, 'complete')
  store.turnSettled(address, 'real-turn', 'succeeded')

  expect(store.getTask(address)?.turn.latestId).toBe('real-turn')
  expect(store.getTask(address)?.derived.isBusy).toBe(false)
})

test.each(['streaming', 'failed', 'removed'] as const)(
  'a completed follow-up stays sendable when an earlier recovered turn is %s',
  historicalStatus => {
    const store = new RuntimeTaskLifecycleStore(`recovered-history-${historicalStatus}`)
    const address = { deviceId: 'device-1', taskId: 'task-1' }
    store.syncRuntimeTask(address, {
      taskId: address.taskId,
      title: 'Recovered Goal follow-up',
      workspacePath: '/repo',
      runtime: 'codex',
      continuable: true,
      running: true,
      status: 'running',
      runtimeHandle: { lastTurnId: 'follow-up-turn' },
    })
    store.turnStarted(address, 'follow-up-turn')
    const completedTurn = {
      id: 'follow-up-turn',
      items: [],
      status: 'done',
      completedAt: 3000,
    }
    store.syncTranscript(address, {
      messages: [],
      running: true,
      turns: [{ id: 'pre-restart-turn', items: [], status: 'streaming' }, completedTurn],
    })

    expect(store.getTask(address)?.turn.id).toBe('follow-up-turn')
    store.turnSettled(address, 'follow-up-turn', 'succeeded')
    const historicalTurns: RuntimePaneTranscript['turns'] =
      historicalStatus === 'removed'
        ? []
        : [{ id: 'pre-restart-turn', items: [], status: historicalStatus }]
    store.syncTranscript(address, {
      messages: [],
      running: false,
      turns: [...historicalTurns, completedTurn],
    })

    expect(store.getTask(address)?.turn.latestId).toBe('follow-up-turn')
    expect(store.getTask(address)?.turn.outcome).toBe('succeeded')
    expect(store.getTask(address)?.derived.isBusy).toBe(false)
    expect(store.getTask(address)?.derived.canSend).toBe(true)
  }
)

test('cold history does not restore an earlier streaming turn before the latest completed turn', () => {
  const store = new RuntimeTaskLifecycleStore('cold-completed-follow-up-history')
  const address = { deviceId: 'device-1', taskId: 'task-1' }
  store.syncRuntimeTask(address, {
    taskId: address.taskId,
    title: 'Recovered conversation',
    workspacePath: '/repo',
    runtime: 'codex',
    continuable: true,
    running: true,
    status: 'running',
  })
  const transcript: RuntimePaneTranscript = {
    messages: [],
    running: true,
    turns: [
      { id: 'pre-restart-turn', items: [], status: 'streaming' },
      { id: 'follow-up-turn', items: [], status: 'done', completedAt: 3000 },
    ],
  }

  store.syncTranscript(address, transcript)

  expect(store.getTask(address)?.turn.id).not.toBe('pre-restart-turn')
  store.syncTranscript(address, { ...transcript, running: false })

  expect(store.getTask(address)?.turn.latestId).toBe('follow-up-turn')
  expect(store.getTask(address)?.derived.canSend).toBe(true)
})

test.each(['metadata-first', 'history-first'] as const)(
  'cold restoration recovers terminal identity with older streaming history: %s',
  order => {
    const store = new RuntimeTaskLifecycleStore(`cold-completed-history-${order}`)
    const address = { deviceId: 'device-1', taskId: 'task-1' }
    const completedTask: RuntimeTaskSummary = {
      taskId: address.taskId,
      title: 'Recovered conversation',
      workspacePath: '/repo',
      runtime: 'codex',
      continuable: true,
      executionState: null,
      running: false,
      status: 'done',
      threadStatus: 'notLoaded',
      turnStatus: 'completed',
      completedAt: 3000,
      updatedAt: 3000,
    }
    store.syncRuntimeTask(address, {
      ...completedTask,
      status: 'active',
      turnStatus: null,
      completedAt: null,
      updatedAt: 4000,
    })
    if (order === 'metadata-first') store.syncRuntimeTask(address, completedTask)

    store.syncTranscript(address, {
      messages: [],
      running: true,
      turns: [
        { id: 'pre-restart-turn', items: [], status: 'streaming' },
        { id: 'follow-up-turn', items: [], status: 'done', completedAt: 3000 },
      ],
    })

    expect(store.getTask(address)?.turn.latestId).toBe('follow-up-turn')
    if (order === 'history-first') {
      expect(store.getTask(address)?.derived.isBusy).toBe(true)
      store.syncRuntimeTask(address, completedTask)
    }
    const snapshot = store.getTask(address)
    expect(snapshot?.turn.latestId).toBe('follow-up-turn')
    expect(snapshot?.turn.outcome).toBe('succeeded')
    expect(snapshot?.turn.active).toBe(false)
    expect(snapshot?.execution.phase).toBe('idle')
    expect(snapshot?.derived.isBusy).toBe(false)
    expect(snapshot?.derived.canSend).toBe(true)
  }
)

test.each(['earlier-turn', 'unobserved-turn'])(
  'historical running evidence cannot replace a known later completion with %s',
  terminalId => {
    const store = new RuntimeTaskLifecycleStore(`idle-known-turn-${terminalId}`)
    const address = { deviceId: 'device-1', taskId: 'task-1' }
    store.syncRuntimeTask(address, {
      taskId: address.taskId,
      title: 'Completed conversation',
      workspacePath: '/repo',
      runtime: 'codex',
      continuable: true,
      running: false,
      status: 'done',
      completedAt: 4000,
    })
    store.turnStarted(address, 'earlier-turn')
    store.turnSettled(address, 'earlier-turn', 'succeeded')
    store.turnStarted(address, 'latest-turn')
    store.turnSettled(address, 'latest-turn', 'succeeded')
    store.executorSettled(address)

    store.syncTranscript(address, {
      messages: [],
      running: true,
      turns: [
        { id: 'pre-restart-turn', items: [], status: 'streaming' },
        { id: terminalId, items: [], status: 'done', completedAt: 3000 },
      ],
    })

    expect(store.getTask(address)?.turn.latestId).toBe('latest-turn')
    expect(store.getTask(address)?.turn.outcome).toBe('succeeded')
    expect(store.getTask(address)?.derived.canSend).toBe(true)
  }
)

test.each(['submitting', 'awaiting', 'queued', 'streaming'] as const)(
  'older streaming history and a completed turn cannot settle a new %s send',
  phase => {
    const store = new RuntimeTaskLifecycleStore(`pending-send-history-${phase}`)
    const address = { deviceId: 'device-1', taskId: 'task-1' }
    store.syncRuntimeTask(address, {
      taskId: address.taskId,
      title: 'Follow-up conversation',
      workspacePath: '/repo',
      runtime: 'codex',
      continuable: true,
      running: false,
      status: 'done',
      completedAt: 3000,
    })
    store.turnStarted(address, 'completed-turn')
    store.turnSettled(address, 'completed-turn', 'succeeded')
    store.executorSettled(address)
    store.sendRequested(address)
    if (phase === 'queued') store.sendQueued(address)
    if (phase === 'awaiting' || phase === 'streaming') store.sendAccepted(address)
    if (phase === 'streaming') store.turnStarted(address, 'live-turn')
    const before = store.getTask(address)!

    store.syncTranscript(address, {
      messages: [],
      running: true,
      turns: [
        { id: 'pre-restart-turn', items: [], status: 'streaming' },
        { id: 'completed-turn', items: [], status: 'done', completedAt: 3000 },
      ],
    })

    const after = store.getTask(address)!
    expect(after.turn).toEqual(before.turn)
    expect(after.derived.isBusy).toBe(true)
    expect(after.derived.canSend).toBe(false)
  }
)

test('an admitted follow-up can clear async waiting before its new turn ID arrives', () => {
  const store = new RuntimeTaskLifecycleStore('follow-up-admission-interaction')
  const address = { deviceId: 'device-1', taskId: 'task-1' }
  const task: RuntimeTaskSummary = {
    taskId: address.taskId,
    title: 'Async question',
    workspacePath: '/repo',
    runtime: 'codex',
    running: false,
    status: 'done',
    completedAt: 1793120189000,
    updatedAt: 1793120189095,
    interactionStatus: 'awaitingUserReply',
    runtimeHandle: { lastTurnId: 'question-turn' },
  }
  store.syncRuntimeTask(address, task)
  store.turnStarted(address, 'question-turn')
  store.turnSettled(address, 'question-turn', 'succeeded')
  store.sendRequested(address)
  store.sendAccepted(address)
  store.syncRuntimeTask(address, {
    ...task,
    running: true,
    status: 'running',
    completedAt: null,
    updatedAt: 1793120194041,
    threadStatus: 'active',
    turnStatus: 'inProgress',
    interactionStatus: null,
  })
  expect(store.getTask(address)?.derived.shouldShowSidebarWaiting).toBe(false)
  store.turnStarted(address, 'reply-turn')
  store.turnSettled(address, 'reply-turn', 'succeeded')
  store.executorSettled(address)
  expect(store.getTask(address)?.derived.isBusy).toBe(false)
  expect(store.getTask(address)?.derived.shouldShowSidebarWaiting).toBe(false)
})

test('a new turn snapshot can confirm execution before the send acknowledgement arrives', () => {
  const store = new RuntimeTaskLifecycleStore('new-turn-before-send-acknowledgement')
  const address = { deviceId: 'device-1', taskId: 'task-1' }
  const task: RuntimeTaskSummary = {
    taskId: address.taskId,
    title: 'Conversation',
    workspacePath: '/repo',
    runtime: 'codex',
    continuable: true,
    running: true,
    status: 'running',
    threadStatus: 'active',
    turnStatus: 'inProgress',
    updatedAt: 1000,
    runtimeHandle: { lastTurnId: 'previous-turn' },
  }
  store.syncRuntimeTask(address, task)
  store.turnStarted(address, 'previous-turn')
  store.turnSettled(address, 'previous-turn', 'succeeded')
  store.executorSettled(address)
  store.sendRequested(address)

  store.syncRuntimeTask(address, {
    ...task,
    updatedAt: 2000,
    runtimeHandle: { lastTurnId: 'new-turn' },
  })
  store.sendRejected(address)

  expect(store.getTask(address)?.turn.id).toBe('new-turn')
  expect(store.getTask(address)?.derived.isBusy).toBe(true)
  store.turnSettled(address, 'new-turn', 'succeeded')
  store.executorSettled(address)
  expect(store.getTask(address)?.derived.canSend).toBe(true)
})
