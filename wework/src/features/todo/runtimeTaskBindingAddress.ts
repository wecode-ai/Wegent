import type { LoopItemTaskBinding } from '@/api/deliveries'
import type { RuntimeTaskAddress } from '@/types/api'

export function runtimeTaskBindingAddress(
  binding: Pick<
    LoopItemTaskBinding,
    'device_id' | 'task_id' | 'modelSelection' | 'executionContext'
  >
): RuntimeTaskAddress {
  const context = binding.executionContext
  return {
    deviceId: binding.device_id,
    taskId: binding.task_id,
    ...(context?.runtime ? { runtime: context.runtime } : {}),
    ...(context?.threadId ? { threadId: context.threadId } : {}),
    ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
    ...(context?.workspaceKind ? { workspaceKind: context.workspaceKind } : {}),
    ...(context?.worktreeId ? { worktreeId: context.worktreeId } : {}),
    ...(binding.modelSelection
      ? { runtimeHandle: { modelSelection: binding.modelSelection } }
      : {}),
  }
}
