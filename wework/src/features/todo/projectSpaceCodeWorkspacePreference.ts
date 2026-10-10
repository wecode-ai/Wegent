import type { RuntimeProjectSpaceRef } from '@/types/api'

const STORAGE_PREFIX = 'wework.project-space-code-workspace:v1'

export interface ProjectSpaceCodeWorkspacePreference {
  localProjectId: number
  deviceWorkspaceId: number | null
}

function storageKey(userId: string | number, project: RuntimeProjectSpaceRef): string {
  return [
    STORAGE_PREFIX,
    encodeURIComponent(String(userId)),
    encodeURIComponent(project.projectStore),
    encodeURIComponent(String(project.projectId)),
  ].join(':')
}

export function loadProjectSpaceCodeWorkspacePreference(
  userId: string | number,
  project: RuntimeProjectSpaceRef
): ProjectSpaceCodeWorkspacePreference | null {
  try {
    const stored = window.localStorage.getItem(storageKey(userId, project))
    if (!stored) return null
    const parsed = JSON.parse(stored) as Partial<ProjectSpaceCodeWorkspacePreference>
    if (!Number.isInteger(parsed.localProjectId) || Number(parsed.localProjectId) <= 0) return null
    if (
      parsed.deviceWorkspaceId !== null &&
      (!Number.isInteger(parsed.deviceWorkspaceId) || Number(parsed.deviceWorkspaceId) <= 0)
    ) {
      return null
    }
    return {
      localProjectId: Number(parsed.localProjectId),
      deviceWorkspaceId:
        parsed.deviceWorkspaceId === null ? null : Number(parsed.deviceWorkspaceId),
    }
  } catch {
    return null
  }
}

export function saveProjectSpaceCodeWorkspacePreference(
  userId: string | number,
  project: RuntimeProjectSpaceRef,
  preference: ProjectSpaceCodeWorkspacePreference
): void {
  try {
    window.localStorage.setItem(storageKey(userId, project), JSON.stringify(preference))
  } catch {
    // The runtime task already exists when this preference is saved. Storage
    // quota or privacy failures must not turn successful task creation into an
    // error.
  }
}
