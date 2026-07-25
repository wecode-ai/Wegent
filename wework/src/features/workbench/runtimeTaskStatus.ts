import type { RuntimeTaskSummary } from '@/types/api'

export function isRuntimeTaskRunning(task: RuntimeTaskSummary): boolean {
  return task.running === true
}
