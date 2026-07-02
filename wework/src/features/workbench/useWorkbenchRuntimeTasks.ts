import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { removeGitWorktree, workspaceHasUncommittedChanges } from '@/api/environment'
import { useTranslation } from '@/hooks/useTranslation'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import type {
  LocalTaskSummary,
  ProjectWithTasks,
  RuntimeGoalSetRequest,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskForkTarget,
  RuntimeTranscriptRequest,
  RuntimeWorkSearchRequest,
  User,
} from '@/types/api'
import type {
  RuntimePaneTranscript,
  RuntimePaneTranscriptLoadOptions,
  WorkbenchState,
} from '@/types/workbench'
import {
  createRuntimeTaskStreamHandlers,
  runtimeAddressDebug,
  runtimeMessagesToWorkbenchMessages,
  runtimeTranscriptDebug,
  type RuntimeTaskStreamHandlers,
} from './runtimePaneMessages'
import type { WorkbenchAction } from './workbenchReducer'
import {
  getRuntimeTaskRouteKey,
  isSameRuntimeTaskAddress,
  isSameRuntimeTaskIdentity,
  projectTaskAddresses,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
import type {
  ArchiveRuntimeLocalTaskOptions,
  ArchiveRuntimeLocalTaskResult,
} from './workbenchContextTypes'

interface UseWorkbenchRuntimeTasksOptions {
  user: User
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  refreshWorkLists: () => Promise<void>
}

const runtimeTranscriptRequests = new Map<string, Promise<RuntimePaneTranscript>>()

export function useWorkbenchRuntimeTasks({
  user,
  state,
  dispatch,
  executorClient,
  services,
  refreshWorkLists,
}: UseWorkbenchRuntimeTasksOptions) {
  const { t } = useTranslation('common')
  const openedRuntimeTaskKeysRef = useRef<Set<string>>(new Set())
  const currentRuntimeTaskRef = useRef<RuntimeTaskAddress | null>(null)

  useEffect(() => {
    currentRuntimeTaskRef.current = state.currentRuntimeTask
  }, [state.currentRuntimeTask])

  const openRuntimeTaskView = useCallback(
    (
      address: RuntimeTaskAddress,
      project: ProjectWithTasks | null,
      options?: { markOpened?: boolean; navigate?: boolean }
    ) => {
      if (isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, address)) {
        if (options?.navigate) {
          navigateTo(buildRuntimeTaskRoute(address))
        }
        return
      }
      currentRuntimeTaskRef.current = address
      if (options?.markOpened !== false) {
        openedRuntimeTaskKeysRef.current.add(getRuntimeTaskRouteKey(address))
      }
      dispatch({
        type: 'runtime_task_opened',
        address,
        project,
      })
      if (options?.navigate) {
        navigateTo(buildRuntimeTaskRoute(address))
      }
    },
    [dispatch]
  )

  const isCurrentRuntimeTask = useCallback(
    (address: RuntimeTaskAddress) =>
      isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, address),
    []
  )

  const clearCurrentRuntimeTaskView = useCallback(() => {
    currentRuntimeTaskRef.current = null
    dispatch({ type: 'current_task_cleared' })
    navigateTo('/')
  }, [dispatch])

  const loadRuntimeTranscriptForPane = useCallback(
    async (
      address: RuntimeTaskAddress,
      options: RuntimePaneTranscriptLoadOptions = {}
    ): Promise<RuntimePaneTranscript> => {
      const transcriptRequest: RuntimeTranscriptRequest = { ...address, ...options }
      const transcriptKey = runtimeTranscriptRequestKey(address, options)
      const inFlightTranscript = runtimeTranscriptRequests.get(transcriptKey)
      if (inFlightTranscript) {
        return inFlightTranscript
      }

      const request = executorClient.runtime
        .getRuntimeTranscript(transcriptRequest)
        .then(transcript => {
          if (!Array.isArray(transcript.messages)) {
            console.error('[Wework] Runtime pane transcript response missing messages array', {
              address: runtimeAddressDebug(address),
              response: runtimeTranscriptDebug(transcript),
              transcriptKey,
            })
          }

          return {
            messages: runtimeMessagesToWorkbenchMessages(
              Array.isArray(transcript.messages) ? transcript.messages : []
            ),
            turnNavigation: Array.isArray(transcript.turnNavigation)
              ? transcript.turnNavigation
              : [],
            rangeStart: typeof transcript.rangeStart === 'number' ? transcript.rangeStart : null,
            rangeEnd: typeof transcript.rangeEnd === 'number' ? transcript.rangeEnd : null,
            hasMoreBefore: Boolean(transcript.hasMoreBefore),
            beforeCursor: transcript.beforeCursor ?? null,
            hasMoreAfter: Boolean(transcript.hasMoreAfter),
            afterCursor: transcript.afterCursor ?? null,
          }
        })
        .finally(() => {
          if (runtimeTranscriptRequests.get(transcriptKey) === request) {
            runtimeTranscriptRequests.delete(transcriptKey)
          }
        })
      runtimeTranscriptRequests.set(transcriptKey, request)
      return request
    },
    [executorClient]
  )

  const subscribeRuntimeTaskStream = useCallback(
    (address: RuntimeTaskAddress, handlers: RuntimeTaskStreamHandlers) =>
      services.chatStream.subscribe(createRuntimeTaskStreamHandlers(address, handlers)),
    [services.chatStream]
  )

  const openRuntimeLocalTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      if (isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, address)) {
        return
      }

      const runtimeProjectWork = state.runtimeWork?.projects.find(item =>
        item.deviceWorkspaces.some(
          workspace =>
            workspace.deviceId === address.deviceId &&
            workspace.localTasks.some(task => task.localTaskId === address.localTaskId)
        )
      )
      const project = runtimeProjectWork
        ? (state.projects.find(
            item => item.id === runtimeProjectUiId(runtimeProjectWork.project)
          ) ?? runtimeProjectToProject(runtimeProjectWork))
        : null

      if (project) writeLastProjectId(user.id, project.id)
      openRuntimeTaskView(address, project, {
        markOpened: !openedRuntimeTaskKeysRef.current.has(getRuntimeTaskRouteKey(address)),
      })
    },
    [openRuntimeTaskView, state.projects, state.runtimeWork, user.id]
  )

  const clearCurrentRuntimeTaskIfArchived = useCallback(
    (addresses: RuntimeTaskAddress[]) => {
      if (
        !addresses.some(address => isSameRuntimeTaskAddress(currentRuntimeTaskRef.current, address))
      ) {
        return
      }
      clearCurrentRuntimeTaskView()
    },
    [clearCurrentRuntimeTaskView]
  )

  const archiveRuntimeLocalTask = useCallback(
    async (
      address: RuntimeTaskAddress,
      options: ArchiveRuntimeLocalTaskOptions = {}
    ): Promise<ArchiveRuntimeLocalTaskResult> => {
      const worktreeTarget = findRuntimeTaskWorktree(state.runtimeWork, address)
      if (worktreeTarget && !options.force) {
        let hasUncommittedChanges: boolean
        try {
          hasUncommittedChanges = await workspaceHasUncommittedChanges(
            executorClient.commands,
            worktreeTarget.workspace.deviceId,
            worktreeTarget.workspace.workspacePath
          )
        } catch (error) {
          dispatch({
            type: 'error_set',
            error:
              error instanceof Error
                ? error.message
                : t('workbench.archive_runtime_task_check_failed'),
          })
          return { status: 'failed' }
        }
        if (hasUncommittedChanges) {
          return { status: 'dirty_worktree' }
        }
      }

      const response = await executorClient.runtime.archiveConversation(address)
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to archive runtime task' })
        return { status: 'failed' }
      }
      if (worktreeTarget) {
        try {
          await removeGitWorktree(
            executorClient.commands,
            worktreeTarget.workspace.deviceId,
            worktreeTarget.workspace.workspacePath
          )
        } catch (error) {
          dispatch({
            type: 'error_set',
            error:
              error instanceof Error
                ? t('workbench.archive_runtime_task_remove_failed_detail', {
                    message: error.message,
                  })
                : t('workbench.archive_runtime_task_remove_failed'),
          })
        }
      }
      if (isSameRuntimeTaskAddress(state.currentRuntimeTask, address)) {
        clearCurrentRuntimeTaskView()
      }
      await refreshWorkLists()
      return { status: 'archived' }
    },
    [
      clearCurrentRuntimeTaskView,
      dispatch,
      executorClient,
      refreshWorkLists,
      state.currentRuntimeTask,
      state.runtimeWork,
      t,
    ]
  )

  const renameRuntimeLocalTask = useCallback(
    async (address: RuntimeTaskAddress, title: string) => {
      const response = await executorClient.runtime.renameRuntimeTask({ address, title })
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to rename runtime task' })
        return
      }
      await refreshWorkLists()
    },
    [dispatch, executorClient, refreshWorkLists]
  )

  const archiveProjectConversations = useCallback(
    async (runtimeProjectKey: string) => {
      const response = await executorClient.runtime.archiveProjectConversations({
        runtimeProjectKey,
      })
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to archive project' })
        return
      }
      clearCurrentRuntimeTaskIfArchived(
        projectTaskAddresses(state.runtimeWork, [runtimeProjectKey])
      )
      await refreshWorkLists()
    },
    [
      clearCurrentRuntimeTaskIfArchived,
      dispatch,
      executorClient,
      refreshWorkLists,
      state.runtimeWork,
    ]
  )

  const archiveProjectsConversations = useCallback(
    async (runtimeProjectKeys: string[]) => {
      const uniqueProjectKeys = [...new Set(runtimeProjectKeys.filter(Boolean))]
      if (uniqueProjectKeys.length === 0) return

      const archivedAddresses = projectTaskAddresses(state.runtimeWork, uniqueProjectKeys)
      const responses = await Promise.all(
        uniqueProjectKeys.map(runtimeProjectKey =>
          executorClient.runtime.archiveProjectConversations({ runtimeProjectKey })
        )
      )
      const failedResponse = responses.find(response => !response.accepted)
      if (failedResponse) {
        dispatch({
          type: 'error_set',
          error: failedResponse.error || 'Failed to archive project conversations',
        })
        return
      }

      clearCurrentRuntimeTaskIfArchived(archivedAddresses)
      await refreshWorkLists()
    },
    [
      clearCurrentRuntimeTaskIfArchived,
      dispatch,
      executorClient,
      refreshWorkLists,
      state.runtimeWork,
    ]
  )

  const archiveChatConversations = useCallback(
    async (addresses: RuntimeTaskAddress[]) => {
      if (addresses.length === 0) return

      const responses = await Promise.all(
        addresses.map(address => executorClient.runtime.archiveConversation(address))
      )
      const failedResponse = responses.find(response => !response.accepted)
      if (failedResponse) {
        dispatch({
          type: 'error_set',
          error: failedResponse.error || 'Failed to archive chat conversations',
        })
        return
      }

      clearCurrentRuntimeTaskIfArchived(addresses)
      await refreshWorkLists()
    },
    [clearCurrentRuntimeTaskIfArchived, dispatch, executorClient, refreshWorkLists]
  )

  const searchRuntimeWork = useCallback(
    async (request: RuntimeWorkSearchRequest) => executorClient.runtime.searchRuntimeWork(request),
    [executorClient]
  )

  const forkCurrentRuntimeTask = useCallback(
    async (target: RuntimeTaskForkTarget) => {
      if (!state.currentRuntimeTask) {
        dispatch({ type: 'error_set', error: 'No runtime task is selected' })
        return
      }

      const response = await executorClient.runtime.forkRuntimeTask({
        source: state.currentRuntimeTask,
        target,
      })
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to fork runtime task' })
        return
      }

      await refreshWorkLists()
      await openRuntimeLocalTask(response.target)
    },
    [dispatch, executorClient, openRuntimeLocalTask, refreshWorkLists, state.currentRuntimeTask]
  )

  const getRuntimeGoal = useCallback(
    async (address: RuntimeTaskAddress) => executorClient.runtime.getRuntimeGoal({ address }),
    [executorClient]
  )

  const setRuntimeGoal = useCallback(
    async (request: RuntimeGoalSetRequest) => {
      const response = await executorClient.runtime.setRuntimeGoal(request)
      if (!response.accepted) {
        dispatch({
          type: 'error_set',
          error: response.error || t('workbench.goal_set_failed', 'Failed to set goal'),
        })
      }
      return response
    },
    [dispatch, executorClient, t]
  )

  const clearRuntimeGoal = useCallback(
    async (address: RuntimeTaskAddress) => {
      const response = await executorClient.runtime.clearRuntimeGoal({ address })
      if (!response.accepted) {
        dispatch({
          type: 'error_set',
          error: response.error || t('workbench.goal_clear_failed', 'Failed to delete goal'),
        })
      }
      return response
    },
    [dispatch, executorClient, t]
  )

  return {
    openRuntimeTaskView,
    isCurrentRuntimeTask,
    clearCurrentRuntimeTaskView,
    loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream,
    openRuntimeLocalTask,
    renameRuntimeLocalTask,
    archiveRuntimeLocalTask,
    archiveProjectConversations,
    archiveProjectsConversations,
    archiveChatConversations,
    searchRuntimeWork,
    forkCurrentRuntimeTask,
    getRuntimeGoal,
    setRuntimeGoal,
    clearRuntimeGoal,
  }
}

function findRuntimeTaskWorktree(
  runtimeWork: WorkbenchState['runtimeWork'],
  address: RuntimeTaskAddress
): { workspace: RuntimeDeviceWorkspace; task: LocalTaskSummary } | null {
  if (!runtimeWork) return null
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]

  for (const workspace of workspaces) {
    if (workspace.deviceId !== address.deviceId) continue
    if (address.workspacePath?.trim() && workspace.workspacePath !== address.workspacePath.trim()) {
      continue
    }
    const task = workspace.localTasks.find(item => item.localTaskId === address.localTaskId)
    if (!task || !isRuntimeTaskWorktree(workspace, task)) continue
    return { workspace, task }
  }

  return null
}

function isRuntimeTaskWorktree(workspace: RuntimeDeviceWorkspace, task: LocalTaskSummary): boolean {
  return (
    workspace.workspaceKind === 'worktree' ||
    Boolean(workspace.worktreeId) ||
    task.workspaceKind === 'worktree' ||
    Boolean(task.worktreeId)
  )
}

function runtimeTranscriptRequestKey(
  address: RuntimeTaskAddress,
  options: RuntimePaneTranscriptLoadOptions
): string {
  return JSON.stringify({
    address: getRuntimeTaskRouteKey(address),
    limit: options.limit ?? null,
    beforeCursor: options.beforeCursor ?? null,
    afterCursor: options.afterCursor ?? null,
    refresh: options.refresh ?? null,
  })
}

export type WorkbenchRuntimeTasks = ReturnType<typeof useWorkbenchRuntimeTasks>
