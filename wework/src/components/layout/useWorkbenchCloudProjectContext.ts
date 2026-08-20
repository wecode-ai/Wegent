import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComposerCloudMentionCandidate } from '@/components/chat/composer/composerMentionCandidates'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import {
  findProjectSpaceContextForTask,
  isDefaultWorkItemProject,
  loadDefaultWorkItemProject,
  projectSpaceKey,
  projectSpaceRef,
  runtimeCloudProjectId,
  subscribeProjectSpaceTaskContextChanged,
  type ProjectSpaceApi,
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
  paneKey: string
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

const pendingTodoBindingsByPane = new Map<string, PendingTodoBinding>()
const pendingTodoBindingsByTask = new Map<string, PendingTodoBinding>()
interface BoundProjectSpaceContextUpdate {
  task: RuntimeTaskAddress
  project: CloudProject
  item: CloudLoopItem
}

const boundProjectSpaceContextListeners = new Set<
  (update: BoundProjectSpaceContextUpdate) => void
>()
const PENDING_BINDING_CONTEXT_RETRY_MS = 100
const PENDING_BINDING_CONTEXT_RETRY_LIMIT = 50
const DEFAULT_WORK_ITEM_LOOKUP_TIMEOUT_MS = 1_500

function runtimeTaskKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}`
}

function pendingBindingFor(
  address: RuntimeTaskAddress | null,
  paneKey: string
): PendingTodoBinding | null {
  return address
    ? (pendingTodoBindingsByTask.get(runtimeTaskKey(address)) ?? null)
    : (pendingTodoBindingsByPane.get(paneKey) ?? null)
}

function storePendingBinding(binding: PendingTodoBinding) {
  if (binding.target) {
    pendingTodoBindingsByTask.set(runtimeTaskKey(binding.target), binding)
    pendingTodoBindingsByPane.delete(binding.paneKey)
    return
  }
  pendingTodoBindingsByPane.set(binding.paneKey, binding)
}

function clearPendingBinding(binding: PendingTodoBinding) {
  pendingTodoBindingsByPane.delete(binding.paneKey)
  if (binding.target) pendingTodoBindingsByTask.delete(runtimeTaskKey(binding.target))
}

function boardTabProjectKey(contentRoute: string): string | null {
  const searchIndex = contentRoute.indexOf('?')
  if (searchIndex < 0) return null
  const params = new URLSearchParams(contentRoute.slice(searchIndex + 1))
  const projectStore = params.get('projectStore')
  const projectId = params.get('projectId')
  return projectStore && projectId ? `${projectStore}:${projectId}` : null
}

function pendingBindingTargetsTask(address: RuntimeTaskAddress): boolean {
  return pendingTodoBindingsByTask.has(runtimeTaskKey(address))
}

function publishBoundProjectSpaceContext(update: BoundProjectSpaceContextUpdate) {
  const pendingBinding = pendingTodoBindingsByTask.get(runtimeTaskKey(update.task))
  if (pendingBinding) clearPendingBinding(pendingBinding)
  for (const listener of boundProjectSpaceContextListeners) listener(update)
}

async function waitForPendingProjectSpaceContext(
  apis: ProjectSpaceApi[],
  task: RuntimeTaskAddress,
  shouldContinue: () => boolean
) {
  let lastError: unknown
  for (let attempt = 0; attempt <= PENDING_BINDING_CONTEXT_RETRY_LIMIT; attempt += 1) {
    try {
      return await findProjectSpaceContextForTask(apis, task)
    } catch (error) {
      lastError = error
      if (
        attempt === PENDING_BINDING_CONTEXT_RETRY_LIMIT ||
        !shouldContinue() ||
        !pendingBindingTargetsTask(task)
      ) {
        throw error
      }
      await new Promise(resolve => window.setTimeout(resolve, PENDING_BINDING_CONTEXT_RETRY_MS))
    }
  }
  throw lastError
}

function pendingTodoForTask(address: RuntimeTaskAddress | null, paneKey: string) {
  return pendingBindingFor(address, paneKey)?.item ?? null
}

function pendingProjectForTask(address: RuntimeTaskAddress | null, paneKey: string) {
  return pendingBindingFor(address, paneKey)?.project ?? null
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
  const deliveryApi = services?.deliveryApi
  const cloudProjectSpaceApi = services?.projectSpaceApis?.cloud
  const localProjectSpaceApi = services?.projectSpaceApis?.local
  const todoBindingApis = useMemo(() => {
    const candidates = [localProjectSpaceApi, cloudProjectSpaceApi, deliveryApi]
    return candidates.filter(
      (api, index): api is ProjectSpaceApi => Boolean(api) && candidates.indexOf(api) === index
    )
  }, [cloudProjectSpaceApi, deliveryApi, localProjectSpaceApi])
  const defaultWorkItemProjectApi =
    localProjectSpaceApi ?? cloudProjectSpaceApi ?? deliveryApi ?? null
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
  const contextMountedRef = useRef(true)
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
  const [contextRefreshKey, setContextRefreshKey] = useState(0)
  const [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false)
  const [pendingTodoItem, setPendingTodoItem] = useState<CloudLoopItem | null>(() =>
    pendingTodoForTask(contextRuntimeTask, paneKey)
  )
  const [pendingCloudProject, setPendingCloudProject] = useState<CloudProject | null>(() =>
    pendingProjectForTask(contextRuntimeTask, paneKey)
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
        storePendingBinding({ paneKey, project, item, target: null, description: '' })
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
    boundProjectSpaceContextListeners.add(handleBoundContext)
    return () => {
      boundProjectSpaceContextListeners.delete(handleBoundContext)
    }
  }, [contextRuntimeTask, setPendingCloudContext])

  useEffect(() => {
    if (!contextRuntimeTask) return
    return subscribeProjectSpaceTaskContextChanged(task => {
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
    if (!contextActive || !contextRuntimeTask) {
      contextLookupTaskKeyRef.current = null
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
    const contextTaskKey = `${contextRuntimeTask.deviceId}:${contextRuntimeTask.taskId}`
    if (contextLookupTaskKeyRef.current !== contextTaskKey) {
      contextLookupTaskKeyRef.current = contextTaskKey
      setBoundCloudItem(null)
      setBoundCloudProject(null)
      setDeliveryItem(null)
    }
    const contextApis = todoBindingApis
    if (contextApis.length > 0) {
      void waitForPendingProjectSpaceContext(contextApis, contextRuntimeTask, () => active)
        .then(context => {
          if (!active || contextLookupGenerationRef.current !== lookupGeneration) return
          setBoundCloudProject(context.project)
          setBoundCloudItem(context.loop_item)
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
    const api = projectSpaceApiFor(projectToBind)
    if (!api) return
    const bindingTaskTitle =
      runtimeTaskTitleRef.current ||
      truncateRuntimeTaskTitle(pendingBinding?.description) ||
      t('workbench.untitled_task', '未命名任务')
    let active = true
    const bindingRequest = itemToBind
      ? api
          .bindTask(itemToBind.id, contextRuntimeTask, bindingTaskTitle)
          .then(() => ({ item: itemToBind }))
      : api.trackProjectTask(
          projectToBind.id,
          contextRuntimeTask,
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
    projectSpaceApiFor,
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
    const projectRequests = apis.map(async api => {
      const result = await api.listCloudProjects()
      return result.items
    })
    void Promise.allSettled(projectRequests).then(results => {
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
    } else if (!defaultProject && pendingAutoJoin) {
      pendingAutoJoinResolutionRef.current = null
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
      if (!contextRuntimeTask) {
        setPendingCloudContext(project, null)
        return
      }
      const api = projectSpaceApiFor(project)
      if (!api) return
      void api
        .bindProjectTask(project.id, contextRuntimeTask, runtimeTaskTitle)
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
    [contextRuntimeTask, projectSpaceApiFor, runtimeTaskTitle, setPendingCloudContext, t]
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
    const params = new URLSearchParams()
    params.set('projectStore', boundCloudProject.project_store)
    params.set('projectId', String(boundCloudProject.id))
    const contentRoute = `/todo?${params.toString()}`
    if (workspaceTabs) {
      const projectKey = projectSpaceKey(projectSpaceRef(boundCloudProject))
      const existingBoardTab = workspaceTabs.tabs.find(
        tab => tab.kind === 'board' && boardTabProjectKey(tab.contentRoute) === projectKey
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
    async (description: string): Promise<CloudSubmissionContext> => {
      let submissionProject = contextRuntimeTask ? null : pendingCloudProject
      if (
        !contextRuntimeTask &&
        !submissionProject &&
        dismissedDefaultCloudProjectKey !== defaultCloudProjectSelectionKey
      ) {
        submissionProject = defaultProject
      }
      if (!contextRuntimeTask && !submissionProject) {
        submissionProject =
          defaultWorkItemProject ??
          (defaultWorkItemProjectApi
            ? await Promise.race([
                loadDefaultWorkItemProject(defaultWorkItemProjectApi).catch(() => null),
                new Promise<null>(resolve => {
                  window.setTimeout(() => resolve(null), DEFAULT_WORK_ITEM_LOOKUP_TIMEOUT_MS)
                }),
              ])
            : null)
      }
      const submissionItem = submissionProject ? pendingTodoItem : null
      if (!contextRuntimeTask) {
        setPendingCloudContext(submissionProject, submissionItem)
        pendingAutoJoinResolutionRef.current =
          !submissionProject &&
          Boolean(defaultProjectSpace) &&
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
          cloudAdditionalContext,
        cloudProjectId: runtimeCloudProjectId(submissionProject),
        onRuntimeTaskCreated: address => {
          const pendingBinding = pendingTodoBindingsByPane.get(paneKey)
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
      cloudAdditionalContext,
      contextRuntimeTask,
      defaultCloudProjectSelectionKey,
      defaultProject,
      defaultProjectSpace,
      defaultWorkItemProject,
      defaultWorkItemProjectApi,
      dismissedDefaultCloudProjectKey,
      pendingCloudProject,
      pendingTodoItem,
      paneKey,
      setPendingCloudContext,
      todoBindingApis,
    ]
  )

  const clearPendingProjectContext = useCallback(() => {
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
    const api = projectSpaceApiFor(boundCloudProject)
    if (!api) return
    void api
      .unbindCloudContext(contextRuntimeTask)
      .then(() => {
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
  }, [boundCloudProject, clearPendingProjectContext, contextRuntimeTask, projectSpaceApiFor, t])

  return {
    activeDeliveryItem,
    boundCloudItem,
    boundCloudProject,
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
    finishLocalDelivery,
    handleSelectCloudProject,
    handleTodoBound,
    openDelivery,
    openBoundProjectSpaceTask,
    pendingCloudProject,
    pendingTodoItem,
    prepareSubmission,
    removeCloudProjectContext,
    todoBindingError,
    visibleCloudMentionCandidates,
  }
}
