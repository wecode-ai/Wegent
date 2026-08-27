import type {
  RuntimeGoal,
  RuntimeGoalContinuationPayload,
  RuntimeGoalCreateInput,
} from '@/types/api'
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

export function isRuntimeGoalContinuationTurn(
  messages: WorkbenchMessage[],
  activeAssistantMessage: WorkbenchMessage | null
): boolean {
  const activeTurnId =
    activeAssistantMessage?.turnId?.trim() || activeAssistantMessage?.subtaskId?.trim()
  if (!activeTurnId) return false

  return !messages.some(message => {
    if (message.role !== 'user') return false
    const messageTurnId = message.turnId?.trim() || message.subtaskId?.trim()
    return messageTurnId === activeTurnId
  })
}

export function projectRuntimeGoalContinuing({
  goal,
  continuation,
  taskRunning,
  messages,
  activeAssistantMessage,
}: {
  goal: RuntimeGoal | null
  continuation: RuntimeGoalContinuationPayload | null
  taskRunning: boolean
  messages: WorkbenchMessage[]
  activeAssistantMessage: WorkbenchMessage | null
}): boolean {
  if (goal?.status !== 'active') return false
  if (continuation?.status === 'started') return true
  return taskRunning && isRuntimeGoalContinuationTurn(messages, activeAssistantMessage)
}

export function shouldReconcileActiveRuntimeGoalTranscript({
  goalContinuing,
  messages,
  activeAssistantMessage,
}: {
  goalContinuing: boolean
  messages: WorkbenchMessage[]
  activeAssistantMessage: WorkbenchMessage | null
}): boolean {
  if (!goalContinuing || !activeAssistantMessage) return false

  return !messages.some(
    message =>
      message.id !== activeAssistantMessage.id &&
      message.role === 'assistant' &&
      message.status !== 'streaming' &&
      hasVisibleAssistantProjection(message)
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
