import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComposerCloudMentionCandidate } from '@/components/chat/composer/composerMentionCandidates'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import {
  findProjectSpaceContextForTask,
  projectSpaceApis,
  projectSpaceKey,
  projectSpaceRef,
  runtimeCloudProjectId,
} from '@/features/todo/projectSpaceSelection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { truncateRuntimeTaskTitle } from '@/features/workbench/workbenchRuntimeHelpers'
import {
  hydrateLocalWorkItems,
  loadLocalWorkItems,
  saveLocalWorkItems,
  type LocalWorkItem,
} from '@/features/todo/todoModel'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type {
  RuntimeAdditionalContext,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
} from '@/types/api'

interface PendingTodoBinding {
  project: CloudProject
  item: CloudLoopItem | null
  target: RuntimeTaskAddress | null
  description: string
}

interface PendingAutoJoinResolution {
  target: RuntimeTaskAddress | null
  description: string
}

interface CloudSubmissionContext {
  additionalContext: RuntimeAdditionalContext | undefined
  cloudProjectId: string | undefined
  onRuntimeTaskCreated: (address: RuntimeTaskAddress) => void
}

interface UseWorkbenchCloudProjectContextOptions {
  active: boolean
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProjectId?: number
  defaultProjectSpace: RuntimeProjectSpaceRef | null
  paneKey: string
  runtimeTaskTitle: string | null
  services?: WorkbenchServices
  userId?: number
}

let pendingTodoBinding: PendingTodoBinding | null = null

function pendingTodoForTask(address: RuntimeTaskAddress | null) {
  if (!pendingTodoBinding) return null
  if (!address) return pendingTodoBinding.target ? null : pendingTodoBinding.item
  const target = pendingTodoBinding.target
  return target?.deviceId === address.deviceId && target.taskId === address.taskId
    ? pendingTodoBinding.item
    : null
}

function pendingProjectForTask(address: RuntimeTaskAddress | null) {
  if (!pendingTodoBinding) return null
  if (!address) return pendingTodoBinding.target ? null : pendingTodoBinding.project
  const target = pendingTodoBinding.target
  return target?.deviceId === address.deviceId && target.taskId === address.taskId
    ? pendingTodoBinding.project
    : null
}

function cloudLoopItemStatusLabel(
  status: CloudLoopItem['status'],
  t: ReturnType<typeof useTranslation>['t']
): string {
  switch (status) {
    case 'inbox':
      return t('workbench.cloud_todo_status_inbox', '收集箱')
    case 'pending':
      return t('workbench.cloud_todo_status_pending', '待处理')
    case 'in_progress':
      return t('workbench.cloud_todo_status_in_progress', '进行中')
    case 'in_review':
      return t('workbench.cloud_todo_status_in_review', '待评审')
    case 'completed':
      return t('workbench.cloud_todo_status_completed', '已完成')
  }
  return ''
}

export function cloudItemAsLocalWorkItem(
  item: CloudLoopItem,
  runtimeTask: RuntimeTaskAddress
): Omit<LocalWorkItem, 'projectId'> {
  return {
    id: item.id,
    title: item.title,
    objective: '',
    description: item.description,
    state:
      item.status === 'completed'
        ? 'completed'
        : item.status === 'in_review'
          ? 'review'
          : item.status === 'in_progress'
            ? 'started'
            : 'backlog',
    assignee: item.assignee_user_id
      ? { type: 'human', id: String(item.assignee_user_id) }
      : { type: 'unassigned' },
    collaborators: [],
    blocker: '',
    nextAction: '',
    priority: item.priority === 'medium' ? 'normal' : item.priority,
    attachments: [],
    runtimeRefs: [runtimeTask],
    events: [],
    sortOrder: item.sort_order,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }
}

function cloudProjectAdditionalContext(
  project: CloudProject | null,
  item: CloudLoopItem | null
): RuntimeAdditionalContext | undefined {
  if (!project) return undefined
  const projectReference = `cloud://projects/${project.id}`
  const todoReference = item ? `${projectReference}/todos/${item.id}` : null
  const scope = item
    ? [
        `Current cloud project: ${project.name} (id=${project.id}).`,
        `Current task: ${item.id} — ${item.title}.`,
        item.description ? `Task description: ${item.description}` : null,
        `Current task reference: ${todoReference}.`,
      ]
    : [
        `Current cloud project: ${project.name} (id=${project.id}).`,
        'No specific task is selected.',
        `Current project reference: ${projectReference}.`,
      ]
  return {
    cloudCollaboration: {
      kind: 'application',
      value: [
        ...scope.filter((line): line is string => Boolean(line)),
        'When the user refers to “this project” or “this task”, use this current cloud context.',
        'Use the wegent_delivery MCP tools to inspect task details, shared files, and deliveries when needed. Do not ask for an id that is already provided here.',
      ].join('\n'),
    },
  }
}

export function useWorkbenchCloudProjectContext({
  active: contextActive,
  currentRuntimeTask,
  currentProjectId,
  defaultProjectSpace,
  paneKey,
  runtimeTaskTitle,
  services,
  userId,
}: UseWorkbenchCloudProjectContextOptions) {
  const { t } = useTranslation('common')
  const workspaceTabs = useOptionalWorkspaceTabs()
  const todoBindingApis = useMemo(() => projectSpaceApis(services), [services])
  const pendingAutoJoinResolutionRef = useRef<PendingAutoJoinResolution | null>(null)
  const [deliveryItem, setDeliveryItem] = useState<Omit<LocalWorkItem, 'projectId'> | null>(null)
  const [boundCloudProject, setBoundCloudProject] = useState<CloudProject | null>(null)
  const [boundCloudItem, setBoundCloudItem] = useState<CloudLoopItem | null>(null)
  const [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false)
  const [todoBindingPickerOpen, setTodoBindingPickerOpen] = useState(false)
  const [deliverAfterBinding, setDeliverAfterBinding] = useState(false)
  const [pendingTodoItem, setPendingTodoItem] = useState<CloudLoopItem | null>(() =>
    pendingTodoForTask(currentRuntimeTask)
  )
  const [pendingCloudProject, setPendingCloudProject] = useState<CloudProject | null>(() =>
    pendingProjectForTask(currentRuntimeTask)
  )
  const [todoBindingError, setTodoBindingError] = useState<string | null>(null)
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([])
  const [dismissedDefaultCloudProjectKey, setDismissedDefaultCloudProjectKey] = useState<
    string | null
  >(null)
  const [cloudActionNotice, setCloudActionNotice] = useState<string | null>(null)
  const [cloudMentionState, setCloudMentionState] = useState<{
    todoId: string
    candidates: ComposerCloudMentionCandidate[]
  } | null>(null)

  const composerCloudProject = currentRuntimeTask ? boundCloudProject : pendingCloudProject
  const composerTodoItem = currentRuntimeTask ? boundCloudItem : pendingTodoItem
  const defaultCloudProjectSelectionKey = `${paneKey}:${currentProjectId ?? 'none'}`
  const defaultProject = useMemo(
    () =>
      defaultProjectSpace
        ? (cloudProjects.find(
            project =>
              projectSpaceKey(projectSpaceRef(project)) === projectSpaceKey(defaultProjectSpace)
          ) ?? null)
        : null,
    [cloudProjects, defaultProjectSpace]
  )
  const defaultProjectOptionKey = defaultProject
    ? projectSpaceKey(projectSpaceRef(defaultProject))
    : null
  const cloudAdditionalContext = useMemo(
    () => cloudProjectAdditionalContext(composerCloudProject, composerTodoItem),
    [composerCloudProject, composerTodoItem]
  )

  const setPendingCloudContext = useCallback(
    (project: CloudProject | null, item: CloudLoopItem | null) => {
      pendingTodoBinding = project ? { project, item, target: null, description: '' } : null
      setPendingCloudProject(project)
      setPendingTodoItem(item)
    },
    []
  )

  const projectSpaceApiFor = useCallback(
    (project: CloudProject): NonNullable<WorkbenchServices['deliveryApi']> | undefined =>
      project.project_store === 'local' || project.task_provider === 'dingtalk_aitable'
        ? (services?.projectSpaceApis?.local ?? services?.deliveryApi)
        : (services?.projectSpaceApis?.cloud ?? services?.deliveryApi),
    [services?.deliveryApi, services?.projectSpaceApis?.cloud, services?.projectSpaceApis?.local]
  )

  useEffect(() => {
    let active = true
    if (!currentRuntimeTask) {
      queueMicrotask(() => {
        if (!active) return
        setBoundCloudItem(null)
        setBoundCloudProject(null)
        setDeliveryItem(null)
      })
      return () => {
        active = false
      }
    }
    const contextApis = todoBindingApis
    if (contextApis.length > 0) {
      void findProjectSpaceContextForTask(contextApis, currentRuntimeTask)
        .then(context => {
          if (!active) return
          setBoundCloudProject(context.project)
          setBoundCloudItem(context.loop_item)
          setDeliveryItem(
            context.loop_item
              ? cloudItemAsLocalWorkItem(context.loop_item, currentRuntimeTask)
              : null
          )
        })
        .catch(() => {
          if (active) {
            setBoundCloudItem(null)
            setBoundCloudProject(null)
            setDeliveryItem(null)
          }
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
                reference.taskId === currentRuntimeTask.taskId &&
                reference.deviceId === currentRuntimeTask.deviceId
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
  }, [currentRuntimeTask, todoBindingApis, userId])

  useEffect(() => {
    const projectToBind = pendingCloudProject ?? pendingTodoBinding?.project ?? null
    const itemToBind = pendingTodoItem ?? pendingTodoBinding?.item ?? null
    if (!currentRuntimeTask || !projectToBind) return
    const pendingBinding = pendingTodoBinding
    if (
      pendingBinding?.target &&
      (pendingBinding.target.deviceId !== currentRuntimeTask.deviceId ||
        pendingBinding.target.taskId !== currentRuntimeTask.taskId)
    ) {
      return
    }
    const api = projectSpaceApiFor(projectToBind)
    if (!api) return
    const bindingTaskTitle =
      runtimeTaskTitle ||
      truncateRuntimeTaskTitle(pendingBinding?.description) ||
      t('workbench.untitled_task', '未命名任务')
    let active = true
    const bindingRequest = itemToBind
      ? api
          .bindTask(itemToBind.id, currentRuntimeTask, bindingTaskTitle)
          .then(() => ({ item: itemToBind }))
      : api.trackProjectTask(
          projectToBind.id,
          currentRuntimeTask,
          bindingTaskTitle,
          pendingBinding?.description ?? ''
        )
    void bindingRequest
      .then(({ item }) => {
        if (!active) return
        setBoundCloudProject(projectToBind)
        setBoundCloudItem(item)
        setDeliveryItem(cloudItemAsLocalWorkItem(item, currentRuntimeTask))
        pendingTodoBinding = null
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
    currentRuntimeTask,
    pendingCloudProject,
    pendingTodoItem,
    projectSpaceApiFor,
    runtimeTaskTitle,
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
    if (!contextActive) return
    let active = true
    const apis = todoBindingApis
    if (!apis.length) {
      queueMicrotask(() => {
        if (active) setCloudProjects([])
      })
      return () => {
        active = false
      }
    }
    void Promise.allSettled(
      apis.map(async api => {
        const result = await api.listCloudProjects()
        return result.items
      })
    ).then(results => {
      if (!active) return
      const candidates = results.flatMap(result =>
        result.status === 'fulfilled' ? result.value : []
      )
      const uniqueProjects = candidates.filter(
        (candidate, index) =>
          candidates.findIndex(
            other => other.id === candidate.id && other.project_store === candidate.project_store
          ) === index
      )
      setCloudProjects(uniqueProjects)
    })
    return () => {
      active = false
    }
  }, [contextActive, todoBindingApis])

  useEffect(() => {
    const pendingAutoJoin = pendingAutoJoinResolutionRef.current
    const pendingTargetMatchesCurrentTask =
      pendingAutoJoin?.target &&
      currentRuntimeTask &&
      pendingAutoJoin.target.deviceId === currentRuntimeTask.deviceId &&
      pendingAutoJoin.target.taskId === currentRuntimeTask.taskId
    if (
      defaultProject &&
      !pendingCloudProject &&
      dismissedDefaultCloudProjectKey !== defaultCloudProjectSelectionKey &&
      (!currentRuntimeTask || pendingTargetMatchesCurrentTask)
    ) {
      pendingTodoBinding = {
        project: defaultProject,
        item: null,
        target: pendingAutoJoin?.target ?? null,
        description: pendingAutoJoin?.description ?? '',
      }
      pendingAutoJoinResolutionRef.current = null
      setPendingCloudProject(defaultProject)
      setPendingTodoItem(null)
    } else if (!defaultProject && pendingAutoJoin) {
      pendingAutoJoinResolutionRef.current = null
    }
  }, [
    currentRuntimeTask,
    defaultCloudProjectSelectionKey,
    defaultProject,
    dismissedDefaultCloudProjectKey,
    pendingCloudProject,
  ])

  const cloudProjectMentionCandidates = useMemo<ComposerCloudMentionCandidate[]>(
    () =>
      cloudProjects.map(project => {
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
    [cloudProjects, defaultProjectOptionKey, t]
  )

  const bindComposerCloudProject = useCallback(
    (project: CloudProject, notice: string) => {
      setCloudActionNotice(notice)
      if (!currentRuntimeTask) {
        setPendingCloudContext(project, null)
        return
      }
      const api = projectSpaceApiFor(project)
      if (!api) return
      void api
        .bindProjectTask(project.id, currentRuntimeTask, runtimeTaskTitle)
        .then(() => {
          setBoundCloudProject(project)
          setBoundCloudItem(null)
          setDeliveryItem(null)
        })
        .catch(cause => {
          setTodoBindingError(
            cause instanceof Error
              ? cause.message
              : t('workbench.cloud_project_bind_failed', '关联项目空间失败')
          )
        })
    },
    [currentRuntimeTask, projectSpaceApiFor, runtimeTaskTitle, setPendingCloudContext, t]
  )

  const handleSelectCloudProject = useCallback(
    (project: CloudProject) => {
      setDismissedDefaultCloudProjectKey(null)
      bindComposerCloudProject(
        project,
        t('workbench.cloud_project_bound_notice', { name: project.name })
      )
    },
    [bindComposerCloudProject, t]
  )

  const activeDeliveryItem =
    currentRuntimeTask &&
    deliveryItem?.runtimeRefs.some(
      reference =>
        reference.taskId === currentRuntimeTask.taskId &&
        reference.deviceId === currentRuntimeTask.deviceId
    )
      ? deliveryItem
      : null

  const openBoundProjectSpaceTask = useCallback(() => {
    if (!boundCloudProject || !boundCloudItem) return
    const params = new URLSearchParams()
    params.set('projectId', String(boundCloudProject.id))
    params.set('itemId', boundCloudItem.id)
    const contentRoute = `/todo?${params.toString()}`
    const boardTab = workspaceTabs?.tabs.find(tab => tab.kind === 'board')
    if (boardTab && workspaceTabs) {
      workspaceTabs.selectTab(boardTab.id, {
        title: boundCloudProject.name,
        contentRoute,
      })
      return
    }
    if (workspaceTabs) {
      workspaceTabs.openTab('board', {
        title: boundCloudProject.name,
        contentRoute,
      })
      return
    }
    navigateTo(contentRoute)
  }, [boundCloudItem, boundCloudProject, workspaceTabs])

  const finishLocalDelivery = useCallback(async () => {
    if (!activeDeliveryItem) return
    const items = await loadLocalWorkItems(userId)
    const now = new Date().toISOString()
    await saveLocalWorkItems(
      userId,
      items.map(item =>
        item.id === activeDeliveryItem.id
          ? {
              ...item,
              state: 'completed',
              updatedAt: now,
              events: [
                ...item.events,
                {
                  id: `delivery-${now}`,
                  type: 'confirmed' as const,
                  summary: t('delivery.completed_activity', '任务已交付并完成'),
                  createdAt: now,
                },
              ],
            }
          : item
      )
    )
    setDeliveryDialogOpen(false)
    navigateTo('/todo')
  }, [activeDeliveryItem, userId, t])

  const prepareSubmission = useCallback(
    (description: string): CloudSubmissionContext => {
      const submissionProject = currentRuntimeTask ? null : pendingCloudProject
      const submissionItem = submissionProject ? pendingTodoItem : null
      if (!currentRuntimeTask) {
        setPendingCloudContext(submissionProject, submissionItem)
        pendingAutoJoinResolutionRef.current =
          !submissionProject &&
          Boolean(defaultProjectSpace) &&
          dismissedDefaultCloudProjectKey !== defaultCloudProjectSelectionKey &&
          todoBindingApis.length > 0
            ? { target: null, description }
            : null
      }
      if (pendingTodoBinding) {
        pendingTodoBinding = { ...pendingTodoBinding, description }
      }
      return {
        additionalContext:
          cloudProjectAdditionalContext(submissionProject, submissionItem) ??
          cloudAdditionalContext,
        cloudProjectId: runtimeCloudProjectId(submissionProject),
        onRuntimeTaskCreated: address => {
          if (pendingTodoBinding) {
            pendingTodoBinding = { ...pendingTodoBinding, target: address }
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
      cloudAdditionalContext,
      currentRuntimeTask,
      defaultCloudProjectSelectionKey,
      defaultProjectSpace,
      dismissedDefaultCloudProjectKey,
      pendingCloudProject,
      pendingTodoItem,
      setPendingCloudContext,
      todoBindingApis,
    ]
  )

  const clearPendingProjectContext = useCallback(() => {
    setDismissedDefaultCloudProjectKey(defaultCloudProjectSelectionKey)
    setPendingCloudContext(null, null)
  }, [defaultCloudProjectSelectionKey, setPendingCloudContext])

  const openDelivery = useCallback(() => {
    if (activeDeliveryItem) {
      setDeliveryDialogOpen(true)
      return
    }
    setDeliverAfterBinding(true)
    setTodoBindingPickerOpen(true)
  }, [activeDeliveryItem])

  const openTodoManager = useCallback(() => {
    if (boundCloudItem) {
      openBoundProjectSpaceTask()
      return
    }
    setDeliverAfterBinding(false)
    setTodoBindingPickerOpen(true)
  }, [boundCloudItem, openBoundProjectSpaceTask])

  const closeTodoBindingPicker = useCallback(() => {
    setTodoBindingPickerOpen(false)
    setDeliverAfterBinding(false)
  }, [])

  const clearCloudActionNotice = useCallback(() => setCloudActionNotice(null), [])
  const clearTodoBindingError = useCallback(() => setTodoBindingError(null), [])
  const closeDeliveryDialog = useCallback(() => setDeliveryDialogOpen(false), [])

  const handleTodoBound = useCallback(
    (project: CloudProject | null, item: CloudLoopItem | null) => {
      if (!currentRuntimeTask) {
        setPendingCloudContext(project, item)
        setTodoBindingPickerOpen(false)
        return
      }
      setBoundCloudProject(project)
      setBoundCloudItem(item)
      setDeliveryItem(item ? cloudItemAsLocalWorkItem(item, currentRuntimeTask) : null)
      setTodoBindingPickerOpen(false)
      if (item && deliverAfterBinding) setDeliveryDialogOpen(true)
      setDeliverAfterBinding(false)
    },
    [currentRuntimeTask, deliverAfterBinding, setPendingCloudContext]
  )

  return {
    activeDeliveryItem,
    boundCloudItem,
    boundCloudProject,
    clearCloudActionNotice,
    clearPendingProjectContext,
    clearTodoBindingError,
    closeDeliveryDialog,
    closeTodoBindingPicker,
    cloudActionNotice,
    cloudProjectMentionCandidates,
    composerCloudProject,
    deliveryDialogOpen,
    finishLocalDelivery,
    handleSelectCloudProject,
    handleTodoBound,
    openDelivery,
    openTodoManager,
    pendingCloudProject,
    pendingTodoItem,
    prepareSubmission,
    todoBindingApis,
    todoBindingError,
    todoBindingPickerOpen,
    visibleCloudMentionCandidates,
  }
}
