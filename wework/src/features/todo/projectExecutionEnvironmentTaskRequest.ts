import type {
  CollaborationExecutionEnvironment,
  CollaborationProject,
  CollaborationProjectRendererWorkspaceContext,
} from '@wegent/collaboration'
import type { RuntimeTaskCreateRequest } from '@/types/api'

interface ProjectExecutionEnvironmentTaskRequestOptions {
  workspace?: CollaborationProjectRendererWorkspaceContext | null
  environments?: CollaborationExecutionEnvironment[] | null
}

function preparedExecutionEnvironmentCandidates(
  project: Pick<CollaborationProject, 'execution_environment'>,
  options: ProjectExecutionEnvironmentTaskRequestOptions
) {
  const workspace = options.workspace
  const configuration =
    project.execution_environment ??
    (workspace && 'execution_environment' in workspace
      ? workspace.execution_environment
      : undefined)
  const environments = options.environments
  const assignedDeviceKeys = environments
    ? new Set(
        environments
          .map(environment => environment.device_key?.trim())
          .filter((deviceKey): deviceKey is string => Boolean(deviceKey))
      )
    : null

  return Object.entries(configuration?.devices ?? {})
    .flatMap(([deviceId, state]) => {
      const normalizedDeviceId = deviceId.trim()
      const workspacePath = state.workspace_path?.trim()
      if (
        !normalizedDeviceId ||
        !workspacePath ||
        state.status !== 'ready' ||
        (assignedDeviceKeys && !assignedDeviceKeys.has(normalizedDeviceId))
      ) {
        return []
      }
      const environment = environments?.find(
        candidate => candidate.device_key === normalizedDeviceId
      )
      return [
        {
          deviceId: normalizedDeviceId,
          workspacePath,
          supportsIsolatedWorkspace: Boolean(
            configuration?.repositories.some(repository => repository.primary)
          ),
          online: environment?.status === 'online',
          preparedAt: state.prepared_at ?? '',
        },
      ]
    })
    .sort(
      (left, right) =>
        Number(right.online) - Number(left.online) ||
        right.preparedAt.localeCompare(left.preparedAt) ||
        left.deviceId.localeCompare(right.deviceId)
    )
}

export function projectExecutionEnvironmentTaskRequest(
  project: Pick<CollaborationProject, 'execution_environment'>,
  options: ProjectExecutionEnvironmentTaskRequestOptions = {}
): RuntimeTaskCreateRequest | null {
  const target = preparedExecutionEnvironmentCandidates(project, options)[0]
  if (!target) return null
  return {
    schemaVersion: 2,
    runtime: 'codex',
    message: '',
    deviceId: target.deviceId,
    workspacePath: target.workspacePath,
    ...(target.supportsIsolatedWorkspace
      ? {
          execution: {
            workspace: { source: 'git_worktree' as const },
          },
        }
      : {}),
  }
}
