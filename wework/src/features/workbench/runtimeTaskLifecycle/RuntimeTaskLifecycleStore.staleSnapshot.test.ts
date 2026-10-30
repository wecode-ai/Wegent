import { expect, test } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

test('accepts executor confirmation of an autonomous turn first observed in streaming history', () => {
  const address: RuntimeTaskAddress = { deviceId: 'local-device', taskId: 'supervised' }
  const task: RuntimeTaskSummary = {
    taskId: address.taskId,
    workspacePath: '/supervised',
    title: 'Supervised task',
    runtime: 'codex',
    status: 'done',
    running: false,
    continuable: true,
    completedAt: 1000,
    updatedAt: 1000,
    runtimeHandle: { lastTurnId: 'turn-1' },
  }
  const store = new RuntimeTaskLifecycleStore('autonomous-history')
  store.turnStarted(address, 'turn-1')
  store.turnSettled(address, 'turn-1', 'succeeded')
  store.syncRuntimeTask(address, task)
  const transcript = {
    taskId: address.taskId,
    running: true,
    messages: [],
    turns: [{ id: 'turn-2', status: 'streaming', items: [] }],
  }
  store.syncTranscript(address, transcript)
  expect(store.getTask(address)?.derived.isRunning).toBe(false)

  store.syncRuntimeTask(address, {
    ...task,
    status: 'running',
    running: true,
    completedAt: null,
    threadStatus: 'active',
    turnStatus: 'inProgress',
    updatedAt: 2000,
    runtimeHandle: { lastTurnId: 'turn-2' },
  })
  store.syncTranscript(address, transcript)
  expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(true)
  expect(store.getTask(address)?.turn.id).toBe('turn-2')

  store.syncRuntimeTask(address, { ...task, updatedAt: 3000 })
  expect(store.getTask(address)?.derived.isRunning).toBe(true)
  expect(store.getTask(address)?.turn.id).toBe('turn-2')
})

test('does not revive a completed follow-up from a late running snapshot of the prior turn', () => {
  const address: RuntimeTaskAddress = { deviceId: 'local-device', taskId: 'chat' }
  const task: RuntimeTaskSummary = {
    taskId: address.taskId,
    workspacePath: '/chat',
    title: 'Conversation',
    runtime: 'codex',
    status: 'running',
    running: true,
    continuable: true,
    updatedAt: 1000,
    runtimeHandle: { lastTurnId: 'turn-1' },
  }
  const store = new RuntimeTaskLifecycleStore('stale-follow-up')
  store.syncRuntimeTask(address, task)
  store.turnStarted(address, 'turn-1')
  store.turnSettled(address, 'turn-1', 'succeeded')
  store.sendRequested(address)
  store.sendAccepted(address)
  store.turnStarted(address, 'turn-2')
  store.turnSettled(address, 'turn-2', 'succeeded')
  store.syncTranscript(address, {
    taskId: address.taskId,
    running: false,
    messages: [],
    turns: [
      { id: 'turn-1', status: 'done', items: [] },
      { id: 'turn-2', status: 'done', items: [] },
    ],
  })
  expect(store.getTask(address)?.derived.canSend).toBe(true)

  store.syncRuntimeTask(address, { ...task, updatedAt: 1100 })

  expect(store.getTask(address)?.derived.canSend).toBe(true)
  expect(store.getTask(address)?.turn.latestId).toBe('turn-2')

  store.syncRuntimeTask(address, {
    ...task,
    updatedAt: 1200,
    runtimeHandle: { lastTurnId: 'turn-3' },
  })
  expect(store.getTask(address)?.derived.isRunning).toBe(true)
  expect(store.getTask(address)?.turn.latestId).toBe('turn-3')
})
