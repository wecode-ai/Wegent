import { createWorkbenchDeviceReconnect } from '@/features/workbench/workbenchDeviceReconnect'
import { pollWorkbenchPresentation } from '@/desktop/workbenchWindowActivity'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { resolveWorkspaceTarget } from '@/lib/workspace-target'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import { isCloudDevice } from '@/lib/device-selection'
import { isRemoteTaskDevice } from '@/lib/device-capabilities'
import { resolveEnvironmentExecutionDeviceId } from './workbenchPaneEnvironmentHelpers'
import type { WorkbenchPaneIdentity } from './workbenchPaneIdentity'

interface EnvironmentSourceInput {
  workspaceProject: ProjectWithTasks | null
  runtimeWorkspaceTarget: WorkspaceTarget | null
  projectRuntimeWorkspaceTarget: WorkspaceTarget | null
  currentRuntimeTask: WorkbenchPaneIdentity['currentRuntimeTask']
  getProjectWorkspaceRoot: WorkbenchPaneContextValue['getProjectWorkspaceRoot']
  loadEnvironmentInfo: WorkbenchPaneContextValue['loadEnvironmentInfo']
  apiOwner: WorkbenchPaneContextValue['services']
  devices: DeviceInfo[]
  workspaceRoots: string[]
  autoLoad: boolean
}
interface EnvironmentSnapshot {
  workspaceTarget: WorkspaceTarget | null
  workspaceTargetError: string | null
  workspaceTargetResolving: boolean
  environmentInfo: EnvironmentInfo
}
/** A pane workspace owns target resolution, partial environment reads and active-run polling. */
export function createWorkbenchPaneEnvironmentSource(initial: EnvironmentSourceInput) {
  const reconnect = createWorkbenchDeviceReconnect()
  let input = initial
  let metadataKey: string | undefined
  const directTarget = input.currentRuntimeTask
    ? input.runtimeWorkspaceTarget
    : input.projectRuntimeWorkspaceTarget
  let snapshot: EnvironmentSnapshot = {
    workspaceTarget: directTarget,
    workspaceTargetError:
      input.currentRuntimeTask && !directTarget ? 'Workspace is not ready' : null,
    workspaceTargetResolving: !input.currentRuntimeTask && !directTarget,
    environmentInfo: {
      additions: '',
      deletions: '',
      executionTarget: 'local',
      ...(input.autoLoad ? { loading: true, branchLoading: true } : {}),
    },
  }
  const listeners = new Set<() => void>()
  let requestSequence = 0
  let generation = 0
  let resolutionRevision = 0
  let started = false
  let refreshActive = false
  let stopPolling: (() => void) | undefined
  const isCurrent = () => started && listeners.size > 0
  function publish(change: Partial<EnvironmentSnapshot>) {
    if (!isCurrent()) return
    snapshot = { ...snapshot, ...change }
    listeners.forEach(listener => listener())
  }
  function updateEnvironmentInfo(change: (info: EnvironmentInfo) => EnvironmentInfo) {
    publish({ environmentInfo: change(snapshot.environmentInfo) })
  }
  async function load({
    force,
    showLoading,
    shareInflight,
  }: {
    force: boolean
    showLoading: boolean
    shareInflight?: boolean
  }) {
    if (!isCurrent()) return
    const requestInput = input
    const ownerGeneration = generation
    const requestIsCurrent = () => started && listeners.size > 0 && ownerGeneration === generation
    const {
      workspaceTarget: activeWorkspaceTarget,
      workspaceTargetError,
      workspaceTargetResolving,
    } = snapshot
    const environmentWorkspaceReady =
      !requestInput.workspaceProject || Boolean(activeWorkspaceTarget)
    const currentRuntimeTaskDeviceId = requestInput.currentRuntimeTask?.deviceId
    const workspaceRoots = requestInput.workspaceRoots
    const loadEnvironmentInfo = requestInput.loadEnvironmentInfo
    const requestId = requestSequence + 1
    requestSequence = requestId
    const startedAt = performance.now()
    const logLoad = (stage: string, details: Record<string, unknown> = {}) => {
      console.info('[Wework] Environment UI', {
        requestId,
        stage,
        elapsedMs: Math.round(performance.now() - startedAt),
        workspacePath: activeWorkspaceTarget?.path,
        deviceId: activeWorkspaceTarget?.deviceId,
        force,
        showLoading,
        ...details,
      })
    }
    logLoad('requested', {
      workspaceTargetResolving,
      environmentWorkspaceReady,
    })

    if (workspaceTargetResolving) {
      if (showLoading) {
        updateEnvironmentInfo(info => ({ ...info, loading: true, branchLoading: true }))
      }
      logLoad('waiting_for_workspace_target')
      return
    }

    if (!environmentWorkspaceReady) {
      updateEnvironmentInfo(info => ({
        ...info,
        loading: false,
        branchLoading: false,
        error: workspaceTargetError ?? 'Workspace is not ready',
      }))
      logLoad('workspace_not_ready', { error: workspaceTargetError })
      return
    }

    if (showLoading) {
      updateEnvironmentInfo(info =>
        info.workspacePath === activeWorkspaceTarget?.path &&
        info.deviceId === activeWorkspaceTarget?.deviceId
          ? {
              ...info,
              loading: true,
              branchLoading: !info.branchName && info.branchLoading !== false,
            }
          : {
              additions: '',
              deletions: '',
              executionTarget: info.executionTarget,
              deviceId: activeWorkspaceTarget?.deviceId,
              workspacePath: activeWorkspaceTarget?.path,
              workspaceRoots,
              loading: true,
              branchLoading: true,
            }
      )
    }
    try {
      const latestWorkspaceProject = requestInput.workspaceProject
      const latestActiveWorkspaceTarget = activeWorkspaceTarget
      const applyEnvironmentInfo = (info: EnvironmentInfo, loading: boolean) => {
        if (!requestIsCurrent() || requestSequence !== requestId) {
          logLoad('discarded_stale_result', {
            activeRequestId: requestSequence,
          })
          return
        }
        const actualDevice = findWorkbenchDevice(
          requestInput.devices,
          latestActiveWorkspaceTarget?.deviceId ?? info.deviceId
        )
        const executionDeviceId = resolveEnvironmentExecutionDeviceId(
          currentRuntimeTaskDeviceId ? { deviceId: currentRuntimeTaskDeviceId } : null,
          latestActiveWorkspaceTarget
        )
        const executionDevice = findWorkbenchDevice(requestInput.devices, executionDeviceId)
        logLoad(loading ? 'partial_published' : 'completed', {
          branchName: info.branchName,
          executionDeviceId,
          workspaceDeviceId: actualDevice?.device_id,
        })
        updateEnvironmentInfo(current => {
          const preserveCurrentFields =
            loading &&
            current.workspacePath === info.workspacePath &&
            current.deviceId === info.deviceId
          return {
            ...info,
            ...(preserveCurrentFields && !info.additions && current.additions
              ? { additions: current.additions }
              : {}),
            ...(preserveCurrentFields && !info.deletions && current.deletions
              ? { deletions: current.deletions }
              : {}),
            workspaceRoots,
            executionDeviceId,
            executionTarget: executionDevice
              ? isCloudDevice(executionDevice)
                ? 'cloud'
                : isRemoteTaskDevice(executionDevice)
                  ? 'remote'
                  : 'local'
              : info.executionTarget,
            loading,
            branchLoading: false,
          }
        })
      }
      const info = await loadEnvironmentInfo(latestWorkspaceProject, latestActiveWorkspaceTarget, {
        ...(force ? { force: true } : {}),
        ...(shareInflight === false ? { shareInflight: false } : {}),
        onPartialInfo: partialInfo => applyEnvironmentInfo(partialInfo, true),
      })
      applyEnvironmentInfo(info, false)
    } catch (error) {
      if (requestIsCurrent() && requestSequence === requestId) {
        logLoad('failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        updateEnvironmentInfo(info => ({
          ...info,
          loading: false,
          branchLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load environment info',
        }))
      }
    }
  }
  async function resolveTarget() {
    const ownerGeneration = generation
    const resolutionInput = input
    const revision = ++resolutionRevision
    if (snapshot.workspaceTargetResolving) {
      try {
        const target = await resolveWorkspaceTarget({
          currentProject: resolutionInput.workspaceProject,
          api: { getProjectWorkspaceRoot: resolutionInput.getProjectWorkspaceRoot },
        })
        if (!isCurrent() || ownerGeneration !== generation || revision !== resolutionRevision)
          return
        publish({
          workspaceTarget: target,
          workspaceTargetError: null,
          workspaceTargetResolving: false,
        })
      } catch (error) {
        if (!isCurrent() || ownerGeneration !== generation || revision !== resolutionRevision)
          return
        publish({
          workspaceTarget: null,
          workspaceTargetError:
            error instanceof Error ? error.message : 'Failed to resolve workspace',
          workspaceTargetResolving: false,
        })
      }
    }
    if (input.autoLoad) await load({ force: false, showLoading: true })
  }
  return {
    getSnapshot: () => snapshot,
    isCurrent,
    ownsApi: (apiOwner: EnvironmentSourceInput['apiOwner']) =>
      isCurrent() && input.apiOwner === apiOwner,
    captureOwner() {
      const apiOwner = input.apiOwner
      const ownerGeneration = generation
      return () => isCurrent() && ownerGeneration === generation && input.apiOwner === apiOwner
    },
    updateEnvironmentInfo,
    load,
    subscribe(
      listener: () => void,
      next: EnvironmentSourceInput,
      nextMetadataKey: string,
      active: boolean
    ) {
      const queryChanged =
        metadataKey !== nextMetadataKey ||
        input.apiOwner !== next.apiOwner ||
        input.loadEnvironmentInfo !== next.loadEnvironmentInfo ||
        input.getProjectWorkspaceRoot !== next.getProjectWorkspaceRoot
      input = next
      metadataKey = nextMetadataKey
      listeners.add(listener)
      reconnect.update({
        deviceId: snapshot.workspaceTarget?.deviceId,
        devices: input.devices,
        onReconnect: () => {
          void load({ force: true, showLoading: true, shareInflight: false })
        },
      })
      const wasRefreshActive = refreshActive
      refreshActive = active
      if (!started || wasRefreshActive !== active) {
        stopPolling?.()
        stopPolling = active
          ? pollWorkbenchPresentation(
              () => void load({ force: true, showLoading: false }),
              30_000,
              120_000
            )
          : undefined
      }
      if (!started) {
        started = true
        void resolveTarget()
      } else if (queryChanged) {
        requestSequence += 1
        void resolveTarget()
      } else if (wasRefreshActive && !active) {
        void load({ force: true, showLoading: false })
      }
      return () => {
        listeners.delete(listener)
        // A same-owner refresh policy handoff keeps its accepted request and snapshot.
        queueMicrotask(() => {
          if (listeners.size) return
          started = false
          generation += 1
          requestSequence += 1
          stopPolling?.()
          stopPolling = undefined
        })
      }
    },
  }
}
