import type { ProjectWithTasks } from '@/types/api'
import { isWorktreeEligibleProject } from './projectClassification'
import {
  probeWorkspaceWorktreeAvailability,
  resolveWorkspaceWorktreeAvailability,
  type ProbeWorkspaceWorktreeAvailabilityInput,
  type ResolveWorkspaceWorktreeAvailabilityInput,
} from '@wegent/chat-core/worktree-availability'

export {
  deviceSupportsManagedWorktrees,
  worktreeWorkspaceDeviceId,
} from '@wegent/chat-core/worktree-availability'
export type {
  ProjectWorktreeAvailability,
  ProjectWorktreeAvailabilityApi,
  ProjectWorktreeAvailabilityReason,
} from '@wegent/chat-core/worktree-availability'

export interface ResolveProjectWorktreeAvailabilityInput extends Omit<
  ResolveWorkspaceWorktreeAvailabilityInput,
  'projectUnavailableReason'
> {
  project: ProjectWithTasks | null | undefined
}

export interface ProbeProjectWorktreeAvailabilityInput extends Omit<
  ProbeWorkspaceWorktreeAvailabilityInput,
  'projectUnavailableReason'
> {
  project: ProjectWithTasks | null | undefined
}

function projectUnavailableReason(project: ProjectWithTasks | null | undefined) {
  return !project
    ? ('no_project' as const)
    : !isWorktreeEligibleProject(project)
      ? ('project_ineligible' as const)
      : undefined
}

export function resolveProjectWorktreeAvailability({
  project,
  ...input
}: ResolveProjectWorktreeAvailabilityInput) {
  return resolveWorkspaceWorktreeAvailability({
    ...input,
    projectUnavailableReason: projectUnavailableReason(project),
  })
}

export function probeProjectWorktreeAvailability({
  project,
  ...input
}: ProbeProjectWorktreeAvailabilityInput) {
  return probeWorkspaceWorktreeAvailability({
    ...input,
    projectUnavailableReason: projectUnavailableReason(project),
  })
}
