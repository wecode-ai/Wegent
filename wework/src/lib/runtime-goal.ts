import type { RuntimeGoal, RuntimeTaskSummary, RuntimeGoalCreateInput } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'

export function runtimeGoalCreateInput(
  goal: Pick<RuntimeGoal, 'objective' | 'status' | 'tokenBudget'>
): RuntimeGoalCreateInput {
  return {
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
  }
}

export function isVisibleRuntimeGoal(goal: RuntimeGoal | null | undefined): goal is RuntimeGoal {
  return Boolean(goal && goal.status !== 'complete')
}

export function visibleRuntimeGoal(goal: RuntimeGoal | null | undefined): RuntimeGoal | null {
  return isVisibleRuntimeGoal(goal) ? goal : null
}

export function reconcileRuntimeGoal(
  current: RuntimeGoal | null,
  next: RuntimeGoal | null
): RuntimeGoal | null {
  if (!next || !current) return next
  // Native Goals use second precision; a matching native creation must own its
  // optimistic millisecond seed without admitting snapshots of an older Goal.
  if (
    current.threadId === 'pending' &&
    next.threadId !== 'pending' &&
    next.objective === current.objective &&
    next.tokenBudget === current.tokenBudget &&
    next.createdAt >= Math.floor(current.createdAt / 1000) * 1000
  ) {
    return next
  }
  return next.updatedAt < current.updatedAt ? current : next
}

export function projectRuntimeGoalContinuationActive({
  goal,
  execution,
}: {
  goal: RuntimeGoal | null
  execution: RuntimeTaskSummary['executionState']
}): boolean {
  return (
    goal?.status === 'active' &&
    execution?.phase !== 'idle' &&
    (execution?.phase === 'continuing' || execution?.continuation === true)
  )
}

export function projectRuntimeGoalContinuing(input: {
  goal: RuntimeGoal | null
  execution: RuntimeTaskSummary['executionState']
  activeAssistantMessage: WorkbenchMessage | null
}): boolean {
  if (!projectRuntimeGoalContinuationActive(input)) return false
  return (
    input.execution?.phase === 'continuing' ||
    !input.activeAssistantMessage ||
    !hasVisibleAssistantProjection(input.activeAssistantMessage)
  )
}

function hasVisibleAssistantProjection(message: WorkbenchMessage): boolean {
  return Boolean(
    message.content.trim() ||
    message.blocks?.length ||
    message.fileChanges ||
    message.references?.length ||
    message.memoryCitations?.length
  )
}
