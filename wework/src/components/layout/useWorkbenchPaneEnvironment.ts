import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { WEWORK_HOST_SERVICES } from '@/features/dsh-runtime/conversationHostServices'
import { hasMatchingConversationSummaryHostService } from '@/features/dsh-runtime/conversationSummarySurface'
import { WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import {
  getChangeRequestMonitor,
  runtimeTaskChangeRequestTarget,
  useTaskChangeRequest,
} from '@/features/workbench/changeRequestMonitor'
import type { ProjectWithTasks } from '@/types/api'
import type { EnvironmentDiffMode } from '@/api/environment'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import { configuredWorkspacePath, executionDeviceId } from '@/lib/project-workspace'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { getRuntimeConfig } from '@/config/runtime'
import { getLocalRuntimeSourceIdentity } from '@/lib/local-runtime-sidebar-identity'
import { useTranslation } from '@/hooks/useTranslation'
import {
  resolveProjectWorktreeAvailability,
  worktreeWorkspaceDeviceId,
} from '@/lib/worktree-availability'
import {
  resolveProjectRuntimeWorkspaceTarget,
  resolveRuntimeTaskSource,
  resolveRuntimeWorkspaceContext,
} from '@/lib/workspace-target'
import type { WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import { createWorkbenchPaneEnvironmentSource } from './workbenchPaneEnvironmentSource'
import {
  resolveConversationSummaryIsGitRepository,
  resolveSelectedWorkspaceProject,
  applySharedChangeRequestSnapshot,
} from './workbenchPaneEnvironmentHelpers'
import { useProjectWorktreeAvailabilityProbe } from './useProjectWorktreeAvailabilityProbe'

export interface WorkbenchPaneEnvironment {
  workspaceProject: ProjectWithTasks | null
  workspaceTarget: WorkspaceTarget | null
  workspaceTargetError: string | null
  environmentInfo: EnvironmentInfo
  conversationSummaryIsGitRepository: boolean | undefined
  projectWork: ProjectWorkControls
  refreshEnvironmentInfo: () => Promise<void>
  commitEnvironmentChanges: (message: string) => Promise<void>
  commitAndPushEnvironmentChanges: (message: string) => Promise<void>
  pushEnvironmentChanges: () => Promise<void>
  loadEnvironmentDiff?: (
    workspaceTarget: WorkspaceTarget,
    mode?: EnvironmentDiffMode
  ) => Promise<string>
  listEnvironmentBranches: () => Promise<string[]>
  checkoutEnvironmentBranch: (branchName: string) => Promise<void>
  createEnvironmentBranch: (branchName: string) => Promise<void>
}

export {
  resolveConversationSummaryIsGitRepository,
  resolveSelectedWorkspaceProject,
  applySharedChangeRequestSnapshot,
  resolveEnvironmentExecutionDeviceId,
} from './workbenchPaneEnvironmentHelpers'

function createPaneEnvironmentDiffLoader(
  source: ReturnType<typeof createWorkbenchPaneEnvironmentSource>,
  apiOwner: Parameters<typeof source.ownsApi>[0],
  loadDiff: ReturnType<typeof useWorkbenchPaneContext>['loadEnvironmentDiff'],
  workspaceError: string | null
): NonNullable<WorkbenchPaneEnvironment['loadEnvironmentDiff']> {
  return async (target, mode) => {
    if (!source.ownsApi(apiOwner)) throw new Error(workspaceError ?? 'Workspace is not ready')
    const isCurrent = source.captureOwner()
    const diff = await loadDiff(null, target, mode)
    if (!isCurrent()) throw new Error('Workspace has changed')
    return diff
  }
}

export function useWorkbenchPaneEnvironment({
  pane,
  projectWork,
  environmentRefreshActive = false,
}: {
  pane: WorkbenchPaneIdentity
  projectWork: ProjectWorkControls
  environmentRefreshActive?: boolean
}): WorkbenchPaneEnvironment {
  const {
    services,
    state,
    getProjectWorkspaceRoot,
    loadEnvironmentInfo,
    loadEnvironmentDiff,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
  } = useWorkbenchPaneContext()
  const runtimeWorkApi = services?.runtimeWorkApi
  const { t } = useTranslation('common')
  const conversationSummaryEntries = useDshSlotEntries<WeworkDshSlotEntry>(
    WEWORK_DSH_SLOTS.conversationSummary
  )
  const currentRuntimeTask = pane.currentRuntimeTask
  const currentProject = pane.currentProject
  const runtimeWorkspaceContext = useMemo(
    () =>
      resolveRuntimeWorkspaceContext({
        currentRuntimeTask,
        projects: state.projects,
        runtimeWork: state.runtimeWork,
      }),
    [currentRuntimeTask, state.projects, state.runtimeWork]
  )
  const currentChangeRequestTarget = useMemo(() => {
    const source = resolveRuntimeTaskSource({
      currentRuntimeTask,
      runtimeWork: state.runtimeWork,
    })
    return source ? runtimeTaskChangeRequestTarget(source.workspace, source.task) : null
  }, [currentRuntimeTask, state.runtimeWork])
  const activeConversationProject = currentProject ?? runtimeWorkspaceContext?.project ?? null
  const selectedWorkspaceProject = resolveSelectedWorkspaceProject({
    currentProject: projectWork.currentProject,
    currentProjectId: projectWork.currentProjectId,
    projects: [...projectWork.projects, ...state.projects],
  })
  const selectedProjectDeviceWorkspace = useMemo(() => {
    if (!selectedWorkspaceProject) return null
    const runtimeProject = state.runtimeWork?.projects.find(
      item => runtimeProjectUiId(item.project) === selectedWorkspaceProject.id
    )
    const workspaces = runtimeProject?.deviceWorkspaces ?? []
    if (projectWork.selectedDeviceWorkspaceId != null) {
      return (
        workspaces.find(workspace => workspace.id === projectWork.selectedDeviceWorkspaceId) ?? null
      )
    }
    return workspaces.length === 1 ? workspaces[0] : null
  }, [projectWork.selectedDeviceWorkspaceId, selectedWorkspaceProject, state.runtimeWork?.projects])
  const workspaceProject = useMemo(() => {
    if (currentRuntimeTask) {
      return runtimeWorkspaceContext?.project ?? null
    }
    return (
      selectedWorkspaceProject ??
      activeConversationProject ??
      state.projects.find(project => project.config?.mode === 'workspace') ??
      null
    )
  }, [
    activeConversationProject,
    currentRuntimeTask,
    runtimeWorkspaceContext?.project,
    selectedWorkspaceProject,
    state.projects,
  ])
  const workspaceRootsKey = (() => {
    if (!workspaceProject) return ''
    const projectWork = state.runtimeWork?.projects.find(
      item => String(runtimeProjectUiId(item.project)) === String(workspaceProject.id)
    )
    const projectRoots =
      projectWork?.project.roots
        ?.map(root => normalizeRuntimeWorkspacePath(root.path))
        .filter(Boolean) ?? []
    const roots =
      projectRoots.length > 0
        ? [...new Set(projectRoots)]
        : [
            ...new Set(
              (projectWork?.deviceWorkspaces ?? [])
                .map(workspace => normalizeRuntimeWorkspacePath(workspace.workspacePath))
                .filter(Boolean)
            ),
          ]
    return JSON.stringify(roots)
  })()
  const workspaceRoots = useMemo<string[]>(
    () => (workspaceRootsKey ? JSON.parse(workspaceRootsKey) : []),
    [workspaceRootsKey]
  )
  const runtimeWorkspaceTarget = runtimeWorkspaceContext?.workspaceTarget ?? null
  const projectRuntimeWorkspaceTarget = useMemo(
    () =>
      currentRuntimeTask
        ? null
        : resolveProjectRuntimeWorkspaceTarget({
            currentProject: workspaceProject,
            runtimeWork: state.runtimeWork,
            selectedDeviceWorkspaceId: projectWork.selectedDeviceWorkspaceId,
          }),
    [currentRuntimeTask, projectWork.selectedDeviceWorkspaceId, state.runtimeWork, workspaceProject]
  )
  const preferences = useAppPreferencesState()
  const connection = useContext(CloudConnectionContext)
  const ownerTarget = currentRuntimeTask ? runtimeWorkspaceTarget : projectRuntimeWorkspaceTarget
  const configuredProjectPath = workspaceProject ? configuredWorkspacePath(workspaceProject) : null
  const configuredProjectDevice = workspaceProject ? executionDeviceId(workspaceProject) : null
  const ownerDeviceId =
    ownerTarget?.deviceId ??
    selectedProjectDeviceWorkspace?.deviceId ??
    currentRuntimeTask?.deviceId
  const ownerDevice = findWorkbenchDevice(state.devices, ownerDeviceId)
  const deviceSource = ownerDevice ? getLocalRuntimeSourceIdentity(ownerDevice) : undefined
  const ownerKey = JSON.stringify([
    state.user?.id,
    connection?.isConnected,
    connection?.apiBaseUrl ?? getRuntimeConfig().apiBaseUrl,
    workspaceProject?.id,
    pane.standaloneChatKey,
    currentRuntimeTask?.deviceId,
    currentRuntimeTask?.taskId,
    ownerTarget?.deviceId,
    ownerTarget?.path,
    ownerTarget?.workspaceSource,
    ownerTarget ? null : configuredProjectPath,
    ownerTarget ? null : configuredProjectDevice,
    ownerTarget ? null : workspaceProject?.config?.workspace?.source,
    selectedProjectDeviceWorkspace?.id,
    ownerDeviceId,
    ownerDevice?.runtime_instance_id,
    ownerDevice?.execution_target_id,
    deviceSource?.deviceId,
    deviceSource?.runtimeInstanceId,
  ])
  const sourceInput = useMemo(
    () => ({
      workspaceProject,
      runtimeWorkspaceTarget,
      projectRuntimeWorkspaceTarget,
      currentRuntimeTask,
      getProjectWorkspaceRoot,
      loadEnvironmentInfo,
      devices: state.devices,
      workspaceRoots,
      apiOwner: services,
      autoLoad: Boolean(activeConversationProject || currentRuntimeTask),
    }),
    [
      workspaceProject,
      runtimeWorkspaceTarget,
      projectRuntimeWorkspaceTarget,
      currentRuntimeTask,
      getProjectWorkspaceRoot,
      loadEnvironmentInfo,
      state.devices,
      workspaceRoots,
      services,
      activeConversationProject,
    ]
  )
  const [scope, setScope] = useState(() => ({
    key: ownerKey,
    source: createWorkbenchPaneEnvironmentSource(sourceInput),
  }))
  if (scope.key !== ownerKey) {
    setScope({ key: ownerKey, source: createWorkbenchPaneEnvironmentSource(sourceInput) })
  }
  const source = scope.source
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener, sourceInput, environmentRefreshActive),
    [source, sourceInput, environmentRefreshActive]
  )
  const {
    environmentInfo,
    workspaceTarget: activeWorkspaceTarget,
    workspaceTargetError,
  } = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  const conversationSummaryIsGitRepository = resolveConversationSummaryIsGitRepository({
    activeWorkspacePath: runtimeWorkspaceContext?.workspaceTarget?.path,
    environmentInfo,
    project: selectedWorkspaceProject ?? activeConversationProject,
    projectWorkspace: selectedProjectDeviceWorkspace,
  })
  const conversationSummaryContext = {
    'workspace.isGitRepository': conversationSummaryIsGitRepository,
  }
  const environmentExtensionsAvailable = hasMatchingConversationSummaryHostService(
    conversationSummaryEntries,
    conversationSummaryContext,
    WEWORK_HOST_SERVICES.environment
  )
  const changeRequestStatusEnabled =
    environmentExtensionsAvailable && (preferences?.preferences.changeRequestStatusEnabled ?? true)
  const deviceApi = services?.deviceApi
  const changeRequestMonitor = useMemo(
    () => (deviceApi ? getChangeRequestMonitor(deviceApi) : null),
    [deviceApi]
  )
  const { remoteUrl, branchName } = environmentInfo
  const displayedChangeRequestTarget =
    currentChangeRequestTarget ??
    (activeWorkspaceTarget &&
    remoteUrl &&
    branchName &&
    environmentInfo.workspacePath === activeWorkspaceTarget.path &&
    environmentInfo.deviceId === activeWorkspaceTarget.deviceId
      ? {
          deviceId: activeWorkspaceTarget.deviceId,
          taskId: currentRuntimeTask?.taskId ?? '',
          workspacePath: activeWorkspaceTarget.path,
          remoteUrl,
          branch: branchName,
        }
      : null)
  const sharedChangeRequestSnapshot = useTaskChangeRequest(
    changeRequestStatusEnabled ? changeRequestMonitor : null,
    changeRequestStatusEnabled ? displayedChangeRequestTarget : null
  )
  const selectedWorktreeDeviceId = worktreeWorkspaceDeviceId(selectedProjectDeviceWorkspace)
  const selectedWorktreeDevice = findWorkbenchDevice(state.devices, selectedWorktreeDeviceId)
  const projectedWorktreeAvailability = resolveProjectWorktreeAvailability({
    project: selectedWorkspaceProject,
    workspace: selectedProjectDeviceWorkspace,
    device: selectedWorktreeDevice,
  })
  const worktreeProbeKey = JSON.stringify([
    selectedWorkspaceProject?.id ?? null,
    selectedWorkspaceProject?.config?.mode ?? null,
    selectedProjectDeviceWorkspace?.id ?? null,
    selectedProjectDeviceWorkspace?.projectId ?? null,
    selectedProjectDeviceWorkspace?.deviceId ?? null,
    selectedProjectDeviceWorkspace?.remoteHostId ?? null,
    selectedProjectDeviceWorkspace?.workspaceSource ?? null,
    selectedProjectDeviceWorkspace?.available ?? null,
    selectedProjectDeviceWorkspace?.workspacePath ?? null,
    selectedProjectDeviceWorkspace?.workspaceKind ?? null,
    selectedProjectDeviceWorkspace?.worktreeId ?? null,
    selectedProjectDeviceWorkspace?.repoRootFingerprint ?? null,
    selectedWorktreeDeviceId,
    selectedWorktreeDevice?.device_id ?? null,
    selectedWorktreeDevice?.device_type ?? null,
    selectedWorktreeDevice?.status ?? null,
    selectedWorktreeDevice?.runtime_routes ?? null,
    selectedWorktreeDevice?.runtime_features?.schemaVersion ?? null,
    selectedWorktreeDevice?.runtime_features?.worktrees ?? null,
    projectWork.worktreeBranch?.trim() ?? '',
  ])
  const worktreeProbe = useProjectWorktreeAvailabilityProbe({
    api: runtimeWorkApi,
    device: selectedWorktreeDevice,
    enabled:
      environmentExtensionsAvailable &&
      conversationSummaryIsGitRepository === true &&
      !currentRuntimeTask,
    key: worktreeProbeKey,
    project: selectedWorkspaceProject,
    ref: projectWork.worktreeBranch,
    workspace: selectedProjectDeviceWorkspace,
  })
  const worktreeAvailability =
    worktreeProbe?.key === worktreeProbeKey
      ? worktreeProbe.availability
      : projectedWorktreeAvailability
  const contributionActionsAvailable = environmentExtensionsAvailable
  const loadPaneEnvironmentDiff = useMemo(
    () =>
      createPaneEnvironmentDiffLoader(source, services, loadEnvironmentDiff, workspaceTargetError),
    [source, services, loadEnvironmentDiff, workspaceTargetError]
  )
  const requireContributionActionsAvailable = useCallback(() => {
    if (!source.ownsApi(services)) throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    if (!environmentExtensionsAvailable) throw new Error(t('workbench.extension_unavailable'))
  }, [environmentExtensionsAvailable, source, services, workspaceTargetError, t])
  const loadCurrentEnvironmentInfo = source.load
  const refreshChangeRequestStatus = useCallback(
    () =>
      changeRequestStatusEnabled && changeRequestMonitor
        ? changeRequestMonitor.refresh({ shareInflight: false })
        : Promise.resolve(),
    [changeRequestMonitor, changeRequestStatusEnabled]
  )

  const refreshEnvironmentInfo = useCallback(async () => {
    await Promise.all([
      loadCurrentEnvironmentInfo({ force: true, showLoading: true, shareInflight: false }),
      refreshChangeRequestStatus(),
    ])
  }, [loadCurrentEnvironmentInfo, refreshChangeRequestStatus])

  const commitPaneEnvironmentChanges = useCallback(
    async (message: string) => {
      requireContributionActionsAvailable()
      if (!activeWorkspaceTarget) {
        throw new Error(workspaceTargetError ?? 'Workspace is not ready')
      }
      const isCurrent = source.captureOwner()
      await commitEnvironmentChanges(workspaceProject, message, activeWorkspaceTarget)
      if (!isCurrent()) return
      source.updateEnvironmentInfo(info => ({ ...info, additions: '', deletions: '' }))
    },
    [
      activeWorkspaceTarget,
      commitEnvironmentChanges,
      requireContributionActionsAvailable,
      source,
      workspaceProject,
      workspaceTargetError,
    ]
  )

  const commitAndPushPaneEnvironmentChanges = useCallback(
    async (message: string) => {
      requireContributionActionsAvailable()
      if (!activeWorkspaceTarget) {
        throw new Error(workspaceTargetError ?? 'Workspace is not ready')
      }
      const isCurrent = source.captureOwner()
      await commitAndPushEnvironmentChanges(workspaceProject, message, activeWorkspaceTarget)
      if (!isCurrent()) return
      source.updateEnvironmentInfo(info => ({ ...info, additions: '', deletions: '' }))
      await Promise.all([
        loadCurrentEnvironmentInfo({ force: true, showLoading: false }),
        refreshChangeRequestStatus(),
      ])
    },
    [
      activeWorkspaceTarget,
      commitAndPushEnvironmentChanges,
      loadCurrentEnvironmentInfo,
      refreshChangeRequestStatus,
      requireContributionActionsAvailable,
      source,
      workspaceProject,
      workspaceTargetError,
    ]
  )

  const pushPaneEnvironmentChanges = useCallback(async () => {
    requireContributionActionsAvailable()
    if (!activeWorkspaceTarget) {
      throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    }
    const isCurrent = source.captureOwner()
    await pushEnvironmentChanges(workspaceProject, activeWorkspaceTarget)
    if (!isCurrent()) return
    await Promise.all([
      loadCurrentEnvironmentInfo({ force: true, showLoading: false }),
      refreshChangeRequestStatus(),
    ])
  }, [
    activeWorkspaceTarget,
    loadCurrentEnvironmentInfo,
    pushEnvironmentChanges,
    refreshChangeRequestStatus,
    requireContributionActionsAvailable,
    source,
    workspaceProject,
    workspaceTargetError,
  ])

  const listPaneEnvironmentBranches = useCallback(async () => {
    requireContributionActionsAvailable()
    const latestWorkspaceProject = workspaceProject
    const latestActiveWorkspaceTarget = activeWorkspaceTarget
    if (!latestActiveWorkspaceTarget) {
      return Promise.reject(new Error(workspaceTargetError ?? 'Workspace is not ready'))
    }
    const isCurrent = source.captureOwner()
    const branches = await listEnvironmentBranches(
      latestWorkspaceProject,
      latestActiveWorkspaceTarget
    )
    if (!isCurrent()) throw new Error('Workspace has changed')
    return branches
  }, [
    activeWorkspaceTarget,
    listEnvironmentBranches,
    requireContributionActionsAvailable,
    source,
    workspaceProject,
    workspaceTargetError,
  ])

  const checkoutPaneEnvironmentBranch = useCallback(
    async (branchName: string) => {
      requireContributionActionsAvailable()
      const latestWorkspaceProject = workspaceProject
      const latestActiveWorkspaceTarget = activeWorkspaceTarget
      if (!latestActiveWorkspaceTarget) {
        throw new Error(workspaceTargetError ?? 'Workspace is not ready')
      }
      const isCurrent = source.captureOwner()
      await checkoutEnvironmentBranch(
        latestWorkspaceProject,
        branchName,
        latestActiveWorkspaceTarget
      )
      if (!isCurrent()) return
      source.updateEnvironmentInfo(info => ({ ...info, branchName }))
    },
    [
      activeWorkspaceTarget,
      checkoutEnvironmentBranch,
      requireContributionActionsAvailable,
      source,
      workspaceProject,
      workspaceTargetError,
    ]
  )

  const createPaneEnvironmentBranch = useCallback(
    async (branchName: string) => {
      requireContributionActionsAvailable()
      const latestWorkspaceProject = workspaceProject
      const latestActiveWorkspaceTarget = activeWorkspaceTarget
      if (!latestActiveWorkspaceTarget) {
        throw new Error(workspaceTargetError ?? 'Workspace is not ready')
      }
      const isCurrent = source.captureOwner()
      await createEnvironmentBranch(latestWorkspaceProject, branchName, latestActiveWorkspaceTarget)
      if (!isCurrent()) return
      source.updateEnvironmentInfo(info => ({ ...info, branchName }))
    },
    [
      activeWorkspaceTarget,
      createEnvironmentBranch,
      requireContributionActionsAvailable,
      source,
      workspaceProject,
      workspaceTargetError,
    ]
  )
  const sharedEnvironmentInfo = useMemo<EnvironmentInfo>(() => {
    if (!sharedChangeRequestSnapshot) {
      return environmentInfo
    }
    return applySharedChangeRequestSnapshot(environmentInfo, sharedChangeRequestSnapshot)
  }, [environmentInfo, sharedChangeRequestSnapshot])

  return {
    workspaceProject,
    workspaceTarget: activeWorkspaceTarget,
    workspaceTargetError,
    environmentInfo: sharedEnvironmentInfo,
    conversationSummaryIsGitRepository,
    projectWork: {
      ...projectWork,
      worktreeAvailability,
      branchName: environmentInfo.branchName,
      branchLoading: environmentInfo.branchLoading ?? environmentInfo.loading,
      onListBranches:
        activeWorkspaceTarget && contributionActionsAvailable
          ? listPaneEnvironmentBranches
          : undefined,
      onCheckoutBranch: contributionActionsAvailable ? checkoutPaneEnvironmentBranch : undefined,
      onCreateBranch: contributionActionsAvailable ? createPaneEnvironmentBranch : undefined,
    },
    refreshEnvironmentInfo,
    commitEnvironmentChanges: commitPaneEnvironmentChanges,
    commitAndPushEnvironmentChanges: commitAndPushPaneEnvironmentChanges,
    pushEnvironmentChanges: pushPaneEnvironmentChanges,
    loadEnvironmentDiff:
      activeWorkspaceTarget && contributionActionsAvailable ? loadPaneEnvironmentDiff : undefined,
    listEnvironmentBranches: listPaneEnvironmentBranches,
    checkoutEnvironmentBranch: checkoutPaneEnvironmentBranch,
    createEnvironmentBranch: createPaneEnvironmentBranch,
  }
}
