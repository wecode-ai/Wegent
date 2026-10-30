import { expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
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
