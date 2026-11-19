import type { LocatedLoopItem } from './cloudTodoWorkspaceTypes'
import { toCloudLoopItem, automationSelectionCandidates } from './cloudTodoWorkspaceSupport'
import type { CloudLoopItem } from '@/api/deliveries'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import { runtimeTaskProjectUiId } from '@/lib/runtime-task-workspace-binding'
import { track } from '@/telemetry/client'
import type { ProjectWithTasks, RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import {
  publishProjectSpaceTaskBindingChanged,
  projectSpaceKey,
  projectSpaceRef,
  sameProjectSpace,
} from './projectSpaceSelection'
import { toWorkspaceRuntimeTaskAddress } from '@/features/workbench/projectTaskTracking'
import { associateLoopItemTags } from '@/api/localProjectAssociation'
import { saveProjectSpaceCodeWorkspacePreference } from './projectSpaceCodeWorkspacePreference'
import { workItemAssociationUpdate, prepareIssueStartStatus } from './workItemTaskInput'
import type { CloudTodoWorkspaceData } from './useCloudTodoWorkspaceData'
import type { createCloudTodoProjectActions } from './cloudTodoProjectActions'
export function createCloudTodoTaskActions(
  data: CloudTodoWorkspaceData & ReturnType<typeof createCloudTodoProjectActions>
) {
  const {
    user,
    runtimeWork,
    services,
    notificationChoice,
    t,
    cloudWorkspaceApi,
    cloudWorkspaceMessages,
    cloudWorkspace,
    projects,
    selectedProject,
    localProjectOptions,
    isMyTasksBoard,
    apiForProject,
    selectedItemProject,
    setQuickCreateStatus,
    closeIssuePanelStack,
    setProjectView,
    selectedItem,
    setSelectedItem,
    setBoardParentId,
    setLocalProjectCounts,
    setLocalProjectItems,
    setItems,
    setCreateProjectOpen,
    setCreateTodoOpen,
    setIssueComposerOpen,
    setIssueComposerBoardKey,
    setIssueComposerStatus,
    setIssueComposerInitialContent,
    setIssueComposerPresentation,
    issueComposerBusy,
    setIssueComposerBusy,
    setIssueComposerError,
    setPendingAutomationSelection,
    taskComposerRequest,
    setBoardError,
    setBoardRefreshNonce,
    selectProject,
    openCreatedItemRuntimeTask,
  } = data
  function openIssueCreation(
    status: CloudLoopItem['status'] = 'inbox',
    initialContent = '',
    presentation: 'page' | 'popup' = 'page'
  ) {
    const targetProject = selectedProject ?? projects[0]
    if (!targetProject) {
      setCreateProjectOpen(true)
      return
    }
    setCreateTodoOpen(false)
    setQuickCreateStatus(null)
    setIssueComposerBoardKey(projectSpaceKey(projectSpaceRef(targetProject)))
    setIssueComposerStatus(status)
    setIssueComposerInitialContent(initialContent)
    setIssueComposerPresentation(presentation)
    setIssueComposerError(null)
    setIssueComposerOpen(true)
    setSelectedItem(null)
  }
  async function createIssueFromComposer(input: {
    boardKey: string
    title: string
    description: string
    files: File[]
    createTask: boolean
    taskRequest?: RuntimeTaskCreateRequest
    continueCreating?: boolean
    status?: CloudLoopItem['status']
    priority?: CloudLoopItem['priority']
    tags?: string[]
    assigneeUserId?: number | null
    automationRuleId?: string
  }) {
    const targetProject = projects.find(
      project => projectSpaceKey(projectSpaceRef(project)) === input.boardKey
    )
    const targetApi = apiForProject(targetProject)
    if (
      !targetProject ||
      (targetProject.location === 'cloud' ? !cloudWorkspaceApi : !targetApi) ||
      issueComposerBusy
    ) {
      return false
    }
    setIssueComposerBusy(true)
    setIssueComposerError(null)
    const notifyAssignee =
      input.assigneeUserId &&
      input.assigneeUserId !== user.id &&
      targetProject.project_store === 'backend'
        ? await notificationChoice.request()
        : true
    if (notifyAssignee === null) {
      setIssueComposerBusy(false)
      return false
    }
    try {
      const taskRuntimeProjectId = runtimeTaskProjectUiId(runtimeWork, input.taskRequest)
      const issueLocalProject =
        localProjectOptions.find(project => project.id === taskRuntimeProjectId) ?? null
      const issueLocalProjectInput =
        input.createTask && isDefaultWorkItemProject(targetProject) && issueLocalProject
          ? issueLocalProject
          : null
      let created =
        targetProject.location === 'cloud'
          ? await cloudWorkspace.commands
              .createIssue(
                String(targetProject.id),
                {
                  title: input.title,
                  description: input.description,
                  status: input.status ?? (input.createTask ? 'pending' : 'inbox'),
                  ...(input.priority ? { priority: input.priority } : {}),
                  ...(input.tags ? { tags: input.tags } : {}),
                  ...(input.automationRuleId ? { automationRuleId: input.automationRuleId } : {}),
                  ...(input.assigneeUserId
                    ? {
                        assigneeUserId: input.assigneeUserId,
                        notifyAssignee,
                      }
                    : {}),
                  parentId: null,
                  ...(issueLocalProjectInput
                    ? {
                        localProjectId: issueLocalProjectInput.id,
                        localProjectName: issueLocalProjectInput.name,
                      }
                    : {}),
                },
                { throwOnError: true }
              )
              .then(issue => {
                if (!issue) throw new Error(cloudWorkspaceMessages.saveFailed)
                return toCloudLoopItem(issue)
              })
          : await targetApi!.createLoopItem(targetProject.id, {
              title: input.title,
              description: input.description,
              status: input.status ?? (input.createTask ? 'pending' : 'inbox'),
              ...(input.priority ? { priority: input.priority } : {}),
              ...(input.tags ? { tags: input.tags } : {}),
              ...(input.automationRuleId ? { automation_rule_id: input.automationRuleId } : {}),
              parent_id: null,
              ...(issueLocalProjectInput
                ? {
                    local_project_id: issueLocalProjectInput.id,
                    local_project_name: issueLocalProjectInput.name,
                  }
                : {}),
            })
      if (input.files.length > 0) {
        const uploadedAttachments = await Promise.all(
          input.files.map(file =>
            targetProject.location === 'cloud'
              ? cloudWorkspaceApi!.attachments.upload(created.id, file)
              : targetApi!.addLoopItemAttachment(created.id, file)
          )
        )
        const attachmentMarkdown = uploadedAttachments
          .map(attachment => attachment.markdown)
          .filter(Boolean)
          .join('\n')
        if (attachmentMarkdown) {
          const description = [input.description, attachmentMarkdown].filter(Boolean).join('\n\n')
          created =
            targetProject.location === 'cloud'
              ? await cloudWorkspace.commands
                  .updateIssue(
                    created.id,
                    {
                      version: created.version,
                      description,
                    },
                    { throwOnError: true }
                  )
                  .then(issue => {
                    if (!issue) throw new Error(cloudWorkspaceMessages.saveFailed)
                    return toCloudLoopItem(issue)
                  })
              : await targetApi!.updateLoopItem(created.id, {
                  version: created.version,
                  description,
                })
        }
      }
      if (input.assigneeUserId && targetProject.location === 'local') {
        if (typeof targetApi!.assignLoopItem === 'function') {
          created = await targetApi!.assignLoopItem(targetProject.id, created.id, {
            version: created.version,
            assigneeType: 'user',
            assigneeId: String(input.assigneeUserId),
            notifyAssignee,
          })
        } else {
          created = await targetApi!.updateLoopItem(created.id, {
            version: created.version,
            assignee_user_id: input.assigneeUserId,
          })
        }
      }
      const locatedItem: LocatedLoopItem = {
        ...created,
        project_store: targetProject.project_store,
      }
      const targetProjectKey = projectSpaceKey(projectSpaceRef(targetProject))
      if (targetProject.location === 'local') {
        setLocalProjectCounts(current => ({
          ...current,
          [targetProjectKey]: (current[targetProjectKey] ?? 0) + 1,
        }))
        setLocalProjectItems(current => ({
          ...current,
          [targetProjectKey]: [...(current[targetProjectKey] ?? []), locatedItem],
        }))
        if (
          selectedProject &&
          sameProjectSpace(projectSpaceRef(targetProject), projectSpaceRef(selectedProject))
        ) {
          setItems(current => [...current, locatedItem])
        }
      }
      selectProject(targetProject)
      setProjectView('board')
      setBoardParentId(null)
      if (input.continueCreating) {
        setIssueComposerOpen(true)
        setSelectedItem(null)
      } else {
        setIssueComposerOpen(false)
        setSelectedItem(locatedItem)
      }
      if (input.createTask) {
        openCreatedItemRuntimeTask(locatedItem, targetProject, input.taskRequest)
      }
      track('board_item_created', {
        has_parent: false,
        source: targetProject.location,
      })
      return true
    } catch (cause) {
      const candidates = automationSelectionCandidates(cause)
      if (candidates) {
        setIssueComposerOpen(false)
        setPendingAutomationSelection({
          candidates,
          onCancel: () => {
            setPendingAutomationSelection(null)
            setIssueComposerOpen(true)
          },
          onConfirm: async automationId => {
            const created = await createIssueFromComposer({
              ...input,
              automationRuleId: automationId,
            })
            if (!created) {
              throw new Error(
                t('todo.automation_selection_create_failed', '创建 Issue 失败，请重新选择')
              )
            }
            setPendingAutomationSelection(null)
          },
        })
        return false
      }
      setIssueComposerError(cause instanceof Error ? cause.message : '创建 Issue 失败')
      return false
    } finally {
      setIssueComposerBusy(false)
    }
  }
  function closeTopPanel() {
    closeIssuePanelStack()
  }
  async function prepareSelectedItemTask(
    address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null
  ) {
    if (!selectedItem || !selectedItemProject) return
    const localApi = apiForProject(selectedItemProject)
    const runtimeBindingApi =
      selectedItemProject.location === 'cloud' ? services.workspaceRuntimePort : localApi
    if (!runtimeBindingApi || (selectedItemProject.location === 'cloud' && !cloudWorkspaceApi))
      return
    try {
      const latest =
        selectedItemProject.location === 'cloud'
          ? await cloudWorkspace.commands.getIssue(selectedItem.id).then(item => {
              if (!item) throw new Error(cloudWorkspaceMessages.loadFailed)
              return toCloudLoopItem(item)
            })
          : await localApi!.getLoopItem(selectedItem.id)
      const dispatch = taskComposerRequest?.dispatch
      if (selectedItemProject.location === 'cloud') {
        await services.workspaceRuntimePort!.bindTask(
          latest.id,
          toWorkspaceRuntimeTaskAddress(address),
          dispatch?.taskTitle ?? latest.title,
          dispatch
            ? {
                humanAssignmentId: dispatch.humanAssignmentId,
                dispatchId: dispatch.dispatchId,
                dispatchRoundId: dispatch.roundId,
                assignmentId: dispatch.assignmentId,
              }
            : (latest.human_task_binding ?? null)
        )
      } else {
        await localApi!.bindTask(
          latest.id,
          address,
          dispatch?.taskTitle ?? latest.title,
          null,
          dispatch
            ? {
                humanAssignmentId: dispatch.humanAssignmentId,
                dispatchId: dispatch.dispatchId,
                dispatchRoundId: dispatch.roundId,
                assignmentId: dispatch.assignmentId,
              }
            : null
        )
      }
      const project = projectSpaceRef(selectedItemProject)
      publishProjectSpaceTaskBindingChanged({ task: address, project, type: 'bound' })
      let rollbackStatus: (() => Promise<void>) | undefined
      if (selectedItemProject.location === 'cloud') {
        const status = await prepareIssueStartStatus(cloudWorkspaceApi!.issues, latest.id, {
          projectStore: 'backend',
          dispatchRoundId: dispatch?.roundId ?? latest.human_task_binding?.dispatchRoundId,
        })
        rollbackStatus = status.rollback
        if (status.error !== null) setBoardError(status.error || cloudWorkspaceMessages.saveFailed)
      }
      await associateSelectedItemWithProject(localProject)
      setBoardRefreshNonce(value => value + 1)
      return async () => {
        try {
          await rollbackStatus?.()
        } finally {
          await runtimeBindingApi.unbindTask(latest.id, address)
          publishProjectSpaceTaskBindingChanged({ task: address, project, type: 'unbound' })
          setBoardRefreshNonce(value => value + 1)
        }
      }
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : '关联任务与 Issue 失败，请重试')
      setBoardRefreshNonce(value => value + 1)
      throw cause
    }
  }
  function handleSelectedItemTaskCreated(
    _address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null,
    deviceWorkspaceId: number | null
  ) {
    if (!selectedItem || !selectedItemProject) return
    if (localProject) {
      saveProjectSpaceCodeWorkspacePreference(user.id, projectSpaceRef(selectedItemProject), {
        localProjectId: localProject.id,
        deviceWorkspaceId,
      })
    }
  }
  async function associateSelectedItemWithProject(localProject: ProjectWithTasks | null) {
    if (!selectedItem || !selectedItemProject || !isMyTasksBoard || !localProject) return
    const localApi = apiForProject(selectedItemProject)
    if (selectedItemProject.location === 'cloud' ? !cloudWorkspaceApi : !localApi) return
    try {
      const latest =
        selectedItemProject.location === 'cloud'
          ? await cloudWorkspace.commands.getIssue(selectedItem.id).then(item => {
              if (!item) throw new Error(cloudWorkspaceMessages.loadFailed)
              return toCloudLoopItem(item)
            })
          : await localApi!.getLoopItem(selectedItem.id)
      const associatedTags = associateLoopItemTags(latest, localProject)
      const associationUpdate = workItemAssociationUpdate(latest, associatedTags)
      const updated = associationUpdate
        ? selectedItemProject.location === 'cloud'
          ? await cloudWorkspace.commands
              .updateIssue(latest.id, associationUpdate)
              .then(updated => {
                if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
                return toCloudLoopItem(updated)
              })
          : await localApi!.updateLoopItem(latest.id, associationUpdate)
        : latest
      const locatedUpdated = {
        ...updated,
        project_store: selectedItem.project_store,
      }
      if (selectedItemProject.location === 'local') {
        setItems(current =>
          current.map(item =>
            item.id === locatedUpdated.id
              ? item.version > locatedUpdated.version
                ? item
                : locatedUpdated
              : item
          )
        )
      }
      setSelectedItem(current =>
        current?.id === locatedUpdated.id
          ? current.version > locatedUpdated.version
            ? current
            : locatedUpdated
          : current
      )
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : '关联任务与 Issue 失败，请重试')
      setBoardRefreshNonce(value => value + 1)
    }
  }
  return {
    openIssueCreation,
    createIssueFromComposer,
    closeTopPanel,
    prepareSelectedItemTask,
    handleSelectedItemTaskCreated,
    associateSelectedItemWithProject,
  }
}
