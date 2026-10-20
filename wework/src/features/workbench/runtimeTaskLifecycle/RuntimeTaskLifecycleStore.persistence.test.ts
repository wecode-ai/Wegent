import { beforeEach, describe, expect, it } from 'vitest'
import type { DeviceInfo, RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { getRuntimeTaskLifecycleKey } from './RuntimeTaskMachine'

const userId = 'persistence-recovery'
const storageScope = `wework.runtimeTaskLifecycle.${userId}`
const first: RuntimeTaskAddress = { deviceId: 'electron-local', taskId: 'task-1' }
const second: RuntimeTaskAddress = { ...first, taskId: 'task-2' }
const alias: RuntimeTaskAddress = { ...first, deviceId: 'app-record-65' }
const device: DeviceInfo = {
  id: 65,
  device_id: first.deviceId,
  socket_device_id: alias.deviceId,
  runtime_instance_id: 'runtime-local',
  name: 'Local Executor',
  status: 'online',
  is_default: true,
  device_type: 'local',
  bind_shell: 'codex',
}

function task(address: RuntimeTaskAddress): RuntimeTaskSummary {
  return {
    taskId: address.taskId,
    title: address.taskId,
    workspacePath: '',
    runtime: 'codex',
    continuable: true,
    running: false,
    status: 'done',
    completedAt: 2000,
    updatedAt: 2000,
  }
}

function completeInBackground(store: RuntimeTaskLifecycleStore, address: RuntimeTaskAddress): void {
  store.syncRuntimeTask(address, {
    ...task(address),
    running: true,
    status: 'running',
    completedAt: undefined,
    updatedAt: 1000,
  })
  store.syncRuntimeTask(address, task(address))
}

function storedKeys(kind: 'unread' | 'running'): Set<string> {
  return new Set(JSON.parse(localStorage.getItem(`${storageScope}.${kind}.v2`) ?? '[]'))
}

function taskKeys(...addresses: RuntimeTaskAddress[]): Set<string> {
  return new Set(addresses.map(getRuntimeTaskLifecycleKey))
}

describe('runtime task lifecycle persistence during startup', () => {
  beforeEach(() => localStorage.clear())

  it('retains both unread tasks when device aliases load before task snapshots', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    completeInBackground(previous, first)
    completeInBackground(previous, second)
    expect(storedKeys('unread')).toEqual(taskKeys(first, second))
    const restored = new RuntimeTaskLifecycleStore(userId)

    restored.syncDevices([device])

    expect(storedKeys('unread')).toEqual(taskKeys(first, second))
    restored.syncRuntimeTask(first, task(first))
    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(true)
    expect(storedKeys('unread')).toEqual(taskKeys(first, second))
    restored.syncRuntimeTask(second, task(second))
    expect(restored.getSnapshot().unreadTaskKeys).toEqual(taskKeys(first, second))
  })

  it('retains an unrestored task when unrelated state publishes and another task is read', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    completeInBackground(previous, first)
    completeInBackground(previous, second)
    const restored = new RuntimeTaskLifecycleStore(userId)
    const unrelated = { ...first, taskId: 'unrelated-task' }

    restored.sendQueued(unrelated, 1)

    expect(storedKeys('unread')).toEqual(taskKeys(first, second))
    restored.syncRuntimeTask(first, task(first))
    restored.markRead(first)
    expect(storedKeys('unread')).toEqual(taskKeys(second))
    restored.syncRuntimeTask(second, task(second))
    expect(restored.getTask(second)?.derived.shouldShowUnread).toBe(true)
    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(false)
  })

  it.each(['read', 'remove'] as const)(
    'migrates persisted alias unread state before task loading and clears it on %s',
    action => {
      const previous = new RuntimeTaskLifecycleStore(userId)
      completeInBackground(previous, alias)
      const restored = new RuntimeTaskLifecycleStore(userId)

      restored.syncDevices([device])

      expect(storedKeys('unread')).toEqual(taskKeys(first))
      restored.syncRuntimeTask(first, task(first))
      expect(restored.getTask(alias)?.derived.shouldShowUnread).toBe(true)
      if (action === 'read') restored.markRead(alias)
      else restored.remove(alias)
      expect(storedKeys('unread')).toEqual(new Set())

      const reloaded = new RuntimeTaskLifecycleStore(userId)
      reloaded.syncDevices([device])
      reloaded.syncRuntimeTask(first, task(first))
      expect(reloaded.getTask(first)?.derived.shouldShowUnread).toBe(false)
    }
  )

  it('restores persisted alias unread when its canonical idle task loads before devices', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    completeInBackground(previous, alias)
    const restored = new RuntimeTaskLifecycleStore(userId)
    restored.syncRuntimeTask(first, task(first))
    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(false)

    restored.syncDevices([device])

    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(true)
    expect(restored.getTask(alias)?.key).toBe(getRuntimeTaskLifecycleKey(first))
    expect(storedKeys('unread')).toEqual(taskKeys(first))
  })

  it('keeps a canonical task explicitly read before its persisted unread alias resolves', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    completeInBackground(previous, alias)
    const restored = new RuntimeTaskLifecycleStore(userId)
    restored.syncRuntimeTask(first, task(first))
    restored.markRead(first)

    restored.syncDevices([device])

    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(false)
    expect(storedKeys('unread')).toEqual(new Set())
    const reloaded = new RuntimeTaskLifecycleStore(userId)
    reloaded.syncDevices([device])
    reloaded.syncRuntimeTask(first, task(first))
    expect(reloaded.getTask(first)?.derived.shouldShowUnread).toBe(false)
  })

  it('keeps a newer alias completion unread after an earlier canonical read', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    completeInBackground(previous, alias)
    const restored = new RuntimeTaskLifecycleStore(userId)
    restored.syncRuntimeTask(first, task(first))
    restored.markRead(first)
    completeInBackground(restored, alias)

    restored.syncDevices([device])

    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(true)
    expect(storedKeys('unread')).toEqual(taskKeys(first))
    const reloaded = new RuntimeTaskLifecycleStore(userId)
    reloaded.syncDevices([device])
    reloaded.syncRuntimeTask(first, task(first))
    expect(reloaded.getTask(first)?.derived.shouldShowUnread).toBe(true)
  })

  it('preserves a completed unread task when a stale running alias arrives later', () => {
    const store = new RuntimeTaskLifecycleStore(userId)
    completeInBackground(store, first)
    expect(store.getTask(first)?.derived.shouldShowUnread).toBe(true)
    store.syncRuntimeTask(alias, {
      ...task(alias),
      running: true,
      status: 'running',
      completedAt: undefined,
      updatedAt: 1000,
    })

    store.syncDevices([device])

    expect(store.getSnapshot().tasks.size).toBe(1)
    expect(store.getTask(first)?.task?.updatedAt).toBe(2000)
    expect(store.getTask(first)?.execution.running).toBe(false)
    expect(store.getTask(first)?.derived.shouldShowUnread).toBe(true)
    expect(storedKeys('unread')).toEqual(taskKeys(first))
    expect(storedKeys('running')).toEqual(new Set())
  })

  it('removes an unread task before loading it without losing another pending task', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    completeInBackground(previous, alias)
    completeInBackground(previous, second)
    const restored = new RuntimeTaskLifecycleStore(userId)
    restored.syncDevices([device])

    restored.remove(alias)

    expect(restored.getTask(first)).toBeNull()
    expect(storedKeys('unread')).toEqual(taskKeys(second))
    const reloaded = new RuntimeTaskLifecycleStore(userId)
    reloaded.syncDevices([device])
    reloaded.syncRuntimeTask(first, task(first))
    reloaded.syncRuntimeTask(second, task(second))
    expect(reloaded.getTask(first)?.derived.shouldShowUnread).toBe(false)
    expect(reloaded.getTask(second)?.derived.shouldShowUnread).toBe(true)
  })

  it('renames persisted unread identity before its task has loaded', () => {
    const resolved = { ...first, taskId: 'resolved-task' }
    const previous = new RuntimeTaskLifecycleStore(userId)
    completeInBackground(previous, alias)
    completeInBackground(previous, second)
    const restored = new RuntimeTaskLifecycleStore(userId)
    restored.syncDevices([device])

    restored.rename(alias, resolved)

    expect(restored.getTask(first)).toBeNull()
    expect(storedKeys('unread')).toEqual(taskKeys(resolved, second))
    const reloaded = new RuntimeTaskLifecycleStore(userId)
    reloaded.syncDevices([device])
    reloaded.syncRuntimeTask(resolved, task(resolved))
    reloaded.syncRuntimeTask(second, task(second))
    reloaded.syncRuntimeTask(first, task(first))
    expect(reloaded.getSnapshot().unreadTaskKeys).toEqual(taskKeys(resolved, second))
  })

  it('migrates an unrestored running alias and marks its interrupted completion unread', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    previous.executorStarted(alias)
    const restored = new RuntimeTaskLifecycleStore(userId)

    restored.syncDevices([device])

    expect(storedKeys('running')).toEqual(taskKeys(first))
    restored.syncRuntimeTask(first, { ...task(first), status: 'cancelled' })
    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(true)
    expect(storedKeys('running')).toEqual(new Set())
    restored.markRead(first)
    const reloaded = new RuntimeTaskLifecycleStore(userId)
    reloaded.syncDevices([device])
    reloaded.syncRuntimeTask(first, task(first))
    expect(reloaded.getTask(first)?.derived.shouldShowUnread).toBe(false)
  })

  it('consumes an alias running marker without reviving a task read before alias discovery', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    previous.executorStarted(alias)
    const restored = new RuntimeTaskLifecycleStore(userId)
    restored.syncRuntimeTask(first, task(first))
    restored.markRead(first)

    restored.syncDevices([device])

    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(false)
    expect(storedKeys('running')).toEqual(new Set())
    restored.syncRuntimeTask(first, task(first))
    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(false)
    expect(storedKeys('unread')).toEqual(new Set())
  })

  it('reconciles an alias running marker with an already loaded idle task only once', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    previous.executorStarted(alias)
    const restored = new RuntimeTaskLifecycleStore(userId)
    restored.syncRuntimeTask(first, task(first))

    restored.syncDevices([device])

    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(true)
    expect(storedKeys('running')).toEqual(new Set())
    restored.markRead(first)
    restored.syncRuntimeTask(first, task(first))
    restored.syncDevices([device])
    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(false)
    expect(storedKeys('unread')).toEqual(new Set())
  })

  it('defers an aliased running task completion until its active Goal becomes inactive', () => {
    const previous = new RuntimeTaskLifecycleStore(userId)
    previous.executorStarted(alias)
    const restored = new RuntimeTaskLifecycleStore(userId)
    restored.syncRuntimeTask(first, { ...task(first), goalStatus: 'active' })
    expect(restored.getTask(first)?.goalStatus).toBe('active')

    restored.syncDevices([device])

    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(false)
    expect(storedKeys('running')).toEqual(new Set())
    restored.goalStatusReceived(first, 'complete')
    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(true)
    restored.markRead(first)
    restored.goalStatusReceived(first, 'complete')
    expect(restored.getTask(first)?.derived.shouldShowUnread).toBe(false)
    expect(storedKeys('unread')).toEqual(new Set())
  })

  it.each(['rename', 'remove'] as const)('updates an unrestored running identity on %s', action => {
    const resolved = { ...first, taskId: 'resolved-task' }
    const previous = new RuntimeTaskLifecycleStore(userId)
    previous.executorStarted(first)
    const restored = new RuntimeTaskLifecycleStore(userId)

    if (action === 'rename') restored.rename(first, resolved)
    else restored.remove(first)

    expect(storedKeys('running')).toEqual(action === 'rename' ? taskKeys(resolved) : new Set())
    const reloaded = new RuntimeTaskLifecycleStore(userId)
    reloaded.syncRuntimeTask(first, task(first))
    reloaded.syncRuntimeTask(resolved, task(resolved))
    expect(reloaded.getTask(first)?.derived.shouldShowUnread).toBe(false)
    expect(reloaded.getTask(resolved)?.derived.shouldShowUnread).toBe(action === 'rename')
  })
})
