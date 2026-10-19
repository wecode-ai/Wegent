import { useTranslation } from '@/hooks/useTranslation'
import { createCommitMessageGenerator } from '@/api/commitMessage'
import { type RuntimeProjectUpdate } from '@/lib/runtime-project-update'
import {
  assertLocalRuntimeSidebarIdentity,
  type LocalRuntimeSidebarIdentity,
} from '@/lib/local-runtime-sidebar-identity'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import { projectEditingDeviceRevision } from '@/lib/project-editing-capabilities'
import {
  findOwnedRuntimeProject,
  saveProjectOnOwningRuntime,
  type ProjectEditingSave,
} from '@/lib/project-editing-save'
import {
  getRuntimeProjectSyncTarget,
  type RuntimeProjectSyncTarget,
} from '@/lib/runtime-project-identity'
import { useCallback, useLayoutEffect, useRef } from 'react'
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
  CloneGitRepositoryInput,
  DeleteDeviceWorkspaceRequest,
  DeviceWorkspacePrepareRequest,
  GitRepoInfo,
  ProjectWithTasks,
  RuntimeProjectAppearanceRequest,
  RuntimeRemoteProjectRegistration,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeTaskPinRequest,
  User,
} from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import type { WorkbenchState } from '@/types/workbench'
import { getParentPath } from '@/components/projects/device-folder-path'
import { hasEmbeddedHttpGitCredentials } from '@/lib/git-url'
import type { ProjectMutationOptions, RefreshWorkLists } from './workbenchContextTypes'
import type { WorkbenchAction } from './workbenchReducer'
import { findProjectMetadataDeviceWorkspace, writeLastProjectId } from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
import { isRemoteRuntimeWorkspace } from './workbenchCloudStatus'
import {
  normalizeRuntimeWorkspacePath,
  runtimeProjectUiId,
  standaloneRuntimeProjectKey,
} from '@/lib/runtime-project'
import { track } from '@/telemetry/client'

interface UseWorkbenchProjectActionsOptions {
  user: User
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  refreshWorkLists: RefreshWorkLists
  updateRuntimeProject: (update: RuntimeProjectUpdate) => void
  getRuntimeWorkSnapshot: () => WorkbenchState['runtimeWork']
  getRemoteProjectRegistrations: (
    identity: LocalRuntimeSidebarIdentity
  ) => RuntimeRemoteProjectRegistration[]
  updateLocalRuntimeTaskPinned: (request: RuntimeTaskPinRequest) => number | null
  rollbackLocalRuntimeTaskPinned: (request: RuntimeTaskPinRequest, requestId: number | null) => void
  markRuntimeProjectRemoved: (
    projectId: number,
    workspace?: { deviceId: string; workspacePath: string }
  ) => void
  invalidateRemoteProjectSync: (target: RuntimeProjectSyncTarget) => void
  clearRemoteProjectSyncRemoval: (target: RuntimeProjectSyncTarget) => void
  enqueueRemoteProjectStateMutation: <T>(mutation: () => Promise<T>) => Promise<T>
}

export function normalizeGitRepositoryUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
}

export async function isMatchingGitCheckout(
  executeCommand: ExecutorClient['commands']['executeCommand'],
  deviceId: string,
  targetPath: string,
  url: string,
  branch?: string
): Promise<boolean> {
  try {
    const remoteResponse = await executeCommand(deviceId, {
      command_key: 'git_remote_url',
      cwd: targetPath,
      timeout_seconds: 10,
      max_output_bytes: 16 * 1024,
    })
    if (
      !remoteResponse.success ||
      remoteResponse.exit_code !== 0 ||
      typeof remoteResponse.stdout !== 'string' ||
      normalizeGitRepositoryUrl(remoteResponse.stdout) !== normalizeGitRepositoryUrl(url)
    ) {
      return false
    }
    if (!branch) return true

    const branchResponse = await executeCommand(deviceId, {
      command_key: 'git_branch',
      cwd: targetPath,
      timeout_seconds: 10,
      max_output_bytes: 16 * 1024,
    })
    return (
      branchResponse.success &&
      branchResponse.exit_code === 0 &&
      typeof branchResponse.stdout === 'string' &&
      branchResponse.stdout.trim() === branch
    )
  } catch {
    return false
  }
}

export function useWorkbenchProjectActions({
  user,
  state,
  dispatch,
  executorClient,
  services,
  refreshWorkLists,
  updateRuntimeProject,
  getRuntimeWorkSnapshot,
  getRemoteProjectRegistrations,
  updateLocalRuntimeTaskPinned,
  rollbackLocalRuntimeTaskPinned,
  markRuntimeProjectRemoved,
  invalidateRemoteProjectSync,
  clearRemoteProjectSyncRemoval,
  enqueueRemoteProjectStateMutation,
}: UseWorkbenchProjectActionsOptions) {
  const { t } = useTranslation('common')
  const runtimeTaskPinMutationTailsRef = useRef(new Map<string, Promise<void>>())
  const currentDevicesRef = useRef(state.devices)
  useLayoutEffect(() => {
    currentDevicesRef.current = state.devices
  }, [state.devices])

  const createProject = useCallback(
    async (data: CreateProjectRequest, options: ProjectMutationOptions = {}) => {
      const project = await services.projectApi.createProject(data)
      if (options.refreshWorkLists === false) {
        dispatch({ type: 'project_created', project })
      } else {
        await refreshWorkLists()
      }
      writeLastProjectId(user.id, project.id)
      dispatch({ type: 'project_selected', project })
      track('project_created', { kind: 'standard' })
      return project
    },
    [dispatch, refreshWorkLists, services.projectApi, user.id]
  )

  const createLocalRuntimeProject = useCallback(
    async (data: { deviceId: string; name: string; roots: string[] }) => {
      const response = await executorClient.runtime.upsertLocalRuntimeProject({
        ...data,
        projectKey: crypto.randomUUID(),
        runtime: 'codex',
      })
      if (!response.accepted) {
        throw new Error(response.error || 'Failed to create local project')
      }
      clearRemoteProjectSyncRemoval({
        deviceId: response.deviceId,
        projectKey: response.projectKey,
      })
      await refreshWorkLists()
      return {
        id: runtimeProjectUiId({
          key: response.projectKey,
          stateDeviceId: response.deviceId,
          name: response.name,
        }),
        name: response.name,
        runtimeProjectKey: response.projectKey,
        config: {
          mode: 'workspace' as const,
          execution: {
            targetType: 'local' as const,
            deviceId: response.deviceId,
          },
          workspace: {
            source: 'local_path' as const,
            localPath: response.roots[0],
          },
        },
        tasks: [],
      }
    },
    [clearRemoteProjectSyncRemoval, executorClient, refreshWorkLists]
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
      await refreshWorkLists()
      writeLastProjectId(user.id, project.id)
      dispatch({ type: 'project_selected', project })
      track('project_created', { kind: 'git' })
      return project
    },
    [dispatch, refreshWorkLists, services.projectApi, user.id]
  )

  const prepareDeviceWorkspace = useCallback(
    async (data: DeviceWorkspacePrepareRequest, options: ProjectMutationOptions = {}) => {
      const response = await executorClient.runtime.prepareDeviceWorkspace(data)
      if (options.refreshWorkLists === false) {
        dispatch({ type: 'device_workspace_prepared', mapping: response.mapping })
      } else {
        await refreshWorkLists()
      }
      return response
    },
    [dispatch, executorClient, refreshWorkLists]
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
        const renamePrimaryProject = () =>
          executorClient.runtime.renameRuntimeWorkspace({
            deviceId: runtimeWorkspace.deviceId,
            projectKey: runtimeProject?.key,
            workspacePath: runtimeWorkspace.workspacePath,
            runtime: 'codex',
            name,
          })
        const primaryTargetsRemoteProjectState =
          Boolean(runtimeProject?.sidebarStateKey) &&
          runtimeProject?.stateDeviceId === runtimeWorkspace.deviceId
        const response = primaryTargetsRemoteProjectState
          ? await enqueueRemoteProjectStateMutation(renamePrimaryProject)
          : await renamePrimaryProject()
        if (!response.accepted) {
          const message = response.error || 'Failed to rename runtime workspace'
          dispatch({ type: 'error_set', error: message })
          throw new Error(message)
        }
        if (
          runtimeProject?.sidebarStateKey &&
          runtimeProject.stateDeviceId &&
          (runtimeProject.stateDeviceId !== runtimeWorkspace.deviceId ||
            runtimeProject.sidebarStateKey !== runtimeProject.key)
        ) {
          await enqueueRemoteProjectStateMutation(() =>
            executorClient.runtime.renameRuntimeWorkspace({
              deviceId: runtimeProject.stateDeviceId!,
              projectKey: runtimeProject.sidebarStateKey,
              workspacePath: runtimeWorkspace.workspacePath,
              runtime: 'codex',
              name,
            })
          )
        }
        await refreshWorkLists()
        return
      }
      await services.projectApi.updateProject(projectId, { name })
      await refreshWorkLists()
    },
    [
      dispatch,
      enqueueRemoteProjectStateMutation,
      executorClient,
      refreshWorkLists,
      services.projectApi,
      state.runtimeWork,
    ]
  )

  const updateLocalRuntimeProject = useCallback(
    async (data: ProjectEditingSave) => {
      const device = findWorkbenchDevice(state.devices, data.deviceId)
      if (!device || (device.status !== 'online' && device.status !== 'busy')) {
        throw new Error(t('workbench.project_device_offline_settings'))
      }
      const deviceRevision = projectEditingDeviceRevision(device)
      const ensureSameRuntime = () => {
        if (
          projectEditingDeviceRevision(
            findWorkbenchDevice(currentDevicesRef.current, data.deviceId)
          ) !== deviceRevision
        ) {
          throw new Error(t('workbench.project_runtime_changed'))
        }
      }
      const existing = findOwnedRuntimeProject(
        getRuntimeWorkSnapshot(),
        device,
        data.projectKey,
        state.devices
      )
      if (!existing) throw new Error(t('workbench.project_owner_unresolved'))
      const update = await saveProjectOnOwningRuntime(data, {
        device,
        devices: state.devices,
        projectWork: existing,
        runtime: executorClient.runtime,
        pluginApi: services.projectDevicePluginApi?.(data.deviceId),
        ensureSameRuntime,
        onRejected: message => dispatch({ type: 'error_set', error: message }),
        messages: {
          upgrade: t('workbench.project_settings_upgrade_required'),
          plugins: t('workbench.project_plugins_upgrade_required'),
          rejected: t('workbench.project_save_verification_failed'),
          mismatch: t('workbench.project_save_verification_failed'),
        },
      })
      updateRuntimeProject(update)
      await (async () => {
        clearRemoteProjectSyncRemoval({ deviceId: data.deviceId, projectKey: data.projectKey })
        const readLocalIdentity = services.getLocalRuntimeSidebarIdentity
        if (!readLocalIdentity || !state.runtimeWork) return
        const identity = await readLocalIdentity()
        if (!identity) return
        if (device.runtime_instance_id === identity.runtimeInstanceId) return
        await enqueueRemoteProjectStateMutation(async () => {
          assertLocalRuntimeSidebarIdentity(identity, await readLocalIdentity())
          const currentWork = getRuntimeWorkSnapshot()
          if (!currentWork) throw new Error('Project list is unavailable')
          const projects = getRemoteProjectRegistrations(identity)
          const sync = await executorClient.runtime.syncRuntimeRemoteProjects(
            { deviceId: identity.deviceId, projects },
            { localSidebarIdentity: identity }
          )
          if (!sync.accepted) throw new Error(sync.error || 'Failed to sync project settings')
        })
      })().catch(error => {
        throw new Error(
          t('workbench.project_saved_sync_failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        )
      })

      await refreshWorkLists()
    },
    [
      clearRemoteProjectSyncRemoval,
      dispatch,
      enqueueRemoteProjectStateMutation,
      executorClient,
      getRemoteProjectRegistrations,
      getRuntimeWorkSnapshot,
      refreshWorkLists,
      state.devices,
      state.runtimeWork,
      services,
      t,
      updateRuntimeProject,
    ]
  )

  const removeListedRuntimeProject = useCallback(
    async (projectId: number) => {
      const runtimeWorkspace = findProjectMetadataDeviceWorkspace(
        state.runtimeWork,
        projectId,
        null
      )
      if (!runtimeWorkspace) return false

      const projectWork = state.runtimeWork?.projects.find(
        item => runtimeProjectUiId(item.project) === projectId
      )
      if (!projectWork) return false
      const runtimeProject = projectWork.project
      const syncTarget = getRuntimeProjectSyncTarget(projectWork)
      const removesOfflineRemoteProject =
        !runtimeWorkspace.available && isRemoteRuntimeWorkspace(runtimeWorkspace)
      const removePrimaryProject = () =>
        executorClient.runtime.removeRuntimeWorkspace({
          deviceId: runtimeWorkspace.deviceId,
          projectKey: runtimeProject?.key,
          workspacePath: runtimeWorkspace.workspacePath,
          runtime: 'codex',
        })
      const primaryTargetsRemoteProjectState =
        Boolean(runtimeProject?.sidebarStateKey) &&
        runtimeProject?.stateDeviceId === runtimeWorkspace.deviceId
      if (!removesOfflineRemoteProject) {
        const response = primaryTargetsRemoteProjectState
          ? await enqueueRemoteProjectStateMutation(removePrimaryProject)
          : await removePrimaryProject()
        if (!response.accepted) {
          const message = response.error || 'Failed to remove runtime workspace'
          dispatch({ type: 'error_set', error: message })
          throw new Error(message)
        }
      }
      invalidateRemoteProjectSync(syncTarget)
      if (
        runtimeProject?.sidebarStateKey &&
        runtimeProject.stateDeviceId &&
        (!removesOfflineRemoteProject ||
          runtimeProject.stateDeviceId !== runtimeWorkspace.deviceId) &&
        (runtimeProject.stateDeviceId !== runtimeWorkspace.deviceId ||
          runtimeProject.sidebarStateKey !== runtimeProject.key)
      ) {
        try {
          const response = await enqueueRemoteProjectStateMutation(() =>
            executorClient.runtime.removeRuntimeWorkspace({
              deviceId: runtimeProject.stateDeviceId!,
              projectKey: runtimeProject.sidebarStateKey,
              workspacePath: runtimeWorkspace.workspacePath,
              runtime: 'codex',
            })
          )
          if (!response.accepted) {
            throw new Error(response.error || 'Failed to remove runtime workspace')
          }
        } catch (error) {
          clearRemoteProjectSyncRemoval(syncTarget)
          const message =
            error instanceof Error ? error.message : 'Failed to remove runtime workspace'
          dispatch({ type: 'error_set', error: message })
          throw error instanceof Error ? error : new Error(message)
        }
      }

      const standaloneDeviceId = state.standaloneDeviceId?.trim()
      const standaloneWorkspacePath = state.standaloneWorkspacePath
        ? normalizeRuntimeWorkspacePath(state.standaloneWorkspacePath)
        : ''
      const clearsStandaloneWorkspace =
        standaloneDeviceId === runtimeWorkspace.deviceId.trim() &&
        standaloneWorkspacePath === normalizeRuntimeWorkspacePath(runtimeWorkspace.workspacePath)
      markRuntimeProjectRemoved(projectId, {
        deviceId: runtimeWorkspace.deviceId,
        workspacePath: runtimeWorkspace.workspacePath,
      })
      await refreshWorkLists({ syncCloud: false })
      dispatch({ type: 'runtime_project_removed', projectId })
      if (clearsStandaloneWorkspace) {
        dispatch({
          type: 'project_cleared',
          standaloneDeviceId: runtimeWorkspace.deviceId,
          standaloneWorkspacePath: null,
          startFreshChat: true,
        })
      }
      track('project_removed', { source: 'local' })
      return true
    },
    [
      clearRemoteProjectSyncRemoval,
      dispatch,
      enqueueRemoteProjectStateMutation,
      executorClient,
      invalidateRemoteProjectSync,
      markRuntimeProjectRemoved,
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
      invalidateRemoteProjectSync({
        deviceId: standaloneDeviceId,
        projectKey: standaloneRuntimeProjectKey(standaloneWorkspacePath),
      })
      markRuntimeProjectRemoved(projectId, {
        deviceId: standaloneDeviceId,
        workspacePath: standaloneWorkspacePath,
      })
      await refreshWorkLists({ syncCloud: false })
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId,
        standaloneWorkspacePath: null,
        startFreshChat: true,
      })
      track('project_removed', { source: 'local' })
      return true
    },
    [
      dispatch,
      executorClient,
      invalidateRemoteProjectSync,
      markRuntimeProjectRemoved,
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
      dispatch({ type: 'project_removed', projectId })
      track('project_removed', { source: 'cloud' })
    },
    [dispatch, services.projectApi, state.projects]
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
      const key = `${data.deviceId}\0${data.threadId}`
      const previousMutation = runtimeTaskPinMutationTailsRef.current.get(key) ?? Promise.resolve()
      const mutation = previousMutation
        .catch(() => undefined)
        .then(async () => {
          const requestId = updateLocalRuntimeTaskPinned(data)
          try {
            await executorClient.runtime.setRuntimeTaskPinned(data)
          } catch (error) {
            rollbackLocalRuntimeTaskPinned(data, requestId)
            throw error
          }
          await refreshWorkLists()
        })
      runtimeTaskPinMutationTailsRef.current.set(key, mutation)
      try {
        await mutation
      } finally {
        if (runtimeTaskPinMutationTailsRef.current.get(key) === mutation) {
          runtimeTaskPinMutationTailsRef.current.delete(key)
        }
      }
    },
    [executorClient, refreshWorkLists, rollbackLocalRuntimeTaskPinned, updateLocalRuntimeTaskPinned]
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

  const cloneGitRepository = useCallback(
    async (deviceId: string, input: CloneGitRepositoryInput) => {
      const url = input.url.trim()
      const targetPath = input.targetPath.trim()
      const branch = input.branch?.trim()
      if (!url) throw new Error('Git repository URL is required')
      if (hasEmbeddedHttpGitCredentials(url)) {
        throw new Error('Git repository URL must not include embedded HTTP credentials')
      }
      if (!targetPath) throw new Error('Git target path is required')

      await executorClient.commands.createDirectory(deviceId, getParentPath(targetPath))
      const matchesExistingCheckout = () =>
        isMatchingGitCheckout(
          executorClient.commands.executeCommand,
          deviceId,
          targetPath,
          url,
          branch
        )
      if (await matchesExistingCheckout()) return

      try {
        const response = await executorClient.commands.executeCommand(deviceId, {
          command_key: 'git_clone',
          args: [...(branch ? ['--branch', branch, '--single-branch'] : []), url, targetPath],
          env: {
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'Never',
          },
          timeout_seconds: 300,
          max_output_bytes: 1024 * 1024 * 5,
        })
        if (!response.success || response.exit_code !== 0) {
          if (await matchesExistingCheckout()) return
          throw new Error(
            response.error ||
              (typeof response.stderr === 'string' ? response.stderr : '') ||
              'Failed to clone Git repository'
          )
        }
      } catch (error) {
        if (await matchesExistingCheckout()) return
        throw error
      }
    },
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
    ) => {
      return loadProjectEnvironmentDiff(executorClient.commands, project, workspaceTarget, mode)
    },
    [executorClient]
  )

  const commitEnvironmentChanges = useCallback(
    async (
      project: ProjectWithTasks | null,
      message: string,
      workspaceTarget?: WorkspaceTarget | null
    ) => {
      try {
        const result = await commitProjectChanges(
          executorClient.commands,
          project,
          message,
          workspaceTarget,
          createCommitMessageGenerator(services)
        )
        track('feature_action_completed', { domain: 'git', action: 'commit' })
        return result
      } catch (error) {
        track('operation_failed', { operation: 'git_action' })
        throw error
      }
    },
    [executorClient, services]
  )

  const commitAndPushEnvironmentChanges = useCallback(
    async (
      project: ProjectWithTasks | null,
      message: string,
      workspaceTarget?: WorkspaceTarget | null
    ) => {
      try {
        const result = await commitAndPushProjectChanges(
          executorClient.commands,
          project,
          message,
          workspaceTarget,
          createCommitMessageGenerator(services)
        )
        track('feature_action_completed', { domain: 'git', action: 'commit_push' })
        return result
      } catch (error) {
        track('operation_failed', { operation: 'git_action' })
        throw error
      }
    },
    [executorClient, services]
  )

  const pushEnvironmentChanges = useCallback(
    async (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) => {
      try {
        const result = await pushProjectChanges(executorClient.commands, project, workspaceTarget)
        track('feature_action_completed', { domain: 'git', action: 'push' })
        return result
      } catch (error) {
        track('operation_failed', { operation: 'git_action' })
        throw error
      }
    },
    [executorClient]
  )

  const listEnvironmentBranches = useCallback(
    (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) => {
      return listProjectBranches(executorClient.commands, project, workspaceTarget)
    },
    [executorClient]
  )

  const checkoutEnvironmentBranch = useCallback(
    async (
      project: ProjectWithTasks | null,
      branchName: string,
      workspaceTarget?: WorkspaceTarget | null
    ) => {
      try {
        const result = await checkoutProjectBranch(
          executorClient.commands,
          project,
          branchName,
          workspaceTarget
        )
        track('feature_action_completed', { domain: 'git', action: 'checkout' })
        return result
      } catch (error) {
        track('operation_failed', { operation: 'git_action' })
        throw error
      }
    },
    [executorClient]
  )

  const createEnvironmentBranch = useCallback(
    async (
      project: ProjectWithTasks | null,
      branchName: string,
      workspaceTarget?: WorkspaceTarget | null
    ) => {
      try {
        const result = await createAndCheckoutProjectBranch(
          executorClient.commands,
          project,
          branchName,
          workspaceTarget
        )
        track('feature_action_completed', { domain: 'git', action: 'branch_create' })
        return result
      } catch (error) {
        track('operation_failed', { operation: 'git_action' })
        throw error
      }
    },
    [executorClient]
  )

  return {
    createProject,
    createLocalRuntimeProject,
    createGitWorkspaceProject,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    listGitRepositories,
    listGitBranches,
    updateProjectName,
    updateLocalRuntimeProject,
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
    cloneGitRepository,
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
