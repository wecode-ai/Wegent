import { expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const address = { deviceId: 'electron-local', taskId: 'chat' }
const task: RuntimeTaskSummary = {
  taskId: address.taskId,
  title: 'Replay regression',
  workspacePath: '/chat',
  runtime: 'codex',
  status: 'done',
  running: false,
  continuable: true,
  completedAt: 2000,
  updatedAt: 2000,
  runtimeHandle: { lastTurnId: 'turn-2' },
}

test('rejects replayed starts for every settled turn while accepting a real continuation', () => {
  const store = new RuntimeTaskLifecycleStore('replayed-start')
  store.syncRuntimeTask(address, { ...task, runtimeHandle: {} })
  for (const id of ['turn-1', 'turn-2']) {
    store.turnStarted(address, id)
    store.turnSettled(address, id, 'succeeded')
  }
  store.executorSettled(address)
  const completed = store.getTask(address)
  for (const id of ['turn-1', 'turn-2']) {
    store.turnStarted(address, id)
    expect(store.getTask(address)).toEqual(completed)
  }
  store.sendRequested(address)
  store.sendAccepted(address)
  store.turnStarted(address, 'turn-1')
  expect(store.getTask(address)?.turn.phase).toBe('awaiting')
  store.turnStarted(address, 'turn-3')
  expect(store.getTask(address)?.turn).toMatchObject({ phase: 'streaming', id: 'turn-3' })
  store.turnStarted(address, 'turn-2')
  expect(store.getTask(address)?.turn.id).toBe('turn-3')
})

test('remembers completion learned from a task snapshot after a cold start', () => {
  const store = new RuntimeTaskLifecycleStore('snapshot-replay')
  store.syncRuntimeTask(address, task)
  store.turnStarted(address, 'turn-2')
  expect(store.getTask(address)?.derived.canSend).toBe(true)
  store.syncRuntimeTask(address, {
    ...task,
    status: 'running',
    running: true,
    completedAt: null,
    updatedAt: 3000,
    threadStatus: 'active',
    turnStatus: 'inProgress',
  })
  expect(store.getTask(address)?.derived.canSend).toBe(true)
  store.turnStarted(address, 'turn-3')
  expect(store.getTask(address)?.turn.id).toBe('turn-3')
})

test('preserves all terminal transcript IDs across device alias reconciliation', () => {
  const store = new RuntimeTaskLifecycleStore('alias-replay')
  const alias = { ...address, deviceId: 'app-record-65' }
  store.syncRuntimeTask(alias, task)
  store.syncTranscript(alias, {
    taskId: address.taskId,
    running: false,
    messages: [],
    turns: [
      { id: 'turn-1', status: 'done', items: [] },
      { id: 'turn-2', status: 'done', items: [] },
    ],
  })
  store.syncDevices([
    {
      id: 65,
      device_id: address.deviceId,
      socket_device_id: alias.deviceId,
      runtime_instance_id: 'runtime-local',
      name: 'Local',
      status: 'online',
      is_default: true,
      device_type: 'local',
      bind_shell: 'codex',
    },
  ])
  for (const id of ['turn-1', 'turn-2']) {
    store.turnStarted(address, id)
    expect(store.getTask(alias)?.derived.canSend).toBe(true)
  }
})
