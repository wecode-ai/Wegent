import type { RuntimeGoal, RuntimeGoalContinuationPayload } from '@/types/api'

export function isVisibleRuntimeGoal(goal: RuntimeGoal | null | undefined): goal is RuntimeGoal {
  return Boolean(goal && goal.status !== 'complete')
}

export function visibleRuntimeGoal(goal: RuntimeGoal | null | undefined): RuntimeGoal | null {
  return isVisibleRuntimeGoal(goal) ? goal : null
}

export function updateRuntimeGoalContinuation(
  current: RuntimeGoalContinuationPayload | null,
  event:
    | { type: 'assistant_started' }
    | { type: 'goal_inactive' }
    | { type: 'turn_lifecycle'; payload: RuntimeGoalContinuationPayload }
): RuntimeGoalContinuationPayload | null {
  if (event.type === 'assistant_started') return current
  if (event.type === 'goal_inactive') return null
  return event.payload.status === 'started' ? event.payload : null
}
