import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { ProjectWithTasks } from '@/types/api'
import type { EnvironmentDiffMode } from '@/api/environment'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { isGitWorkspaceProject } from '@/lib/projectClassification'
import { isCloudDevice } from '@/lib/device-selection'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import {
  resolveProjectRuntimeWorkspaceTarget,
  resolveRuntimeWorkspaceContext,
  resolveWorkspaceTarget,
  workspaceTargetKey,
} from '@/lib/workspace-target'
import type { WorkbenchPaneIdentity } from './workbenchPaneStack'

export interface WorkbenchPaneEnvironment {
  workspaceProject: ProjectWithTasks | null
  workspaceTarget: WorkspaceTarget | null
  workspaceTargetError: string | null
  environmentInfo: EnvironmentInfo
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
  const [environmentInfo, setEnvironmentInfo] = useState<EnvironmentInfo>({
    additions: '',
    deletions: '',
    executionTarget: 'local',
  })
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceTarget | null>(null)
  const [workspaceTargetError, setWorkspaceTargetError] = useState<string | null>(null)
  const [workspaceTargetResolving, setWorkspaceTargetResolving] = useState(false)
  const environmentInfoRequestSequence = useRef(0)
  const previousEnvironmentRefreshActive = useRef(false)
  const devicesRef = useRef(state.devices)
  devicesRef.current = state.devices
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
  const activeConversationProject = currentProject ?? runtimeWorkspaceContext?.project ?? null
  const selectedWorkspaceProject = projectWork.currentProjectId
    ? (projectWork.projects.find(project => project.id === projectWork.currentProjectId) ??
      state.projects.find(project => project.id === projectWork.currentProjectId) ??
      null)
    : null
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
  const workspaceTargetResolverApi = useMemo(
    () => ({ getProjectWorkspaceRoot }),
    [getProjectWorkspaceRoot]
  )
  const runtimeWorkspaceTarget = runtimeWorkspaceContext?.workspaceTarget ?? null
  const runtimeWorkspaceTargetKey = workspaceTargetKey(runtimeWorkspaceTarget)
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
  const projectRuntimeWorkspaceTargetKey = workspaceTargetKey(projectRuntimeWorkspaceTarget)
  const activeWorkspaceTarget = currentRuntimeTask
    ? runtimeWorkspaceTarget
    : (projectRuntimeWorkspaceTarget ?? workspaceTarget)
  const activeWorkspaceTargetKey = workspaceTargetKey(activeWorkspaceTarget)
  const environmentMatchesActiveWorkspace = Boolean(
    activeWorkspaceTarget &&
    environmentInfo.workspacePath === activeWorkspaceTarget.path &&
    environmentInfo.deviceId === activeWorkspaceTarget.deviceId
  )
  const isGitProject = environmentMatchesActiveWorkspace
    ? environmentInfo.isGitRepository !== false
    : Boolean(workspaceProject && isGitWorkspaceProject(workspaceProject))
  const workspaceProjectKey = workspaceProject ? String(workspaceProject.id) : ''
  const activeConversationProjectKey = activeConversationProject
    ? String(activeConversationProject.id)
    : ''
  const currentRuntimeTaskKey = currentRuntimeTask
    ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}:${
        currentRuntimeTask.workspacePath ?? ''
      }`
    : ''
  const environmentContextRef = useRef({ workspaceProject, activeWorkspaceTarget })
  const hasEnvironmentProject = Boolean(workspaceProject)
  const environmentWorkspaceReady = !hasEnvironmentProject || Boolean(activeWorkspaceTarget)
  const gitActionsAvailable =
    !environmentMatchesActiveWorkspace || environmentInfo.isGitRepository !== false

  useEffect(() => {
    environmentContextRef.current = { workspaceProject, activeWorkspaceTarget }
  }, [activeWorkspaceTarget, workspaceProject])

  useEffect(() => {
    let cancelled = false

    if (currentRuntimeTask) {
      setWorkspaceTarget(current =>
        workspaceTargetKey(current) === runtimeWorkspaceTargetKey ? current : runtimeWorkspaceTarget
      )
      setWorkspaceTargetError(runtimeWorkspaceTarget ? null : 'Workspace is not ready')
      setWorkspaceTargetResolving(false)
      return () => {
        cancelled = true
      }
    }

    if (projectRuntimeWorkspaceTarget) {
      setWorkspaceTarget(current =>
        workspaceTargetKey(current) === projectRuntimeWorkspaceTargetKey
          ? current
          : projectRuntimeWorkspaceTarget
      )
      setWorkspaceTargetError(null)
      setWorkspaceTargetResolving(false)
      return () => {
        cancelled = true
      }
    }

    setWorkspaceTargetResolving(true)
    setWorkspaceTarget(null)
    setWorkspaceTargetError(null)
    resolveWorkspaceTarget({
      currentProject: workspaceProject,
      api: workspaceTargetResolverApi,
    })
      .then(target => {
        if (!cancelled) {
          setWorkspaceTarget(current =>
            workspaceTargetKey(current) === workspaceTargetKey(target) ? current : target
          )
          setWorkspaceTargetError(null)
          setWorkspaceTargetResolving(false)
        }
      })
      .catch(error => {
        if (!cancelled) {
          setWorkspaceTarget(null)
          setWorkspaceTargetError(
            error instanceof Error ? error.message : 'Failed to resolve workspace'
          )
          setWorkspaceTargetResolving(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    currentRuntimeTask,
    projectRuntimeWorkspaceTarget,
    projectRuntimeWorkspaceTargetKey,
    runtimeWorkspaceTarget,
    runtimeWorkspaceTargetKey,
    workspaceProject,
    workspaceTargetResolverApi,
  ])

  const loadCurrentEnvironmentInfo = useCallback(
    async ({ force, showLoading }: { force: boolean; showLoading: boolean }) => {
      const requestId = environmentInfoRequestSequence.current + 1
      environmentInfoRequestSequence.current = requestId

      if (workspaceTargetResolving) {
        if (showLoading) {
          setEnvironmentInfo(info => ({ ...info, loading: true }))
        }
        return
      }

      if (!environmentWorkspaceReady) {
        setEnvironmentInfo(info => ({
          ...info,
          loading: false,
          error: workspaceTargetError ?? 'Workspace is not ready',
        }))
        return
      }

      if (showLoading) {
        setEnvironmentInfo(info =>
          info.workspacePath === activeWorkspaceTarget?.path &&
          info.deviceId === activeWorkspaceTarget?.deviceId
            ? { ...info, loading: true }
            : {
                additions: '',
                deletions: '',
                executionTarget: info.executionTarget,
                deviceId: activeWorkspaceTarget?.deviceId,
                workspacePath: activeWorkspaceTarget?.path,
                loading: true,
              }
        )
      }
      try {
        const {
          workspaceProject: latestWorkspaceProject,
          activeWorkspaceTarget: latestActiveWorkspaceTarget,
        } = environmentContextRef.current
        const info = force
          ? await loadEnvironmentInfo(latestWorkspaceProject, latestActiveWorkspaceTarget, {
              force: true,
            })
          : await loadEnvironmentInfo(latestWorkspaceProject, latestActiveWorkspaceTarget)
        if (environmentInfoRequestSequence.current === requestId) {
          const actualDevice = findWorkbenchDevice(
            devicesRef.current,
            latestActiveWorkspaceTarget?.deviceId ?? info.deviceId
          )
          setEnvironmentInfo({
            ...info,
            executionTarget: actualDevice
              ? isCloudDevice(actualDevice)
                ? 'cloud'
                : 'local'
              : info.executionTarget,
            loading: false,
          })
        }
      } catch (error) {
        if (environmentInfoRequestSequence.current === requestId) {
          setEnvironmentInfo(info => ({
            ...info,
            loading: false,
            error: error instanceof Error ? error.message : 'Failed to load environment info',
          }))
        }
      }
    },
    [
      activeWorkspaceTarget?.deviceId,
      activeWorkspaceTarget?.path,
      environmentWorkspaceReady,
      loadEnvironmentInfo,
      workspaceTargetError,
      workspaceTargetResolving,
    ]
  )

  const refreshEnvironmentInfo = useCallback(
    () => loadCurrentEnvironmentInfo({ force: true, showLoading: true }),
    [loadCurrentEnvironmentInfo]
  )

  useEffect(() => {
    if (!activeConversationProjectKey && !currentRuntimeTaskKey) return
    void loadCurrentEnvironmentInfo({ force: false, showLoading: true })
  }, [
    activeConversationProjectKey,
    activeWorkspaceTargetKey,
    currentRuntimeTaskKey,
    loadCurrentEnvironmentInfo,
    workspaceProjectKey,
  ])

  useEffect(() => {
    const wasRefreshActive = previousEnvironmentRefreshActive.current
    previousEnvironmentRefreshActive.current = environmentRefreshActive

    if (!environmentRefreshActive) {
      if (wasRefreshActive) {
        void loadCurrentEnvironmentInfo({ force: true, showLoading: false })
      }
      return
    }

    const intervalId = window.setInterval(() => {
      void loadCurrentEnvironmentInfo({ force: true, showLoading: false })
    }, 5000)
    return () => window.clearInterval(intervalId)
  }, [environmentRefreshActive, loadCurrentEnvironmentInfo])

  const commitPaneEnvironmentChanges = useCallback(
    async (message: string) => {
      if (!activeWorkspaceTarget) {
        throw new Error(workspaceTargetError ?? 'Workspace is not ready')
      }
      await commitEnvironmentChanges(workspaceProject, message, activeWorkspaceTarget)
      setEnvironmentInfo(info => ({ ...info, additions: '', deletions: '' }))
    },
    [activeWorkspaceTarget, commitEnvironmentChanges, workspaceProject, workspaceTargetError]
  )

  const commitAndPushPaneEnvironmentChanges = useCallback(
    async (message: string) => {
      if (!activeWorkspaceTarget) {
        throw new Error(workspaceTargetError ?? 'Workspace is not ready')
      }
      await commitAndPushEnvironmentChanges(workspaceProject, message, activeWorkspaceTarget)
      setEnvironmentInfo(info => ({ ...info, additions: '', deletions: '' }))
    },
    [activeWorkspaceTarget, commitAndPushEnvironmentChanges, workspaceProject, workspaceTargetError]
  )

  const pushPaneEnvironmentChanges = useCallback(async () => {
    if (!activeWorkspaceTarget) {
      throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    }
    await pushEnvironmentChanges(workspaceProject, activeWorkspaceTarget)
  }, [activeWorkspaceTarget, pushEnvironmentChanges, workspaceProject, workspaceTargetError])

  const listPaneEnvironmentBranches = useCallback(() => {
    const {
      workspaceProject: latestWorkspaceProject,
      activeWorkspaceTarget: latestActiveWorkspaceTarget,
    } = environmentContextRef.current
    if (!latestActiveWorkspaceTarget) {
      return Promise.reject(new Error(workspaceTargetError ?? 'Workspace is not ready'))
    }
    return listEnvironmentBranches(latestWorkspaceProject, latestActiveWorkspaceTarget)
  }, [listEnvironmentBranches, workspaceTargetError])

  const checkoutPaneEnvironmentBranch = useCallback(
    async (branchName: string) => {
      const {
        workspaceProject: latestWorkspaceProject,
        activeWorkspaceTarget: latestActiveWorkspaceTarget,
      } = environmentContextRef.current
      if (!latestActiveWorkspaceTarget) {
        throw new Error(workspaceTargetError ?? 'Workspace is not ready')
      }
      await checkoutEnvironmentBranch(
        latestWorkspaceProject,
        branchName,
        latestActiveWorkspaceTarget
      )
      setEnvironmentInfo(info => ({ ...info, branchName }))
    },
    [checkoutEnvironmentBranch, workspaceTargetError]
  )

  const createPaneEnvironmentBranch = useCallback(
    async (branchName: string) => {
      const {
        workspaceProject: latestWorkspaceProject,
        activeWorkspaceTarget: latestActiveWorkspaceTarget,
      } = environmentContextRef.current
      if (!latestActiveWorkspaceTarget) {
        throw new Error(workspaceTargetError ?? 'Workspace is not ready')
      }
      await createEnvironmentBranch(latestWorkspaceProject, branchName, latestActiveWorkspaceTarget)
      setEnvironmentInfo(info => ({ ...info, branchName }))
    },
    [createEnvironmentBranch, workspaceTargetError]
  )

  return {
    workspaceProject,
    workspaceTarget: activeWorkspaceTarget,
    workspaceTargetError,
    environmentInfo,
    projectWork: {
      ...projectWork,
      isGitProject,
      branchName: environmentInfo.branchName,
      branchLoading: environmentInfo.loading,
      onRefreshBranch: undefined,
      onListBranches:
        activeWorkspaceTarget && gitActionsAvailable ? listPaneEnvironmentBranches : undefined,
      onCheckoutBranch: gitActionsAvailable ? checkoutPaneEnvironmentBranch : undefined,
      onCreateBranch: gitActionsAvailable ? createPaneEnvironmentBranch : undefined,
    },
    refreshEnvironmentInfo,
    commitEnvironmentChanges: commitPaneEnvironmentChanges,
    commitAndPushEnvironmentChanges: commitAndPushPaneEnvironmentChanges,
    pushEnvironmentChanges: pushPaneEnvironmentChanges,
    loadEnvironmentDiff:
      activeWorkspaceTarget && gitActionsAvailable
        ? (target, mode) => loadEnvironmentDiff(workspaceProject, target, mode)
        : undefined,
    listEnvironmentBranches: listPaneEnvironmentBranches,
    checkoutEnvironmentBranch: checkoutPaneEnvironmentBranch,
    createEnvironmentBranch: createPaneEnvironmentBranch,
  }
}
