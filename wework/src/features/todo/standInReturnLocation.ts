import type { CollaborationPlatformLocation, CollaborationProject } from '@wegent/collaboration'

/** Restore the project workspace after leaving the full-page stand-in settings. */
export function standInReturnLocation(
  project: CollaborationProject,
  returnLocation: CollaborationPlatformLocation
): CollaborationPlatformLocation {
  return {
    ...returnLocation,
    collaborationDomain: project.project_store === 'local' ? 'local' : 'cloud',
    workspaceId: returnLocation.workspaceId ?? project.workspace_id ?? null,
    workspaceView: returnLocation.workspaceView ?? 'projects',
  }
}
