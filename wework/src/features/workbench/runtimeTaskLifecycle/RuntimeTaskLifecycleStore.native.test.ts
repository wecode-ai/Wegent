import { describe, expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { deriveRuntimePaneStatus } from '../runtimePaneStatus'

const address = { deviceId: 'device-1', taskId: 'task-1', workspacePath: '/project' }

function task(
  revision: string,
  phase: NonNullable<RuntimeTaskSummary['executionState']>['phase'],
  turnId: string | null,
  latestTurnId = turnId
): RuntimeTaskSummary {
  return {
    ...address,
    title: 'Native Goal',
    runtime: 'codex',
    goalStatus: 'active',
    running: phase !== 'idle' && phase !== 'queued',
    continuable: true,
    executionState: {
      revision,
      epoch: 'executor-1',
      phase,
      turnId,
      latestTurnId,
      outcome: turnId ? null : 'succeeded',
    },
  }
}

describe('native lifecycle ownership', () => {
  test('keeps queued Goal recovery owned without inventing a running model turn', () => {
    const store = new RuntimeTaskLifecycleStore('native-goal-recovery-admission')
    store.syncRuntimeTask(address, {
      ...task('2', 'recovering', null),
      running: false,
      status: 'queued',
      goalExecutionStatus: 'recovering',
    })
    const lifecycle = store.getTask(address)!
    expect(lifecycle.derived.shouldShowSidebarRunning).toBe(true)
    expect(lifecycle.turn.active).toBe(false)
    const pane = deriveRuntimePaneStatus({ messages: [], currentRuntimeTask: address, lifecycle })
    expect(pane.isBusy).toBe(true)
    expect(pane.isWaitingForAssistantIndicator).toBe(false)
  })
  test('queue cancellation releases admission and rejects a delayed queued snapshot', () => {
    const store = new RuntimeTaskLifecycleStore('native-queue-cancel')
    store.syncRuntimeTask(address, { ...task('2', 'queued', null, 'old-turn'), status: 'queued' })
    expect(store.getTask(address)?.execution.phase).toBe('queued')
    expect(store.getTask(address)?.derived.isBusy).toBe(true)
    expect(store.getTask(address)?.execution.running).toBe(false)
    expect(store.getTask(address)?.turn.active).toBe(false)
    const cancelled = task('3', 'idle', null, 'old-turn')
    cancelled.executionState!.executionOutcome = 'cancelled'
    store.syncRuntimeTask(address, cancelled)
    store.syncRuntimeTask(address, task('2', 'queued', null, 'old-turn'))
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.derived.isBusy).toBe(false)
    expect(store.getTask(address)?.derived.canSend).toBe(true)
  })
  test('invalidates execution evidence from a replaced executor before accepting its new snapshot', () => {
    const store = new RuntimeTaskLifecycleStore('native-executor-replacement')
    store.syncRuntimeTask(address, task('100', 'running', 'old-turn'))
    store.invalidateNativeExecutions()
    expect(store.getTask(address)?.execution.known).toBe(false)
    expect(store.getTask(address)?.derived.isThinking).toBe(false)
    const next = task('1', 'idle', null, 'old-turn')
    next.executionState!.epoch = 'executor-2'
    store.syncRuntimeTask(address, next)
    store.syncRuntimeTask(address, task('101', 'running', 'old-turn'))
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.derived.isBusy).toBe(false)
  })
  test('RPC completion cannot stop an existing Goal continuation', () => {
    const store = new RuntimeTaskLifecycleStore('native-rpc-handoff')
    store.syncRuntimeTask(address, task('1793351778604000000', 'running', 'turn-2'))
    store.turnSettled(address, 'turn-1', 'succeeded')
    store.executorSettled(address)
    const lifecycle = store.getTask(address)!
    const pane = deriveRuntimePaneStatus({ messages: [], currentRuntimeTask: address, lifecycle })
    expect(lifecycle.derived.shouldShowSidebarRunning).toBe(true)
    expect(lifecycle.turn.id).toBe('turn-2')
    expect(pane.taskExecution.running).toBe(true)
    expect(pane.isBusy).toBe(true)
    expect(pane.canSendQueuedMessage).toBe(false)
  })

  test('orders snapshots precisely even beyond the JavaScript integer limit', () => {
    const store = new RuntimeTaskLifecycleStore('native-snapshot-order')
    store.syncRuntimeTask(address, task('1793351778604000001', 'running', 'turn-2'))
    store.syncRuntimeTask(address, task('1793351778604000000', 'idle', null, 'turn-1'))
    expect(store.getTask(address)?.turn.id).toBe('turn-2')
    expect(store.getTask(address)?.execution.running).toBe(true)
  })

  test('history and an unversioned task snapshot cannot override native state', () => {
    const store = new RuntimeTaskLifecycleStore('native-history-order')
    store.syncRuntimeTask(address, task('2', 'running', 'turn-2'))
    store.syncTranscript(address, {
      taskId: address.taskId,
      messages: [],
      turns: [{ id: 'turn-1', status: 'done', items: [], completedAt: 100 }],
      running: false,
    })
    const old = task('1', 'idle', null, 'turn-1')
    delete old.executionState
    store.syncRuntimeTask(address, old)
    expect(store.getTask(address)?.turn.id).toBe('turn-2')
    expect(store.getTask(address)?.execution.running).toBe(true)
  })

  test('keeps the between-turn phase busy without inventing an active turn', () => {
    const store = new RuntimeTaskLifecycleStore('native-between-turns')
    store.syncRuntimeTask(address, task('2', 'continuing', null, 'turn-1'))
    expect(store.getTask(address)?.derived.isBusy).toBe(true)
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(true)
    expect(store.getTask(address)?.turn.id).toBeNull()
  })

  test('late content cannot revive a genuinely stopped execution', () => {
    const store = new RuntimeTaskLifecycleStore('native-stopped-content')
    store.syncRuntimeTask(address, task('3', 'idle', null, 'turn-2'))
    store.turnStarted(address, 'turn-2')
    store.executorStarted(address)
    expect(store.getTask(address)?.derived.isBusy).toBe(false)
    expect(store.getTask(address)?.derived.isThinking).toBe(false)
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('completing the Goal does not stop the still-open native turn', () => {
    const store = new RuntimeTaskLifecycleStore('native-goal-complete-open-turn')
    store.syncRuntimeTask(address, task('2', 'running', 'turn-2'))
    store.goalStatusReceived(address, 'complete')
    expect(store.getTask(address)?.execution.running).toBe(true)
  })
})
