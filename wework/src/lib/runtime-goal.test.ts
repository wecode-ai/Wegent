import { describe, expect, test } from 'vitest'
import type { RuntimeGoal, RuntimeGoalContinuationPayload } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  isRuntimeGoalContinuationTurn,
  projectRuntimeGoalContinuing,
  shouldReconcileActiveRuntimeGoalTranscript,
  updateRuntimeGoalContinuation,
} from './runtime-goal'

const started: RuntimeGoalContinuationPayload = {
  taskId: 'task-1',
  deviceId: 'device-1',
  threadId: 'thread-1',
  turnId: 'turn-2',
  status: 'started',
}

const activeGoal: RuntimeGoal = {
  threadId: 'thread-1',
  objective: 'Keep working',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1787618000000,
  updatedAt: 1787618000000,
}

const initialUserMessage: WorkbenchMessage = {
  id: 'user-1',
  role: 'user',
  content: 'Start the Goal',
  status: 'done',
  turnId: 'turn-1',
  subtaskId: 'turn-1',
  createdAt: '2026-08-25T00:00:00.000Z',
}

const continuedAssistantMessage: WorkbenchMessage = {
  id: 'assistant-2',
  role: 'assistant',
  content: '',
  status: 'streaming',
  runtimeStatus: 'streaming',
  turnId: 'turn-2',
  subtaskId: 'turn-2',
  createdAt: '2026-08-25T00:00:01.000Z',
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

  test('projects an assistant-only active turn as Goal continuation when its event was missed', () => {
    const messages = [initialUserMessage, continuedAssistantMessage]

    expect(isRuntimeGoalContinuationTurn(messages, continuedAssistantMessage)).toBe(true)
    expect(
      projectRuntimeGoalContinuing({
        goal: activeGoal,
        continuation: null,
        taskRunning: true,
        messages,
        activeAssistantMessage: continuedAssistantMessage,
      })
    ).toBe(true)
  })

  test('does not project the initial Goal turn as continuation', () => {
    const initialAssistantMessage: WorkbenchMessage = {
      ...continuedAssistantMessage,
      id: 'assistant-1',
      turnId: 'turn-1',
      subtaskId: 'turn-1',
    }
    const messages = [initialUserMessage, initialAssistantMessage]

    expect(isRuntimeGoalContinuationTurn(messages, initialAssistantMessage)).toBe(false)
    expect(
      projectRuntimeGoalContinuing({
        goal: activeGoal,
        continuation: null,
        taskRunning: true,
        messages,
        activeAssistantMessage: initialAssistantMessage,
      })
    ).toBe(false)
  })

  test('requests transcript reconciliation until the previous Goal result is visible', () => {
    expect(
      shouldReconcileActiveRuntimeGoalTranscript({
        goalContinuing: true,
        messages: [initialUserMessage, continuedAssistantMessage],
        activeAssistantMessage: continuedAssistantMessage,
      })
    ).toBe(true)

    expect(
      shouldReconcileActiveRuntimeGoalTranscript({
        goalContinuing: true,
        messages: [
          initialUserMessage,
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Initial Goal result',
            status: 'done',
            turnId: 'turn-1',
            subtaskId: 'turn-1',
            createdAt: '2026-08-25T00:00:01.000Z',
          },
          continuedAssistantMessage,
        ],
        activeAssistantMessage: continuedAssistantMessage,
      })
    ).toBe(false)
  })
})
