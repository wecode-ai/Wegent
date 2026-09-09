import type { RuntimePaneSendPhase } from '@/features/workbench/runtimePaneStatus'
import type { RuntimeTaskSummary } from '@/types/api'

export function isWorktreeCreationPending(
  task: RuntimeTaskSummary | null,
  sendPhase: RuntimePaneSendPhase,
  workspaceCreationKind?: string
): boolean {
  if (sendPhase !== 'submitting') return false
  if (!task) return Boolean(workspaceCreationKind)
  return task.optimistic === true && task.status === 'creating' && task.workspaceKind === 'worktree'
}
