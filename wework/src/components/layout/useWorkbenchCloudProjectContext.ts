import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComposerCloudMentionCandidate } from '@/components/chat/composer/composerMentionCandidates'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import {
  findProjectSpaceContextForTask,
  isDefaultWorkItemProject,
  publishProjectSpaceTaskBindingChanged,
  projectSpaceKey,
  projectSpaceRef,
  runtimeCloudProjectId,
  subscribeProjectSpaceTaskContextChanged,
  type ProjectSpaceApi,
} from '@/features/todo/projectSpaceSelection'
import {
  projectSpaceContentRoute,
  projectSpaceRouteMatchesProject,
} from '@/features/todo/projectSpaceRoute'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { truncateRuntimeTaskTitle } from '@/features/workbench/workbenchRuntimeHelpers'
import { hydrateLocalWorkItems, type LocalWorkItem } from '@/features/todo/todoModel'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import type {
  RuntimeAdditionalContext,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
} from '@/types/api'
import {
  createCloudProjectTaskRuntimeApi,
  projectTaskRuntimeApiForProject,
  rememberProjectTaskStore,
  type ProjectTaskRuntimeApi,
} from '@/features/workbench/projectTaskTracking'
import { useProjectSpaceProjects } from './useProjectSpaceProjects'
import { useTaskOriginAssociation } from './useTaskOriginAssociation'
import { useTaskGroupOwners } from './useTaskGroupOwners'

import {
  cloudItemAsLocalWorkItem,
  runtimeTaskKey,
  runtimeTaskAddressForBinding,
  executionAddressFromContext,
  pendingBindingFor,
  storePendingBinding,
  clearPendingBinding,
  pendingBindingTargetsTask,
  publishBoundProjectSpaceContext,
  waitForPendingProjectSpaceContext,
  pendingTodoForTask,
  pendingProjectForTask,
  cloudLoopItemStatusLabel,
  cloudProjectAdditionalContext,
  projectHasModelContext,
  subscribeBoundProjectSpaceContext,
  type PendingAutoJoinResolution,
  type BoundProjectSpaceContextUpdate,
} from './workbenchTaskOriginState'
export { cloudItemAsLocalWorkItem } from './workbenchTaskOriginState'

interface CloudSubmissionContext {
  additionalContext: RuntimeAdditionalContext | undefined
  cloudProjectId: string | undefined
  origin: RuntimeTaskCreateRequest['origin']
  onRuntimeTaskCreated: (address: RuntimeTaskAddress) => void
}

interface UseWorkbenchCloudProjectContextOptions {
  active: boolean
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProjectId?: number
  defaultProjectSpace: RuntimeProjectSpaceRef | null
  paneKey: string
  runtimeTaskDescription?: string
  runtimeTaskTitle: string | null
  services?: WorkbenchServices
  userId?: number
}

export function useWorkbenchCloudProjectContext({
  active: contextActive,
  currentRuntimeTask,
  currentProjectId,
  defaultProjectSpace,
  paneKey,
  runtimeTaskDescription = '',
  runtimeTaskTitle,
  services,
  userId,
}: UseWorkbenchCloudProjectContextOptions) {
  const { t } = useTranslation('common')
  const workspaceTabs = useOptionalWorkspaceTabs()
  const deliveryApi = services?.deliveryApi
  const cloudProjectSpaceApi = services?.projectSpaceApis?.cloud
  const localProjectSpaceApi = services?.projectSpaceApis?.local
  const workspaceRuntimePort = services?.workspaceRuntimePort
  const projectSpaceDataApis = useMemo(() => {
    const candidates = [localProjectSpaceApi, cloudProjectSpaceApi, deliveryApi]
    return candidates.filter(
      (api, index): api is ProjectSpaceApi => Boolean(api) && candidates.indexOf(api) === index
    )
  }, [cloudProjectSpaceApi, deliveryApi, localProjectSpaceApi])
  const todoBindingApis = useMemo(
    () =>
      [
        localProjectSpaceApi,
        workspaceRuntimePort ? createCloudProjectTaskRuntimeApi(workspaceRuntimePort) : undefined,
      ].filter((api): api is ProjectTaskRuntimeApi => Boolean(api)),
    [localProjectSpaceApi, workspaceRuntimePort]
  )
  const currentRuntimeDeviceId = currentRuntimeTask?.deviceId
  const currentRuntimeTaskId = currentRuntimeTask?.taskId
  const contextRuntimeTask = useMemo<RuntimeTaskAddress | null>(
    () =>
      currentRuntimeDeviceId && currentRuntimeTaskId
        ? {
            deviceId: currentRuntimeDeviceId,
            taskId: currentRuntimeTaskId,
          }
        : null,
    [currentRuntimeDeviceId, currentRuntimeTaskId]
  )
  const currentContextTaskKey = contextRuntimeTask ? runtimeTaskKey(contextRuntimeTask) : null
  const contextMountedRef = useRef(true)
  const currentContextTaskKeyRef = useRef(currentContextTaskKey)
  const currentRuntimeTaskRef = useRef(currentRuntimeTask)
  useLayoutEffect(() => {
    currentContextTaskKeyRef.current = currentContextTaskKey
    currentRuntimeTaskRef.current = currentRuntimeTask
  }, [currentContextTaskKey, currentRuntimeTask])
  const contextLookupGenerationRef = useRef(0)
  const contextLookupTaskKeyRef = useRef<string | null>(null)
  useEffect(
    () => () => {
      contextMountedRef.current = false
    },
    []
  )
  const pendingAutoJoinResolutionRef = useRef<PendingAutoJoinResolution | null>(null)
  const runtimeTaskTitleRef = useRef(runtimeTaskTitle)
  useEffect(() => {
    runtimeTaskTitleRef.current = runtimeTaskTitle
  }, [runtimeTaskTitle])
  const [deliveryItem, setDeliveryItem] = useState<Omit<LocalWorkItem, 'projectId'> | null>(null)
  const [boundCloudProject, setBoundCloudProject] = useState<CloudProject | null>(null)
  const [boundCloudItem, setBoundCloudItem] = useState<CloudLoopItem | null>(null)
  const [boundRuntimeTaskAddress, setBoundRuntimeTaskAddress] = useState<RuntimeTaskAddress | null>(
    null
  )
  const [contextRefreshKey, setContextRefreshKey] = useState(0)
  const [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false)
  const [pendingTodoItem, setPendingTodoItem] = useState<CloudLoopItem | null>(() =>
    pendingTodoForTask(contextRuntimeTask, paneKey)
  )
  const [pendingCloudProject, setPendingCloudProject] = useState<CloudProject | null>(() =>
    pendingProjectForTask(contextRuntimeTask, paneKey)
  )
  const [todoBindingError, setTodoBindingError] = useState<string | null>(null)
  const projectCatalog = useProjectSpaceProjects(contextActive, projectSpaceDataApis)
  const groupOwners = useTaskGroupOwners(
    contextActive,
    services?.chatGroupApis,
    String(userId ?? 'anonymous')
  )
  const cloudProjects = useMemo(() => {
    const owners = [...groupOwners, ...projectCatalog]
    return owners.filter(
      (owner, index) =>
        owners.findIndex(
          other => other.id === owner.id && other.project_store === owner.project_store
        ) === index
    )
  }, [groupOwners, projectCatalog])
  const [dismissedDefaultCloudProjectKey, setDismissedDefaultCloudProjectKey] = useState<
    string | null
  >(null)
  const [cloudActionNotice, setCloudActionNotice] = useState<string | null>(null)
  const [cloudMentionState, setCloudMentionState] = useState<{
    todoId: string
    candidates: ComposerCloudMentionCandidate[]
  } | null>(null)

  const composerCloudProject = contextRuntimeTask ? boundCloudProject : pendingCloudProject
  const composerTodoItem = contextRuntimeTask ? boundCloudItem : pendingTodoItem
  const defaultCloudProjectSelectionKey = `${paneKey}:${currentProjectId ?? 'none'}`
  const defaultWorkItemProject = useMemo(
    () => cloudProjects.find(isDefaultWorkItemProject) ?? null,
    [cloudProjects]
  )
  const defaultProject = useMemo(() => {
    if (dismissedDefaultCloudProjectKey === defaultCloudProjectSelectionKey) {
      return defaultWorkItemProject
    }
    return defaultProjectSpace
      ? (cloudProjects.find(
          project =>
            projectSpaceKey(projectSpaceRef(project)) === projectSpaceKey(defaultProjectSpace)
        ) ?? null)
      : (cloudProjects.find(isDefaultWorkItemProject) ?? null)
  }, [
    cloudProjects,
    defaultCloudProjectSelectionKey,
    defaultProjectSpace,
    defaultWorkItemProject,
    dismissedDefaultCloudProjectKey,
  ])
  const defaultProjectOptionKey = defaultProject
    ? projectSpaceKey(projectSpaceRef(defaultProject))
    : null
  const cloudAdditionalContext = useMemo(
    () => cloudProjectAdditionalContext(composerCloudProject, composerTodoItem),
    [composerCloudProject, composerTodoItem]
  )

  const setPendingCloudContext = useCallback(
    (project: CloudProject | null, item: CloudLoopItem | null) => {
      const currentBinding = pendingBindingFor(contextRuntimeTask, paneKey)
      if (currentBinding) clearPendingBinding(currentBinding)
      if (project) {
        storePendingBinding({
          paneKey,
          project,
          item,
          target: null,
          description: '',
        })
      }
      setPendingCloudProject(project)
      setPendingTodoItem(item)
    },
    [contextRuntimeTask, paneKey]
  )

  useEffect(() => {
    if (!contextRuntimeTask) return
    const handleBoundContext = (update: BoundProjectSpaceContextUpdate) => {
      if (
        update.task.deviceId !== contextRuntimeTask.deviceId ||
        update.task.taskId !== contextRuntimeTask.taskId
      ) {
        return
      }
      contextLookupGenerationRef.current += 1
      setBoundCloudProject(update.project)
      setBoundCloudItem(update.item)
      setDeliveryItem(cloudItemAsLocalWorkItem(update.item, contextRuntimeTask))
      setPendingCloudContext(null, null)
      setContextRefreshKey(current => current + 1)
    }
    return subscribeBoundProjectSpaceContext(handleBoundContext)
  }, [contextRuntimeTask, setPendingCloudContext])

  useEffect(() => {
    if (!contextRuntimeTask) return
    return subscribeProjectSpaceTaskContextChanged(({ task }) => {
      if (
        task.deviceId !== contextRuntimeTask.deviceId ||
        task.taskId !== contextRuntimeTask.taskId
      ) {
        return
      }
      setContextRefreshKey(current => current + 1)
    })
  }, [contextRuntimeTask])

  const projectSpaceApiFor = useCallback(
    (project: CloudProject): NonNullable<WorkbenchServices['deliveryApi']> | undefined =>
      project.project_store === 'local' || project.task_provider === 'dingtalk_aitable'
        ? (services?.projectSpaceApis?.local ?? services?.deliveryApi)
        : (services?.projectSpaceApis?.cloud ?? services?.deliveryApi),
    [services?.deliveryApi, services?.projectSpaceApis?.cloud, services?.projectSpaceApis?.local]
  )
  const boundProjectSpaceApi = boundCloudProject ? projectSpaceApiFor(boundCloudProject) : undefined
  useEffect(() => {
    let active = true
    const lookupGeneration = contextLookupGenerationRef.current + 1
    contextLookupGenerationRef.current = lookupGeneration
    if (!contextRuntimeTask) {
      contextLookupTaskKeyRef.current = null
      queueMicrotask(() => {
        if (!active) return
        setBoundCloudItem(null)
        setBoundCloudProject(null)
        setBoundRuntimeTaskAddress(null)
        setDeliveryItem(null)
      })
      return () => {
        active = false
      }
    }
    const contextTaskKey = `${contextRuntimeTask.deviceId}:${contextRuntimeTask.taskId}`
    if (contextLookupTaskKeyRef.current !== contextTaskKey) {
      contextLookupTaskKeyRef.current = contextTaskKey
      setBoundCloudItem(null)
      setBoundCloudProject(null)
      setBoundRuntimeTaskAddress(null)
      setDeliveryItem(null)
    }
    if (!contextActive) {
      return () => {
        active = false
      }
    }
    const contextApis = todoBindingApis
    if (contextApis.length > 0) {
      const lookupStartedAt = performance.now()
      void waitForPendingProjectSpaceContext(contextApis, contextRuntimeTask, () => active)
        .then(context => {
          logRuntimeTaskCreateStage('project-space-context-resolved', {
            taskId: contextRuntimeTask.taskId,
            deviceId: contextRuntimeTask.deviceId,
            projectId: context.project.id,
            itemId: context.loop_item?.id ?? null,
            elapsedMs: Math.round(performance.now() - lookupStartedAt),
            applied: active && contextLookupGenerationRef.current === lookupGeneration,
          })
          if (!active || contextLookupGenerationRef.current !== lookupGeneration) return
          if (rememberProjectTaskStore(contextRuntimeTask, context.project.project_store)) {
            publishProjectSpaceTaskBindingChanged({
              task: contextRuntimeTask,
              project: projectSpaceRef(context.project),
              type: 'bound',
            })
          }
          setBoundCloudProject(context.project)
          setBoundCloudItem(context.loop_item)
          setBoundRuntimeTaskAddress(
            executionAddressFromContext(
              currentRuntimeTaskRef.current ?? contextRuntimeTask,
              context
            )
          )
          setDeliveryItem(
            context.loop_item
              ? cloudItemAsLocalWorkItem(context.loop_item, contextRuntimeTask)
              : null
          )
          if (pendingBindingTargetsTask(contextRuntimeTask)) {
            const pendingBinding = pendingBindingFor(contextRuntimeTask, paneKey)
            if (pendingBinding) clearPendingBinding(pendingBinding)
            setPendingCloudContext(null, null)
          }
        })
        .catch(error => {
          if (!active || contextLookupGenerationRef.current !== lookupGeneration) return
          logRuntimeTaskCreateStage('project-space-context-failed', {
            taskId: contextRuntimeTask.taskId,
            deviceId: contextRuntimeTask.deviceId,
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: Math.round(performance.now() - lookupStartedAt),
            causes:
              error instanceof AggregateError
                ? error.errors.map(cause =>
                    cause instanceof Error ? cause.message : String(cause)
                  )
                : undefined,
          })
          console.warn('[Wework] Failed to resolve project-space context for task', {
            task: contextRuntimeTask,
            error,
          })
        })
      return () => {
        active = false
      }
    }
    void hydrateLocalWorkItems(userId)
      .then(items => {
        if (!active) return
        setBoundCloudItem(null)
        setDeliveryItem(
          items.find(item =>
            item.runtimeRefs.some(
              reference =>
                reference.taskId === contextRuntimeTask.taskId &&
                reference.deviceId === contextRuntimeTask.deviceId
            )
          ) ?? null
        )
      })
      .catch(() => {
        if (active) {
          setBoundCloudItem(null)
          setDeliveryItem(null)
        }
      })
    return () => {
      active = false
    }
  }, [
    contextActive,
    contextRefreshKey,
    contextRuntimeTask,
    paneKey,
    setPendingCloudContext,
    todoBindingApis,
    userId,
  ])

  useEffect(() => {
    const pendingBinding = pendingBindingFor(contextRuntimeTask, paneKey)
    const projectToBind = pendingCloudProject ?? pendingBinding?.project ?? null
    const itemToBind = pendingTodoItem ?? pendingBinding?.item ?? null
    if (!contextRuntimeTask || !projectToBind) return
    if (
      pendingBinding?.target &&
      (pendingBinding.target.deviceId !== contextRuntimeTask.deviceId ||
        pendingBinding.target.taskId !== contextRuntimeTask.taskId)
    ) {
      return
    }
    const api = projectTaskRuntimeApiForProject(services, projectToBind)
    if (!api) return
    if (isDefaultWorkItemProject(projectToBind) && !itemToBind) {
      return
    }
    const bindingTaskTitle =
      runtimeTaskTitleRef.current ||
      truncateRuntimeTaskTitle(pendingBinding?.description) ||
      t('workbench.untitled_task', '未命名任务')
    const taskForBinding = runtimeTaskAddressForBinding(
      contextRuntimeTask,
      currentRuntimeTaskRef.current
    )
    let active = true
    const bindingRequest = itemToBind
      ? api
          .bindTask(itemToBind.id, taskForBinding, bindingTaskTitle)
          .then(() => ({ item: itemToBind }))
      : api.trackProjectTask(
          projectToBind.id,
          taskForBinding,
          bindingTaskTitle,
          pendingBinding?.description ?? ''
        )
    void bindingRequest
      .then(({ item }) => {
        const bindingTaskKey = `${contextRuntimeTask.deviceId}:${contextRuntimeTask.taskId}`
        publishBoundProjectSpaceContext({
          task: contextRuntimeTask,
          project: projectToBind,
          item,
        })
        if (
          !active ||
          !contextMountedRef.current ||
          contextLookupTaskKeyRef.current !== bindingTaskKey
        ) {
          return
        }
        contextLookupGenerationRef.current += 1
        setBoundCloudProject(projectToBind)
        setBoundCloudItem(item)
        setDeliveryItem(cloudItemAsLocalWorkItem(item, contextRuntimeTask))
        setContextRefreshKey(current => current + 1)
        setPendingCloudContext(null, null)
      })
      .catch(cause => {
        if (!active) return
        setTodoBindingError(
          cause instanceof Error
            ? cause.message
            : t('workbench.cloud_project_bind_failed', '关联项目空间失败')
        )
      })
    return () => {
      active = false
    }
  }, [
    contextRuntimeTask,
    paneKey,
    pendingCloudProject,
    pendingTodoItem,
    services,
    setPendingCloudContext,
    t,
  ])

  useEffect(() => {
    let active = true
    if (!composerCloudProject) {
      return () => {
        active = false
      }
    }
    const api = projectSpaceApiFor(composerCloudProject)
    if (!api) {
      return () => {
        active = false
      }
    }
    const projectId = composerCloudProject.id
    void Promise.all([
      api.listCloudFiles(projectId),
      api.listLoopItems(projectId),
      composerTodoItem ? api.listDeliveries(composerTodoItem.id) : Promise.resolve({ items: [] }),
    ])
      .then(([files, items, deliveries]) => {
        if (!active) return
        const candidate = (
          key: string,
          title: string,
          description: string,
          reference: string,
          aliases: string[],
          statusLabel?: string
        ): ComposerCloudMentionCandidate => ({
          kind: 'cloud',
          key,
          title,
          description,
          metaLabel: t('workbench.mention_cloud_space', '云空间'),
          testId: key.replace(/[^a-zA-Z0-9_-]/g, '-'),
          enabled: true,
          reference,
          searchAliases: aliases,
          statusLabel,
        })
        setCloudMentionState({
          todoId: composerTodoItem?.id ?? `project:${projectId}`,
          candidates: [
            candidate(
              `cloud-project:${projectId}`,
              t('workbench.mention_cloud_whole_space', '整个空间'),
              t('workbench.mention_cloud_whole_space_description', '共享文件 + 看板全部内容'),
              `[$${t('workbench.mention_cloud_whole_space', '整个空间')}](cloud://projects/${projectId})`,
              ['云项目', 'cloud', 'workspace']
            ),
            ...items.items.map(item =>
              candidate(
                `cloud-todo:${item.id}`,
                item.id,
                item.title,
                `[$${t('workbench.mention_cloud_todo_chip', '任务')}:${item.id}](cloud://projects/${projectId}/todos/${item.id})`,
                [item.title, item.status, 'TODO', '任务'],
                cloudLoopItemStatusLabel(item.status, t)
              )
            ),
            ...files.items.map(file =>
              candidate(
                `cloud-file:${file.id}`,
                file.name,
                file.path,
                `[$${file.name}](cloud://projects/${projectId}/files/${file.id})`,
                [file.path, file.kind, '文件', '目录']
              )
            ),
            ...deliveries.items.map(delivery =>
              candidate(
                `cloud-delivery:${delivery.id}`,
                `交付 ${delivery.id.slice(0, 8)}`,
                delivery.delivered_at ?? delivery.created_at,
                `[$交付 ${delivery.id.slice(0, 8)}](cloud://projects/${projectId}/deliveries/${delivery.id})`,
                ['交付', 'delivery', delivery.id]
              )
            ),
          ],
        })
      })
      .catch(() => {
        if (active) setCloudMentionState(null)
      })
    return () => {
      active = false
    }
  }, [composerCloudProject, composerTodoItem, projectSpaceApiFor, t])

  const visibleCloudMentionCandidates =
    composerCloudProject &&
    cloudMentionState?.todoId === (composerTodoItem?.id ?? `project:${composerCloudProject.id}`)
      ? cloudMentionState.candidates
      : []

  useEffect(() => {
    const pendingAutoJoin = pendingAutoJoinResolutionRef.current
    const pendingTargetMatchesCurrentTask =
      pendingAutoJoin?.target &&
      contextRuntimeTask &&
      pendingAutoJoin.target.deviceId === contextRuntimeTask.deviceId &&
      pendingAutoJoin.target.taskId === contextRuntimeTask.taskId
    if (
      defaultProject &&
      !pendingCloudProject &&
      dismissedDefaultCloudProjectKey !== defaultCloudProjectSelectionKey &&
      (!contextRuntimeTask || pendingTargetMatchesCurrentTask)
    ) {
      storePendingBinding({
        paneKey,
        project: defaultProject,
        item: null,
        target: pendingAutoJoin?.target ?? null,
        description: pendingAutoJoin?.description ?? '',
      })
      pendingAutoJoinResolutionRef.current = null
      setPendingCloudProject(defaultProject)
      setPendingTodoItem(null)
    }
  }, [
    contextRuntimeTask,
    defaultCloudProjectSelectionKey,
    defaultProject,
    dismissedDefaultCloudProjectKey,
    paneKey,
    pendingCloudProject,
  ])

  const cloudProjectMentionCandidates = useMemo<ComposerCloudMentionCandidate[]>(
    () =>
      projectCatalog.map(project => {
        const spaceLabel = t('workbench.mention_cloud_project_space', '项目空间')
        return {
          kind: 'cloud',
          key: `cloud-project-space:${project.id}`,
          title: project.name,
          description: project.description || project.project_key || undefined,
          statusLabel:
            projectSpaceKey(projectSpaceRef(project)) === defaultProjectOptionKey
              ? t('workbench.project_space_auto_join', '自动加入')
              : undefined,
          metaLabel: t('workbench.mention_cloud_space', '云空间'),
          testId: `cloud-project-space-${String(project.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
          enabled: true,
          reference: `[$${spaceLabel}:${project.name}](cloud://projects/${project.id})`,
          searchAliases: [
            project.name,
            project.project_key,
            project.description,
            spaceLabel,
            'project space',
            'project-space',
            'cloud',
          ].filter(alias => Boolean(alias)),
          project,
        }
      }),
    [projectCatalog, defaultProjectOptionKey, t]
  )

  const onOriginBound = useCallback((update: BoundProjectSpaceContextUpdate) => {
    publishBoundProjectSpaceContext(update)
    setBoundCloudProject(update.project)
    setBoundCloudItem(update.item)
    setDeliveryItem(cloudItemAsLocalWorkItem(update.item, update.task))
  }, [])
  const onLinkRecoveryFailed = useCallback(() => {
    contextLookupGenerationRef.current += 1
    setBoundCloudProject(null)
    setBoundCloudItem(null)
    setBoundRuntimeTaskAddress(null)
    setDeliveryItem(null)
  }, [])
  const {
    taskBoardAssociation,
    handleSelectCloudProject,
    closeTaskBoardAssociation,
    associateRuntimeTaskWithNewItem,
    associateRuntimeTaskWithExistingItem,
    closeTaskOriginCreation,
    associateCreatedTaskOrigin,
    taskOriginCreation,
    openTaskOriginCreation,
    taskOriginJoinRequest,
    cancelTaskOriginJoin,
    confirmTaskOriginJoin,
    scopeKey: taskOriginScopeKey,
  } = useTaskOriginAssociation({
    accountScope: String(userId ?? 'anonymous'),
    paneKey,
    contextRuntimeTask,
    currentRuntimeTaskRef,
    boundProject: boundCloudProject,
    boundItem: boundCloudItem,
    services,
    runtimeTaskTitle,
    runtimeTaskDescription,
    projectSpaceApiFor,
    setPendingCloudContext,
    setDismissedDefaultCloudProjectKey,
    setTodoBindingError,
    setCloudActionNotice,
    onBound: onOriginBound,
    onLinkRecoveryFailed,
  })

  const activeDeliveryItem =
    contextRuntimeTask &&
    deliveryItem?.runtimeRefs.some(
      reference =>
        reference.taskId === contextRuntimeTask.taskId &&
        reference.deviceId === contextRuntimeTask.deviceId
    )
      ? deliveryItem
      : null
  const openBoundProjectSpaceTask = useCallback(() => {
    if (!boundCloudProject || !boundCloudItem) return
    const projectRef = projectSpaceRef(boundCloudProject)
    const contentRoute = projectSpaceContentRoute(projectRef, boundCloudItem.id)
    if (workspaceTabs) {
      const existingBoardTab = workspaceTabs.tabs.find(
        tab =>
          tab.kind === 'board' &&
          !tab.fixed &&
          projectSpaceRouteMatchesProject(tab.contentRoute, projectRef)
      )
      if (existingBoardTab) {
        workspaceTabs.selectTab(existingBoardTab.id, {
          title: boundCloudProject.name,
          contentRoute,
        })
        return
      }
      workspaceTabs.openTab('board', {
        title: boundCloudProject.name,
        contentRoute,
      })
      return
    }
    navigateTo(contentRoute)
  }, [boundCloudItem, boundCloudProject, workspaceTabs])

  const finishDelivery = useCallback(() => {
    setDeliveryDialogOpen(false)
    openBoundProjectSpaceTask()
  }, [openBoundProjectSpaceTask])

  const prepareSubmission = useCallback(
    async (description: string): Promise<CloudSubmissionContext> => {
      let refreshedCloudAdditionalContext = cloudAdditionalContext
      let refreshedCloudProject = boundCloudProject
      let refreshedCloudItem = boundCloudItem
      if (contextRuntimeTask && todoBindingApis.length > 0) {
        const refreshTaskKey = runtimeTaskKey(contextRuntimeTask)
        const refreshGeneration = contextLookupGenerationRef.current + 1
        contextLookupGenerationRef.current = refreshGeneration
        try {
          const context = await findProjectSpaceContextForTask(todoBindingApis, contextRuntimeTask)
          if (
            contextMountedRef.current &&
            currentContextTaskKeyRef.current === refreshTaskKey &&
            contextLookupGenerationRef.current === refreshGeneration
          ) {
            setBoundCloudProject(context.project)
            setBoundCloudItem(context.loop_item)
            setDeliveryItem(
              context.loop_item
                ? cloudItemAsLocalWorkItem(context.loop_item, contextRuntimeTask)
                : null
            )
          }
          refreshedCloudProject = context.project
          refreshedCloudItem = context.loop_item
          refreshedCloudAdditionalContext = cloudProjectAdditionalContext(
            context.project,
            context.loop_item
          )
        } catch (error) {
          console.warn('[Wework] Failed to refresh project-space context before send', {
            task: contextRuntimeTask,
            error,
          })
          refreshedCloudAdditionalContext = cloudAdditionalContext
        }
      }
      let submissionProject = contextRuntimeTask ? refreshedCloudProject : pendingCloudProject
      if (
        !contextRuntimeTask &&
        !submissionProject &&
        dismissedDefaultCloudProjectKey !== defaultCloudProjectSelectionKey
      ) {
        submissionProject = defaultProject
      }
      if (!contextRuntimeTask && !submissionProject) submissionProject = defaultWorkItemProject
      const submissionItem = contextRuntimeTask
        ? refreshedCloudItem
        : submissionProject
          ? pendingTodoItem
          : null
      const submissionHasModelContext = projectHasModelContext(submissionProject, submissionItem)
      if (!contextRuntimeTask) {
        setPendingCloudContext(submissionProject, submissionItem)
        pendingAutoJoinResolutionRef.current =
          !submissionProject &&
          dismissedDefaultCloudProjectKey !== defaultCloudProjectSelectionKey &&
          todoBindingApis.length > 0
            ? { target: null, description }
            : null
      }
      const pendingBinding = pendingBindingFor(contextRuntimeTask, paneKey)
      if (pendingBinding) {
        storePendingBinding({ ...pendingBinding, description })
      }
      return {
        additionalContext:
          cloudProjectAdditionalContext(submissionProject, submissionItem) ??
          refreshedCloudAdditionalContext,
        cloudProjectId: submissionHasModelContext
          ? runtimeCloudProjectId(submissionProject)
          : undefined,
        origin:
          submissionHasModelContext &&
          submissionProject &&
          submissionItem &&
          !isDefaultWorkItemProject(submissionProject)
            ? {
                type: 'board_task',
                projectStore: submissionProject.project_store,
                cloudProjectId: submissionProject.id,
                loopItemId: submissionItem.id,
              }
            : undefined,
        onRuntimeTaskCreated: address => {
          const pendingBinding = pendingBindingFor(null, paneKey)
          if (pendingBinding) {
            storePendingBinding({ ...pendingBinding, target: address })
          }
          if (pendingAutoJoinResolutionRef.current) {
            pendingAutoJoinResolutionRef.current = {
              ...pendingAutoJoinResolutionRef.current,
              target: address,
            }
          }
        },
      }
    },
    [
      boundCloudItem,
      boundCloudProject,
      cloudAdditionalContext,
      contextRuntimeTask,
      defaultCloudProjectSelectionKey,
      defaultProject,
      defaultWorkItemProject,
      dismissedDefaultCloudProjectKey,
      pendingCloudProject,
      pendingTodoItem,
      paneKey,
      setPendingCloudContext,
      todoBindingApis,
    ]
  )

  const clearPendingProjectContext = useCallback(() => {
    pendingAutoJoinResolutionRef.current = null
    setDismissedDefaultCloudProjectKey(defaultCloudProjectSelectionKey)
    setPendingCloudContext(null, null)
  }, [defaultCloudProjectSelectionKey, setPendingCloudContext])

  const openDelivery = useCallback(() => {
    if (activeDeliveryItem) setDeliveryDialogOpen(true)
  }, [activeDeliveryItem])

  const clearCloudActionNotice = useCallback(() => setCloudActionNotice(null), [])
  const clearTodoBindingError = useCallback(() => setTodoBindingError(null), [])
  const closeDeliveryDialog = useCallback(() => setDeliveryDialogOpen(false), [])

  const handleTodoBound = useCallback(
    (project: CloudProject | null, item: CloudLoopItem | null) => {
      if (!contextRuntimeTask) {
        setPendingCloudContext(project, item)
        return
      }
      setBoundCloudProject(project)
      setBoundCloudItem(item)
      setDeliveryItem(item ? cloudItemAsLocalWorkItem(item, contextRuntimeTask) : null)
    },
    [contextRuntimeTask, setPendingCloudContext]
  )

  const removeCloudProjectContext = useCallback(() => {
    if (!contextRuntimeTask) {
      clearPendingProjectContext()
      return
    }
    if (!boundCloudProject) return
    const api = projectTaskRuntimeApiForProject(services, boundCloudProject)
    if (!api) return
    void api
      .unbindCloudContext(contextRuntimeTask)
      .then(() => {
        publishProjectSpaceTaskBindingChanged({
          task: contextRuntimeTask,
          project: projectSpaceRef(boundCloudProject),
          type: 'unbound',
        })
        setBoundCloudProject(null)
        setBoundCloudItem(null)
        setDeliveryItem(null)
      })
      .catch(cause => {
        setTodoBindingError(
          cause instanceof Error
            ? cause.message
            : t('workbench.cloud_project_unbind_failed', '从工作空间移除失败')
        )
      })
  }, [boundCloudProject, clearPendingProjectContext, contextRuntimeTask, services, t])

  return {
    activeDeliveryItem,
    boundCloudItem,
    boundCloudProject,
    boundRuntimeTaskAddress,
    boundProjectSpaceApi,
    clearCloudActionNotice,
    clearPendingProjectContext,
    clearTodoBindingError,
    closeDeliveryDialog,
    cloudActionNotice,
    cloudProjects,
    cloudProjectMentionCandidates,
    composerCloudProject,
    defaultProject,
    deliveryDialogOpen,
    finishDelivery,
    handleSelectCloudProject,
    handleTodoBound,
    openDelivery,
    openBoundProjectSpaceTask,
    pendingCloudProject,
    pendingTodoItem,
    prepareSubmission,
    removeCloudProjectContext,
    taskBoardAssociation,
    closeTaskBoardAssociation,
    associateRuntimeTaskWithNewItem,
    closeTaskOriginCreation,
    associateCreatedTaskOrigin,
    taskOriginCreation,
    openTaskOriginCreation,
    taskOriginJoinRequest,
    cancelTaskOriginJoin,
    confirmTaskOriginJoin,
    taskOriginScopeKey,
    associateRuntimeTaskWithExistingItem,
    todoBindingError,
    visibleCloudMentionCandidates,
  }
}
