import { describe, expect, test } from 'vitest'
import type { RuntimeGoal, RuntimeTaskSummary } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { projectRuntimeGoalContinuing, projectRuntimeGoalContinuationActive } from './runtime-goal'

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

const execution: NonNullable<RuntimeTaskSummary['executionState']> = {
  revision: '2',
  phase: 'running',
  turnId: 'turn-2',
  latestTurnId: 'turn-2',
  outcome: null,
  continuation: true,
}

describe('native Goal presentation', () => {
  test('uses the native continuation snapshot without a separate event cache', () => {
    expect(
      projectRuntimeGoalContinuing({
        goal: activeGoal,
        execution,
        activeAssistantMessage: continuedAssistantMessage,
      })
    ).toBe(true)
  })
  test.each([
    { content: 'Checking CI results' },
    {
      blocks: [
        { id: 'tool-1', type: 'tool', status: 'running', toolName: 'exec_command', toolInput: {} },
      ],
    },
  ] as Partial<WorkbenchMessage>[])(
    'keeps continuation active without treating visible output as startup',
    output => {
      const input = {
        goal: activeGoal,
        execution,
        activeAssistantMessage: { ...continuedAssistantMessage, ...output },
      }
      expect(projectRuntimeGoalContinuationActive(input)).toBe(true)
      expect(projectRuntimeGoalContinuing(input)).toBe(false)
    }
  )
  test('settles presentation only after authoritative execution settlement', () => {
    expect(
      projectRuntimeGoalContinuing({
        goal: activeGoal,
        execution: { ...execution, phase: 'idle', turnId: null },
        activeAssistantMessage: continuedAssistantMessage,
      })
    ).toBe(false)
  })
  test('does not project the initial request turn as Goal continuation', () => {
    expect(
      projectRuntimeGoalContinuing({
        goal: activeGoal,
        execution: { ...execution, continuation: false },
        activeAssistantMessage: continuedAssistantMessage,
      })
    ).toBe(false)
  })
  test('shows continuation between turns without showing an active assistant', () => {
    expect(
      projectRuntimeGoalContinuing({
        goal: activeGoal,
        execution: { ...execution, phase: 'continuing', turnId: null },
        activeAssistantMessage: null,
      })
    ).toBe(true)
  })
  test('does not project inactive Goals or unknown execution as continuing', () => {
    for (const status of ['paused', 'blocked', 'complete'] as const) {
      expect(
        projectRuntimeGoalContinuationActive({ goal: { ...activeGoal, status }, execution })
      ).toBe(false)
    }
    expect(projectRuntimeGoalContinuationActive({ goal: activeGoal, execution: undefined })).toBe(
      false
    )
  })
})
