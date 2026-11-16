import type { ExecutorClient } from '@/api/executorAccess'
import type { DeviceInfo } from '@/types/api'
import type { RefreshWorkLists } from './workbenchContextTypes'
import { findFirstSelectableProject } from './workbenchProviderHelpers'
// Keep memoized callbacks in independent scopes so they cannot retain prior provider renders.
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import {
  assertLocalRuntimeSidebarIdentity,
  getLocalRuntimeSourceIdentity,
  type LocalRuntimeSidebarIdentity,
} from '@/lib/local-runtime-sidebar-identity'
import { navigateTo } from '@/lib/navigation'
import {
  normalizeRuntimeWorkspacePath,
  runtimeProjectToProject,
  runtimeProjectUiId,
} from '@/lib/runtime-project'
import {
  runtimeProjectSyncTargetKey,
  type RuntimeProjectSyncTarget,
} from '@/lib/runtime-project-identity'
import { getRuntimeRemoteProjectRegistrations } from '@/lib/runtime-project-state'
import {
  createWorkbenchDeviceResolver,
  resolveLocalWorkbenchDeviceId,
} from '@/lib/workbench-device'
import { requestNewChatComposerFocus, requestWorkbenchNewChat } from '@/lib/workbenchComposerFocus'
import type { RuntimeTaskAddress, RuntimeWorkListResponse, User } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import type { ActionDispatch, RefObject } from 'react'
import { useCallback } from 'react'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import type { WorkbenchAction } from './workbenchReducer'
import {
  findSelectableProject,
  getDefaultProjectDeviceWorkspaceId,
  getRememberedStandaloneDeviceId,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import {
  queueWorkbenchWorkspaceLaunch,
  type WorkbenchWorkspaceLaunchOptions,
} from './workspaceLaunchRequest'
export function useMarkRuntimeTasksArchived({
  sharedLifecycleStore,
  markRuntimeTasksArchivedInView,
}: {
  sharedLifecycleStore: RuntimeTaskLifecycleStore
  markRuntimeTasksArchivedInView: (addresses: RuntimeTaskAddress[]) => void
}) {
  return useCallback(
    (addresses: RuntimeTaskAddress[]) => {
      // Successful explicit archival is authoritative even when another pane owns snapshot writes.
      addresses.forEach(address => sharedLifecycleStore.remove(address))
      markRuntimeTasksArchivedInView(addresses)
    },
    [markRuntimeTasksArchivedInView, sharedLifecycleStore]
  )
}

export function useEnqueueRemoteProjectStateMutation({
  remoteProjectMutationQueueRef,
}: {
  remoteProjectMutationQueueRef: RefObject<Promise<void>>
}) {
  return useCallback(
    <T>(mutation: () => Promise<T>): Promise<T> => {
      const run = remoteProjectMutationQueueRef.current.catch(() => undefined).then(mutation)
      remoteProjectMutationQueueRef.current = run.then(
        () => undefined,
        () => undefined
      )
      return run
    },
    [remoteProjectMutationQueueRef]
  )
}

export function useInvalidateRemoteProjectSync({
  removedRemoteProjectsRef,
  remoteProjectSyncRevisionRef,
}: {
  removedRemoteProjectsRef: RefObject<RuntimeProjectSyncTarget[]>
  remoteProjectSyncRevisionRef: RefObject<number>
}) {
  return useCallback(
    (target: RuntimeProjectSyncTarget) => {
      removedRemoteProjectsRef.current.push(target)
      remoteProjectSyncRevisionRef.current += 1
    },
    [remoteProjectSyncRevisionRef, removedRemoteProjectsRef]
  )
}

export function useClearRemoteProjectSyncRemoval({
  state,
  removedRemoteProjectsRef,
  remoteProjectSyncSignatureRef,
}: {
  state: WorkbenchState
  removedRemoteProjectsRef: RefObject<RuntimeProjectSyncTarget[]>
  remoteProjectSyncSignatureRef: RefObject<string>
}) {
  return useCallback(
    (target: RuntimeProjectSyncTarget) => {
      const devices = createWorkbenchDeviceResolver(state.devices)
      const key = runtimeProjectSyncTargetKey(target, devices)
      removedRemoteProjectsRef.current = removedRemoteProjectsRef.current.filter(
        removed => runtimeProjectSyncTargetKey(removed, devices) !== key
      )
      remoteProjectSyncSignatureRef.current = ''
    },
    [remoteProjectSyncSignatureRef, removedRemoteProjectsRef, state.devices]
  )
}

export function useGetRemoteProjectRegistrations({
  removedRemoteProjectsRef,
  getRuntimeWorkSnapshot,
  sidebarDevicesRef,
}: {
  removedRemoteProjectsRef: RefObject<RuntimeProjectSyncTarget[]>
  getRuntimeWorkSnapshot: () => RuntimeWorkListResponse | null
  sidebarDevicesRef: RefObject<DeviceInfo[]>
}) {
  return useCallback(
    (identity: LocalRuntimeSidebarIdentity) => {
      assertLocalRuntimeSidebarIdentity(identity, identity)
      removedRemoteProjectsRef.current = removedRemoteProjectsRef.current.filter(target => {
        const source = getLocalRuntimeSourceIdentity(target)
        return (
          !source ||
          (source.deviceId === identity.deviceId &&
            source.runtimeInstanceId === identity.runtimeInstanceId)
        )
      })
      return getRuntimeRemoteProjectRegistrations(getRuntimeWorkSnapshot(), identity.deviceId, {
        localSidebarIdentity: identity,
        devices: sidebarDevicesRef.current,
        excludedTargets: removedRemoteProjectsRef.current,
      })
    },
    [getRuntimeWorkSnapshot, removedRemoteProjectsRef, sidebarDevicesRef]
  )
}

export function useSelectProject({
  projectSelectionStartedRef,
  ownershipKey,
  dispatch,
  user,
  state,
}: {
  projectSelectionStartedRef: RefObject<boolean>
  ownershipKey: string
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  user: User
  state: WorkbenchState
}) {
  return useCallback(
    (projectId: number | null) => {
      projectSelectionStartedRef.current = true
      if (projectId === null) {
        writeLastProjectId(ownershipKey, null)
        dispatch({
          type: 'project_cleared',
          standaloneDeviceId: getRememberedStandaloneDeviceId(
            user,
            state.devices,
            state.standaloneDeviceId
          ),
          standaloneWorkspacePath: null,
        })
        navigateTo('/')
        return
      }
      const project = findSelectableProject(state.projects, state.runtimeWork, projectId)
      if (project) {
        writeLastProjectId(ownershipKey, project.id)
        dispatch({ type: 'project_selected', project })
        navigateTo('/')
      }
    },
    [
      projectSelectionStartedRef,
      state.projects,
      state.runtimeWork,
      state.devices,
      state.standaloneDeviceId,
      ownershipKey,
      dispatch,
      user,
    ]
  )
}

export function useSelectProjectWorkspace({
  projectSelectionStartedRef,
  state,
  ownershipKey,
  dispatch,
}: {
  projectSelectionStartedRef: RefObject<boolean>
  state: WorkbenchState
  ownershipKey: string
  dispatch: ActionDispatch<[action: WorkbenchAction]>
}) {
  return useCallback(
    (projectId: number, deviceWorkspaceId: number | null) => {
      projectSelectionStartedRef.current = true
      const project = findSelectableProject(state.projects, state.runtimeWork, projectId)
      if (!project) return
      writeLastProjectId(ownershipKey, project.id)
      dispatch({
        type: 'project_workspace_selected',
        project,
        deviceWorkspaceId,
      })
      navigateTo('/')
    },
    [projectSelectionStartedRef, state.projects, state.runtimeWork, ownershipKey, dispatch]
  )
}

export function useSelectStandaloneDevice({
  projectSelectionStartedRef,
  ownershipKey,
  state,
  user,
  dispatch,
}: {
  projectSelectionStartedRef: RefObject<boolean>
  ownershipKey: string
  state: WorkbenchState
  user: User
  dispatch: ActionDispatch<[action: WorkbenchAction]>
}) {
  return useCallback(
    (deviceId: string | null) => {
      projectSelectionStartedRef.current = true
      writeLastProjectId(ownershipKey, null)
      const standaloneDeviceId = getPreferredStandaloneDeviceId(
        state.devices,
        deviceId ?? user.preferences?.default_execution_target ?? state.standaloneDeviceId
      )
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId,
        standaloneWorkspacePath: null,
        startFreshChat: true,
      })
      navigateTo('/')
    },
    [
      projectSelectionStartedRef,
      ownershipKey,
      state.devices,
      state.standaloneDeviceId,
      user.preferences?.default_execution_target,
      dispatch,
    ]
  )
}

export function useOpenStandaloneWorkspace({
  projectSelectionStartedRef,
  state,
  executorClient,
  dispatch,
  clearRemoteProjectSyncRemoval,
  ownershipKey,
  refreshWorkLists,
}: {
  projectSelectionStartedRef: RefObject<boolean>
  state: WorkbenchState
  executorClient: ExecutorClient
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  clearRemoteProjectSyncRemoval: (target: RuntimeProjectSyncTarget) => void
  ownershipKey: string
  refreshWorkLists: RefreshWorkLists
}) {
  return useCallback(
    async (
      deviceId: string,
      workspacePath: string,
      label?: string,
      projectRoots?: string[],
      launchOptions?: WorkbenchWorkspaceLaunchOptions
    ) => {
      projectSelectionStartedRef.current = true
      const requestDeviceId = deviceId.trim()
      const normalizedWorkspacePath = workspacePath.trim()
      if (!requestDeviceId || !normalizedWorkspacePath) return
      const normalizedLabel = label?.trim()
      const normalizedRoots = Array.from(
        new Set((projectRoots ?? []).map(root => root.trim()).filter(Boolean))
      )

      // CLI open uses the local-device alias. Resolve the real executor device id so
      // online checks, composer enablement, and new-chat buttons match listDevices.
      let devicesForResolution = state.devices
      const needsDeviceLookup =
        !devicesForResolution.some(device => device.device_id === requestDeviceId) &&
        resolveLocalWorkbenchDeviceId(devicesForResolution, requestDeviceId) === requestDeviceId
      if (needsDeviceLookup) {
        try {
          const listedDevices = await executorClient.commands.listDevices()
          if (listedDevices.length > 0) {
            devicesForResolution = listedDevices
            dispatch({
              type: 'devices_refreshed',
              devices: listedDevices,
              standaloneDeviceId: getPreferredStandaloneDeviceId(listedDevices, requestDeviceId),
            })
          }
        } catch (error) {
          console.warn('[Wework] Failed to load devices before opening workspace', error)
        }
      }

      if (projectRoots && normalizedRoots.length > 0) {
        const projectName =
          normalizedLabel ||
          normalizedWorkspacePath.split(/[\\/]/).filter(Boolean).at(-1) ||
          'Project'
        const response = await executorClient.runtime.upsertLocalRuntimeProject({
          deviceId: requestDeviceId,
          projectKey: crypto.randomUUID(),
          name: projectName,
          roots: normalizedRoots,
          runtime: 'codex',
        })
        if (!response.accepted) {
          throw new Error(response.error || 'Failed to register local project')
        }
        clearRemoteProjectSyncRemoval({
          deviceId: response.deviceId,
          projectKey: response.projectKey,
        })
        writeLastProjectId(
          ownershipKey,
          runtimeProjectUiId({
            key: response.projectKey,
            stateDeviceId: response.deviceId,
            name: response.name,
          })
        )
        await refreshWorkLists()
        if (launchOptions) {
          queueWorkbenchWorkspaceLaunch(response.deviceId, response.roots[0], launchOptions)
        }
        dispatch({
          type: 'project_workspace_selected',
          project: runtimeProjectToProject({
            project: {
              key: response.projectKey,
              stateDeviceId: response.deviceId,
              name: response.name,
            },
            deviceWorkspaces: [
              {
                deviceId: response.deviceId,
                workspacePath: response.roots[0],
                available: true,
                tasks: [],
              },
            ],
          }),
          startFreshChat: true,
        })
        navigateTo('/')
        return
      }

      const response = await executorClient.runtime.openRuntimeWorkspace({
        deviceId: requestDeviceId,
        workspacePath: normalizedWorkspacePath,
        runtime: 'codex',
        ...(normalizedLabel ? { label: normalizedLabel } : {}),
      })
      if (!response.accepted) {
        throw new Error(response.error || 'Failed to register runtime workspace')
      }
      const openedWorkspacePath = response.workspacePath || normalizedWorkspacePath
      clearRemoteProjectSyncRemoval({
        deviceId: response.deviceId?.trim() || requestDeviceId,
        projectKey: normalizeRuntimeWorkspacePath(openedWorkspacePath),
      })
      const openedDeviceId =
        resolveLocalWorkbenchDeviceId(
          devicesForResolution,
          response.deviceId?.trim() || requestDeviceId
        ) ||
        response.deviceId?.trim() ||
        requestDeviceId

      writeLastProjectId(ownershipKey, null)
      if (launchOptions) {
        queueWorkbenchWorkspaceLaunch(openedDeviceId, openedWorkspacePath, launchOptions)
      }
      dispatch({
        type: 'runtime_workspace_opened',
        deviceId: openedDeviceId,
        workspacePath: openedWorkspacePath,
        label: normalizedLabel,
      })
      navigateTo('/')
    },
    [
      projectSelectionStartedRef,
      state.devices,
      executorClient.runtime,
      executorClient.commands,
      clearRemoteProjectSyncRemoval,
      ownershipKey,
      dispatch,
      refreshWorkLists,
    ]
  )
}

export function useStartNewChat({
  canNavigateWorkspaceTab,
  state,
  ownershipKey,
  dispatch,
  workspaceTabId,
  user,
}: {
  canNavigateWorkspaceTab: () => boolean
  state: WorkbenchState
  ownershipKey: string
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  workspaceTabId: string | undefined
  user: User
}) {
  return useCallback(() => {
    navigateTo('/')
    if (!canNavigateWorkspaceTab()) {
      requestWorkbenchNewChat()
      return
    }
    const project = state.currentProject
      ? findFirstSelectableProject(state.projects, state.runtimeWork, [state.currentProject.id])
      : null
    if (project) {
      writeLastProjectId(ownershipKey, project.id)
      dispatch({
        type: 'project_workspace_selected',
        project,
        deviceWorkspaceId: getDefaultProjectDeviceWorkspaceId(state.runtimeWork, project.id),
      })
      requestNewChatComposerFocus(workspaceTabId)
      return
    }

    writeLastProjectId(ownershipKey, null)
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
      standaloneWorkspacePath: null,
    })
    requestNewChatComposerFocus(workspaceTabId)
  }, [
    canNavigateWorkspaceTab,
    state.currentProject,
    state.projects,
    state.runtimeWork,
    state.devices,
    state.standaloneDeviceId,
    ownershipKey,
    dispatch,
    user,
    workspaceTabId,
  ])
}
