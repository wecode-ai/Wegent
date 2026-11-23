import {
  cardSessionAddress,
  type TaskReplyCard,
} from '@wegent/collaboration/execution/taskCardReply'

import type { LoopItemTaskBinding } from '@/api/deliveries'

import type { RuntimeTaskAddress } from '@/types/api'

export function boundCardSessionAddress(
  card: TaskReplyCard,
  taskBindings: LoopItemTaskBinding[]
): RuntimeTaskAddress | null {
  const address = cardSessionAddress(card)
  if (!address) return null
  const binding = taskBindings.find(
    candidate => candidate.device_id === address.deviceId && candidate.task_id === address.taskId
  )
  if (!binding) return address
  const context = binding.executionContext
  return {
    ...address,
    ...(context?.runtime ? { runtime: context.runtime as RuntimeTaskAddress['runtime'] } : {}),
    ...(context?.threadId ? { threadId: context.threadId } : {}),
    ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
    ...(context?.workspaceKind ? { workspaceKind: context.workspaceKind } : {}),
    ...(context?.worktreeId ? { worktreeId: context.worktreeId } : {}),
    ...(binding.modelSelection
      ? {
          runtimeHandle: {
            ...address.runtimeHandle,
            modelSelection: binding.modelSelection,
          },
        }
      : {}),
  }
}
export function isVersionConflict(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false
  if ('status' in cause && cause.status === 409) return true
  if ('code' in cause && cause.code === 'version_conflict') return true
  return 'errorCode' in cause && cause.errorCode === 'version_conflict'
}
