import { useCallback } from 'react'
import type { Dispatch } from 'react'
import {
  checkoutProjectBranch,
  commitAndPushProjectChanges,
  commitProjectChanges,
  createAndCheckoutProjectBranch,
  listProjectBranches,
  loadProjectEnvironment,
  loadProjectEnvironmentDiff,
  pushProjectChanges,
  type EnvironmentDiffMode,
  type EnvironmentInfoLoadOptions,
} from '@/api/environment'
import type { ExecutorClient } from '@/api/executorAccess'
import type {
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeleteDeviceWorkspaceRequest,
  DeviceWorkspacePrepareRequest,
  GitRepoInfo,
  ProjectWithTasks,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeTaskPinRequest,
  User,
} from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import type { WorkbenchState } from '@/types/workbench'
import type { ProjectMutationOptions } from './workbenchContextTypes'
import type { WorkbenchAction } from './workbenchReducer'
import { findProjectMetadataDeviceWorkspace, writeLastProjectId } from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
import {
  normalizeRuntimeWorkspacePath,
  runtimeProjectUiId,
  standaloneRuntimeProjectKey,
} from '@/lib/runtime-project'

interface UseWorkbenchProjectActionsOptions {
  user: User
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  refreshWorkLists: () => Promise<void>
  rememberExecutionDevice: (deviceId: string) => void
}

export function useWorkbenchProjectActions({
  user,
  state,
  dispatch,
  executorClient,
  services,
  refreshWorkLists,
  rememberExecutionDevice,
}: UseWorkbenchProjectActionsOptions) {
  const createProject = useCallback(
    async (data: CreateProjectRequest, options: ProjectMutationOptions = {}) => {
      const project = await services.projectApi.createProject(data)
      const projectDeviceId = data.config?.execution?.deviceId ?? data.config?.device_id
      if (projectDeviceId) {
        rememberExecutionDevice(projectDeviceId)
      }
      if (options.refreshWorkLists === false) {
        dispatch({ type: 'project_created', project })
      } else {
        await refreshWorkLists()
      }
      writeLastProjectId(user.id, project.id)
      dispatch({ type: 'project_selected', project })
      return project
    },
    [dispatch, refreshWorkLists, rememberExecutionDevice, services.projectApi, user.id]
  )

  const createGitWorkspaceProject = useCallback(
    async (data: CreateGitWorkspaceProjectRequest) => {
      if (!services.projectApi.createGitWorkspaceProject) {
        throw new Error('Git workspace project creation is unavailable')
      }
      const response = await services.projectApi.createGitWorkspaceProject(data)
      const project: ProjectWithTasks = {
        ...response.project,
        tasks: response.project.tasks ?? [],
      }
      rememberExecutionDevice(data.device_id)
      await refreshWorkLists()
      writeLastProjectId(user.id, project.id)
      dispatch({ type: 'project_selected', project })
      return project
    },
    [dispatch, refreshWorkLists, rememberExecutionDevice, services.projectApi, user.id]
  )

  const prepareDeviceWorkspace = useCallback(
    async (data: DeviceWorkspacePrepareRequest, options: ProjectMutationOptions = {}) => {
      const response = await executorClient.runtime.prepareDeviceWorkspace(data)
      rememberExecutionDevice(data.deviceId)
      if (options.refreshWorkLists === false) {
        dispatch({ type: 'device_workspace_prepared', mapping: response.mapping })
      } else {
        await refreshWorkLists()
      }
      return response
    },
    [dispatch, executorClient, refreshWorkLists, rememberExecutionDevice]
  )

  const deleteDeviceWorkspace = useCallback(
    async (data: DeleteDeviceWorkspaceRequest) => {
      await executorClient.runtime.deleteDeviceWorkspace(data)
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists]
  )

  const listGitRepositories = useCallback(
    () => services.gitApi?.listRepositories() ?? Promise.resolve([]),
    [services.gitApi]
  )

  const listGitBranches = useCallback(
    (repo: GitRepoInfo) => services.gitApi?.listBranches(repo) ?? Promise.resolve([]),
    [services.gitApi]
  )

  const updateProjectName = useCallback(
    async (projectId: number, name: string) => {
      const runtimeWorkspace = findProjectMetadataDeviceWorkspace(
        state.runtimeWork,
        projectId,
        null
      )
      if (runtimeWorkspace) {
        const runtimeProject = state.runtimeWork?.projects.find(
          item => runtimeProjectUiId(item.project) === projectId
        )?.project
        const response = await executorClient.runtime.renameRuntimeWorkspace({
          deviceId: runtimeWorkspace.deviceId,
          projectKey: runtimeProject?.key,
          workspacePath: runtimeWorkspace.workspacePath,
          runtime: 'codex',
          name,
        })
        if (!response.accepted) {
          const message = response.error || 'Failed to rename runtime workspace'
          dispatch({ type: 'error_set', error: message })
          throw new Error(message)
        }
        await refreshWorkLists()
        return
      }
      await services.projectApi.updateProject(projectId, { name })
      await refreshWorkLists()
    },
    [dispatch, executorClient, refreshWorkLists, services.projectApi, state.runtimeWork]
  )

  const removeListedRuntimeProject = useCallback(
    async (projectId: number) => {
      const runtimeWorkspace = findProjectMetadataDeviceWorkspace(
        state.runtimeWork,
        projectId,
        null
      )
      if (!runtimeWorkspace) return false

      const runtimeProject = state.runtimeWork?.projects.find(
        item => runtimeProjectUiId(item.project) === projectId
      )?.project
      const response = await executorClient.runtime.removeRuntimeWorkspace({
        deviceId: runtimeWorkspace.deviceId,
        projectKey: runtimeProject?.key,
        workspacePath: runtimeWorkspace.workspacePath,
        runtime: 'codex',
      })
      if (!response.accepted) {
        const message = response.error || 'Failed to remove runtime workspace'
        dispatch({ type: 'error_set', error: message })
        throw new Error(message)
      }

      const standaloneDeviceId = state.standaloneDeviceId?.trim()
      const standaloneWorkspacePath = state.standaloneWorkspacePath
        ? normalizeRuntimeWorkspacePath(state.standaloneWorkspacePath)
        : ''
      const clearsStandaloneWorkspace =
        standaloneDeviceId === runtimeWorkspace.deviceId.trim() &&
        standaloneWorkspacePath === normalizeRuntimeWorkspacePath(runtimeWorkspace.workspacePath)
      await refreshWorkLists()
      if (clearsStandaloneWorkspace) {
        dispatch({
          type: 'project_cleared',
          standaloneDeviceId: runtimeWorkspace.deviceId,
          standaloneWorkspacePath: null,
          startFreshChat: true,
        })
      }
      return true
    },
    [
      dispatch,
      executorClient,
      refreshWorkLists,
      state.runtimeWork,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
    ]
  )

  const removeStandaloneRuntimeProject = useCallback(
    async (projectId: number) => {
      const standaloneDeviceId = state.standaloneDeviceId?.trim()
      const standaloneWorkspacePath = state.standaloneWorkspacePath
        ? normalizeRuntimeWorkspacePath(state.standaloneWorkspacePath)
        : ''
      const standaloneProjectId =
        standaloneDeviceId && standaloneWorkspacePath
          ? runtimeProjectUiId({
              key: standaloneRuntimeProjectKey(standaloneWorkspacePath),
              stateDeviceId: standaloneDeviceId,
              name: standaloneWorkspacePath,
            })
          : null
      if (standaloneProjectId !== projectId || !standaloneDeviceId || !standaloneWorkspacePath) {
        return false
      }

      const response = await executorClient.runtime.removeRuntimeWorkspace({
        deviceId: standaloneDeviceId,
        projectKey: standaloneRuntimeProjectKey(standaloneWorkspacePath),
        workspacePath: standaloneWorkspacePath,
        runtime: 'codex',
      })
      if (!response.accepted) {
        const message = response.error || 'Failed to remove runtime workspace'
        dispatch({ type: 'error_set', error: message })
        throw new Error(message)
      }
      await refreshWorkLists()
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId,
        standaloneWorkspacePath: null,
        startFreshChat: true,
      })
      return true
    },
    [
      dispatch,
      executorClient,
      refreshWorkLists,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
    ]
  )

  const removeCloudProject = useCallback(
    async (projectId: number) => {
      if (!state.projects.some(project => project.id === projectId)) {
        const message = 'Project is no longer available'
        dispatch({ type: 'error_set', error: message })
        throw new Error(message)
      }
      try {
        await services.projectApi.deleteProject(projectId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove project'
        dispatch({ type: 'error_set', error: message })
        throw error
      }
      await refreshWorkLists()
    },
    [dispatch, refreshWorkLists, services.projectApi, state.projects]
  )

  const removeProject = useCallback(
    async (projectId: number) => {
      if (await removeListedRuntimeProject(projectId)) return
      if (await removeStandaloneRuntimeProject(projectId)) return
      await removeCloudProject(projectId)
    },
    [removeCloudProject, removeListedRuntimeProject, removeStandaloneRuntimeProject]
  )

  const reorderRuntimeProjects = useCallback(
    async (data: RuntimeProjectReorderRequest) => {
      await executorClient.runtime.reorderRuntimeProjects(data)
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists]
  )

  const setRuntimeProjectPinned = useCallback(
    async (data: RuntimeProjectPinRequest) => {
      await executorClient.runtime.setRuntimeProjectPinned(data)
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists]
  )

  const setRuntimeProjectAppearance = useCallback(
    async (data: RuntimeProjectAppearanceRequest) => {
      await executorClient.runtime.setRuntimeProjectAppearance(data)
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists]
  )

  const reorderRuntimeProjectTasks = useCallback(
    async (data: RuntimeProjectTaskReorderRequest) => {
      await executorClient.runtime.reorderRuntimeProjectTasks(data)
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists]
  )

  const setRuntimeTaskPinned = useCallback(
    async (data: RuntimeTaskPinRequest) => {
      await executorClient.runtime.setRuntimeTaskPinned(data)
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists]
  )

  const getDeviceHomeDirectory = useCallback(
    (deviceId: string) => executorClient.commands.getHomeDirectory(deviceId),
    [executorClient]
  )

  const getProjectWorkspaceRoot = useCallback(
    (deviceId: string) => executorClient.commands.getProjectWorkspaceRoot(deviceId),
    [executorClient]
  )

  const listDeviceDirectories = useCallback(
    (deviceId: string, path: string) => executorClient.commands.listDirectories(deviceId, path),
    [executorClient]
  )

  const createDeviceDirectory = useCallback(
    (deviceId: string, path: string) => executorClient.commands.createDirectory(deviceId, path),
    [executorClient]
  )

  const loadEnvironmentInfo = useCallback(
    (
      project: ProjectWithTasks | null,
      workspaceTarget?: WorkspaceTarget | null,
      options?: EnvironmentInfoLoadOptions
    ) => loadProjectEnvironment(executorClient.commands, project, workspaceTarget, options),
    [executorClient]
  )

  const loadEnvironmentDiff = useCallback(
    (
      project: ProjectWithTasks | null,
      workspaceTarget?: WorkspaceTarget | null,
      mode?: EnvironmentDiffMode
    ) => loadProjectEnvironmentDiff(executorClient.commands, project, workspaceTarget, mode),
    [executorClient]
  )

  const commitEnvironmentChanges = useCallback(
    (project: ProjectWithTasks | null, message: string, workspaceTarget?: WorkspaceTarget | null) =>
      commitProjectChanges(executorClient.commands, project, message, workspaceTarget),
    [executorClient]
  )

  const commitAndPushEnvironmentChanges = useCallback(
    (project: ProjectWithTasks | null, message: string, workspaceTarget?: WorkspaceTarget | null) =>
      commitAndPushProjectChanges(executorClient.commands, project, message, workspaceTarget),
    [executorClient]
  )

  const pushEnvironmentChanges = useCallback(
    (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) =>
      pushProjectChanges(executorClient.commands, project, workspaceTarget),
    [executorClient]
  )

  const listEnvironmentBranches = useCallback(
    (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) =>
      listProjectBranches(executorClient.commands, project, workspaceTarget),
    [executorClient]
  )

  const checkoutEnvironmentBranch = useCallback(
    (
      project: ProjectWithTasks | null,
      branchName: string,
      workspaceTarget?: WorkspaceTarget | null
    ) => checkoutProjectBranch(executorClient.commands, project, branchName, workspaceTarget),
    [executorClient]
  )

  const createEnvironmentBranch = useCallback(
    (
      project: ProjectWithTasks | null,
      branchName: string,
      workspaceTarget?: WorkspaceTarget | null
    ) =>
      createAndCheckoutProjectBranch(executorClient.commands, project, branchName, workspaceTarget),
    [executorClient]
  )

  return {
    createProject,
    createGitWorkspaceProject,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    listGitRepositories,
    listGitBranches,
    updateProjectName,
    removeProject,
    reorderRuntimeProjects,
    setRuntimeProjectPinned,
    setRuntimeProjectAppearance,
    reorderRuntimeProjectTasks,
    setRuntimeTaskPinned,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    loadEnvironmentInfo,
    loadEnvironmentDiff,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
  }
}
