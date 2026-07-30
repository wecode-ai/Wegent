import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { getRuntimeTaskLifecycleKey } from './RuntimeTaskMachine'

const address: RuntimeTaskAddress = {
  deviceId: 'local-device',
  taskId: 'task-1',
  workspacePath: '/repo/Wegent',
}

function task(overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? '',
    title: 'Task',
    runtime: 'codex',
    running: false,
    continuable: true,
    ...overrides,
  }
}

function runtimeWork(summary: RuntimeTaskSummary): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { key: 'project-1', id: 1, name: 'Wegent' },
        deviceWorkspaces: [
          {
            deviceId: address.deviceId,
            available: true,
            workspacePath: address.workspacePath ?? '',
            tasks: [summary],
          },
        ],
      },
    ],
    chats: [],
    totalTasks: 1,
  }
}

function transcript(overrides: Partial<RuntimePaneTranscript> = {}): RuntimePaneTranscript {
  return {
    taskId: address.taskId,
    messages: [],
    ...overrides,
  }
}

describe('RuntimeTaskLifecycleStore', () => {
  beforeEach(() => window.localStorage.clear())

  test('routes executor snapshots to the matching task machine', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))

    expect(store.getTask(address)?.execution).toMatchObject({
      known: true,
      running: true,
      phase: 'running',
    })
    expect(store.getSnapshot().runningTaskKeys).toEqual(
      new Set([getRuntimeTaskLifecycleKey(address)])
    )
  })

  test('owns optimistic send, accepted, stream, and settled turn transitions', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task()))

    store.sendRequested(address)
    expect(store.getTask(address)?.turn.phase).toBe('submitting')
    expect(store.getTask(address)?.derived.isRunning).toBe(true)

    store.sendAccepted(address)
    expect(store.getTask(address)?.turn.phase).toBe('awaiting')

    store.turnStarted(address)
    expect(store.getTask(address)?.turn.phase).toBe('streaming')

    store.turnSettled(address)
    expect(store.getTask(address)?.turn.phase).toBe('idle')
    expect(store.getTask(address)?.derived.isRunning).toBe(false)
  })

  test('does not regress a stream that starts before the create acknowledgement', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.turnStarted(address)
    store.sendAccepted(address)

    expect(store.getTask(address)?.turn.phase).toBe('streaming')
    expect(store.getTask(address)?.derived.isThinking).toBe(false)
  })

  test('does not clear an optimistic send from a transcript without executor state', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.syncTranscript(address, transcript())

    expect(store.getTask(address)?.execution.phase).toBe('starting')
    expect(store.getTask(address)?.turn.phase).toBe('submitting')
  })

  test('does not clear an in-flight send from an early idle transcript', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.syncTranscript(address, transcript({ running: false }), {
      preserveActiveTurn: true,
    })

    expect(store.getTask(address)?.execution.phase).toBe('starting')
    expect(store.getTask(address)?.turn.phase).toBe('submitting')

    store.sendAccepted(address)
    store.syncTranscript(address, transcript({ running: false }), {
      preserveActiveTurn: true,
    })

    expect(store.getTask(address)?.execution.phase).toBe('running')
    expect(store.getTask(address)?.turn.phase).toBe('awaiting')
  })

  test('does not clear an active send because a transcript contains historical settled output', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.syncTranscript(
      address,
      transcript({
        messages: [
          {
            id: 'historical-assistant',
            role: 'assistant',
            content: 'Earlier response',
            status: 'done',
          },
        ],
      }),
      { preserveActiveTurn: true }
    )

    expect(store.getTask(address)?.execution.phase).toBe('starting')
    expect(store.getTask(address)?.turn.phase).toBe('submitting')
  })

  test('keeps an executor-confirmed stream when the original send transport rejects late', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.turnStarted(address)
    store.sendRejected(address)

    expect(store.getTask(address)?.execution.phase).toBe('running')
    expect(store.getTask(address)?.turn.phase).toBe('streaming')
  })

  test('returns an unconfirmed optimistic send to idle when its transport rejects', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.sendRejected(address)

    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
  })

  test('does not let a stale idle transcript override a live streaming turn', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.turnStarted(address)
    store.syncTranscript(
      address,
      transcript({
        running: false,
        messages: [{ id: 'assistant-1', role: 'assistant', content: '', status: 'streaming' }],
      }),
      { preserveActiveTurn: true }
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('running')
    expect(snapshot?.turn.phase).toBe('streaming')
    expect(snapshot?.derived.isTurnActive).toBe(true)
  })

  test('treats an explicit executor snapshot as authoritative over a live turn', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.turnStarted(address)
    store.syncRuntimeWork(runtimeWork(task({ running: false, status: 'done' })))

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('idle')
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.derived.isThinking).toBe(false)
  })

  test('keeps task execution running across an active Goal turn gap', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(
      runtimeWork(task({ running: true, goalStatus: 'active', status: 'active' }))
    )

    store.turnStarted(address)
    store.turnSettled(address)

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.running).toBe(true)
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.derived.isThinking).toBe(false)
    expect(snapshot?.derived.shouldShowUnread).toBe(false)
  })

  test('does not reconstruct running from an active Goal after renderer restart', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(
      runtimeWork(task({ running: false, goalStatus: 'active', status: 'active' }))
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.running).toBe(false)
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.derived.shouldShowUnread).toBe(false)
  })

  test('preserves a known Goal status when a later executor snapshot omits it', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true, goalStatus: 'active' })))

    store.syncRuntimeWork(runtimeWork(task({ running: true, goalStatus: undefined })))

    expect(store.getTask(address)?.goalStatus).toBe('active')
  })

  test('ignores stale snapshots while an optimistic start awaits executor confirmation', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: false })))
    store.sendRequested(address)
    store.sendAccepted(address)

    store.syncRuntimeWork(runtimeWork(task({ running: false })))
    expect(store.getTask(address)?.execution.running).toBe(true)
    expect(store.getTask(address)?.turn.phase).toBe('awaiting')

    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    expect(store.getTask(address)?.execution.running).toBe(true)
  })

  test('settles the active turn when an authoritative terminal snapshot is idle', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: false })))
    store.sendRequested(address)
    store.sendAccepted(address)

    store.syncRuntimeWork(runtimeWork(task({ running: false, status: 'failed' })))

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('idle')
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.derived.isBusy).toBe(false)
    expect(snapshot?.derived.isThinking).toBe(false)
  })

  test('ignores stale running snapshots after a terminal transition until idle is confirmed', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    store.executorSettled(address)

    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    expect(store.getTask(address)?.execution.running).toBe(false)

    store.syncRuntimeWork(runtimeWork(task({ running: false })))
    expect(store.getTask(address)?.execution.running).toBe(false)
  })

  test('marks only background non-Goal completion unread and clears it when opened', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    store.executorSettled(address)

    expect(store.getTask(address)?.derived.shouldShowUnread).toBe(true)

    store.setCurrentTask(address)
    expect(store.getTask(address)?.derived.shouldShowUnread).toBe(false)
  })

  test('never marks an active Goal turn gap unread', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true, goalStatus: 'active' })))
    store.turnStarted(address)
    store.turnSettled(address)

    expect(store.getTask(address)?.derived.shouldShowUnread).toBe(false)
  })

  test('migrates optimistic lifecycle state when the executor resolves a new task identity', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const resolved = { ...address, taskId: 'resolved-task' }
    store.sendRequested(address)

    store.rename(address, resolved)
    store.sendAccepted(resolved)

    expect(store.getTask(address)).toBeNull()
    expect(store.getTask(resolved)?.execution.running).toBe(true)
    expect(store.getTask(resolved)?.turn.phase).toBe('awaiting')
  })

  test('migrates Goal status when the executor resolves a new task identity', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const resolved = { ...address, taskId: 'resolved-task' }
    store.syncRuntimeWork(runtimeWork(task({ running: true, goalStatus: 'active' })))

    store.rename(address, resolved)

    expect(store.getTask(address)).toBeNull()
    expect(store.getTask(resolved)?.goalStatus).toBe('active')
    expect(store.getTask(resolved)?.execution.running).toBe(true)
  })

  test('notifies subscribers even when unread persistence fails', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    const listener = vi.fn()
    store.subscribe(listener)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    store.executorSettled(address)

    expect(store.getTask(address)?.derived.shouldShowUnread).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    setItem.mockRestore()
    warn.mockRestore()
  })

  test('does not rewrite unchanged unread persistence on unrelated lifecycle events', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    const setItem = vi.spyOn(window.localStorage, 'setItem')

    store.executorSettled(address)
    store.goalStatusReceived(address, 'paused')

    expect(setItem).toHaveBeenCalledOnce()
    setItem.mockRestore()
  })
})
