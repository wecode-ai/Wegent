import type { RuntimeGoal } from '@/types/api'

export function isVisibleRuntimeGoal(goal: RuntimeGoal | null | undefined): goal is RuntimeGoal {
  return Boolean(goal && goal.status !== 'complete')
}

export function visibleRuntimeGoal(goal: RuntimeGoal | null | undefined): RuntimeGoal | null {
  return isVisibleRuntimeGoal(goal) ? goal : null
}
