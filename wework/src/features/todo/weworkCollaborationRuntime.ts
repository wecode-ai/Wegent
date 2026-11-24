import {
  toSharedIssueDetailTaskBinding,
  type CollaborationPlatformLocation,
  type CollaborationProject,
  type SharedIssueDetailTaskExecutionState,
  type WorkspaceTaskBinding,
} from '@wegent/collaboration'

import { type CloudProject, type LoopItemTaskBinding } from '@/api/deliveries'

import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'

import type {
  ModelSelectionConfig,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'

import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import { hydrateRuntimeTaskAddress } from '@/features/workbench/workbenchRuntimeHelpers'
import { runtimeTaskTrackingExecutionStatus } from '@/features/workbench/runtimeTaskLifecycle/projection'

import { type RuntimeTaskConversationStatus } from './runtimeTaskConversationStatus'

import { projectSpaceForRuntimeTask, sameProjectSpace } from './projectSpaceSelection'

export const initialLocation: CollaborationPlatformLocation = {
  platformView: 'spaces',
  collaborationDomain: 'local',
  workspaceId: null,
  workspaceView: 'home',
  projectId: null,
  projectView: 'board',
  issueId: null,
}
export function routeProjectLocation(
  projectRef: RuntimeProjectSpaceRef | null,
  focusedItemId: string | null
): CollaborationPlatformLocation | null {
  if (!projectRef) return null
  return {
    platformView: 'spaces',
    collaborationDomain: projectRef.projectStore === 'local' ? 'local' : 'cloud',
    workspaceId: null,
    workspaceView: 'projects',
    projectId: String(projectRef.projectId),
    projectView: 'board',
    issueId: focusedItemId,
  }
}
export function issueTaskExecutionStates(
  bindings: WorkspaceTaskBinding[],
  runtimeStatuses: ReadonlyMap<string, RuntimeTaskConversationStatus>
): Readonly<Record<string, SharedIssueDetailTaskExecutionState>> {
  const states: Record<string, SharedIssueDetailTaskExecutionState> = {}
  for (const binding of bindings) {
    const status = runtimeStatuses.get(
      runtimeConversationKey({ deviceId: binding.deviceId, taskId: binding.taskId })
    )
    if (status) states[String(binding.id)] = { status }
  }
  return states
}
export function projectRuntimeStatusSignature(
  runtimeTaskLifecycle: RuntimeTaskLifecycleStoreSnapshot | undefined,
  project: RuntimeProjectSpaceRef
): string {
  return [...(runtimeTaskLifecycle?.tasks.entries() ?? [])]
    .flatMap(([key, lifecycle]) => {
      if (!sameProjectSpace(projectSpaceForRuntimeTask(lifecycle.address), project)) return []
      const status = runtimeTaskTrackingExecutionStatus(lifecycle)
      return status ? [`${key}:${status}:${lifecycle.task?.title ?? ''}`] : []
    })
    .sort()
    .join('|')
}
export function toWeworkIssueTaskBinding(binding: WorkspaceTaskBinding): LoopItemTaskBinding {
  const mapped = toSharedIssueDetailTaskBinding(binding)
  return {
    ...mapped,
    modelSelection: mapped.modelSelection as LoopItemTaskBinding['modelSelection'],
  }
}
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
export function normalizeWorkspaceRoot(root: string): string {
  const trimmed = root.trim()
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed)
  const normalized = isWindowsPath ? trimmed.replaceAll('\\', '/').toLowerCase() : trimmed
  if (normalized === '/' || /^[a-z]:\/$/i.test(normalized)) return normalized
  return normalized.replace(isWindowsPath ? /\/+$/ : /[\\/]+$/, '')
}
export function projectWorkspaceRoots(project: CollaborationProject): string[] {
  const roots = project.metadata?.workspace_roots
  return Array.isArray(roots)
    ? roots
        .filter((root): root is string => typeof root === 'string')
        .map(normalizeWorkspaceRoot)
        .filter(Boolean)
    : []
}
