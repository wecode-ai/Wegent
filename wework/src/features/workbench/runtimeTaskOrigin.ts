import type { RuntimeTaskSummary } from '@/types/api'

function runtimeTaskOrigin(task: Pick<RuntimeTaskSummary, 'runtimeHandle'>) {
  const origin = task.runtimeHandle?.origin
  return origin && typeof origin === 'object' ? (origin as Record<string, unknown>) : null
}

export function isProjectAutomationManagerRuntimeTask(
  task: Pick<RuntimeTaskSummary, 'runtimeHandle'>
): boolean {
  const origin = runtimeTaskOrigin(task)
  return origin?.type === 'project_automation' && origin.automationRole === 'manager'
}
