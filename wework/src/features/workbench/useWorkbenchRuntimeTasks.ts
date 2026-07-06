import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { removeGitWorktree, workspaceHasUncommittedChanges } from '@/api/environment'
import { useTranslation } from '@/hooks/useTranslation'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import type {
  RuntimeTaskSummary,
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
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
  ArchiveRuntimeConversationsResult,
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

  const openRuntimeTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      if (isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, address)) {
        return
      }

      const runtimeProjectWork = state.runtimeWork?.projects.find(item =>
        item.deviceWorkspaces.some(
          workspace =>
            workspace.deviceId === address.deviceId &&
            workspace.tasks.some(task => task.taskId === address.taskId)
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

  const prepareWorktreeArchive = useCallback(
    async (
      worktreeTargets: RuntimeTaskWorktreeTarget[],
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<'ready' | 'dirty_worktree' | 'failed'> => {
      if (options.force || worktreeTargets.length === 0) return 'ready'

      for (const target of uniqueRuntimeTaskWorktreeTargets(worktreeTargets)) {
        try {
          const hasUncommittedChanges = await workspaceHasUncommittedChanges(
            executorClient.commands,
            target.workspace.deviceId,
            target.workspace.workspacePath
          )
          if (hasUncommittedChanges) return 'dirty_worktree'
        } catch (error) {
          dispatch({
            type: 'error_set',
            error:
              error instanceof Error
                ? error.message
                : t('workbench.archive_runtime_task_check_failed'),
          })
          return 'failed'
        }
      }

      return 'ready'
    },
    [dispatch, executorClient, t]
  )

  const removeArchivedWorktrees = useCallback(
    async (worktreeTargets: RuntimeTaskWorktreeTarget[]) => {
      for (const target of uniqueRuntimeTaskWorktreeTargets(worktreeTargets)) {
        try {
          await removeGitWorktree(
            executorClient.commands,
            target.workspace.deviceId,
            target.workspace.workspacePath
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
    },
    [dispatch, executorClient, t]
  )

  const archiveRuntimeTask = useCallback(
    async (
      address: RuntimeTaskAddress,
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<ArchiveRuntimeTaskResult> => {
      const worktreeTarget = findRuntimeTaskWorktree(state.runtimeWork, address)
      const worktreeTargets = worktreeTarget ? [worktreeTarget] : []
      const prepareResult = await prepareWorktreeArchive(worktreeTargets, options)
      if (prepareResult === 'dirty_worktree') return { status: 'dirty_worktree' }
      if (prepareResult === 'failed') return { status: 'failed' }

      const response = await executorClient.runtime.archiveConversation(address)
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to archive runtime task' })
        return { status: 'failed' }
      }
      await removeArchivedWorktrees(worktreeTargets)
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
      prepareWorktreeArchive,
      refreshWorkLists,
      removeArchivedWorktrees,
      state.currentRuntimeTask,
      state.runtimeWork,
    ]
  )

  const renameRuntimeTask = useCallback(
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
    async (
      runtimeProjectKey: string,
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<ArchiveRuntimeConversationsResult> => {
      const addresses = projectTaskAddresses(state.runtimeWork, [runtimeProjectKey])
      const worktreeTargets = findRuntimeTaskWorktrees(state.runtimeWork, addresses)
      const prepareResult = await prepareWorktreeArchive(worktreeTargets, options)
      if (prepareResult === 'dirty_worktree') return { status: 'dirty_worktree' }
      if (prepareResult === 'failed') return { status: 'failed' }

      const response = await executorClient.runtime.archiveProjectConversations({
        runtimeProjectKey,
      })
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to archive project' })
        return { status: 'failed' }
      }
      await removeArchivedWorktrees(worktreeTargets)
      clearCurrentRuntimeTaskIfArchived(addresses)
      await refreshWorkLists()
      return { status: 'archived' }
    },
    [
      clearCurrentRuntimeTaskIfArchived,
      dispatch,
      executorClient,
      prepareWorktreeArchive,
      refreshWorkLists,
      removeArchivedWorktrees,
      state.runtimeWork,
    ]
  )

  const archiveProjectsConversations = useCallback(
    async (
      runtimeProjectKeys: string[],
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<ArchiveRuntimeConversationsResult> => {
      const uniqueProjectKeys = [...new Set(runtimeProjectKeys.filter(Boolean))]
      if (uniqueProjectKeys.length === 0) return { status: 'archived' }

      const archivedAddresses = projectTaskAddresses(state.runtimeWork, uniqueProjectKeys)
      const worktreeTargets = findRuntimeTaskWorktrees(state.runtimeWork, archivedAddresses)
      const prepareResult = await prepareWorktreeArchive(worktreeTargets, options)
      if (prepareResult === 'dirty_worktree') return { status: 'dirty_worktree' }
      if (prepareResult === 'failed') return { status: 'failed' }

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
        return { status: 'failed' }
      }

      await removeArchivedWorktrees(worktreeTargets)
      clearCurrentRuntimeTaskIfArchived(archivedAddresses)
      await refreshWorkLists()
      return { status: 'archived' }
    },
    [
      clearCurrentRuntimeTaskIfArchived,
      dispatch,
      executorClient,
      prepareWorktreeArchive,
      refreshWorkLists,
      removeArchivedWorktrees,
      state.runtimeWork,
    ]
  )

  const archiveChatConversations = useCallback(
    async (
      addresses: RuntimeTaskAddress[],
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<ArchiveRuntimeConversationsResult> => {
      if (addresses.length === 0) return { status: 'archived' }

      const worktreeTargets = findRuntimeTaskWorktrees(state.runtimeWork, addresses)
      const prepareResult = await prepareWorktreeArchive(worktreeTargets, options)
      if (prepareResult === 'dirty_worktree') return { status: 'dirty_worktree' }
      if (prepareResult === 'failed') return { status: 'failed' }

      const responses = await Promise.all(
        addresses.map(address => executorClient.runtime.archiveConversation(address))
      )
      const failedResponse = responses.find(response => !response.accepted)
      if (failedResponse) {
        dispatch({
          type: 'error_set',
          error: failedResponse.error || 'Failed to archive chat conversations',
        })
        return { status: 'failed' }
      }

      await removeArchivedWorktrees(worktreeTargets)
      clearCurrentRuntimeTaskIfArchived(addresses)
      await refreshWorkLists()
      return { status: 'archived' }
    },
    [
      clearCurrentRuntimeTaskIfArchived,
      dispatch,
      executorClient,
      prepareWorktreeArchive,
      refreshWorkLists,
      removeArchivedWorktrees,
      state.runtimeWork,
    ]
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
      await openRuntimeTask(response.target)
    },
    [dispatch, executorClient, openRuntimeTask, refreshWorkLists, state.currentRuntimeTask]
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
    openRuntimeTask,
    renameRuntimeTask,
    archiveRuntimeTask,
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

type RuntimeTaskWorktreeTarget = { workspace: RuntimeDeviceWorkspace; task: RuntimeTaskSummary }

function findRuntimeTaskWorktree(
  runtimeWork: WorkbenchState['runtimeWork'],
  address: RuntimeTaskAddress
): RuntimeTaskWorktreeTarget | null {
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
    const task = workspace.tasks.find(item => item.taskId === address.taskId)
    if (!task || !isRuntimeTaskWorktree(workspace, task)) continue
    return { workspace, task }
  }

  return null
}

function findRuntimeTaskWorktrees(
  runtimeWork: WorkbenchState['runtimeWork'],
  addresses: RuntimeTaskAddress[]
): RuntimeTaskWorktreeTarget[] {
  return addresses
    .map(address => findRuntimeTaskWorktree(runtimeWork, address))
    .filter((target): target is RuntimeTaskWorktreeTarget => Boolean(target))
}

function uniqueRuntimeTaskWorktreeTargets(
  targets: RuntimeTaskWorktreeTarget[]
): RuntimeTaskWorktreeTarget[] {
  const seen = new Set<string>()
  const uniqueTargets: RuntimeTaskWorktreeTarget[] = []
  for (const target of targets) {
    const key = `${target.workspace.deviceId}:${target.workspace.workspacePath}`
    if (seen.has(key)) continue
    seen.add(key)
    uniqueTargets.push(target)
  }
  return uniqueTargets
}

function isRuntimeTaskWorktree(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): boolean {
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
