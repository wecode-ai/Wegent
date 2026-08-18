import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import {
  createRuntimeTaskLifecycleOwnershipView,
  RuntimeTaskLifecycleStore,
} from './RuntimeTaskLifecycleStore'
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
    turns: [],
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

  test('uses one lifecycle machine for canonical workspace and remote host addresses', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const remoteAddress = {
      ...address,
      deviceId: 'cloud-device',
      runtime: 'claude_code',
    }

    store.sendRequested(remoteAddress)
    store.sendAccepted(remoteAddress)
    store.turnStarted(remoteAddress, 'turn-1')
    store.syncRuntimeWork({
      projects: [
        {
          project: { key: 'project-1', id: 1, name: 'Wegent' },
          deviceWorkspaces: [
            {
              deviceId: address.deviceId,
              remoteHostId: remoteAddress.deviceId,
              available: true,
              workspacePath: address.workspacePath ?? '',
              tasks: [
                task({
                  runtime: 'claude_code',
                  status: 'done',
                  running: false,
                  completedAt: 1_786_692_066_192,
                  turnStatus: 'completed',
                }),
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    })

    expect(store.getTask(remoteAddress)?.key).toBe(getRuntimeTaskLifecycleKey(address))
    expect(store.getTask(address)?.task).toMatchObject({
      status: 'done',
      running: false,
      completedAt: 1_786_692_066_192,
    })
    expect(store.getTask(address)?.derived.isRunning).toBe(false)
    expect([...store.getSnapshot().tasks.keys()]).toEqual([getRuntimeTaskLifecycleKey(address)])
  })

  test('preserves an alias streaming turn when the canonical machine already exists', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const remoteAddress = {
      ...address,
      deviceId: 'cloud-device',
      runtime: 'claude_code',
    }
    const completedAt = 1_786_692_066_192
    store.syncRuntimeWork(
      runtimeWork(
        task({
          runtime: 'claude_code',
          status: 'done',
          running: false,
          completedAt,
          turnStatus: 'completed',
        })
      )
    )
    store.sendRequested(remoteAddress)
    store.sendAccepted(remoteAddress)
    store.turnStarted(remoteAddress, 'streaming-turn')

    store.syncRuntimeWork({
      projects: [
        {
          project: { key: 'project-1', id: 1, name: 'Wegent' },
          deviceWorkspaces: [
            {
              deviceId: address.deviceId,
              remoteHostId: remoteAddress.deviceId,
              available: true,
              workspacePath: address.workspacePath ?? '',
              tasks: [
                task({
                  runtime: 'claude_code',
                  status: 'done',
                  running: false,
                  completedAt,
                  turnStatus: 'completed',
                }),
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    })

    expect(store.getTask(remoteAddress)?.key).toBe(getRuntimeTaskLifecycleKey(address))
    expect(store.getTask(address)?.turn).toMatchObject({
      phase: 'streaming',
      id: 'streaming-turn',
    })
    expect(store.getTask(address)?.derived.isRunning).toBe(true)
    expect([...store.getSnapshot().tasks.keys()]).toEqual([getRuntimeTaskLifecycleKey(address)])
  })

  test('reconciles an optimistic start into a queued executor snapshot', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.sendRequested(address)
    store.sendAccepted(address)

    store.syncRuntimeWork(runtimeWork(task({ running: false, status: 'queued' })))

    const snapshot = store.getTask(address)
    expect(snapshot?.execution).toMatchObject({
      known: true,
      running: false,
      phase: 'queued',
    })
    expect(snapshot?.derived).toMatchObject({
      isQueued: true,
      isBusy: true,
      shouldShowSidebarRunning: false,
    })
    expect(store.getSnapshot().queuedTaskKeys).toEqual(
      new Set([getRuntimeTaskLifecycleKey(address)])
    )
    expect(store.getSnapshot().unreadTaskKeys).toEqual(new Set())
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

    store.turnSettled(address, null, 'succeeded')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
    expect(store.getTask(address)?.turn.outcome).toBe('succeeded')
    expect(store.getTask(address)?.derived.isRunning).toBe(false)
  })

  test('tracks terminal turn outcome without relying on persisted task status', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ status: 'active' })))

    store.turnStarted(address, 'turn-1')
    store.turnSettled(address, 'turn-1', 'succeeded')

    expect(store.getTask(address)?.task?.status).toBe('active')
    expect(store.getTask(address)?.turn.outcome).toBe('succeeded')

    store.turnStarted(address, 'turn-2')
    expect(store.getTask(address)?.turn.outcome).toBeNull()
  })

  test('rejects a stale running snapshot after a terminal event without a matching start', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))

    store.turnSettled(address, null, 'succeeded')
    const accepted = store.syncRuntimeTask(address, task({ running: true }))

    expect(accepted).toBe(false)
    expect(store.getTask(address)?.execution.running).toBe(false)
  })

  test('keeps terminal executor snapshots idle even when running remains true', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const terminalTask = task({ running: true, status: 'complete' })

    store.syncRuntimeWork(runtimeWork(terminalTask))
    store.syncRuntimeWork(runtimeWork(terminalTask))

    expect(store.getTask(address)?.execution.running).toBe(false)
    expect(store.getTask(address)?.turn.phase).toBe('idle')
  })

  test('records worktree creation intent without changing the task address', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address, { workspaceCreationKind: 'worktree' })

    expect(store.getTask(address)?.workspaceCreationKind).toBe('worktree')
    expect(store.getTask(address)?.address).toEqual(address)
  })

  test('rejects a snapshot when a newer send starts before the response arrives', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    store.turnSettled(address, null, 'succeeded')
    const expectedSnapshot = store.getTask(address)

    store.sendRequested(address)
    const accepted = store.syncRuntimeTask(address, task({ running: true }), expectedSnapshot)

    expect(accepted).toBe(false)
    expect(store.getTask(address)?.turn.phase).toBe('submitting')
  })

  test('accepts canonical completion after an equivalent optimistic projection update', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true, status: 'active' })))
    store.turnStarted(address, 'turn-1')
    store.turnSettled(address, 'turn-1', 'succeeded')
    const expectedSnapshot = store.getTask(address)

    store.syncRuntimeWork(runtimeWork(task({ running: false, status: 'active', optimistic: true })))
    expect(store.getTask(address)).not.toBe(expectedSnapshot)

    const accepted = store.syncRuntimeTask(
      address,
      task({
        running: false,
        status: 'active',
        completedAt: 1_786_692_066_192,
      }),
      expectedSnapshot
    )

    expect(accepted).toBe(true)
    expect(store.getTask(address)?.task).toMatchObject({
      running: false,
      status: 'done',
      completedAt: 1_786_692_066_192,
    })
    expect(store.getTask(address)?.execution.phase).toBe('idle')
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

  test('ignores a stale running transcript after the current turn settles', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.sendAccepted(address)
    store.turnStarted(address, 'turn-1')
    store.turnSettled(address, 'turn-1', 'succeeded')
    store.syncTranscript(address, transcript({ running: true }))

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('idle')
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.turn.outcome).toBe('succeeded')
    expect(snapshot?.derived.isBusy).toBe(false)
  })

  test('ignores a stale running transcript snapshot after the current turn settles', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.sendAccepted(address)
    store.turnStarted(address, 'turn-1')
    store.turnSettled(address, 'turn-1', 'succeeded')
    store.syncRuntimeTranscriptSnapshot(address, {
      running: true,
      turns: [],
    })

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('idle')
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.turn.outcome).toBe('succeeded')
    expect(snapshot?.derived.isBusy).toBe(false)
  })

  test('does not settle an in-flight turn from a non-terminal idle snapshot', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.sendAccepted(address)
    store.syncRuntimeWork(
      runtimeWork(task({ runtime: 'claude_code', running: false, status: 'active' }))
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('running')
    expect(snapshot?.turn.phase).toBe('awaiting')
    expect(snapshot?.derived.isThinking).toBe(true)
  })

  test('ignores a settled transcript from the previous turn and converges on the new completion', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(
      runtimeWork(
        task({
          runtime: 'claude_code',
          running: false,
          status: 'done',
          completedAt: 1_786_676_400_000,
          turnStatus: 'completed',
        })
      )
    )
    store.sendRequested(address)
    store.sendAccepted(address)

    store.syncRuntimeTranscriptSnapshot(address, {
      running: false,
      turns: [
        {
          id: 'previous-turn',
          items: [],
          status: 'completed',
          completedAt: 1_786_676_400_000,
        },
      ],
    })

    expect(store.getTask(address)?.execution.phase).toBe('running')

    store.syncRuntimeTranscriptSnapshot(address, {
      running: false,
      turns: [
        {
          id: 'current-turn',
          items: [],
          status: 'completed',
          completedAt: 1_786_676_401_000,
        },
      ],
    })

    expect(store.getTask(address)?.task).toMatchObject({
      running: false,
      status: 'done',
      completedAt: 1_786_676_401_000,
      turnStatus: 'completed',
    })
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
  })

  test('settles a late stream projection from the matching completed transcript turn', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(
      runtimeWork(
        task({
          runtime: 'claude_code',
          running: false,
          status: 'done',
          completedAt: 1_786_676_400_000,
          turnStatus: 'completed',
        })
      )
    )

    store.turnStarted(address, 'completed-turn')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(true)

    store.syncRuntimeTranscriptSnapshot(address, {
      running: false,
      turns: [
        {
          id: 'completed-turn',
          items: [],
          status: 'completed',
          completedAt: 1_786_676_400_000,
        },
      ],
    })

    const snapshot = store.getTask(address)
    expect(snapshot?.task).toMatchObject({
      running: false,
      status: 'done',
      completedAt: 1_786_676_400_000,
    })
    expect(snapshot?.execution.phase).toBe('idle')
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('does not clear an active send because a transcript contains historical settled output', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.sendRequested(address)
    store.syncTranscript(
      address,
      transcript({
        turns: [
          {
            id: 'historical-turn',
            items: [],
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

  test('recovers from a stale idle view when the provider rejects an overlapping turn', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.turnStarted(address, 'stale-client-turn')
    store.sendRequested(address)
    store.sendBlockedByActiveTurn(address)

    expect(store.getTask(address)?.execution.phase).toBe('running')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
    store.turnSettled(address, 'provider-active-turn', 'succeeded')

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
        turns: [{ id: 'turn-1', items: [], status: 'streaming' }],
      }),
      { preserveActiveTurn: true }
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('running')
    expect(snapshot?.turn.phase).toBe('streaming')
    expect(snapshot?.derived.isTurnActive).toBe(true)
  })

  test('recovers a streaming turn after restart when coarse transcript running state is stale', () => {
    const store = new RuntimeTaskLifecycleStore('test')

    store.syncTranscript(
      address,
      transcript({
        running: false,
        turns: [{ id: 'restored-turn', items: [], status: 'streaming' }],
      })
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('running')
    expect(snapshot?.turn.phase).toBe('streaming')
    expect(snapshot?.derived.shouldShowSidebarRunning).toBe(true)
    expect(store.getSnapshot().runningTaskKeys).toEqual(
      new Set([getRuntimeTaskLifecycleKey(address)])
    )
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

  test('keeps an identified live turn when the task list still reports prior completion', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: false, status: 'done' })))

    store.turnStarted(address, 'correction-turn')
    store.syncRuntimeWork(runtimeWork(task({ running: false, status: 'done' })))
    store.syncRuntimeWork(runtimeWork(task({ running: false, status: 'done' })))

    const runningSnapshot = store.getTask(address)
    expect(runningSnapshot?.execution.phase).toBe('running')
    expect(runningSnapshot?.turn.phase).toBe('streaming')
    expect(runningSnapshot?.derived.shouldShowSidebarRunning).toBe(true)

    store.turnSettled(address, 'correction-turn')
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
  })

  test('keeps an identified live turn over an unchanged completed snapshot', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const completedTask = task({
      runtime: 'claude_code',
      running: false,
      status: 'done',
      completedAt: 1_786_676_400_000,
      turnStatus: 'completed',
    })
    store.syncRuntimeWork(runtimeWork(completedTask))

    store.turnStarted(address, 'late-stream-turn')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(true)

    store.syncRuntimeWork(runtimeWork(completedTask))

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('running')
    expect(snapshot?.turn.phase).toBe('streaming')
    expect(snapshot?.derived.shouldShowSidebarRunning).toBe(true)
  })

  test('does not let a stale optimistic work list revive authoritative completion', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(
      runtimeWork(
        task({
          runtime: 'claude_code',
          running: false,
          status: 'done',
          completedAt: 1_786_676_400_000,
          turnStatus: 'completed',
        })
      )
    )

    store.syncRuntimeWork(
      runtimeWork(
        task({
          runtime: 'claude_code',
          running: true,
          status: 'active',
          threadStatus: 'active',
          turnStatus: 'inProgress',
          optimistic: true,
        })
      )
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.task).toMatchObject({
      running: false,
      status: 'done',
      completedAt: 1_786_676_400_000,
    })
    expect(snapshot?.execution.phase).toBe('idle')
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.derived.shouldShowSidebarRunning).toBe(false)
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

  test('ignores a completed active snapshot after a terminal turn event', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    store.turnStarted(address, 'turn-1')
    store.turnSettled(address, 'turn-1')

    store.syncRuntimeWork(
      runtimeWork(
        task({
          completedAt: '2026-08-14T19:26:26+08:00',
          running: true,
          status: 'active',
          threadStatus: 'active',
          turnStatus: 'inProgress',
        })
      )
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.running).toBe(false)
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.derived.isBusy).toBe(false)
  })

  test('accepts an executor-confirmed autonomous turn after the previous turn settles', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    store.executorSettled(address)

    store.syncRuntimeWork(
      runtimeWork(
        task({
          running: true,
          status: 'running',
          threadStatus: 'active',
          turnStatus: 'inProgress',
        })
      )
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.running).toBe(true)
    expect(snapshot?.derived.shouldShowSidebarRunning).toBe(true)
  })

  test('does not let an optimistic active projection revive a settled turn', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    store.turnStarted(address, 'turn-1')
    store.turnSettled(address, 'turn-1', 'succeeded')

    store.syncRuntimeWork(
      runtimeWork(
        task({
          running: true,
          status: 'active',
          threadStatus: 'active',
          turnStatus: 'inProgress',
          optimistic: true,
        })
      )
    )

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('idle')
    expect(snapshot?.turn.phase).toBe('idle')
    expect(snapshot?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('ignores a settled event from an older turn after a newer turn starts', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.turnStarted(address, 'turn-1')
    store.turnStarted(address, 'turn-2')

    store.turnSettled(address, 'turn-1')

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.running).toBe(true)
    expect(snapshot?.turn.phase).toBe('streaming')
    expect(snapshot?.derived.shouldShowSidebarRunning).toBe(true)
  })

  test('keeps a live stream when an idle executor snapshot lags behind it', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: false })))

    store.turnStarted(address)
    store.syncRuntimeWork(runtimeWork(task({ running: false, status: 'active' })))

    const snapshot = store.getTask(address)
    expect(snapshot?.execution.phase).toBe('running')
    expect(snapshot?.turn.phase).toBe('streaming')
    expect(snapshot?.derived.shouldShowSidebarRunning).toBe(true)
  })

  test('marks a running task unread when startup reconciliation settles it', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(task({ running: true })))
    store.syncRuntimeWork(runtimeWork(task({ running: true })))

    store.syncRuntimeTranscriptSnapshot(address, {
      running: false,
      turns: [
        {
          id: 'restored-turn',
          items: [],
          status: 'completed',
          completedAt: 1_786_692_066_192,
        },
      ],
    })

    expect(store.getTask(address)?.derived.shouldShowUnread).toBe(true)
  })

  test('marks work interrupted by an app restart unread', () => {
    const previousStore = new RuntimeTaskLifecycleStore('test')
    previousStore.syncRuntimeWork(runtimeWork(task()))
    previousStore.executorStarted(address)

    const restoredStore = new RuntimeTaskLifecycleStore('test')
    restoredStore.syncRuntimeWork(
      runtimeWork(
        task({
          running: false,
          status: 'cancelled',
          completedAt: 1_786_692_066_192,
          turnStatus: 'interrupted',
        })
      )
    )

    expect(restoredStore.getTask(address)?.derived.shouldShowUnread).toBe(true)
    expect(localStorage.getItem('wework.runtimeTaskLifecycle.test.running')).toBe('[]')
  })

  test('marks background non-Goal completion unread and clears it when opened', () => {
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

  test.each(['paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const)(
    'settles execution when the Goal reports %s',
    goalStatus => {
      const store = new RuntimeTaskLifecycleStore('test')
      store.syncRuntimeWork(runtimeWork(task({ running: true, goalStatus: 'active' })))
      store.turnStarted(address, 'goal-turn')
      store.turnSettled(address, 'goal-turn')

      store.goalStatusReceived(address, goalStatus)

      expect(store.getTask(address)?.goalStatus).toBe(goalStatus)
      expect(store.getTask(address)?.execution.running).toBe(false)
      expect(store.getTask(address)?.turn.phase).toBe('idle')
    }
  )

  test('migrates optimistic lifecycle state when the executor resolves a new task identity', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const resolved = { ...address, taskId: 'resolved-task' }
    store.sendRequested(address, { workspaceCreationKind: 'worktree' })

    store.rename(address, resolved)
    store.sendAccepted(resolved)

    expect(store.getTask(address)).toBeNull()
    expect(store.getTask(resolved)?.execution.running).toBe(true)
    expect(store.getTask(resolved)?.turn.phase).toBe('awaiting')
    expect(store.getTask(resolved)?.workspaceCreationKind).toBe('worktree')
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
    const originalSetItem = Storage.prototype.setItem
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (key, value) {
        if (key === 'wework.runtimeTaskLifecycle.test.unread') {
          throw new Error('storage unavailable')
        }
        return originalSetItem.call(this, key, value)
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
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    store.executorSettled(address)
    store.goalStatusReceived(address, 'paused')

    expect(
      setItem.mock.calls.filter(([key]) => key === 'wework.runtimeTaskLifecycle.test.unread')
    ).toHaveLength(1)
    setItem.mockRestore()
  })

  test('gates every lifecycle mutation through one provider ownership boundary', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(
      runtimeWork(
        task({
          status: 'done',
          running: false,
          completedAt: 1_786_692_066_192,
          turnStatus: 'completed',
        })
      )
    )
    let ownsWrites = false
    const providerView = createRuntimeTaskLifecycleOwnershipView(store, () => ownsWrites)
    const settledSnapshot = store.getSnapshot()

    expect(providerView.subscribe).toBe(providerView.subscribe)
    expect(providerView.getSnapshot).toBe(providerView.getSnapshot)
    expect(providerView.syncRuntimeWork).toBe(providerView.syncRuntimeWork)

    providerView.syncRuntimeWork(runtimeWork(task({ status: 'active', running: true })))
    providerView.syncRuntimeTask(address, task({ status: 'active', running: true }))
    providerView.setCurrentTask(address)
    providerView.sendRequested(address)
    providerView.sendAccepted(address)
    providerView.sendRejected(address)
    providerView.sendBlockedByActiveTurn(address)
    providerView.stopRequested(address)
    providerView.stopRejected(address)
    providerView.executorStarted(address)
    providerView.executorSettled(address)
    providerView.turnStarted(address, 'hidden-turn')
    providerView.turnSettled(address, 'hidden-turn', 'succeeded')
    providerView.syncTranscript(address, {
      taskId: address.taskId,
      workspacePath: address.workspacePath ?? '',
      runtime: 'claude_code',
      running: true,
      messages: [],
      turns: [],
    })
    providerView.goalStatusReceived(address, 'active')
    providerView.markRead(address)
    providerView.rename(address, { ...address, taskId: 'hidden-renamed-task' })
    providerView.remove(address)

    expect(providerView.getSnapshot()).toBe(settledSnapshot)
    expect(providerView.getTask(address)?.derived.isRunning).toBe(false)
    expect(store.getTask({ ...address, taskId: 'hidden-renamed-task' })).toBeNull()

    ownsWrites = true
    providerView.turnStarted(address, 'owned-turn')

    expect(store.getTask(address)?.derived.isRunning).toBe(true)
    expect(store.getTask(address)?.turn.id).toBe('owned-turn')
  })
})
