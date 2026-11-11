import type { LoopItemTaskBinding, CloudProject } from '@/api/deliveries'
import type { WorkspaceTaskBinding } from '@wegent/collaboration'
import type { ModelSelectionConfig, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { hydrateRuntimeTaskAddress } from '@/features/workbench/workbenchRuntimeHelpers'

export function collaborationTaskAddress(
  binding: {
    deviceId: string
    taskId: string
    modelSelection?: ModelSelectionConfig | null
    executionContext?: {
      runtime?: string | null
      threadId?: string | null
      workspacePath?: string | null
      workspaceKind?: string | null
      worktreeId?: string | null
    } | null
  },
  runtimeWork?: RuntimeWorkListResponse | null,
  projectSession?: RuntimeTaskAddress['projectSession'],
  issueExecution?: RuntimeTaskAddress['issueExecution']
): RuntimeTaskAddress {
  const hydrated = hydrateRuntimeTaskAddress(runtimeWork, {
    deviceId: binding.deviceId,
    taskId: binding.taskId,
  })
  const context = binding.executionContext
  return {
    ...hydrated,
    ...(context?.runtime ? { runtime: context.runtime } : {}),
    ...(context?.threadId ? { threadId: context.threadId } : {}),
    ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
    ...(context?.workspaceKind ? { workspaceKind: context.workspaceKind } : {}),
    ...(context?.worktreeId ? { worktreeId: context.worktreeId } : {}),
    ...(binding.modelSelection
      ? {
          runtimeHandle: {
            ...(hydrated.runtimeHandle ?? {}),
            modelSelection: binding.modelSelection,
          },
        }
      : {}),
    ...(issueExecution ? { issueExecution } : {}),
    ...(projectSession ? { projectSession } : {}),
  }
}

export function issueExecutionAddress(
  binding: Pick<
    LoopItemTaskBinding,
    'device_id' | 'task_id' | 'modelSelection' | 'executionContext'
  >,
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: string,
  issueId: string,
  projectStore: CloudProject['project_store']
): RuntimeTaskAddress {
  const issueExecution = { projectId, issueId }
  return collaborationTaskAddress(
    {
      deviceId: binding.device_id,
      taskId: binding.task_id,
      modelSelection: binding.modelSelection,
      executionContext: binding.executionContext,
    },
    runtimeWork,
    projectStore === 'backend' ? issueExecution : undefined,
    issueExecution
  )
}

export function workspaceExecutionAddress(
  binding: WorkspaceTaskBinding,
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  issueId: string,
  projectStore: CloudProject['project_store']
): RuntimeTaskAddress {
  const issueExecution = { projectId: binding.projectId, issueId }
  return collaborationTaskAddress(
    {
      deviceId: binding.deviceId,
      taskId: binding.taskId,
      modelSelection: binding.modelSelection,
      executionContext: binding.executionContext,
    },
    runtimeWork,
    projectStore === 'backend' ? issueExecution : undefined,
    issueExecution
  )
}
