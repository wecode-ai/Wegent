import { cloudTodoIssueResourceKey } from './cloudTodoWorkspaceSupport'
import type { LocatedCloudProject, LocatedLoopItem } from './cloudTodoWorkspaceTypes'
import {
  nativeBoardStatusColors,
  aitableCellLabels,
  toWeworkCloudProject,
  toCloudLoopItem,
} from './cloudTodoWorkspaceSupport'
import {
  collectProjectTags,
  savedBoardColumns,
  useSavedBoardViews,
  saveProjectBoardViews,
  isBaseBoardStatusGroupingEnabled,
  useBaseBoardStatusMigration,
} from '@wegent/collaboration'
import { useCallback, useMemo } from 'react'
import type { CloudLoopItem } from '@/api/deliveries'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import { useIssueAssignmentsByIssueId } from '@wegent/collaboration'
import {
  createStandardCloudBoardColumns,
  useStandardCloudBoardController,
  useBoardTagFilter,
  type ProjectBoardColumn,
  type ProjectBoardGroupBy,
} from '@wegent/collaboration/project-board'
import { runtimeTaskProjectUiId } from '@/lib/runtime-task-workspace-binding'
import { runtimeTaskTrackingExecutionStatus } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { getRuntimeTaskLifecycleKey } from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimeTaskAddress } from '@/types/api'
import { type BoardCardDisplaySettings } from './CloudTodoBoardCard'
import { projectSpaceRef, sameProjectSpace } from './projectSpaceSelection'
import { useParentIssueBoard } from '@wegent/collaboration/project-board'
import { boardStatusColorClasses, columnDotClasses, columns } from './todoShared'
import { loadProjectSpaceCodeWorkspacePreference } from './projectSpaceCodeWorkspacePreference'
import { isRuntimeMyWorkItem, mergeRuntimeMyWorkItems, runtimeMyWorkItems } from './runtimeMyWork'
import type { CloudTodoWorkspaceBase } from './useCloudTodoWorkspaceBase'
export function useCloudTodoWorkspaceBoard(base: CloudTodoWorkspaceBase) {
  const {
    user,
    runtimeWork,
    runtimeTaskLifecycle,
    services,
    startupActive,
    activeProjectRef,
    focusedItemId,
    onOpenRuntimeTask,
    onMarkRuntimeTaskRead,
    workspaceSource,
    projectView,
    selectedItem,
    boardParentId,
    items,
    itemsProjectKey,
    localExternalPageCursors,
    localExternalPageLoading,
    backgroundTaskItemId,
    detailItems,
    createTodoParent,
    selectedTaskBinding,
    taskComposerRequest,
    aitableFields,
    aitableGroupFieldId,
    localProjectsLoading,
    issueResourceAttachmentState,
    setAssigneeQuickAddRequest,
    setSelectedItem,
    setBoardParentId,
    setBackgroundTaskItemId,
    setSelectedTaskBinding,
    setTaskComposerRequest,
    performStandardBoardMove,
    t,
    boardTranslate,
    workbench,
    cloudWorkspaceApi,
    cloudWorkspaceMessages,
    cloudWorkspace,
    projectSpaceApis,
    localProjectManageApi,
    selectedProjectRef,
    selectedProjectId,
    replaceProject,
    collaborationProjectMembers,
    collaborationProjectAgents,
    advanceTaskPanelSession,
    selectedProject,
    taskOwnerUserId,
    isMyTasksBoard,
    selectedLocalProject,
    runtimeAddressesByWorkItem,
    selectedProjectKey,
    activeItemTaskBindings,
    localProjectIdForItem,
    personalGroupKey,
    focusExecutionColumnsKey,
    projectForItem,
    apiForProject,
    isAITableProject,
    isExternalGitBoard,
    usesSharedCloudBoard,
  } = base
  const selectedCloudProjectItems = useMemo(() => {
    if (
      !usesSharedCloudBoard ||
      !selectedProject ||
      cloudWorkspace.state.project?.id !== String(selectedProject.id)
    ) {
      return []
    }
    return cloudWorkspace.state.issues.map(issue => ({
      ...toCloudLoopItem(issue),
      project_store: selectedProject.project_store,
    }))
  }, [
    cloudWorkspace.state.issues,
    cloudWorkspace.state.project?.id,
    selectedProject,
    usesSharedCloudBoard,
  ])
  const selectedProjectBoardItems = usesSharedCloudBoard ? selectedCloudProjectItems : items
  const { assignmentsByIssueId: loadedProjectAssignments } = useIssueAssignmentsByIssueId({
    assignmentsApi: cloudWorkspaceApi?.assignments,
    issues: selectedProjectBoardItems,
    enabled: usesSharedCloudBoard && projectView === 'table',
  })
  const issueTableAssignmentsByIssue = useMemo(() => {
    const assignmentsByIssue = { ...loadedProjectAssignments }
    if (
      cloudWorkspace.state.selectedIssue &&
      cloudWorkspace.state.selectedIssue.cloud_project_id === selectedProjectId
    ) {
      assignmentsByIssue[cloudWorkspace.state.selectedIssue.id] = cloudWorkspace.state.assignments
    }
    return assignmentsByIssue
  }, [
    cloudWorkspace.state.assignments,
    cloudWorkspace.state.selectedIssue,
    loadedProjectAssignments,
    selectedProjectId,
  ])
  const activeExternalPageCursors =
    selectedProject?.location === 'cloud'
      ? cloudWorkspace.state.externalPageCursors
      : localExternalPageCursors
  const activeExternalPageLoading =
    selectedProject?.location === 'cloud'
      ? cloudWorkspace.state.externalPageLoading
      : localExternalPageLoading
  const selectedProjectAgents = useMemo(
    () => (selectedProjectKey ? (collaborationProjectAgents[selectedProjectKey] ?? []) : []),
    [collaborationProjectAgents, selectedProjectKey]
  )
  const agentNameById = (() => {
    const names: Record<string, string> = {}
    for (const agent of selectedProjectAgents) names[agent.id] = agent.name
    return names
  })()
  const boardCardDisplay: BoardCardDisplaySettings = {
    showAssignee: selectedProject?.card_display?.show_assignee ?? true,
    showPriority: selectedProject?.card_display?.show_priority ?? true,
    showReference: false,
    showTags: selectedProject?.card_display?.show_tags ?? true,
    showDate: selectedProject?.card_display?.show_date ?? true,
  }
  const nativeStatuses =
    selectedProject?.board_config?.statuses ??
    columns.map(column => ({
      id: column.status,
      name: column.label,
      color: nativeBoardStatusColors[column.status],
    }))
  const visibleNativeStatuses = nativeStatuses
  const processingStartStatusId =
    selectedProject?.board_config?.processing_start_status_id ?? nativeStatuses[1]?.id ?? null
  const processingStartIndex = processingStartStatusId
    ? nativeStatuses.findIndex(status => status.id === processingStartStatusId)
    : -1
  const isProcessingStatus = (status: string) => {
    const statusIndex = nativeStatuses.findIndex(candidate => candidate.id === status)
    return processingStartIndex >= 0 && statusIndex >= processingStartIndex
  }
  const selectedGroupField = aitableFields.find(field => field.id === aitableGroupFieldId)
  const configuredGroupValues = Array.isArray(selectedGroupField?.config?.options)
    ? selectedGroupField.config.options.flatMap(option => aitableCellLabels(option))
    : []
  const aitableGroupValues = Array.from(
    new Set([
      ...configuredGroupValues,
      ...selectedProjectBoardItems.flatMap(item =>
        aitableCellLabels(item.source_cells?.[aitableGroupFieldId])
      ),
      ...(selectedProjectBoardItems.some(
        item => !aitableCellLabels(item.source_cells?.[aitableGroupFieldId]).length
      )
        ? ['未设置']
        : []),
    ])
  )
  const availableTags = useMemo(
    () =>
      collectProjectTags(selectedProject ?? {}, selectedProjectBoardItems).sort((a, b) =>
        a.localeCompare(b, 'zh-CN')
      ),
    [selectedProject, selectedProjectBoardItems]
  )
  const createBoardColumns = useCallback(
    (groupBy: ProjectBoardGroupBy): ProjectBoardColumn[] =>
      isAITableProject
        ? aitableGroupValues.map((groupValue, index) => ({
            key: `field-${aitableGroupFieldId}-${groupValue}`,
            label: groupValue,
            status: 'inbox' as CloudLoopItem['status'],
            sourceStatus: null,
            groupValue,
            dotClass: ['bg-zinc-400', 'bg-indigo-500', 'bg-amber-500', 'bg-violet-500'][index % 4],
          }))
        : createStandardCloudBoardColumns({
            assignees: [
              ...(selectedProjectKey
                ? (collaborationProjectMembers[selectedProjectKey] ?? []).map(member => ({
                    id: String(member.user_id),
                    name: member.user_name,
                    type: 'user' as const,
                  }))
                : []),
              ...selectedProjectAgents.map(agent => ({
                id: agent.id,
                name: agent.name,
                type: 'agent' as const,
              })),
            ],
            getDotClass: (nextGroupBy, value, status) =>
              nextGroupBy === 'status'
                ? (boardStatusColorClasses[status?.color ?? ''] ??
                  columnDotClasses[value] ??
                  'bg-text-muted wework:bg-zinc-400')
                : nextGroupBy === 'priority'
                  ? (columnDotClasses[value] ?? 'bg-text-muted wework:bg-zinc-400')
                  : nextGroupBy === 'assignee' && value
                    ? 'bg-info wework:bg-indigo-500'
                    : 'bg-text-muted wework:bg-zinc-400',
            groupBy,
            items: selectedProjectBoardItems,
            labels: {
              noPriority: '普通',
              noTag: '无标签',
              priority: {
                low: 'low',
                medium: 'medium',
                high: 'high',
                urgent: 'urgent',
              },
              unassigned: '未指定',
            },
            statuses: visibleNativeStatuses,
            tags: availableTags,
          }),
    [
      aitableGroupFieldId,
      aitableGroupValues,
      collaborationProjectMembers,
      isAITableProject,
      availableTags,
      selectedProjectAgents,
      selectedProjectBoardItems,
      selectedProjectKey,
      visibleNativeStatuses,
    ]
  )
  const aitableApi = isAITableProject ? services.aitableApi : undefined
  const canCreateBoardTask = selectedProject !== null
  const persistedBoardItems = useMemo(() => {
    if (!isMyTasksBoard) return selectedProjectBoardItems
    const bindings = Object.values(activeItemTaskBindings).flat()
    const boundItemIds = new Set(
      bindings.flatMap(binding => (binding.loop_item_id ? [binding.loop_item_id] : []))
    )
    return selectedProjectBoardItems.filter(item => boundItemIds.has(item.id))
  }, [activeItemTaskBindings, isMyTasksBoard, selectedProjectBoardItems])
  const activeBoardSourceItems = useMemo(() => {
    if (!isMyTasksBoard || !selectedProject) return persistedBoardItems
    const bindings = Object.values(activeItemTaskBindings).flat()
    const runtimeItems = runtimeMyWorkItems(
      runtimeWork,
      {
        projectId: String(selectedProject.id),
        projectStore: selectedProject.project_store,
        createdByUserId: user.id,
      },
      runtimeTaskLifecycle
    )
    const mergedItems = mergeRuntimeMyWorkItems(
      persistedBoardItems,
      runtimeItems,
      bindings,
      selectedProjectBoardItems.map(item => item.id)
    )
    const runtimeStatusByItemId = new Map<
      string,
      Pick<CloudLoopItem, 'status' | 'execution_state'>
    >()
    for (const binding of bindings) {
      if (!binding.loop_item_id) continue
      const lifecycle = runtimeTaskLifecycle?.tasks.get(
        getRuntimeTaskLifecycleKey({
          deviceId: binding.device_id,
          taskId: binding.task_id,
        })
      )
      const runtimeStatus = lifecycle ? runtimeTaskTrackingExecutionStatus(lifecycle) : null
      if (runtimeStatus === 'running') {
        runtimeStatusByItemId.set(binding.loop_item_id, {
          status: 'in_progress',
          execution_state: 'running',
        })
      } else if (
        runtimeStatus === 'queued' &&
        runtimeStatusByItemId.get(binding.loop_item_id)?.status !== 'in_progress'
      ) {
        runtimeStatusByItemId.set(binding.loop_item_id, {
          status: 'pending',
          execution_state: null,
        })
      }
    }
    return mergedItems.map(item => {
      const runtimeStatus = runtimeStatusByItemId.get(item.id)
      return runtimeStatus ? { ...item, ...runtimeStatus } : item
    })
  }, [
    activeItemTaskBindings,
    isMyTasksBoard,
    persistedBoardItems,
    runtimeTaskLifecycle,
    runtimeWork,
    selectedProject,
    selectedProjectBoardItems,
    user.id,
  ])
  const boardItemsLoading =
    selectedProject !== null &&
    (selectedProject.location === 'cloud'
      ? cloudWorkspace.state.project?.id !== String(selectedProject.id) ||
        cloudWorkspace.state.loading
      : itemsProjectKey !== selectedProjectKey)
  const startupProjectsLoading =
    (Boolean(projectSpaceApis.local) && localProjectsLoading) ||
    (Boolean(cloudWorkspaceApi) && cloudWorkspace.state.loading)
  const startupProjectRouteReady =
    !activeProjectRef ||
    Boolean(selectedProject && sameProjectSpace(projectSpaceRef(selectedProject), activeProjectRef))
  const focusedStartupItem = focusedItemId
    ? activeBoardSourceItems.find(item => item.id === focusedItemId)
    : undefined
  const startupFocusedItemReady =
    !focusedItemId ||
    selectedItem?.id === focusedItemId ||
    (!boardItemsLoading && (!focusedStartupItem || focusedStartupItem.can_view_detail === false))
  const startupBoardReady =
    startupActive &&
    Boolean(workbench?.isStartupReady) &&
    !startupProjectsLoading &&
    startupProjectRouteReady &&
    !boardItemsLoading &&
    startupFocusedItemReady
  const selectedItemProject = selectedItem ? projectForItem(selectedItem) : undefined
  const selectedItemApi = apiForProject(selectedItemProject)
  const runtimeAddressesForTaskBoardItem = useCallback(
    (item: CloudLoopItem): RuntimeTaskAddress[] => {
      if (isRuntimeMyWorkItem(item)) return [item.runtime_address]
      const addresses = new Map<string, RuntimeTaskAddress>()
      for (const binding of activeItemTaskBindings[item.id] ?? []) {
        const address = { deviceId: binding.device_id, taskId: binding.task_id }
        addresses.set(getRuntimeTaskLifecycleKey(address), address)
      }
      for (const address of runtimeAddressesByWorkItem.get(`${item.cloud_project_id}:${item.id}`) ??
        []) {
        addresses.set(getRuntimeTaskLifecycleKey(address), address)
      }
      return [...addresses.values()]
    },
    [activeItemTaskBindings, runtimeAddressesByWorkItem]
  )
  const isTaskBoardItemUnread = useCallback(
    (item: CloudLoopItem): boolean =>
      runtimeAddressesForTaskBoardItem(item).some(address =>
        runtimeTaskLifecycle?.unreadTaskKeys.has(getRuntimeTaskLifecycleKey(address))
      ),
    [runtimeAddressesForTaskBoardItem, runtimeTaskLifecycle]
  )
  const markTaskBoardItemRead = useCallback(
    (item: CloudLoopItem) => {
      if (!onMarkRuntimeTaskRead) return
      for (const address of runtimeAddressesForTaskBoardItem(item)) {
        if (runtimeTaskLifecycle?.unreadTaskKeys.has(getRuntimeTaskLifecycleKey(address))) {
          onMarkRuntimeTaskRead(address)
        }
      }
    },
    [onMarkRuntimeTaskRead, runtimeAddressesForTaskBoardItem, runtimeTaskLifecycle]
  )
  const openItemForProject = useCallback(
    (project: LocatedCloudProject, item: LocatedLoopItem, openRuntimeItemInWorkbench = false) => {
      if (isDefaultWorkItemProject(project)) markTaskBoardItemRead(item)
      if (openRuntimeItemInWorkbench && isRuntimeMyWorkItem(item)) {
        void onOpenRuntimeTask?.(item.runtime_address)
        return
      }
      setSelectedItem(item)
    },
    [markTaskBoardItemRead, onOpenRuntimeTask, setSelectedItem]
  )
  const detailAllItems =
    selectedItemProject &&
    !sameProjectSpace(projectSpaceRef(selectedItemProject), selectedProjectRef)
      ? selectedItemProject.location === 'cloud'
        ? (cloudWorkspace.state.projectItems[String(selectedItemProject.id)] ?? []).map(issue => ({
            ...toCloudLoopItem(issue),
            project_store: selectedItemProject.project_store,
          }))
        : detailItems
      : activeBoardSourceItems
  const createTodoProject = createTodoParent
    ? (projectForItem(createTodoParent) ?? null)
    : selectedProject
  const createTodoApi = apiForProject(createTodoProject)
  const boardItems =
    boardItemsLoading || !selectedProject
      ? []
      : activeBoardSourceItems.filter(item =>
          sameProjectSpace(
            {
              projectStore: item.project_store ?? selectedProject.project_store,
              projectId: item.cloud_project_id,
            },
            projectSpaceRef(selectedProject)
          )
        )
  const standardBoardExtensions = useMemo(
    () => ({
      getSearchText: (item: LocatedLoopItem) => `${item.title} ${item.description ?? ''}`,
      noTagGroupValue: '',
    }),
    []
  )
  const savedViews = useSavedBoardViews({
    projectKey: selectedProjectKey ?? '',
    config: selectedProject?.board_views,
    revision: selectedProject?.version ?? 0,
    translate: boardTranslate,
    save: async (boardViews, settings) => {
      if (!selectedProject) throw new Error(cloudWorkspaceMessages.saveFailed)
      const api = selectedProject.location === 'cloud' ? cloudWorkspaceApi : localProjectManageApi
      if (!api) throw new Error(cloudWorkspaceMessages.saveFailed)
      await saveProjectBoardViews({
        api: api.projects,
        projectId: String(selectedProject.id),
        version: selectedProject.version,
        config: boardViews,
        settings,
        translate: boardTranslate,
        accept: project => {
          replaceProject(selectedProject, toWeworkCloudProject(project))
        },
      })
    },
  })
  const canManageViews =
    selectedProject?.location === 'local' ||
    ['Owner', 'Maintainer'].includes(selectedProject?.access_role ?? '')
  const baseBoardStatusGrouping =
    !isMyTasksBoard &&
    !isAITableProject &&
    !isExternalGitBoard &&
    isBaseBoardStatusGroupingEnabled()
  const baseBoardMigrationReady =
    selectedProject?.location !== 'cloud' ||
    (cloudWorkspace.state.project?.project_store === 'backend' &&
      cloudWorkspace.state.project.id === String(selectedProject.id) &&
      !cloudWorkspace.state.loading)
  const baseBoardMigration = useBaseBoardStatusMigration({
    api:
      selectedProject?.location === 'cloud'
        ? (cloudWorkspaceApi?.projects ?? null)
        : (localProjectManageApi?.projects ?? null),
    project: selectedProject
      ? {
          id: String(selectedProject.id),
          project_store: selectedProject.project_store ?? 'backend',
          board_config: selectedProject.board_config,
        }
      : null,
    enabled: baseBoardStatusGrouping && baseBoardMigrationReady && projectView === 'board',
    canManage: canManageViews,
    onMigrated: project => {
      if (selectedProject) replaceProject(selectedProject, toWeworkCloudProject(project))
    },
  })
  const tagFilter = useBoardTagFilter({
    scope: `${selectedProjectKey}:${savedViews.view?.id ?? 'default'}`,
    tags: availableTags,
    translate: boardTranslate,
  })
  const standardBoardController = useStandardCloudBoardController({
    baseBoardStatusGrouping,
    currentUserId: taskOwnerUserId,
    tagFilter: tagFilter.tags,
    tagLimitError: boardTranslate('todo.tag_limit_exceeded', '最多添加 20 个不同标签'),
    view: savedViews.view,
    viewScope: `${selectedProjectKey}:${savedViews.view?.id ?? 'default'}`,
    defaultColumnSorts: savedViews.view?.sorts,
    createColumns: groupBy =>
      savedViews.view
        ? savedBoardColumns(savedViews.view, nativeStatuses, createBoardColumns('status'))
        : createBoardColumns(groupBy),
    currentParentId: boardParentId,
    defaultGroupBy: selectedProject?.board_config?.group_by ?? 'status',
    extensions: standardBoardExtensions,
    focusStorageKey: focusExecutionColumnsKey,
    items: boardItems,
    supportsOrder: !isExternalGitBoard && !isAITableProject && !isMyTasksBoard,
    onCurrentParentIdChange: setBoardParentId,
    onMove: async (item, column, beforeItemId, mutation) => {
      return performStandardBoardMove(item, column, beforeItemId, mutation)
    },
    personalGroupStorageKey: personalGroupKey,
    personalSortStorageKey: selectedProjectKey
      ? `wework-board-column-sort:v2:${user.id}:${selectedProjectKey}${savedViews.view ? `:view:${savedViews.view.id}` : ''}`
      : null,
  })
  const {
    activeDragItemId,
    breadcrumb: boardBreadcrumb,
    columns: boardColumns,
    currentParent: boardParent,
    setActiveDragItemId,
    state: boardState,
  } = standardBoardController
  const {
    groupBy: nativeGroupBy,
    groupFilter: nativeGroupFilter,
    query: nativeBoardQuery,
    setExternalGroupFilter: setAitableGroupFilter,
    setGroupFilter: setNativeGroupFilter,
    setQuery: setNativeBoardQuery,
    setQuickCreateStatus,
  } = boardState
  const resetProjectViewState = workspaceSource.resetProjectView
  const parentIssueBoard = useParentIssueBoard({
    scope: `${user.id}:${selectedProjectKey}:${savedViews.view?.id ?? 'default'}`,
    enabled:
      Boolean(selectedProject) && !isMyTasksBoard && !isAITableProject && !isExternalGitBoard,
    items: boardItems,
    columns: boardColumns,
    currentParentId: boardParentId,
    state: boardState,
    getColumnItems: standardBoardController.getColumnItems,
    translate: boardTranslate,
  })
  const boardLayerCount = standardBoardController.filteredItems.filter(
    item => item.parent_id === boardParentId
  ).length
  const rootBoardItems = boardItems.filter(item => item.parent_id === null)
  const firstRootBoardItem = rootBoardItems[0] ?? null
  const quickStartStorageKey = selectedProjectKey
    ? `wework-board-quick-start:v1:${user.id}:${selectedProjectKey}`
    : null
  const quickStartDetailOpened = Boolean(
    selectedItem &&
    selectedItem.parent_id === null &&
    selectedProject &&
    String(selectedItem.cloud_project_id) === String(selectedProject.id) &&
    selectedItem.project_store === selectedProject.project_store
  )
  const taskColumnEmptyHints: Record<CloudLoopItem['status'], string> = {
    inbox: t('todo.task_column_empty_inbox', '先记录一个需要推进的问题、目标或具体工作。'),
    pending: t('todo.task_column_empty_pending', '目标和执行方式明确后，从这里等待开始。'),
    in_progress: t(
      'todo.task_column_empty_in_progress',
      '拖到这里开始处理；需要运行环境时系统会先提示。'
    ),
    in_review: t('todo.task_column_empty_in_review', '成员或 AI 提交结果后，可在这里确认。'),
    completed: t('todo.task_column_empty_completed', '确认通过的任务会显示在这里。'),
  }
  const issueColumnEmptyHints: Record<CloudLoopItem['status'], string> = {
    inbox: t('todo.issue_column_empty_inbox', '先记录一个需要推进的问题、目标或交付。'),
    pending: t('todo.issue_column_empty_pending', '目标和负责人明确后，从这里等待开始。'),
    in_progress: t(
      'todo.issue_column_empty_in_progress',
      '拖到这里开始推进；需要执行配置时系统会先提示。'
    ),
    in_review: t('todo.issue_column_empty_in_review', '成员或 AI 提交结果后，可在这里验收。'),
    completed: t('todo.issue_column_empty_completed', '验收通过的 Issue 会显示在这里。'),
  }
  const consumeAssigneeQuickAddRequest = useCallback(
    (requestId: number) => {
      setAssigneeQuickAddRequest(current => (current?.id === requestId ? null : current))
    },
    [setAssigneeQuickAddRequest]
  )
  const aiChatProject = selectedItemProject
  const selectedProjectCodeWorkspacePreference = selectedItemProject
    ? loadProjectSpaceCodeWorkspacePreference(user.id, projectSpaceRef(selectedItemProject))
    : null
  const selectedItemLocalProjectId = selectedItem ? localProjectIdForItem(selectedItem) : null
  const selectedItemDefaultLocalProjectId =
    selectedItemLocalProjectId ??
    selectedProjectCodeWorkspacePreference?.localProjectId ??
    (isMyTasksBoard ? selectedLocalProject?.id : null)
  const selectedItemDefaultDeviceWorkspaceId =
    selectedItemDefaultLocalProjectId === selectedProjectCodeWorkspacePreference?.localProjectId
      ? (selectedProjectCodeWorkspacePreference?.deviceWorkspaceId ?? null)
      : null
  const selectedItemTaskRequestProjectId =
    selectedItem && taskComposerRequest?.workItemId === selectedItem.id
      ? runtimeTaskProjectUiId(runtimeWork, taskComposerRequest.taskRequest)
      : null
  const selectedItemTaskDeviceWorkspaceId =
    selectedItemTaskRequestProjectId !== null &&
    selectedItemTaskRequestProjectId !== selectedItemDefaultLocalProjectId
      ? null
      : selectedItemDefaultDeviceWorkspaceId
  const taskPanelOpen = Boolean(
    selectedItem &&
    aiChatProject &&
    backgroundTaskItemId !== selectedItem.id &&
    (selectedTaskBinding?.work_item_id === selectedItem.id ||
      taskComposerRequest?.workItemId === selectedItem.id)
  )
  const taskStartingInBackground = backgroundTaskItemId === selectedItem?.id
  const issueResourceKey = cloudTodoIssueResourceKey(selectedItem, selectedItemProject, user.id)
  const issueResourceAttachments =
    issueResourceAttachmentState.owner === issueResourceKey
      ? issueResourceAttachmentState.attachments
      : []
  const issueResourceAttachmentsLoading = Boolean(
    taskPanelOpen &&
    selectedItem &&
    selectedItemProject &&
    (selectedItemProject.location === 'cloud' ? cloudWorkspaceApi : selectedItemApi) &&
    issueResourceAttachmentState.owner !== issueResourceKey
  )
  const closeTaskPanel = useCallback(() => {
    advanceTaskPanelSession()
    setSelectedTaskBinding(null)
    setTaskComposerRequest(null)
  }, [advanceTaskPanelSession, setSelectedTaskBinding, setTaskComposerRequest])
  const closeIssuePanelStack = useCallback(() => {
    setBackgroundTaskItemId(null)
    setSelectedItem(null)
    closeTaskPanel()
  }, [closeTaskPanel, setBackgroundTaskItemId, setSelectedItem])
  const openBoardItem = useCallback(
    (item: LocatedLoopItem) => {
      if (item.can_view_detail === false || !selectedProject) return
      setBackgroundTaskItemId(null)
      closeTaskPanel()
      openItemForProject(selectedProject, item, true)
    },
    [closeTaskPanel, openItemForProject, selectedProject, setBackgroundTaskItemId]
  )
  return {
    selectedCloudProjectItems,
    selectedProjectBoardItems,
    loadedProjectAssignments,
    issueTableAssignmentsByIssue,
    activeExternalPageCursors,
    activeExternalPageLoading,
    selectedProjectAgents,
    agentNameById,
    boardCardDisplay,
    nativeStatuses,
    visibleNativeStatuses,
    processingStartStatusId,
    processingStartIndex,
    isProcessingStatus,
    selectedGroupField,
    configuredGroupValues,
    aitableGroupValues,
    availableTags,
    createBoardColumns,
    aitableApi,
    canCreateBoardTask,
    persistedBoardItems,
    activeBoardSourceItems,
    boardItemsLoading,
    startupProjectsLoading,
    startupProjectRouteReady,
    focusedStartupItem,
    startupFocusedItemReady,
    startupBoardReady,
    selectedItemProject,
    selectedItemApi,
    runtimeAddressesForTaskBoardItem,
    isTaskBoardItemUnread,
    markTaskBoardItemRead,
    openItemForProject,
    detailAllItems,
    createTodoProject,
    createTodoApi,
    boardItems,
    standardBoardExtensions,
    savedViews,
    canManageViews,
    baseBoardMigration,
    baseBoardStatusGrouping,
    tagFilter,
    standardBoardController,
    activeDragItemId,
    boardBreadcrumb,
    boardColumns,
    boardParent,
    setActiveDragItemId,
    boardState,
    nativeGroupBy,
    nativeGroupFilter,
    nativeBoardQuery,
    setAitableGroupFilter,
    setNativeGroupFilter,
    setNativeBoardQuery,
    setQuickCreateStatus,
    resetProjectViewState,
    parentIssueBoard,
    boardLayerCount,
    rootBoardItems,
    firstRootBoardItem,
    quickStartStorageKey,
    quickStartDetailOpened,
    taskColumnEmptyHints,
    issueColumnEmptyHints,
    consumeAssigneeQuickAddRequest,
    aiChatProject,
    selectedProjectCodeWorkspacePreference,
    selectedItemLocalProjectId,
    selectedItemDefaultLocalProjectId,
    selectedItemDefaultDeviceWorkspaceId,
    selectedItemTaskRequestProjectId,
    selectedItemTaskDeviceWorkspaceId,
    taskPanelOpen,
    taskStartingInBackground,
    issueResourceAttachments,
    issueResourceAttachmentsLoading,
    closeTaskPanel,
    closeIssuePanelStack,
    openBoardItem,
  }
}
export type CloudTodoWorkspaceBoard = ReturnType<typeof useCloudTodoWorkspaceBoard>
