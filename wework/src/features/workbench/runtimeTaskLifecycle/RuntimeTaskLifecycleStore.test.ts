import { beforeEach, describe, expect, test } from 'vitest'
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
  beforeEach(() => localStorage.clear())

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

  test('treats explicit executor idle as authoritative over a stale streaming message', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.turnStarted(address)
    store.syncTranscript(
      address,
      transcript({
        running: false,
        messages: [{ id: 'assistant-1', role: 'assistant', content: '', status: 'streaming' }],
      })
    )

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

  test('ignores stale snapshots while an optimistic start awaits executor confirmation', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: false })))
    store.sendRequested(address)
    store.sendAccepted(address)

    store.syncRuntimeWork(runtimeWork(task({ running: false })))
    expect(store.getTask(address)?.execution.running).toBe(true)

    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    expect(store.getTask(address)?.execution.running).toBe(true)
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
})
