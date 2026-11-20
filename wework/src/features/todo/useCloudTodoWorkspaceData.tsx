import { createCloudTodoProjectActions } from './cloudTodoProjectActions'
import { createCloudTodoTaskActions } from './cloudTodoTaskActions'
import { useSyncExternalStore } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import type { CloudTodoWorkspaceProps } from './cloudTodoWorkspaceTypes'
import type { CloudTodoWorkspaceObservation } from './cloudTodoWorkspaceObservation'
import { useCloudTodoWorkspaceBase, type CloudTodoWorkspaceBase } from './useCloudTodoWorkspaceBase'
import {
  useCloudTodoWorkspaceBoard,
  type CloudTodoWorkspaceBoard,
} from './useCloudTodoWorkspaceBoard'
function observeWorkspace(
  data: CloudTodoWorkspaceBase & CloudTodoWorkspaceBoard
): CloudTodoWorkspaceObservation {
  const {
    user,
    localProjects,
    runtimeWork,
    runtimeTaskLifecycle,
    services,
    embedded,
    embeddedTitle,
    startupActive,
    workspaceActive,
    activeProjectRef,
    defaultProjectRequested,
    focusedItemId,
    onFocusedItemHandled,
    onActiveProjectChange,
    onOpenRuntimeTask,
    onMarkRuntimeTaskRead,
    onArchiveRuntimeTasks,
    onOpenSettings,
    onLogout,
    itemTaskBindingsProjectKey,
    notificationChoice,
    t,
    boardTranslate,
    workbench,
    changeRequestMonitor,
    cloudWorkspaceApi,
    requestedProjectRef,
    activeProjectKey,
    cloudWorkspace,
    projectSpaceApis,
    projects,
    defaultProject,
    selectedProject,
    runtimeTaskStatusSignature,
    runtimeTasksByKey,
    runtimeAddressesByWorkItem,
    activeItemTaskBindings,
    boardTaskBindings,
    selectedProjectApi,
    selectedProjectAgentApi,
    selectedProjectChatClient,
    nativeStatuses,
    processingStartIndex,
    activeBoardSourceItems,
    startupBoardReady,
    selectedItemProject,
    selectedItemApi,
    standardBoardController,
    nativeGroupBy,
    taskPanelOpen,
  } = data
  const projectActions = createCloudTodoProjectActions(data)
  const taskActions = createCloudTodoTaskActions({ ...data, ...projectActions })
  const backgroundTask =
    data.workbench &&
    data.selectedItem &&
    data.aiChatProject &&
    data.taskStartingInBackground &&
    data.taskComposerRequest?.workItemId === data.selectedItem.id
      ? {
          key: data.taskPanelSessionId,
          workbench: data.workbench,
          props: {
            project: data.aiChatProject,
            localProjects: data.localProjects,
            task: data.selectedItem,
            input: data.taskComposerRequest.initialInput,
            initialLocalProjectId: data.selectedItemDefaultLocalProjectId,
            initialDeviceWorkspaceId: data.selectedItemTaskDeviceWorkspaceId,
            taskRequest: data.taskComposerRequest.taskRequest,
            inheritFromTask: data.taskComposerRequest.inheritFromTask,
            prepareTask: taskActions.prepareSelectedItemTask,
            onTaskCreated: taskActions.handleSelectedItemTaskCreated,
            onAddressChange: () => {
              data.closeIssuePanelStack()
              data.setBoardRefreshNonce(value => value + 1)
            },
            onError: data.setBoardError,
          },
        }
      : undefined
  return {
    backgroundTask,
    notificationChoice,
    t,
    boardTranslate,
    runtimeTasksByKey,
    nativeGroupBy,
    nativeStatuses,
    processingStartIndex,
    props: {
      user,
      localProjects,
      runtimeWork,
      runtimeTaskLifecycle,
      services,
      embedded,
      embeddedTitle,
      startupActive,
      workspaceActive,
      activeProjectRef,
      defaultProjectRequested,
      focusedItemId,
      onFocusedItemHandled,
      onActiveProjectChange,
      onOpenRuntimeTask,
      onMarkRuntimeTaskRead,
      onArchiveRuntimeTasks,
      onOpenSettings,
      onLogout,
    },
    cloud: cloudWorkspace,
    cloudApi: cloudWorkspaceApi,
    localApi: projectSpaceApis.local ?? services.projectSpaceDetailServices?.local?.deliveryApi,
    catalogApi: projectSpaceApis.local,
    project: selectedProject,
    projects,
    requestedProjectRef,
    defaultProject,
    activeProjectKey,
    projectApi: selectedProjectApi,
    projectAgents: selectedProjectAgentApi,
    projectChat: selectedProjectChatClient,
    itemProject: selectedItemProject,
    itemApi: selectedItemApi,
    board: standardBoardController,
    sourceItems: activeBoardSourceItems,
    runtimeSignature: runtimeTaskStatusSignature,
    runtimeAddressesByWorkItem,
    taskBindings: activeItemTaskBindings,
    boardBindings: boardTaskBindings,
    localBindingsProjectKey: itemTaskBindingsProjectKey,
    monitor: changeRequestMonitor,
    workbench,
    startupReady: startupBoardReady,
    taskPanelOpen,
    detailLoadError: t('todo.work_item_detail_load_failed'),
    repairFailedError: t('workbench.change_request_continue_repair_failed', '无法继续任务'),
  }
}
export function useCloudTodoWorkspaceData(props: CloudTodoWorkspaceProps) {
  const base = useCloudTodoWorkspaceBase(props)
  const board = useCloudTodoWorkspaceBoard(base)
  const data = { ...base, ...board }
  const {
    workspaceSource,
    selectedItem,
    backgroundTaskItemId,
    setGlobalSearchOpen,
    setProjectSearchOpen,
    closeIssuePanelStack,
  } = data
  useDOMEvent<KeyboardEvent>('window', 'keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      setGlobalSearchOpen(true)
    } else if (event.key === 'Escape') {
      setGlobalSearchOpen(false)
      setProjectSearchOpen(false)
    }
  })
  useDOMEvent<KeyboardEvent>(
    'window',
    'keydown',
    event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      event.preventDefault()
      closeIssuePanelStack()
    },
    { enabled: Boolean(selectedItem && backgroundTaskItemId !== selectedItem.id) }
  )
  const snapshot = useSyncExternalStore(
    listener => workspaceSource.subscribe(observeWorkspace(data), listener),
    workspaceSource.getSnapshot,
    workspaceSource.getSnapshot
  )
  return { ...data, ...snapshot }
}
export type CloudTodoWorkspaceData = ReturnType<typeof useCloudTodoWorkspaceData>
