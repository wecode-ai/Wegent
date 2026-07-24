import { describe, expect, test } from 'vitest'
import type { RuntimeGoalContinuationPayload } from '@/types/api'
import { updateRuntimeGoalContinuation } from './runtime-goal'

const started: RuntimeGoalContinuationPayload = {
  taskId: 'task-1',
  deviceId: 'device-1',
  threadId: 'thread-1',
  turnId: 'turn-2',
  status: 'started',
}

describe('runtime goal continuation', () => {
  test('stays active when the continued turn starts producing assistant output', () => {
    const continuing = updateRuntimeGoalContinuation(null, {
      type: 'turn_lifecycle',
      payload: started,
    })

    expect(updateRuntimeGoalContinuation(continuing, { type: 'assistant_started' })).toEqual(
      started
    )
  })

  test('settles only when the turn lifecycle settles or the goal becomes inactive', () => {
    expect(
      updateRuntimeGoalContinuation(started, {
        type: 'turn_lifecycle',
        payload: { ...started, status: 'settled' },
      })
    ).toBeNull()
    expect(updateRuntimeGoalContinuation(started, { type: 'goal_inactive' })).toBeNull()
  })
})
