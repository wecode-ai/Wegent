import type { ProjectWithTasks, RuntimeDeviceWorkspace } from '@/types/api'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { normalizeRuntimeWorkspacePath } from '@/lib/runtime-project'

export function resolveConversationSummaryIsGitRepository({
  activeWorkspacePath,
  environmentInfo,
  project,
  projectWorkspace,
}: {
  activeWorkspacePath?: string | null
  environmentInfo: EnvironmentInfo
  project: ProjectWithTasks | null
  projectWorkspace: Pick<
    RuntimeDeviceWorkspace,
    'repoRootFingerprint' | 'repoUrl' | 'workspacePath'
  > | null
}): boolean | undefined {
  const rawEnvironmentWorkspacePath = environmentInfo.workspacePath
  const environmentWorkspacePath = rawEnvironmentWorkspacePath
    ? normalizeRuntimeWorkspacePath(rawEnvironmentWorkspacePath)
    : ''
  const normalizedActiveWorkspacePath = activeWorkspacePath
    ? normalizeRuntimeWorkspacePath(activeWorkspacePath)
    : ''
  if (
    environmentInfo.isGitRepository !== undefined &&
    environmentWorkspacePath &&
    environmentWorkspacePath === normalizedActiveWorkspacePath
  ) {
    return environmentInfo.isGitRepository
  }
  if (project?.config?.workspace?.source === 'git') return true
  if (
    Boolean(environmentInfo.branchName?.trim()) ||
    Boolean(environmentInfo.additions || environmentInfo.deletions)
  ) {
    return true
  }
  const projectWorkspacePaths = [
    project?.config?.workspace?.localPath,
    projectWorkspace?.workspacePath,
  ].flatMap(path => (path ? [normalizeRuntimeWorkspacePath(path)] : []))
  if (
    environmentInfo.isGitRepository !== undefined &&
    environmentWorkspacePath &&
    projectWorkspacePaths.includes(environmentWorkspacePath)
  ) {
    return environmentInfo.isGitRepository
  }
  if (projectWorkspace) {
    if (projectWorkspace.repoRootFingerprint?.trim() || projectWorkspace.repoUrl?.trim()) {
      return true
    }
    return environmentInfo.isGitRepository === undefined ? undefined : false
  }
  return environmentInfo.isGitRepository
}

export function resolveSelectedWorkspaceProject({
  currentProject,
  currentProjectId,
  projects,
}: {
  currentProject: ProjectWithTasks | null | undefined
  currentProjectId: number | undefined
  projects: ProjectWithTasks[]
}): ProjectWithTasks | null {
  if (currentProjectId == null) return null
  if (currentProject?.id === currentProjectId) return currentProject
  return projects.find(project => project.id === currentProjectId) ?? null
}

export function applySharedChangeRequestSnapshot(
  environmentInfo: EnvironmentInfo,
  snapshot: TaskChangeRequestSnapshot
): EnvironmentInfo {
  const provider = snapshot.provider ?? snapshot.changeRequest?.provider
  const previous = snapshot.changeRequest ?? environmentInfo.changeRequest?.changeRequest
  if ((snapshot.error || snapshot.stale) && previous) {
    return {
      ...environmentInfo,
      changeRequest: { provider: previous.provider, state: 'found', changeRequest: previous },
      changeRequestObservation: snapshot.observation ?? {
        state: snapshot.lookupState === 'unauthenticated' ? 'auth_required' : 'error',
        transport: 'poll',
        lastSuccessAt: null,
        stale: true,
        error: snapshot.error,
      },
    }
  }
  if (
    provider &&
    snapshot.lookupState &&
    ['unavailable', 'unauthenticated', 'error'].includes(snapshot.lookupState)
  ) {
    return {
      ...environmentInfo,
      changeRequest: {
        provider,
        state: snapshot.lookupState,
      },
    }
  }
  if (snapshot.error || snapshot.stale) return environmentInfo
  if (
    environmentInfo.changeRequest &&
    ['unavailable', 'unauthenticated', 'error'].includes(environmentInfo.changeRequest.state)
  ) {
    return environmentInfo
  }
  const resolvedProvider = provider ?? environmentInfo.changeRequest?.provider
  if (!resolvedProvider) return environmentInfo
  return {
    ...environmentInfo,
    changeRequestObservation: snapshot.observation,
    changeRequest: snapshot.changeRequest
      ? {
          provider: resolvedProvider,
          state: 'found',
          changeRequest: snapshot.changeRequest,
        }
      : { provider: resolvedProvider, state: 'not_found' },
  }
}

export function resolveEnvironmentExecutionDeviceId(
  currentRuntimeTask: { deviceId: string } | null,
  workspaceTarget: WorkspaceTarget | null
): string | undefined {
  return currentRuntimeTask?.deviceId || workspaceTarget?.deviceId
}
