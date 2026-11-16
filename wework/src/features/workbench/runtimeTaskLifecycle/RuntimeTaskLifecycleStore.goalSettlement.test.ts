import { describe, expect, test } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const address: RuntimeTaskAddress = { deviceId: 'cloud-device', taskId: 'goal-task' }
const runningTask: RuntimeTaskSummary = {
  taskId: address.taskId,
  workspacePath: '/workspace',
  title: 'Goal task',
  runtime: 'codex',
  continuable: true,
  running: true,
  status: 'running',
  threadStatus: 'active',
  turnStatus: 'inProgress',
  goalStatus: 'active',
  goalExecutionStatus: 'running',
  updatedAt: 1792771365735,
}
const completedTranscript = {
  taskId: address.taskId,
  messages: [],
  running: false,
  turns: [{ id: 'goal-turn', status: 'completed', completedAt: 1792771365000, items: [] }],
}

describe('Goal settlement with an older executor projection', () => {
  test.each(['before', 'after'] as const)(
    'does not revive completed work when the Goal settles %s its transcript',
    order => {
      const store = new RuntimeTaskLifecycleStore(`goal-settlement-${order}`)
      store.syncRuntimeTask(address, runningTask)
      store.turnStarted(address, 'goal-turn')

      if (order === 'before') store.goalStatusReceived(address, 'complete')
      store.turnSettled(address, 'goal-turn', 'succeeded')
      store.syncTranscript(address, completedTranscript)
      if (order === 'after') store.goalStatusReceived(address, 'complete')
      store.syncRuntimeTask(address, runningTask)

      expect(store.getTask(address)?.task).toMatchObject({
        running: false,
        status: 'done',
        goalStatus: 'complete',
        goalExecutionStatus: null,
      })
      expect(store.getTask(address)?.derived).toMatchObject({
        isBusy: false,
        canSend: true,
        shouldShowSidebarRunning: false,
      })
    }
  )

  test('does not settle a live turn merely because the Goal completes', () => {
    const store = new RuntimeTaskLifecycleStore('goal-complete-during-turn')
    store.syncRuntimeTask(address, runningTask)
    store.turnStarted(address, 'goal-turn')

    store.goalStatusReceived(address, 'complete')

    expect(store.getTask(address)?.derived.isBusy).toBe(true)
    expect(store.getTask(address)?.turn.id).toBe('goal-turn')
  })

  test('retains active Goal recovery between turns', () => {
    const store = new RuntimeTaskLifecycleStore('goal-still-active')
    store.syncRuntimeTask(address, { ...runningTask, goalExecutionStatus: 'recovering' })
    store.turnStarted(address, 'goal-turn')
    store.turnSettled(address, 'goal-turn', 'succeeded')

    store.syncTranscript(address, completedTranscript)
    store.syncRuntimeTask(address, {
      ...runningTask,
      running: false,
      status: 'queued',
      completedAt: completedTranscript.turns[0].completedAt,
      updatedAt: 1792771366735,
      goalExecutionStatus: 'recovering',
    })
    store.goalStatusReceived(address, 'active')

    expect(store.getTask(address)?.derived.isBusy).toBe(true)
    expect(store.getTask(address)?.task?.goalExecutionStatus).toBe('recovering')
  })
})
