import type { RuntimeTaskSummary } from '@/types/api'

export function runtimeTaskBoardOrigin(
  task: Pick<RuntimeTaskSummary, 'runtimeHandle'>
): 'board_comment' | 'board_task' | null {
  const origin = task.runtimeHandle?.origin
  if (!origin || typeof origin !== 'object') return null
  const type = (origin as { type?: unknown }).type
  return type === 'board_comment' || type === 'board_task' ? type : null
}
