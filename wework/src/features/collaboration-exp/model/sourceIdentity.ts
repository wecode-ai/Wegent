import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import type {
  CollaborationProject,
  IssueParticipationViewer,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type { ExperienceProjectScope } from './types'

export function matchesExperienceViewer(
  id: string | number,
  viewer: IssueParticipationViewer
): boolean {
  const principals = typeof viewer === 'object' ? viewer : [viewer]
  return principals.some(principal => String(principal) === String(id))
}

export function projectViewer(
  project: CollaborationProject,
  viewer: IssueParticipationViewer,
  participationViewer?: IssueParticipationViewer
): IssueParticipationViewer {
  if (project.project_store === 'local' && participationViewer !== undefined)
    return participationViewer
  return project.current_user_id ?? viewer
}

export function projectScopeOf(project: CollaborationProject): ExperienceProjectScope {
  return {
    key: JSON.stringify([project.project_store, project.id]),
    id: project.id,
    store: project.project_store,
    name: project.name,
    projectKey: project.project_key,
  }
}

export function runtimeAddressKey(
  address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>
): string {
  return JSON.stringify([address.deviceId, address.taskId])
}

export function knownRuntimeAddress(
  address: RuntimeTaskAddress | null | undefined
): address is RuntimeTaskAddress {
  return Boolean(address?.deviceId && address.taskId)
}

export function bindingAddress(
  binding: WorkspaceTaskBinding,
  runtimeWork?: RuntimeWorkListResponse | null
): RuntimeTaskAddress {
  const context = binding.executionContext
  const task = findRuntimeTask(runtimeWork, binding)
  return {
    deviceId: binding.deviceId,
    taskId: binding.taskId,
    ...(context?.runtime || task?.runtime
      ? { runtime: context?.runtime ?? task?.runtime ?? undefined }
      : {}),
    ...(context?.threadId || task?.threadId
      ? { threadId: context?.threadId ?? task?.threadId }
      : {}),
    ...(context?.workspacePath || task?.workspacePath
      ? { workspacePath: context?.workspacePath ?? task?.workspacePath }
      : {}),
    ...(context?.workspaceKind || task?.workspaceKind
      ? { workspaceKind: context?.workspaceKind ?? task?.workspaceKind }
      : {}),
    ...(context?.worktreeId || task?.worktreeId
      ? { worktreeId: context?.worktreeId ?? task?.worktreeId }
      : {}),
  }
}

export function validSourceTimestamp(value: string | null | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null
}
