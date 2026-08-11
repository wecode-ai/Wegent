import type { RuntimePaneSendPhase } from '@/features/workbench/runtimePaneStatus'
import type { RuntimeTaskSummary } from '@/types/api'

export function isWorktreeCreationPending(
  task: RuntimeTaskSummary | null,
  sendPhase: RuntimePaneSendPhase
): boolean {
  return (
    task?.optimistic === true &&
    task.status === 'creating' &&
    task.workspaceKind === 'worktree' &&
    sendPhase === 'submitting'
  )
}
