import { expect, test } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { isRuntimeTaskConfirmedActive, isRuntimeTaskExecutionRunning } from './projection'

const address: RuntimeTaskAddress = { deviceId: 'local-device', taskId: 'supervised-task' }
const completedAt = 1792773817910
const completed: RuntimeTaskSummary = {
  taskId: address.taskId,
  workspacePath: '/workspace',
  title: 'Supervised task',
  runtime: 'codex',
  continuable: true,
  running: false,
  status: 'done',
  threadStatus: 'idle',
  turnStatus: 'completed',
  completedAt,
  updatedAt: completedAt,
}
const correction: RuntimeTaskSummary = {
  ...completed,
  running: true,
  status: 'running',
  threadStatus: 'active',
  turnStatus: 'inProgress',
  // Wire summaries omit the prior completion while the executor retains it internally.
  completedAt: null,
  updatedAt: 1792773818072,
}

test('recognizes an autonomous turn whose wire summary clears its previous completion', () => {
  expect(isRuntimeTaskConfirmedActive(correction)).toBe(true)
  expect(isRuntimeTaskExecutionRunning(correction)).toBe(true)
})

test('projects a supervisor correction as running before its held model response emits output', () => {
  const store = new RuntimeTaskLifecycleStore('supervisor-correction')
  store.syncRuntimeTask(address, completed)

  store.syncRuntimeTask(address, correction)

  expect(store.getTask(address)?.derived).toMatchObject({
    isRunning: true,
    shouldShowSidebarRunning: true,
    isBusy: true,
    canSend: false,
  })
  expect(store.getTask(address)?.task?.completedAt).toBeNull()
})

test.each([completedAt - 1, completedAt, completedAt + 1000])(
  'does not revive completed work from a snapshot retaining completion at %s',
  updatedAt => {
    const store = new RuntimeTaskLifecycleStore(`stale-supervisor-${updatedAt}`)
    store.syncRuntimeTask(address, completed)
    const stale = { ...correction, completedAt, updatedAt }

    expect(isRuntimeTaskConfirmedActive(stale)).toBe(false)
    expect(isRuntimeTaskExecutionRunning(stale)).toBe(false)
    store.syncRuntimeTask(address, stale)

    expect(store.getTask(address)?.derived.isBusy).toBe(false)
  }
)

test('does not infer a new turn from a newer timestamp without active provider state', () => {
  const unconfirmed = {
    ...correction,
    completedAt,
    threadStatus: 'idle',
    turnStatus: 'completed' as const,
  }
  expect(isRuntimeTaskConfirmedActive(unconfirmed)).toBe(false)
  expect(isRuntimeTaskExecutionRunning(unconfirmed)).toBe(false)
})
