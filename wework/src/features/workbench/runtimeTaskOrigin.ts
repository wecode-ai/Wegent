import type { RuntimeTaskSummary } from '@/types/api'

function runtimeTaskOrigin(task: Pick<RuntimeTaskSummary, 'runtimeHandle'>) {
  const origin = task.runtimeHandle?.origin
  return origin && typeof origin === 'object' ? (origin as Record<string, unknown>) : null
}

export function runtimeTaskBoardOrigin(
  task: Pick<RuntimeTaskSummary, 'runtimeHandle'>
): 'board_comment' | 'board_task' | null {
  const type = runtimeTaskOrigin(task)?.type
  return type === 'board_comment' || type === 'board_task' ? type : null
}

export function isProjectAutomationManagerRuntimeTask(
  task: Pick<RuntimeTaskSummary, 'runtimeHandle'>
): boolean {
  const origin = runtimeTaskOrigin(task)
  return origin?.type === 'project_automation' && origin.automationRole === 'manager'
}
