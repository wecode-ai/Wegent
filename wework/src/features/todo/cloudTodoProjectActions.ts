import type {
  LocatedCloudProject,
  LocatedLoopItem,
  AssigneeQuickAddRequest,
} from './cloudTodoWorkspaceTypes'
import { toCloudLoopItem, automationSelectionCandidates } from './cloudTodoWorkspaceSupport'
import { issueDraftFromText } from '@wegent/collaboration'
import type { CloudLoopItem } from '@/api/deliveries'
import { type CollaborationProject } from '@wegent/collaboration'
import {
  issueDispatchPersonalTaskInput,
  type IssueTaskDispatchInput,
} from '@/features/notifications/NotificationTaskSourceContext'
import { track } from '@/telemetry/client'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import type { RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import { projectSpaceKey, projectSpaceRef, sameProjectSpace } from './projectSpaceSelection'
import { projectExecutionEnvironmentTaskRequest } from './projectExecutionEnvironmentTaskRequest'
import { workItemTaskInput } from './workItemTaskInput'
import type { CloudTodoWorkspaceData } from './useCloudTodoWorkspaceData'
export function createCloudTodoProjectActions(data: CloudTodoWorkspaceData) {
  const {
    onActiveProjectChange,
    onArchiveRuntimeTasks,
    workspaceSource,
    t,
    cloudWorkspaceApi,
    cloudWorkspaceMessages,
    cloudWorkspace,
    selectedProjectRef,
    replaceProject,
    removeProjectFromList,
    openTaskComposer,
    selectedProject,
    isMyTasksBoard,
    selectedLocalProject,
    runtimeAddressesByWorkItem,
    selectedProjectKey,
    activeItemTaskBindings,
    projectForItem,
    apiForProject,
    selectedProjectApi,
    activeBoardSourceItems,
    boardParent,
    setQuickCreateStatus,
    resetProjectViewState,
    setSelectedProjectRef,
    setProjectView,
    setProjectSettingsSectionId,
    setAssigneeQuickAddRequest,
    selectedItem,
    setSelectedItem,
    boardParentId,
    setBoardParentId,
    setLocalProjectCounts,
    setLocalProjectItems,
    setItems,
    setItemsProjectKey,
    setBackgroundTaskItemId,
    setDetailItems,
    setCreateTodoOpen,
    setCreateTodoParent,
    setCreateTodoStatus,
    setCreateTodoInitialTitle,
    setCreateTodoNonce,
    setCreateTodoStartRuntime,
    setCreateTodoContinueCreating,
    setPendingAutomationSelection,
    setSelectedTaskBinding,
    setLocalProjectsLoading,
    setLocalProjectsError,
    setLocalProjectsRefreshNonce,
    renameProject,
    setRenameProject,
    renameProjectName,
    renameBusy,
    setRenameBusy,
    setRenameError,
    archiveProject,
    setArchiveProject,
    archiveItem,
    setArchiveItem,
    archiveBusy,
    setArchiveBusy,
    setArchiveError,
    setRuntimeBatchArchiveItems,
    setBatchArchiveError,
  } = data
  function applyProjectSelection(project: LocatedCloudProject | null) {
    const ref = project ? projectSpaceRef(project) : null
    if (!sameProjectSpace(selectedProjectRef, ref)) {
      setItems([])
      setItemsProjectKey(null)
      workspaceSource.resetBoardSnapshot()
    }
    workspaceSource.rememberProjectRequest(ref)
    setSelectedProjectRef(ref)
    resetProjectViewState()
  }
  function selectProject(project: LocatedCloudProject | null) {
    applyProjectSelection(project)
    onActiveProjectChange?.(project)
  }
  function openAssigneeQuickAdd(
    project: LocatedCloudProject,
    target: AssigneeQuickAddRequest['target']
  ) {
    setAssigneeQuickAddRequest({
      id: workspaceSource.nextQuickAddId(),
      projectKey: projectSpaceKey(projectSpaceRef(project)),
      target,
    })
    setCreateTodoOpen(false)
    setCreateTodoParent(null)
    setCreateTodoInitialTitle(undefined)
    selectProject(project)
    setProjectSettingsSectionId(target)
    setProjectView('manage')
  }
  async function renameSelectedProject() {
    if (!renameProject || !renameProjectName.trim() || renameBusy) return
    const api = apiForProject(renameProject)
    if (renameProject.location === 'cloud' ? !cloudWorkspaceApi : !api) {
      throw new Error('项目空间接口当前不可用')
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      if (renameProject.location === 'cloud') {
        const updated = await cloudWorkspace.commands.updateProject(String(renameProject.id), {
          name: renameProjectName.trim(),
          version: renameProject.version,
        })
        if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
      } else {
        const updated = await api!.updateCloudProject(renameProject.id, {
          name: renameProjectName.trim(),
          version: renameProject.version,
        })
        replaceProject(renameProject, updated)
      }
      track('feature_action_completed', { domain: 'project_space', action: 'rename' })
      setRenameProject(null)
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setRenameError(cause instanceof Error ? cause.message : '修改项目名称失败')
    } finally {
      setRenameBusy(false)
    }
  }
  async function confirmArchiveProject() {
    if (!archiveProject || archiveBusy) return
    const api = apiForProject(archiveProject)
    if (archiveProject.location === 'cloud' ? !cloudWorkspaceApi : !api) return
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      if (archiveProject.location === 'cloud') {
        const archived = await cloudWorkspace.commands.archiveProject(
          String(archiveProject.id),
          archiveProject.version
        )
        if (!archived) throw new Error(cloudWorkspaceMessages.saveFailed)
      } else {
        await api!.archiveCloudProject(archiveProject.id, archiveProject.version)
        removeProjectFromList(archiveProject)
      }
      setLocalProjectCounts(current => {
        const next = { ...current }
        delete next[projectSpaceKey(projectSpaceRef(archiveProject))]
        return next
      })
      if (sameProjectSpace(selectedProjectRef, projectSpaceRef(archiveProject))) {
        selectProject(null)
      }
      track('feature_action_completed', { domain: 'project_space', action: 'delete' })
      setArchiveProject(null)
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setArchiveError(cause instanceof Error ? cause.message : '归档项目失败')
    } finally {
      setArchiveBusy(false)
    }
  }
  async function confirmArchiveItem() {
    if (!archiveItem || archiveBusy) return
    const project = projectForItem(archiveItem)
    const api = apiForProject(project)
    if (!project || (project.location === 'cloud' ? !cloudWorkspaceApi : !api)) return
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      if (project.location === 'cloud') {
        const archived = await cloudWorkspace.commands.archiveIssue(archiveItem.id)
        if (!archived) throw new Error(cloudWorkspaceMessages.saveFailed)
      } else {
        await api!.archiveLoopItem(archiveItem.id)
      }
      const archivedIds = new Set([archiveItem.id])
      let changed = true
      while (changed) {
        changed = false
        for (const candidate of activeBoardSourceItems) {
          if (
            candidate.parent_id &&
            archivedIds.has(candidate.parent_id) &&
            !archivedIds.has(candidate.id)
          ) {
            archivedIds.add(candidate.id)
            changed = true
          }
        }
      }
      const archiveProjectKey = selectedProjectKey
      if (project.location === 'local') {
        setItems(current => current.filter(item => !archivedIds.has(item.id)))
      }
      if (project.location === 'local' && archiveProjectKey) {
        setLocalProjectItems(current => ({
          ...current,
          [archiveProjectKey]: (current[archiveProjectKey] ?? []).filter(
            item => !archivedIds.has(item.id)
          ),
        }))
        setLocalProjectCounts(current => ({
          ...current,
          [archiveProjectKey]: Math.max(0, (current[archiveProjectKey] ?? 0) - archivedIds.size),
        }))
      }
      if (boardParentId && archivedIds.has(boardParentId)) setBoardParentId(null)
      if (selectedItem && archivedIds.has(selectedItem.id)) setSelectedItem(null)
      track('feature_action_completed', { domain: 'board_item', action: 'delete' })
      setArchiveItem(null)
    } catch (cause) {
      track('operation_failed', { operation: 'board_item_action' })
      setArchiveError(cause instanceof Error ? cause.message : '归档任务失败')
    } finally {
      setArchiveBusy(false)
    }
  }
  async function archiveCompletedItems(completedItems: LocatedLoopItem[]) {
    if (!onArchiveRuntimeTasks || archiveBusy || completedItems.length === 0) return
    setRuntimeBatchArchiveItems(null)
    setArchiveBusy(true)
    setBatchArchiveError(null)
    const archivedItemKeys = new Set<string>()
    const failedItems: LocatedLoopItem[] = []
    try {
      const addresses = new Map<string, RuntimeTaskAddress>()
      for (const item of completedItems) {
        for (const binding of activeItemTaskBindings[item.id] ?? []) {
          const address = { deviceId: binding.device_id, taskId: binding.task_id }
          addresses.set(runtimeConversationKey(address), address)
        }
        for (const address of runtimeAddressesByWorkItem.get(
          `${item.cloud_project_id}:${item.id}`
        ) ?? []) {
          addresses.set(runtimeConversationKey(address), address)
        }
      }
      const runtimeResult = await onArchiveRuntimeTasks([...addresses.values()])
      if (runtimeResult?.status === 'failed') {
        failedItems.push(...completedItems)
      } else {
        const archiveResults = await Promise.allSettled(
          completedItems.map(async item => {
            const project = projectForItem(item)
            const api = apiForProject(project)
            if (!project || (project.location === 'cloud' ? !cloudWorkspaceApi : !api)) {
              throw new Error('项目空间当前不可用')
            }
            if (project.location === 'cloud') {
              const archived = await cloudWorkspace.commands.archiveIssue(item.id)
              if (!archived) throw new Error(cloudWorkspaceMessages.saveFailed)
            } else {
              await api!.archiveLoopItem(item.id)
            }
            return item
          })
        )
        archiveResults.forEach((result, index) => {
          const item = completedItems[index]
          if (result.status === 'fulfilled') {
            archivedItemKeys.add(`${item.project_store ?? 'backend'}:${item.id}`)
          } else {
            failedItems.push(item)
            console.error('[Wework my tasks] archive project task failed', result.reason)
          }
        })
      }
      if (
        archivedItemKeys.size > 0 &&
        completedItems.some(item => item.project_store === 'local')
      ) {
        setItems(current =>
          current.filter(
            item => !archivedItemKeys.has(`${item.project_store ?? 'backend'}:${item.id}`)
          )
        )
      }
      if (failedItems.length > 0) {
        setBatchArchiveError(
          t('todo.batch_archive_failed', '{{count}} 个任务归档失败，请稍后重试', {
            count: failedItems.length,
          })
        )
      }
    } catch (error) {
      console.error('[Wework my tasks] batch archive failed', error)
      setBatchArchiveError(
        t('todo.batch_archive_failed', '{{count}} 个任务归档失败，请稍后重试', {
          count: completedItems.length,
        })
      )
    } finally {
      setArchiveBusy(false)
    }
  }
  function openTodoCreation(
    parent: CloudLoopItem | null,
    status: CloudLoopItem['status'] = 'inbox',
    initialTitle?: string,
    options?: { startRuntime?: boolean }
  ) {
    setQuickCreateStatus(null)
    setCreateTodoParent(parent)
    setCreateTodoStatus(status)
    setCreateTodoInitialTitle(initialTitle)
    setCreateTodoStartRuntime(options?.startRuntime ?? false)
    setCreateTodoContinueCreating(false)
    setCreateTodoNonce(current => current + 1)
    setCreateTodoOpen(true)
  }
  function addCreatedTodo(item: CloudLoopItem, project: LocatedCloudProject) {
    const locatedItem = {
      ...item,
      project_store: project.project_store,
    }
    if (
      selectedProject &&
      project.location === 'local' &&
      sameProjectSpace(projectSpaceRef(project), projectSpaceRef(selectedProject))
    ) {
      setItems(current => [...current, locatedItem])
    } else {
      setDetailItems(current => [...current, locatedItem])
    }
    const targetProjectKey = projectSpaceKey(projectSpaceRef(project))
    if (project.location === 'local') {
      setLocalProjectCounts(current => ({
        ...current,
        [targetProjectKey]: (current[targetProjectKey] ?? 0) + 1,
      }))
      setLocalProjectItems(current => ({
        ...current,
        [targetProjectKey]: [...(current[targetProjectKey] ?? []), locatedItem],
      }))
    }
    track('board_item_created', {
      has_parent: item.parent_id !== null,
      source: project.location,
    })
    return locatedItem
  }
  function openCreatedItemRuntimeTask(
    item: LocatedLoopItem,
    project: LocatedCloudProject,
    taskRequest?: RuntimeTaskCreateRequest
  ) {
    const resolvedTaskRequest =
      taskRequest ?? projectExecutionEnvironmentTaskRequest(project as CollaborationProject)
    setSelectedTaskBinding(null)
    setSelectedItem(item)
    setBackgroundTaskItemId(item.id)
    openTaskComposer({
      workItemId: item.id,
      initialInput: workItemTaskInput(item),
      backgroundAfterSend: true,
      taskRequest: resolvedTaskRequest
        ? {
            ...resolvedTaskRequest,
            message: workItemTaskInput(item),
            title: item.title,
            cloudProjectId: String(project.id),
            origin: {
              type: 'board_task',
              cloudProjectId: String(project.id),
              loopItemId: String(item.id),
              projectStore: project.project_store,
            },
          }
        : undefined,
    })
  }
  function createIssueAssignmentTask(
    project: LocatedCloudProject,
    issue: LocatedLoopItem,
    assignment: IssueTaskDispatchInput,
    backgroundAfterSend: boolean
  ) {
    const initialInput = issueDispatchPersonalTaskInput(assignment)
    selectProject(project)
    setProjectView('board')
    setSelectedTaskBinding(null)
    setSelectedItem(issue)
    setBackgroundTaskItemId(backgroundAfterSend ? issue.id : null)
    openTaskComposer({
      workItemId: issue.id,
      initialInput,
      backgroundAfterSend,
      dispatch: assignment,
      taskRequest: {
        runtime: 'codex',
        message: initialInput,
        title: assignment.taskTitle,
        cloudProjectId: String(project.id),
        origin: {
          type: 'issue_dispatch',
          cloudProjectId: String(project.id),
          loopItemId: String(issue.id),
          projectStore: project.project_store,
          dispatchId: assignment.dispatchId,
          roundId: assignment.roundId,
          assignmentId: assignment.assignmentId,
          humanAssignmentId: assignment.humanAssignmentId,
        },
      },
    })
  }
  async function createTodoInBoardColumn(
    status: CloudLoopItem['status'],
    content: string,
    automationRuleId?: string
  ) {
    if (
      !selectedProject ||
      (selectedProject.location === 'cloud' ? !cloudWorkspaceApi : !selectedProjectApi)
    ) {
      throw new Error('项目空间接口当前不可用')
    }
    if (isMyTasksBoard && status !== 'inbox' && !selectedLocalProject) {
      throw new Error(t('todo.select_local_project_before_create', '请先选择要修改的本地项目'))
    }
    const draft = issueDraftFromText(content)
    try {
      const localProject =
        isMyTasksBoard && status !== 'inbox' && selectedLocalProject ? selectedLocalProject : null
      const created =
        selectedProject.location === 'cloud'
          ? await cloudWorkspace.commands
              .createIssue(
                String(selectedProject.id),
                {
                  title: draft.title,
                  description: draft.description,
                  priority: 'none',
                  status,
                  tags: [],
                  localProjectId: localProject?.id,
                  localProjectName: localProject?.name,
                  parentId: boardParent?.id,
                },
                { throwOnError: true }
              )
              .then(created => {
                if (!created) throw new Error(cloudWorkspaceMessages.saveFailed)
                return toCloudLoopItem(created)
              })
          : await selectedProjectApi!.createLoopItem(selectedProject.id, {
              title: draft.title,
              description: draft.description,
              priority: 'none',
              status,
              tags: [],
              ...(localProject
                ? {
                    local_project_id: localProject.id,
                    local_project_name: localProject.name,
                  }
                : {}),
              ...(boardParent ? { parent_id: boardParent.id } : {}),
              ...(selectedProject.current_user_name
                ? { creator_name: selectedProject.current_user_name }
                : {}),
              ...(automationRuleId ? { automation_rule_id: automationRuleId } : {}),
            })
      addCreatedTodo(created, selectedProject)
      setQuickCreateStatus(null)
    } catch (cause) {
      const candidates = automationSelectionCandidates(cause)
      if (candidates) {
        setQuickCreateStatus(null)
        setPendingAutomationSelection({
          candidates,
          onCancel: () => setPendingAutomationSelection(null),
          onConfirm: async automationId => {
            await createTodoInBoardColumn(status, content, automationId)
            setPendingAutomationSelection(null)
          },
        })
        return
      }
      track('operation_failed', { operation: 'board_item_action' })
      throw cause
    }
  }
  function retryLocalProjects() {
    setLocalProjectsError(null)
    setLocalProjectsLoading(true)
    setLocalProjectsRefreshNonce(current => current + 1)
  }
  return {
    applyProjectSelection,
    selectProject,
    openAssigneeQuickAdd,
    renameSelectedProject,
    confirmArchiveProject,
    confirmArchiveItem,
    archiveCompletedItems,
    openTodoCreation,
    addCreatedTodo,
    openCreatedItemRuntimeTask,
    createIssueAssignmentTask,
    createTodoInBoardColumn,
    retryLocalProjects,
  }
}
