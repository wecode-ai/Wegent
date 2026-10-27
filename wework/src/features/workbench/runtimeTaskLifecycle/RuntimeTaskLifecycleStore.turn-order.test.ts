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
