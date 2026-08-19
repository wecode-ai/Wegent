import type {
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  UserPreferences,
} from '@/types/api'
import { configuredWorkspacePath, executionDeviceId } from '@/lib/project-workspace'

export interface ProjectWorkPreferenceScope {
  projectId: number
  deviceWorkspaceId?: number | null
  deviceId?: string | null
  repoRootFingerprint?: string | null
  workspacePath?: string | null
}

export interface NormalizedProjectWorkPreference {
  executionMode: ProjectExecutionMode
  worktreeBranch: string | null
}

export interface ProjectWorkPreferenceReadResult {
  preference: NormalizedProjectWorkPreference
  source: 'workspace' | 'legacy_project' | 'default'
}

type ProjectWorkPreferencePatch = Partial<NormalizedProjectWorkPreference>

function normalizeIdentityPart(value?: string | null): string | null {
  const normalized = value?.trim()
  return normalized ? encodeURIComponent(normalized) : null
}

function normalizeWorkspacePath(value?: string | null): string | null {
  const normalized = value?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || null
}

export function resolveProjectWorkPreferenceScope(
  project: ProjectWithTasks | null | undefined,
  workspace: RuntimeDeviceWorkspace | null | undefined
): ProjectWorkPreferenceScope | null {
  if (!project) return null

  return {
    projectId: project.id,
    deviceWorkspaceId: workspace?.id,
    deviceId: workspace?.deviceId ?? executionDeviceId(project),
    repoRootFingerprint: workspace?.repoRootFingerprint,
    workspacePath: workspace?.workspacePath ?? configuredWorkspacePath(project),
  }
}

export function getLegacyProjectWorkPreferenceKey(projectId: number): string {
  return `project:${projectId}`
}

export function getProjectWorkPreferenceKey(
  scope: ProjectWorkPreferenceScope | null | undefined
): string | null {
  if (!scope) return null
  if (scope.deviceWorkspaceId != null) {
    return `project:${scope.projectId}:workspace:${scope.deviceWorkspaceId}`
  }

  const deviceId = normalizeIdentityPart(scope.deviceId)
  const repositoryIdentity = normalizeIdentityPart(
    scope.repoRootFingerprint ?? normalizeWorkspacePath(scope.workspacePath)
  )
  if (!deviceId || !repositoryIdentity) return null

  return `project:${scope.projectId}:workspace:${deviceId}:${repositoryIdentity}`
}

export function normalizeProjectWorkPreference(value?: {
  executionMode?: ProjectExecutionMode | null
  worktreeBranch?: string | null
}): NormalizedProjectWorkPreference {
  return {
    executionMode: value?.executionMode === 'git_worktree' ? 'git_worktree' : 'current_workspace',
    worktreeBranch: value?.worktreeBranch?.trim() || null,
  }
}

export function readProjectWorkPreference(
  preferences: UserPreferences | null | undefined,
  scope: ProjectWorkPreferenceScope | null | undefined
): ProjectWorkPreferenceReadResult {
  const workspaceKey = getProjectWorkPreferenceKey(scope)
  const storedPreferences = preferences?.wework_project_work_preferences
  if (workspaceKey && storedPreferences?.[workspaceKey]) {
    return {
      preference: normalizeProjectWorkPreference(storedPreferences[workspaceKey]),
      source: 'workspace',
    }
  }

  if (scope) {
    const legacyKey = getLegacyProjectWorkPreferenceKey(scope.projectId)
    if (storedPreferences?.[legacyKey]) {
      return {
        preference: normalizeProjectWorkPreference(storedPreferences[legacyKey]),
        source: 'legacy_project',
      }
    }
  }

  return {
    preference: normalizeProjectWorkPreference(),
    source: 'default',
  }
}

export function mergeProjectWorkPreference(
  preferences: UserPreferences | null | undefined,
  scope: ProjectWorkPreferenceScope,
  patch: ProjectWorkPreferencePatch
): UserPreferences | null {
  const workspaceKey = getProjectWorkPreferenceKey(scope)
  if (!workspaceKey) return null

  const current = readProjectWorkPreference(preferences, scope).preference
  const next = normalizeProjectWorkPreference({ ...current, ...patch })

  return {
    ...(preferences ?? {}),
    wework_project_work_preferences: {
      ...(preferences?.wework_project_work_preferences ?? {}),
      [workspaceKey]: next,
    },
  }
}
