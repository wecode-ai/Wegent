import { getRuntimeProjectOwner } from './runtime-project-state'
import { createWorkbenchDeviceResolver } from './workbench-device'
import { runtimeProjectTargetKey } from './runtime-project-identity'
import { getLocalRuntimeSourceIdentity } from './local-runtime-sidebar-identity'
import type {
  DeviceInfo,
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
  source?: 'local_project'
}

export function updateRuntimeWorkProject(
  work: RuntimeWorkListResponse,
  update: RuntimeProjectUpdate,
  devices: DeviceInfo[] = []
): RuntimeWorkListResponse {
  const owners = createWorkbenchDeviceResolver(devices)
  const ownerIdentity = runtimeProjectTargetKey(update.deviceId, update.projectKey, owners)
  return {
    ...work,
    projects: work.projects.map(projectWork => {
      const owner = getRuntimeProjectOwner(projectWork)
      const source = getLocalRuntimeSourceIdentity(projectWork.project)
      const localOwner =
        projectWork.project.source !== 'remote_project' &&
        projectWork.project.kind !== 'remote' &&
        source?.deviceId === owner.deviceId &&
        !projectWork.deviceWorkspaces.some(
          workspace => workspace.remoteHostId || workspace.workspaceSource === 'remote'
        )
          ? source
          : undefined
      if (
        owner.projectKey !== update.projectKey ||
        runtimeProjectTargetKey(owner.deviceId, owner.projectKey, owners, localOwner) !==
          ownerIdentity
      )
        return projectWork
      return {
        ...projectWork,
        project: {
          ...projectWork.project,
          ...(projectWork.project.source === 'legacy_root' && update.source === 'local_project'
            ? { source: update.source }
            : {}),
          name: update.name,
          ownerDeviceId: owner.deviceId,
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
