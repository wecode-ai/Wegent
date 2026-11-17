import { useCallback } from 'react'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { RuntimeProjectWork, RuntimeDeviceWorkspace } from '@/types/runtime'

// PC findProjectMetadataDeviceWorkspace selects the primary root, never a task worktree.
export function projectMetadataWorkspace(work: RuntimeProjectWork): RuntimeDeviceWorkspace {
  const roots = work.project.roots
  const normalize = (path: string) => path.trim().replace(/\/+$/u, '') || '/'
  const primary = roots?.[0]?.path
  const primaryWorkspace = primary
    ? work.deviceWorkspaces.find(item => normalize(item.workspacePath) === normalize(primary))
    : undefined
  const workspace =
    work.deviceWorkspaces.length === 1
      ? work.deviceWorkspaces[0]
      : (primaryWorkspace ??
        (new Set(work.deviceWorkspaces.map(item => item.remoteHostId || item.deviceId)).size <= 1
          ? work.deviceWorkspaces[0]
          : undefined))
  if (!workspace) throw new Error('无法确定项目所属设备，请刷新项目列表')
  return workspace
}

export function projectMutationTargets(work: RuntimeProjectWork) {
  const workspace = projectMetadataWorkspace(work)
  const project = work.project
  const primary = {
    deviceId: workspace.deviceId,
    projectKey: project.ownerProjectKey || project.key,
    workspacePath: workspace.workspacePath,
    runtime: 'codex' as const,
  }
  const mirror =
    project.sidebarStateKey &&
    project.stateDeviceId &&
    (project.stateDeviceId !== workspace.deviceId || project.sidebarStateKey !== primary.projectKey)
      ? { ...primary, deviceId: project.stateDeviceId, projectKey: project.sidebarStateKey }
      : null
  return { primary, mirror }
}

export function useProjectActions({
  api,
  reloadWork,
  onRemoved,
}: {
  api: RuntimeApi
  reloadWork: (deviceId: string) => Promise<unknown>
  onRemoved?: (project: RuntimeProjectWork) => void
}) {
  const refresh = useCallback(
    async (deviceIds: string[]) => {
      // List reads register their own source-owned retry; never repeat an accepted mutation.
      await Promise.allSettled([...new Set(deviceIds)].map(deviceId => reloadWork(deviceId)))
    },
    [reloadWork]
  )
  const setProjectPinned = useCallback(
    async (work: RuntimeProjectWork, pinned: boolean) => {
      const deviceId = work.project.stateDeviceId || projectMetadataWorkspace(work).deviceId
      const result = await api.setProjectPinned({
        deviceId,
        projectKey: work.project.sidebarStateKey || work.project.key,
        pinned,
      })
      if (!result.accepted) throw new Error(result.error || '无法更新项目置顶状态')
      await refresh([deviceId])
    },
    [api, refresh]
  )
  const renameProject = useCallback(
    async (work: RuntimeProjectWork, name: string) => {
      const { primary, mirror } = projectMutationTargets(work)
      for (const target of [primary, ...(mirror ? [mirror] : [])]) {
        const result = await api.renameWorkspace({ ...target, name })
        if (!result.accepted) throw new Error(result.error || '无法重命名项目')
      }
      await refresh([primary.deviceId, ...(mirror ? [mirror.deviceId] : [])])
    },
    [api, refresh]
  )
  const removeProject = useCallback(
    async (work: RuntimeProjectWork) => {
      const { primary, mirror } = projectMutationTargets(work)
      const workspace = projectMetadataWorkspace(work)
      const offlineRemote =
        !workspace.available &&
        (workspace.workspaceSource === 'remote' || Boolean(workspace.remoteHostId))
      const targets = offlineRemote && mirror ? [mirror] : [primary, ...(mirror ? [mirror] : [])]
      for (const target of targets) {
        const result = await api.removeWorkspace(target)
        if (!result.accepted) throw new Error(result.error || '无法移除项目')
      }
      onRemoved?.(work)
      await refresh(targets.map(target => target.deviceId))
    },
    [api, refresh, onRemoved]
  )
  return { setProjectPinned, renameProject, removeProject }
}
