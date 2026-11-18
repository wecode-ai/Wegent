import { findCloudTodoProject } from './cloudTodoWorkspaceSupport'
import { locateBoardItems } from './cloudTodoLocalBoard'
import type { WeworkStandardBoardUpdate } from './cloudTodoWorkspaceTypes'
import { useCloudTodoRuntimeProjection } from './useCloudTodoRuntimeProjection'
import type {
  LocatedCloudProject,
  LocatedLoopItem,
  SelectedTaskBinding,
  TaskComposerRequest,
  CloudTodoWorkspaceProps,
} from './cloudTodoWorkspaceTypes'
import {
  externalBoardColumnPageSize,
  toWeworkCloudProject,
  toCloudLoopItem,
} from './cloudTodoWorkspaceSupport'
import { createCloudTodoWorkspaceSource } from './cloudTodoWorkspaceSource'
import { requireIssueTaskAvailable } from './issueTaskAvailability'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useAssignmentNotificationChoice } from '@/features/notifications/useAssignmentNotificationChoice'
import { createWeworkProjectAgentConfigurationHost } from '@/features/collaboration/WeworkProjectAgentConfigurationHost'
import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import { useProjectBoardSensors } from '@wegent/collaboration/project-board/projectBoardDnd'
import type { CloudProject } from '@/api/deliveries'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import {
  useCollaborationWorkspaceController,
  type CollaborationProject,
  type ProjectCreateTarget,
} from '@wegent/collaboration'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotAvailable } from '@/features/dsh-runtime/useDshSlotAvailable'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeWorkDeviceNamesById } from '@/lib/workbench-device'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { getChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import { type CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'
import { waitForDwsAuthentication } from './dwsAuth'
import { runtimeTaskConversationStatusesByAddress } from './runtimeTaskConversationStatus'
import {
  projectSpaceKey,
  projectSpaceRef,
  projectSupportsRobotAutomation,
} from './projectSpaceSelection'
import { createLocalWorkspaceApi } from './WeworkCollaborationPlatform'
export function useCloudTodoWorkspaceBase({
  user,
  localProjects,
  runtimeWork,
  runtimeTaskLifecycle,
  services,
  embedded = false,
  embeddedTitle = 'workspace',
  startupActive = false,
  workspaceActive = true,
  activeProjectRef,
  defaultProjectRequested = false,
  focusedItemId,
  onFocusedItemHandled,
  onActiveProjectChange,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onArchiveRuntimeTasks,
  onOpenSettings,
  onLogout,
}: CloudTodoWorkspaceProps) {
  const workspaceLocalApi =
    services.projectSpaceApis?.local ?? services.projectSpaceDetailServices?.local?.deliveryApi
  const workspaceSource = useMemo(
    () =>
      createCloudTodoWorkspaceSource({
        userId: user.id,
        cloudApi: services.sharedWorkspaceApi,
        catalogApi: services.projectSpaceApis?.local,
        localApi: workspaceLocalApi,
      }),
    [user.id, services.sharedWorkspaceApi, services.projectSpaceApis?.local, workspaceLocalApi]
  )
  const workspaceState = useSyncExternalStore(
    workspaceSource.subscribeState,
    workspaceSource.getSnapshot,
    workspaceSource.getSnapshot
  )
  const {
    internalSelectedProjectRef,
    projectView,
    assigneeQuickAddRequest,
    selectedItem,
    boardParentId,
    localProjectSpaces,
    localProjectCounts,
    localProjectMembers,
    localProjectAgents,
    localProjectItems,
    localItemTaskBindings,
    itemTaskBindingsProjectKey,
    localProjectFilter,
    dingtalkAuthBusy,
  } = workspaceState
  const {
    setLocalProjectSpaces,
    setProjectAssistantOpen,
    setSelectedTaskBinding,
    setTaskComposerRequest,
    setBoardError,
    setTaskDispatchError,
    setDingtalkAuthPrompt,
    setDingtalkAuthBusy,
    setBoardRefreshNonce,
  } = workspaceSource
  const performStandardBoardMove = workspaceSource.performStandardBoardMove
  const notificationChoice = useAssignmentNotificationChoice()
  const { t, i18n } = useTranslation('common')
  const boardTranslate = useMemo(
    () => createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en'),
    [i18n.language]
  )
  const workbench = useContext(WorkbenchContext)
  const workbenchDevices = useMemo(
    () => workbench?.state?.devices ?? [],
    [workbench?.state?.devices]
  )
  const taskStatusExtensionsAvailable = useDshSlotAvailable(WEWORK_DSH_SLOTS.taskStatus)
  const preferences = useAppPreferencesState()
  const changeRequestStatusEnabled =
    taskStatusExtensionsAvailable && (preferences?.preferences.changeRequestStatusEnabled ?? true)
  const issueChangeRequestMonitor =
    services.deviceApi && (preferences?.preferences.changeRequestStatusEnabled ?? true)
      ? getChangeRequestMonitor(services.deviceApi)
      : null
  const changeRequestMonitor = changeRequestStatusEnabled ? issueChangeRequestMonitor : null
  const cloudWorkspaceApi = services.sharedWorkspaceApi
  const deviceNamesById = useMemo(() => getRuntimeWorkDeviceNamesById(runtimeWork), [runtimeWork])
  const runtimeTaskExecutionStatusByAddress = useMemo(
    () => runtimeTaskConversationStatusesByAddress(runtimeWork, runtimeTaskLifecycle),
    [runtimeTaskLifecycle, runtimeWork]
  )
  const projectAgentConfigurationHost = useMemo(
    () =>
      createWeworkProjectAgentConfigurationHost(
        services.agentResourceApi,
        services.localProjectChatAgentApi,
        services.modelApi,
        services.pluginApi,
        services.deviceApi
      ),
    [
      services.agentResourceApi,
      services.deviceApi,
      services.localProjectChatAgentApi,
      services.modelApi,
      services.pluginApi,
    ]
  )
  const requestedProjectRef =
    activeProjectRef === undefined ? internalSelectedProjectRef : activeProjectRef
  const activeProjectKey =
    activeProjectRef === undefined
      ? undefined
      : activeProjectRef
        ? projectSpaceKey(activeProjectRef)
        : null
  const cloudWorkspaceMessages = useMemo(
    () => ({
      loadFailed: '云端协作数据加载失败',
      saveFailed: '云端协作数据保存失败',
      conflict: '数据已更新，已重新加载最新内容',
    }),
    []
  )
  const cloudWorkspace = useCollaborationWorkspaceController({
    api: cloudWorkspaceApi,
    location: {
      projectId:
        requestedProjectRef?.projectStore === 'backend'
          ? String(requestedProjectRef.projectId)
          : null,
      issueId: selectedItem?.project_store === 'backend' ? selectedItem.id : null,
      view: projectView === 'files' ? 'files' : projectView === 'manage' ? 'manage' : 'board',
      rootView: 'home',
    },
    messages: cloudWorkspaceMessages,
    loadProjectOnLocation: false,
    externalBoard: {
      parentId: boardParentId,
      pageSize: externalBoardColumnPageSize,
      eager: false,
    },
  })
  const projectSpaceApis = useMemo(() => {
    if (services.projectSpaceApis) return services.projectSpaceApis
    return {
      defaultLocation: 'cloud' as const,
    }
  }, [services])
  const localProjectManageApi = useMemo(
    () =>
      createLocalWorkspaceApi(
        projectSpaceApis.local ?? services.projectSpaceDetailServices?.local?.deliveryApi,
        Number(user.id),
        user.user_name,
        user.email ?? null,
        services.projectSpaceDetailServices?.local,
        i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
      ),
    [
      i18n.language,
      projectSpaceApis.local,
      services.projectSpaceDetailServices?.local,
      user.email,
      user.id,
      user.user_name,
    ]
  )
  const availableProjectSpaceApis = useMemo(() => {
    const available: ProjectCreateTarget[] = []
    if (localProjectManageApi) {
      available.push({
        location: 'local',
        create: localProjectManageApi.projects.create,
      })
    }
    if (cloudWorkspaceApi) {
      available.push({
        location: 'cloud',
        create: async input => {
          const project = await cloudWorkspace.commands.createProject(input)
          if (!project) throw new Error(cloudWorkspaceMessages.saveFailed)
          return project
        },
      })
    }
    return available
  }, [
    cloudWorkspace.commands,
    cloudWorkspaceApi,
    cloudWorkspaceMessages.saveFailed,
    localProjectManageApi,
  ])
  const cloudProjectSpaces = useMemo(
    () =>
      cloudWorkspace.state.projects.map(project => ({
        ...toWeworkCloudProject(project),
        project_store: 'backend' as const,
        location: 'cloud' as const,
      })),
    [cloudWorkspace.state.projects]
  )
  const projects = useMemo(() => {
    const allProjects = [...localProjectSpaces, ...cloudProjectSpaces]
    const preferredProjects =
      projectSpaceApis.defaultLocation === 'local' ? localProjectSpaces : cloudProjectSpaces
    const fallbackProjects =
      projectSpaceApis.defaultLocation === 'local' ? cloudProjectSpaces : localProjectSpaces
    const defaultProject =
      preferredProjects.find(isDefaultWorkItemProject) ??
      fallbackProjects.find(isDefaultWorkItemProject) ??
      null
    let defaultProjectAdded = false
    return allProjects.flatMap(project => {
      if (!isDefaultWorkItemProject(project)) return [project]
      if (!defaultProject || defaultProjectAdded) return []
      defaultProjectAdded = true
      return [defaultProject]
    })
  }, [cloudProjectSpaces, localProjectSpaces, projectSpaceApis.defaultLocation])
  const defaultProject =
    defaultProjectRequested && requestedProjectRef === null
      ? (projects.find(isDefaultWorkItemProject) ?? null)
      : null
  const selectedProjectRef =
    requestedProjectRef ?? (defaultProject ? projectSpaceRef(defaultProject) : null)
  const selectedProjectId = selectedProjectRef?.projectId ?? null
  const replaceProject = useCallback(
    (currentProject: LocatedCloudProject, updated: CloudProject) => {
      if (currentProject.location === 'cloud') {
        cloudWorkspace.commands.replaceProject(updated as CollaborationProject)
        return
      }
      setLocalProjectSpaces(current =>
        current.map(project =>
          projectSpaceKey(projectSpaceRef(project)) ===
          projectSpaceKey(projectSpaceRef(currentProject))
            ? { ...updated, location: currentProject.location }
            : project
        )
      )
    },
    [cloudWorkspace.commands, setLocalProjectSpaces]
  )
  const removeProjectFromList = useCallback(
    (projectToRemove: LocatedCloudProject) => {
      if (projectToRemove.location === 'cloud') return
      const key = projectSpaceKey(projectSpaceRef(projectToRemove))
      setLocalProjectSpaces(current =>
        current.filter(project => projectSpaceKey(projectSpaceRef(project)) !== key)
      )
    },
    [setLocalProjectSpaces]
  )
  const globalSearchScope = useMemo(
    () => ({ cloudWorkspaceApi, localProjectManageApi, userId: user.id }),
    [cloudWorkspaceApi, localProjectManageApi, user.id]
  )
  const prependProject = useCallback(
    (project: LocatedCloudProject) => {
      if (project.location === 'cloud') {
        cloudWorkspace.commands.replaceProject(project as CollaborationProject)
        return
      }
      setLocalProjectSpaces(current => [project, ...current])
    },
    [cloudWorkspace.commands, setLocalProjectSpaces]
  )
  const collaborationProjectItems = useMemo(
    () => ({
      ...localProjectItems,
      ...Object.fromEntries(
        Object.entries(cloudWorkspace.state.projectItems).map(([projectId, projectIssues]) => [
          `backend:${projectId}`,
          projectIssues.map(toCloudLoopItem),
        ])
      ),
    }),
    [cloudWorkspace.state.projectItems, localProjectItems]
  )
  const collaborationProjectMembers = useMemo(
    () => ({
      ...localProjectMembers,
      ...Object.fromEntries(
        Object.entries(cloudWorkspace.state.projectMembers).map(([projectId, members]) => [
          `backend:${projectId}`,
          members,
        ])
      ),
    }),
    [cloudWorkspace.state.projectMembers, localProjectMembers]
  )
  const collaborationProjectAgents = useMemo(
    () => ({
      ...localProjectAgents,
      ...Object.fromEntries(
        Object.entries(cloudWorkspace.state.projectAgents).map(([projectId, agents]) => [
          `backend:${projectId}`,
          (agents as ProjectChatAgent[]).filter(agent => agent.status === 'active'),
        ])
      ),
    }),
    [cloudWorkspace.state.projectAgents, localProjectAgents]
  )
  const collaborationProjectCounts = useMemo(
    () => ({
      ...localProjectCounts,
      ...Object.fromEntries(
        Object.entries(cloudWorkspace.state.projectItems).map(([projectId, projectIssues]) => [
          `backend:${projectId}`,
          projectIssues.length,
        ])
      ),
    }),
    [cloudWorkspace.state.projectItems, localProjectCounts]
  )
  const openProjectAssistant = () => {
    workbench?.projectChat.requestCatalogs?.()
    setProjectAssistantOpen(true)
  }
  const advanceTaskPanelSession = workspaceSource.advanceTaskPanelSession
  const openTaskComposer = (request: TaskComposerRequest) => {
    workbench?.projectChat.requestCatalogs?.()
    advanceTaskPanelSession()
    setTaskComposerRequest(request)
  }
  const boardSensors = useProjectBoardSensors()
  const clearTaskDispatchError = useCallback(
    () => setTaskDispatchError(null),
    [setTaskDispatchError]
  )
  const connectDingTalkBoard = async () => {
    if (!services.dwsApi || dingtalkAuthBusy) return
    setDingtalkAuthBusy(true)
    try {
      await services.dwsApi.login()
      await waitForDwsAuthentication(services.dwsApi)
      setBoardRefreshNonce(value => value + 1)
    } catch (cause) {
      setDingtalkAuthPrompt(true)
      setBoardError(cause instanceof Error ? cause.message : '连接钉钉失败')
    } finally {
      setDingtalkAuthBusy(false)
    }
  }
  const selectedProject =
    projects.find(
      project =>
        project.id === selectedProjectRef?.projectId &&
        project.project_store === selectedProjectRef.projectStore
    ) ?? null
  const updateStandardBoardItem = (target: LocatedLoopItem, update: WeworkStandardBoardUpdate) =>
    workspaceSource.updateStandardBoardItem(
      target,
      update,
      selectedProject ? projectSpaceKey(projectSpaceRef(selectedProject)) : null
    )
  const taskOwnerUserId = selectedProject?.current_user_id ?? user.id
  const openTaskBinding = async (binding: SelectedTaskBinding) => {
    advanceTaskPanelSession()
    const session = workspaceSource.getSnapshot().taskPanelSessionId
    try {
      await requireIssueTaskAvailable(
        { taskUserId: binding.task_user_id, deviceId: binding.device_id, taskId: binding.task_id },
        taskOwnerUserId,
        services.standInApi,
        key => t(key)
      )
      if (workspaceSource.getSnapshot().taskPanelSessionId !== session) return
    } catch (cause) {
      if (workspaceSource.getSnapshot().taskPanelSessionId === session) {
        setTaskDispatchError(
          cause instanceof Error ? cause.message : t('todo.linked_task_unavailable')
        )
      }
      return
    }
    setTaskDispatchError(null)
    setTaskComposerRequest(null)
    setSelectedTaskBinding(binding)
  }
  const selectedProjectForViewAccess =
    selectedProject &&
    selectedProject.project_store === 'backend' &&
    selectedProject.access_role === undefined &&
    selectedProject.created_by_user_id === user.id
      ? { ...selectedProject, access_role: 'Owner' as const }
      : selectedProject
  const {
    localProjectOptions,
    isMyTasksBoard,
    runtimeTaskStatusSignature,
    activeLocalProjectFilter,
    selectedLocalProject,
    runtimeProjectIdByTask,
    runtimeTasksByKey,
    runtimeTaskKeys,
    runtimeAddressesByWorkItem,
    runtimeTaskRunningByAddress,
    runtimeTaskByAddress,
    selectedProjectKey,
    activeAssigneeQuickAddRequest,
    activeItemTaskBindings,
    taskExecutionStatesByBindingId,
    boardTaskBindings,
    loadBoardTaskRuntimeGoal,
    localProjectIdForItem,
  } = useCloudTodoRuntimeProjection({
    user,
    localProjects,
    runtimeWork,
    runtimeTaskLifecycle,
    services,
    workbenchDevices,
    selectedProject,
    selectedProjectRef,
    localProjectFilter,
    cloudWorkspace,
    localItemTaskBindings,
    itemTaskBindingsProjectKey,
    assigneeQuickAddRequest,
    taskOwnerUserId,
    runtimeTaskExecutionStatusByAddress,
  })
  const personalGroupKey = selectedProject
    ? `wework-board-group:${user.id}:${selectedProject.id}`
    : null
  const focusExecutionColumnsKey = selectedProjectKey
    ? `wework-board-focus-execution:v1:${user.id}:${selectedProjectKey}`
    : null
  async function continueChangeRequestRepair(
    binding: CloudTodoBoardTaskBinding,
    snapshot: TaskChangeRequestSnapshot
  ): Promise<void> {
    if (selectedProject)
      await workspaceSource.continueChangeRequestRepair(
        binding,
        snapshot,
        projectSpaceKey(projectSpaceRef(selectedProject))
      )
  }
  const projectForItem = useCallback(
    (item: Pick<LocatedLoopItem, 'cloud_project_id' | 'project_store'>) =>
      findCloudTodoProject(projects, selectedProject, item),
    [projects, selectedProject]
  )
  const locateItems = locateBoardItems
  const selectedProjectAutomationSupported = selectedProject
    ? projectSupportsRobotAutomation(selectedProject)
    : false
  const apiForProject = useCallback(
    (project: LocatedCloudProject | null | undefined) => {
      if (!project || project.location !== 'local') return undefined
      return projectSpaceApis.local ?? services.projectSpaceDetailServices?.local?.deliveryApi
    },
    [projectSpaceApis, services.projectSpaceDetailServices]
  )
  const selectedProjectServices = selectedProject
    ? services.projectSpaceDetailServices?.[selectedProject.location]
    : undefined
  const selectedProjectApi =
    selectedProject?.location === 'local'
      ? apiForProject(selectedProject)
      : selectedProjectServices?.deliveryApi
  const selectedProjectAgentApi = selectedProjectServices?.projectChatAgentApi
  const selectedProjectChatClient = selectedProjectServices?.projectChatClient
  const selectedProjectSelfManagedExecution = selectedProject?.location === 'local'
  const isAITableProject = selectedProject?.task_provider === 'dingtalk_aitable'
  const isExternalGitBoard =
    selectedProject?.task_provider === 'github' || selectedProject?.task_provider === 'gitlab'
  const usesSharedCloudBoard = selectedProject?.location === 'cloud'
  return {
    ...workspaceState,
    ...workspaceSource,
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
    workspaceSource,
    performStandardBoardMove,
    updateStandardBoardItem,
    notificationChoice,
    t,
    i18n,
    boardTranslate,
    workbench,
    workbenchDevices,
    taskStatusExtensionsAvailable,
    preferences,
    changeRequestStatusEnabled,
    issueChangeRequestMonitor,
    changeRequestMonitor,
    cloudWorkspaceApi,
    globalSearchScope,
    deviceNamesById,
    runtimeTaskExecutionStatusByAddress,
    projectAgentConfigurationHost,
    requestedProjectRef,
    activeProjectKey,
    cloudWorkspaceMessages,
    cloudWorkspace,
    projectSpaceApis,
    localProjectManageApi,
    availableProjectSpaceApis,
    cloudProjectSpaces,
    projects,
    defaultProject,
    selectedProjectRef,
    selectedProjectId,
    replaceProject,
    removeProjectFromList,
    prependProject,
    collaborationProjectItems,
    collaborationProjectMembers,
    collaborationProjectAgents,
    collaborationProjectCounts,
    openProjectAssistant,
    advanceTaskPanelSession,
    openTaskComposer,
    boardSensors,
    clearTaskDispatchError,
    connectDingTalkBoard,
    selectedProject,
    taskOwnerUserId,
    openTaskBinding,
    selectedProjectForViewAccess,
    localProjectOptions,
    isMyTasksBoard,
    runtimeTaskStatusSignature,
    activeLocalProjectFilter,
    selectedLocalProject,
    runtimeProjectIdByTask,
    runtimeTasksByKey,
    runtimeTaskKeys,
    runtimeAddressesByWorkItem,
    runtimeTaskRunningByAddress,
    runtimeTaskByAddress,
    selectedProjectKey,
    activeAssigneeQuickAddRequest,
    activeItemTaskBindings,
    taskExecutionStatesByBindingId,
    boardTaskBindings,
    loadBoardTaskRuntimeGoal,
    localProjectIdForItem,
    personalGroupKey,
    focusExecutionColumnsKey,
    continueChangeRequestRepair,
    projectForItem,
    locateItems,
    selectedProjectAutomationSupported,
    apiForProject,
    selectedProjectServices,
    selectedProjectApi,
    selectedProjectAgentApi,
    selectedProjectChatClient,
    selectedProjectSelfManagedExecution,
    isAITableProject,
    isExternalGitBoard,
    usesSharedCloudBoard,
  }
}
export type CloudTodoWorkspaceBase = ReturnType<typeof useCloudTodoWorkspaceBase>
