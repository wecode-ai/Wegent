import { useMemo } from 'react'
import { findWorkbenchDevice, getActiveWorkbenchDeviceId } from '@/lib/workbench-device'
import { resolveProjectRuntimeWorkspaceTargets } from '@/lib/workspace-target'
import { isRemoteTaskDevice } from '@/lib/device-capabilities'
import type { WorkspaceFileOpenRequest, WorkspaceTarget } from '@/types/workspace-files'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { getWeworkDevInstanceInfo } from '@/lib/wework-dev-instance'
import { type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import { type BottomPanelRenderContext } from './desktopWorkbenchPaneTypes'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'
import type { RuntimeTaskAddress } from '@/types/api'
import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'
import { createBottomPanelWorkspaceKey } from './desktopWorkbenchMainHelpers'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DesktopPaneWorkspaceSnapshot } from './desktopPaneWorkspaceState'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
interface Input {
  activeLocalHarnessSession: LocalHarnessWorkbenchSession | null
  state: WorkbenchPaneContextValue['state']
  services: WorkbenchServices
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProject: WorkbenchPaneIdentity['currentProject']
  runtimeWork: WorkbenchPaneContextValue['state']['runtimeWork']
  currentRuntimeConversationSource: RuntimeTaskAddress | null
  workbenchTitle: string | null
  workspaceProject: ReturnType<typeof useWorkbenchPaneEnvironment>['workspaceProject']
  workspaceTarget: ReturnType<typeof useWorkbenchPaneEnvironment>['workspaceTarget']
  paneProjectWork: ReturnType<typeof useWorkbenchPaneEnvironment>['projectWork']
  devices: WorkbenchPaneContextValue['state']['devices']
  selectedFileWorkspaceTargetKey: DesktopPaneWorkspaceSnapshot['selectedFileWorkspaceTargetKey']
  selectedWorkspaceFile: DesktopPaneWorkspaceSnapshot['selectedWorkspaceFile']
  bottomPanelOpenByKey: Record<string, boolean>
  bottomPanelContexts: BottomPanelRenderContext[]
  openFileRequest: WorkspaceFileOpenRequest | null
}
export function useDesktopPaneWorkspaceTargets({
  activeLocalHarnessSession,
  state,
  services,
  currentRuntimeTask,
  currentProject,
  runtimeWork,
  currentRuntimeConversationSource,
  workbenchTitle,
  workspaceProject,
  workspaceTarget,
  paneProjectWork,
  devices,
  selectedFileWorkspaceTargetKey,
  selectedWorkspaceFile,
  bottomPanelOpenByKey,
  bottomPanelContexts,
  openFileRequest,
}: Input) {
  const activeDeviceId =
    currentRuntimeTask?.deviceId ??
    getActiveWorkbenchDeviceId({
      currentProject,
      standaloneDeviceId: paneProjectWork.currentStandaloneDeviceId,
    })
  const soleActiveDeviceWorkspacePath = useMemo(() => {
    if (!runtimeWork || !activeDeviceId) return null
    const workspaces = [
      ...runtimeWork.chats,
      ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ]
    const matches = workspaces.filter(workspace => workspace.deviceId === activeDeviceId)
    return matches.length === 1
      ? matches[0].workspacePath
      : workspaces.length === 1
        ? workspaces[0].workspacePath
        : null
  }, [activeDeviceId, runtimeWork])
  const standaloneRootWorkspaceTarget = useMemo(
    () =>
      !workspaceProject && !workspaceTarget && activeDeviceId
        ? {
            deviceId: activeDeviceId,
            path: '/',
            source: 'runtime' as const,
            workspaceSource: 'remote',
          }
        : null,
    [activeDeviceId, workspaceProject, workspaceTarget]
  )
  const effectiveWorkspaceTarget = workspaceTarget ?? standaloneRootWorkspaceTarget
  const projectFileWorkspaceTargets = useMemo(
    () =>
      resolveProjectRuntimeWorkspaceTargets({
        currentProject: workspaceProject,
        runtimeWork,
      }),
    [runtimeWork, workspaceProject]
  )
  const fileWorkspaceTargets = useMemo(() => {
    const candidates = effectiveWorkspaceTarget
      ? [effectiveWorkspaceTarget, ...projectFileWorkspaceTargets]
      : projectFileWorkspaceTargets
    return candidates.filter(
      (candidate, index) =>
        candidates.findIndex(
          item => item.deviceId === candidate.deviceId && item.path === candidate.path
        ) === index
    )
  }, [effectiveWorkspaceTarget, projectFileWorkspaceTargets])
  const soleProjectWorkspaceTarget =
    projectFileWorkspaceTargets.length === 1 ? projectFileWorkspaceTargets[0] : null
  const composerWorkspaceTarget =
    workspaceTarget ??
    (activeDeviceId && state.standaloneWorkspacePath
      ? {
          deviceId: activeDeviceId,
          path: state.standaloneWorkspacePath,
          source: 'runtime' as const,
        }
      : null) ??
    soleProjectWorkspaceTarget ??
    (activeDeviceId && soleActiveDeviceWorkspacePath
      ? {
          deviceId: activeDeviceId,
          path: soleActiveDeviceWorkspacePath,
          source: 'runtime' as const,
        }
      : null)
  const conversationImageTarget = currentRuntimeConversationSource?.workspacePath
    ? {
        deviceId: currentRuntimeConversationSource.deviceId,
        workspacePath: currentRuntimeConversationSource.workspacePath,
      }
    : composerWorkspaceTarget
      ? { deviceId: composerWorkspaceTarget.deviceId, workspacePath: composerWorkspaceTarget.path }
      : null
  const conversationImageDevice = findWorkbenchDevice(devices, conversationImageTarget?.deviceId)
  const remoteImageTarget =
    conversationImageTarget &&
    (!isElectronRuntime() || conversationImageDevice?.device_type !== 'local')
      ? conversationImageTarget
      : null
  const selectedFileWorkspaceTarget =
    fileWorkspaceTargets.find(
      target => `${target.deviceId}:${target.path}` === selectedFileWorkspaceTargetKey
    ) ?? null
  const fileWorkspaceTarget =
    openFileRequest?.target ??
    selectedFileWorkspaceTarget ??
    selectedWorkspaceFile?.target ??
    effectiveWorkspaceTarget
  const fileWorkspaceTargetKey = fileWorkspaceTarget
    ? `${fileWorkspaceTarget.deviceId}:${fileWorkspaceTarget.path}`
    : null
  const initialFileWorkspaceSelection =
    selectedWorkspaceFile &&
    `${selectedWorkspaceFile.target.deviceId}:${selectedWorkspaceFile.target.path}` ===
      fileWorkspaceTargetKey
      ? {
          path: selectedWorkspaceFile.path,
          isDirectory: selectedWorkspaceFile.isDirectory,
        }
      : null
  const devWorkspacePath = getWeworkDevInstanceInfo()?.worktree?.trim() ?? ''
  const centralHarnessTargetDevice = composerWorkspaceTarget?.deviceId
    ? devices.find(device => device.device_id === composerWorkspaceTarget.deviceId)
    : undefined
  const centralHarnessUsesRemoteDevice = Boolean(
    centralHarnessTargetDevice && isRemoteTaskDevice(centralHarnessTargetDevice)
  )
  const centralHarnessUsesRemoteSource = composerWorkspaceTarget?.workspaceSource === 'remote'
  const centralHarnessCwd = composerWorkspaceTarget?.path?.trim() || devWorkspacePath
  const preferLocalWorkspaceTerminal =
    Boolean(centralHarnessCwd) && !centralHarnessUsesRemoteDevice && !centralHarnessUsesRemoteSource
  const canPrepareHarnessWorktree = Boolean(
    paneProjectWork.executionMode !== 'git_worktree' ||
    (services?.runtimeWorkApi &&
      centralHarnessCwd &&
      (composerWorkspaceTarget?.deviceId || centralHarnessTargetDevice?.device_id))
  )
  const workspacePanelTarget = useMemo<WorkspaceTarget | null>(() => {
    if (!activeLocalHarnessSession) return effectiveWorkspaceTarget

    return {
      deviceId:
        effectiveWorkspaceTarget?.deviceId ??
        composerWorkspaceTarget?.deviceId ??
        centralHarnessTargetDevice?.device_id ??
        'local',
      path: activeLocalHarnessSession.cwd,
      source: 'project',
      workspaceSource: 'local',
    }
  }, [
    activeLocalHarnessSession,
    centralHarnessTargetDevice?.device_id,
    composerWorkspaceTarget?.deviceId,
    effectiveWorkspaceTarget,
  ])
  const workspacePanelPrefersLocalTerminal = activeLocalHarnessSession
    ? true
    : preferLocalWorkspaceTerminal
  const bottomPanelWorkspaceKey = activeLocalHarnessSession
    ? `harness:${activeLocalHarnessSession.sessionId}`
    : createBottomPanelWorkspaceKey({
        currentRuntimeTask,
        workspaceProjectId: workspaceProject?.id,
        workspaceTarget: effectiveWorkspaceTarget,
        executionMode: paneProjectWork.executionMode,
        preferLocalTerminal: preferLocalWorkspaceTerminal,
      })
  const bottomPanelOpen = bottomPanelOpenByKey[bottomPanelWorkspaceKey] ?? false
  const activeBottomPanelContext: BottomPanelRenderContext = {
    key: bottomPanelWorkspaceKey,
    currentProject: workspaceProject,
    devices,
    workspaceTarget: workspacePanelTarget,
    preferLocalTerminal: workspacePanelPrefersLocalTerminal,
    terminalContextTitle: workbenchTitle,
  }
  const inactiveBottomPanelContexts = bottomPanelContexts.filter(
    context => context.key !== bottomPanelWorkspaceKey
  )
  const bottomPanelContextsToRender = [...inactiveBottomPanelContexts, activeBottomPanelContext]
  return {
    activeDeviceId,
    effectiveWorkspaceTarget,
    fileWorkspaceTargets,
    composerWorkspaceTarget,
    remoteImageTarget,
    fileWorkspaceTarget,
    initialFileWorkspaceSelection,
    centralHarnessTargetDevice,
    centralHarnessCwd,
    preferLocalWorkspaceTerminal,
    canPrepareHarnessWorktree,
    workspacePanelTarget,
    workspacePanelPrefersLocalTerminal,
    bottomPanelWorkspaceKey,
    bottomPanelOpen,
    activeBottomPanelContext,
    bottomPanelContextsToRender,
  }
}
