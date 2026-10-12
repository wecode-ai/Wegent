import { getRuntimeProjectOwner } from './runtime-project-state'
import type {
  RuntimeProjectAiSettings,
  RuntimeProjectSpaceRef,
  RuntimeWorkListResponse,
} from '@/types/api'

export interface RuntimeProjectUpdate {
  deviceId: string
  projectKey: string
  name: string
  roots: string[]
  defaultProjectSpace: RuntimeProjectSpaceRef | null
  aiSettings: RuntimeProjectAiSettings | null
}

export function updateRuntimeWorkProject(
  work: RuntimeWorkListResponse,
  update: RuntimeProjectUpdate
): RuntimeWorkListResponse {
  return {
    ...work,
    projects: work.projects.map(projectWork => {
      const owner = getRuntimeProjectOwner(projectWork)
      if (owner.deviceId !== update.deviceId || owner.projectKey !== update.projectKey)
        return projectWork
      return {
        ...projectWork,
        project: {
          ...projectWork.project,
          name: update.name,
          ownerDeviceId: update.deviceId,
          ownerProjectKey: update.projectKey,
          roots: update.roots.map(path => ({ kind: 'local', path })),
          defaultProjectSpace: update.defaultProjectSpace,
          aiSettings: update.aiSettings,
        },
        deviceWorkspaces: projectWork.deviceWorkspaces.map(workspace =>
          workspace.workspaceKind === 'worktree' ||
          workspace.worktreeId ||
          workspace.workspaceKind === 'chat'
            ? workspace
            : { ...workspace, workspacePath: update.roots[0], label: update.name }
        ),
      }
    }),
  }
}
