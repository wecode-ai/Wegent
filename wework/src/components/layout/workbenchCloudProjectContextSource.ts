import { runtimeTasksShareOwner } from '@/lib/workbench-device'
import type { ComposerCloudMentionCandidate } from '@/components/chat/composer/composerMentionCandidates'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { RuntimeTaskAddress, RuntimeProjectSpaceRef } from '@/types/api'
import type { useTranslation } from '@/hooks/useTranslation'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { navigateTo } from '@/lib/navigation'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { truncateRuntimeTaskTitle } from '@/features/workbench/workbenchRuntimeHelpers'
import { hydrateLocalWorkItems, type LocalWorkItem } from '@/features/todo/todoModel'
import {
  createCloudProjectTaskRuntimeApi,
  projectTaskRuntimeApiForProject,
  type ProjectTaskRuntimeApi,
} from '@/features/workbench/projectTaskTracking'
import {
  findProjectSpaceContextForTaskInStores,
  isDefaultWorkItemProject,
  ProjectSpaceTaskContextUnavailableError,
  projectSpaceForRuntimeTask,
  projectSpaceTaskContextApisForTask,
  publishProjectSpaceTaskBindingChanged,
  projectSpaceKey,
  projectSpaceRef,
  rememberProjectSpaceTaskBinding,
  sameProjectSpace,
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
  type ProjectSpaceTaskBindingChange,
} from '@/features/todo/projectSpaceSelection'
import {
  projectSpaceContentRoute,
  projectSpaceRouteMatchesProject,
} from '@/features/todo/projectSpaceRoute'
import {
  cloudItemAsLocalWorkItem,
  cloudProjectAdditionalContext,
  projectHasModelContext,
  runtimeContextIdentity,
  runtimeContextAddress,
  runtimeTaskAddressForBinding,
  runtimeTaskKey,
  executionAddressFromContext,
  type UseWorkbenchCloudProjectContextOptions,
  type PendingAutoJoinResolution,
  type PendingTodoBinding,
  type TaskBoardAssociationState,
  type CloudSubmissionContext,
} from './workbenchCloudProjectContextModel'
import type { WorkbenchCloudPendingBindings } from './workbenchCloudProjectPendingBindings'
import { loadWorkbenchCloudMentions } from './workbenchCloudProjectMentions'

export interface CloudProjectContextObservation extends UseWorkbenchCloudProjectContextOptions {
  taskOwnerKey?: string | null
  projects: CloudProject[]
  t: ReturnType<typeof useTranslation>['t']
  tabs: WorkspaceTabsContextValue | null
}
interface ContextSnapshot {
  taskScope: string | null
  deliveryItem: Omit<LocalWorkItem, 'projectId'> | null
  boundCloudProject: CloudProject | null
  boundCloudItem: CloudLoopItem | null
  boundRuntimeTaskAddress: RuntimeTaskAddress | null
  pendingCloudProject: CloudProject | null
  pendingTodoItem: CloudLoopItem | null
  deliveryDialogOpen: boolean
  todoBindingError: string | null
  contextAvailabilityError: string | null
  dismissedDefaultCloudProjectKey: string | null
  cloudActionNotice: string | null
  taskBoardAssociation: TaskBoardAssociationState | null
  mentions: { scope: string; candidates: ComposerCloudMentionCandidate[] } | null
}
export function defaultWorkbenchCloudProject(
  input: CloudProjectContextObservation,
  snapshot: ContextSnapshot
) {
  const key = `${input.paneKey}:${input.currentProjectId ?? 'none'}`
  const fallback = input.projects.find(isDefaultWorkItemProject) ?? null
  if (snapshot.dismissedDefaultCloudProjectKey === key) return fallback
  return input.defaultProjectSpace
    ? (input.projects.find(
        project =>
          projectSpaceKey(projectSpaceRef(project)) === projectSpaceKey(input.defaultProjectSpace!)
      ) ?? null)
    : fallback
}
export function workbenchCloudMentionScope(
  project: CloudProject | null,
  item: CloudLoopItem | null
) {
  return project
    ? JSON.stringify([
        project.project_store,
        project.id,
        project.current_user_id,
        project.access_role,
        item?.id,
      ])
    : null
}

/** Owns the task's confirmed context, pending association and submission transactions. */
export function createWorkbenchCloudProjectContextSource(
  initial: CloudProjectContextObservation,
  registry: WorkbenchCloudPendingBindings
) {
  let input = initial
  const pending = registry.get(initial.currentRuntimeTask, initial.paneKey)
  let snapshot: ContextSnapshot = {
    taskScope: runtimeContextIdentity(initial.currentRuntimeTask, initial.taskOwnerKey),
    deliveryItem: null,
    boundCloudProject: null,
    boundCloudItem: null,
    boundRuntimeTaskAddress: null,
    pendingCloudProject: pending?.project ?? null,
    pendingTodoItem: pending?.item ?? null,
    deliveryDialogOpen: false,
    todoBindingError: null,
    contextAvailabilityError: null,
    dismissedDefaultCloudProjectKey: null,
    cloudActionNotice: null,
    taskBoardAssociation: null,
    mentions: null,
  }
  const listeners = new Set<() => void>()
  let releases: Array<() => void> = []

  let lookupRevision = 0
  let mentionRevision = 0
  let dialogRevision = 0
  let lookupKeys: readonly unknown[] | undefined
  let mentionKeys: readonly unknown[] | undefined
  let binding: PendingTodoBinding | null = null
  let pendingAutoJoin: (PendingAutoJoinResolution & { binding?: PendingTodoBinding }) | null = null
  let publication: ProjectSpaceTaskBindingChange | null = null
  const publish = (patch: Partial<ContextSnapshot>) => {
    if (
      Object.entries(patch).every(([key, value]) =>
        Object.is(snapshot[key as keyof ContextSnapshot], value)
      )
    )
      return
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const task = () => input.currentRuntimeTask
  const contextIdentity = (address: RuntimeTaskAddress | null) =>
    runtimeContextIdentity(
      address,
      runtimeTasksShareOwner(address, task(), input.devices ?? []) ? input.taskOwnerKey : undefined
    )
  const current = (scope: string | null) => listeners.size > 0 && contextIdentity(task()) === scope
  const matches = (address: RuntimeTaskAddress) =>
    runtimeTasksShareOwner(task(), address, input.devices ?? [])
  const runtimeApi = () =>
    input.services?.workspaceRuntimePort
      ? createCloudProjectTaskRuntimeApi(input.services.workspaceRuntimePort)
      : undefined
  const contextApis = () =>
    projectSpaceTaskContextApisForTask<ProjectTaskRuntimeApi>(
      null,
      input.services?.projectSpaceApis?.local,
      runtimeApi()
    )
  const find = (address: RuntimeTaskAddress) =>
    findProjectSpaceContextForTaskInStores<ProjectTaskRuntimeApi>(
      address,
      input.services?.projectSpaceApis?.local,
      runtimeApi()
    )
  const projectApi = (project: CloudProject) =>
    project.project_store === 'local' || project.task_provider === 'dingtalk_aitable'
      ? (input.services?.projectSpaceApis?.local ?? input.services?.deliveryApi)
      : (input.services?.projectSpaceApis?.cloud ?? input.services?.deliveryApi)
  const record = (address: RuntimeTaskAddress, project: CloudProject) => {
    const reference = projectSpaceRef(project)
    const identity = runtimeContextAddress(address)
    if (!rememberProjectSpaceTaskBinding(identity, reference)) return
    const change: ProjectSpaceTaskBindingChange = {
      task: identity,
      project: reference,
      type: 'bound',
    }
    publication = change
    try {
      publishProjectSpaceTaskBindingChanged(change)
    } finally {
      publication = null
    }
  }
  const clearPending = (address = task()) => {
    const value = registry.get(address, input.paneKey)
    if (value) registry.clear(value)
    binding = null
    publish({ pendingCloudProject: null, pendingTodoItem: null })
  }
  const setPending = (project: CloudProject | null, item: CloudLoopItem | null) => {
    const old = registry.get(task(), input.paneKey)
    if (old) registry.clear(old)
    if (project)
      registry.store({ paneKey: input.paneKey, project, item, target: null, description: '' })
    binding = null
    publish({ pendingCloudProject: project, pendingTodoItem: item })
  }
  const apply = (
    address: RuntimeTaskAddress,
    project: CloudProject,
    item: CloudLoopItem | null,
    execution?: RuntimeTaskAddress | null
  ) => {
    record(address, project)
    publish({
      boundCloudProject: project,
      boundCloudItem: item,
      contextAvailabilityError: null,
      deliveryItem: item ? cloudItemAsLocalWorkItem(item, runtimeContextAddress(address)) : null,
      ...(execution !== undefined ? { boundRuntimeTaskAddress: execution } : {}),
    })
  }
  const resolve = async () => {
    const address = task()
    const scope = contextIdentity(address)
    const revision = ++lookupRevision
    const valid = () => current(scope) && revision === lookupRevision && input.active
    if (!address || !input.active) return
    if (!contextApis().length && !address.projectSession && !projectSpaceForRuntimeTask(address)) {
      try {
        const items = await hydrateLocalWorkItems(input.userId)
        if (valid())
          publish({
            boundCloudProject: null,
            boundCloudItem: null,
            deliveryItem:
              items.find(item =>
                item.runtimeRefs.some(ref => runtimeTaskKey(ref) === runtimeTaskKey(address))
              ) ?? null,
          })
      } catch {
        if (valid()) publish({ boundCloudProject: null, boundCloudItem: null, deliveryItem: null })
      }
      return
    }
    const started = performance.now()
    try {
      let context: Awaited<ReturnType<ProjectTaskRuntimeApi['findCloudContextForTask']>> | undefined
      for (let attempt = 0; attempt <= 50; attempt++) {
        if (!valid()) return
        try {
          context = await find(runtimeTaskAddressForBinding(address, task(), input.devices))
          break
        } catch (error) {
          if (
            attempt === 50 ||
            error instanceof ProjectSpaceTaskContextUnavailableError ||
            !valid() ||
            !registry.has(address)
          )
            throw error
          await new Promise(done => setTimeout(done, 100))
        }
      }
      if (!context) return
      logRuntimeTaskCreateStage('project-space-context-resolved', {
        taskId: address.taskId,
        deviceId: address.deviceId,
        projectId: context.project.id,
        itemId: context.loop_item?.id ?? null,
        elapsedMs: Math.round(performance.now() - started),
        applied: valid(),
      })
      if (!valid()) return
      apply(
        address,
        context.project,
        context.loop_item,
        executionAddressFromContext(task() ?? address, context)
      )
      if (registry.has(address)) clearPending(address)
    } catch (error) {
      if (!valid()) return
      if (error instanceof ProjectSpaceTaskContextUnavailableError)
        publish({
          boundCloudProject: null,
          boundCloudItem: null,
          boundRuntimeTaskAddress: null,
          deliveryItem: null,
          contextAvailabilityError: input.t(
            'workbench.cloud_project_bind_failed',
            '关联项目空间失败'
          ),
        })
      logRuntimeTaskCreateStage(
        'project-space-context-failed',
        {
          taskId: address.taskId,
          deviceId: address.deviceId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          elapsedMs: Math.round(performance.now() - started),
          causes:
            error instanceof AggregateError
              ? error.errors.map(cause =>
                  cause instanceof Error
                    ? { message: cause.message, stack: cause.stack }
                    : { message: String(cause) }
                )
              : undefined,
        },
        'warn'
      )
    }
  }
  const bindPending = () => {
    const address = task()
    const value = registry.get(address, input.paneKey)
    if (
      !address ||
      !value?.target ||
      runtimeTaskKey(value.target) !== runtimeTaskKey(address) ||
      value === binding
    )
      return
    const project = value.project
    if (
      address.projectSession &&
      (project.project_store !== 'backend' ||
        String(project.id) !== String(address.projectSession.projectId) ||
        (value.item && String(value.item.id) !== String(address.projectSession.issueId)))
    )
      return
    const api = projectTaskRuntimeApiForProject(input.services, project)
    if (!api || (isDefaultWorkItemProject(project) && !value.item)) return
    binding = value
    const scope = contextIdentity(address)
    const title =
      input.runtimeTaskTitle ||
      truncateRuntimeTaskTitle(value.description) ||
      input.t('workbench.untitled_task', '未命名任务')
    void registry
      .bind(value, runtimeTaskAddressForBinding(address, task(), input.devices), api, title)
      .catch(cause => {
        if (current(scope) && binding === value)
          publish({
            todoBindingError:
              cause instanceof Error
                ? cause.message
                : input.t('workbench.cloud_project_bind_failed', '关联项目空间失败'),
          })
      })
  }
  const autoJoin = () => {
    const project = defaultWorkbenchCloudProject(input, snapshot)
    const key = `${input.paneKey}:${input.currentProjectId ?? 'none'}`
    const address = task()
    const matchesTarget =
      pendingAutoJoin?.target &&
      address &&
      runtimeTaskKey(pendingAutoJoin.target) === runtimeTaskKey(address)
    if (
      !project ||
      snapshot.pendingCloudProject ||
      snapshot.dismissedDefaultCloudProjectKey === key ||
      (address && !matchesTarget)
    )
      return
    const selected = registry.store({
      paneKey: input.paneKey,
      project,
      item: null,
      target: pendingAutoJoin?.target ?? null,
      description: pendingAutoJoin?.description ?? '',
    })
    if (pendingAutoJoin) pendingAutoJoin.binding = selected
    pendingAutoJoin = null
    publish({ pendingCloudProject: project, pendingTodoItem: null })
  }
  const mentions = () => {
    const project = task() ? snapshot.boundCloudProject : snapshot.pendingCloudProject
    const item = task() ? snapshot.boundCloudItem : snapshot.pendingTodoItem
    const api = project ? projectApi(project) : undefined
    const scope = workbenchCloudMentionScope(project, item)
    const keys = [scope, api, input.t]
    if (mentionKeys && keys.every((value, index) => value === mentionKeys![index])) return
    mentionKeys = keys
    const revision = ++mentionRevision
    if (!project || !api || !scope) return
    void loadWorkbenchCloudMentions(project, item, api, input.t)
      .then(candidates => {
        if (listeners.size && revision === mentionRevision)
          publish({ mentions: { scope, candidates } })
      })
      .catch(() => {
        if (listeners.size && revision === mentionRevision) publish({ mentions: null })
      })
  }
  const observe = () => {
    const scope = contextIdentity(task())
    if (scope !== snapshot.taskScope) {
      lookupRevision++
      dialogRevision++
      binding = null
      const pending = registry.get(task(), input.paneKey)
      publish({
        taskScope: scope,
        taskBoardAssociation: null,
        deliveryDialogOpen: false,
        todoBindingError: null,
        boundCloudProject: null,
        boundCloudItem: null,
        boundRuntimeTaskAddress: null,
        deliveryItem: null,
        contextAvailabilityError: null,
        pendingCloudProject: pending?.project ?? null,
        pendingTodoItem: pending?.item ?? null,
      })
    }
    const keys = [input.active, scope, task()?.deviceId, input.t]
    if (!lookupKeys || keys.some((value, index) => value !== lookupKeys![index])) {
      lookupKeys = keys
      void resolve()
    }
    autoJoin()
    bindPending()
    mentions()
  }
  const openBound = () => {
    if (!listeners.size) return
    const project = snapshot.boundCloudProject,
      item = snapshot.boundCloudItem,
      address = task()
    // Durable source IDs navigate immediately; the destination checks current access.
    const execution = address?.issueExecution
    const ref: RuntimeProjectSpaceRef | null = execution
      ? {
          projectId: execution.projectId,
          projectStore: address?.projectSession ? 'backend' : 'local',
        }
      : project
        ? projectSpaceRef(project)
        : null
    const itemId = execution?.issueId ?? item?.id
    if (!ref || !itemId) return
    const route = projectSpaceContentRoute(ref, itemId)
    const options = {
      contentRoute: route,
      ...(project && sameProjectSpace(ref, projectSpaceRef(project))
        ? { title: project.name }
        : {}),
    }
    const tabs = input.tabs
    if (!tabs) {
      navigateTo(route)
      return
    }
    const board = tabs.tabs.find(
      tab =>
        tab.kind === 'board' && !tab.fixed && projectSpaceRouteMatchesProject(tab.contentRoute, ref)
    )
    if (board) tabs.selectTab(board.id, options)
    else tabs.openTab('board', options)
  }

  const associate = async (item: CloudLoopItem | null) => {
    if (!listeners.size) return
    const association = snapshot.taskBoardAssociation
    if (
      !association ||
      association.pending ||
      association.taskKey !== (task() ? runtimeTaskKey(task()!) : null)
    )
      return
    const { project } = association,
      address = task()
    if (!address) {
      setPending(project, item)
      publish({
        taskBoardAssociation: null,
        cloudActionNotice: item
          ? input.t('workbench.task_board_association_pending_existing', { title: item.title })
          : input.t('workbench.task_board_association_pending_new', { name: project.name }),
      })
      return
    }
    const api = projectTaskRuntimeApiForProject(input.services, project)
    if (!api) return
    const scope = contextIdentity(address)
    const revision = dialogRevision
    const title =
      input.runtimeTaskTitle ||
      truncateRuntimeTaskTitle(input.runtimeTaskDescription) ||
      input.t('workbench.untitled_task', '未命名任务')
    publish({ taskBoardAssociation: { ...association, pending: true }, todoBindingError: null })
    try {
      const linked = item
        ? (await api.bindTask(
            item.id,
            runtimeTaskAddressForBinding(address, task(), input.devices),
            title
          ),
          item)
        : (
            await api.trackProjectTask(
              project.id,
              runtimeTaskAddressForBinding(address, task(), input.devices),
              title,
              input.runtimeTaskDescription ?? ''
            )
          ).item
      if (!current(scope) || revision !== dialogRevision) return
      ++lookupRevision
      registry.publishBound({ task: address, project, item: linked })
      publish({
        taskBoardAssociation: null,
        cloudActionNotice: input.t('workbench.task_board_association_success', {
          name: project.name,
        }),
      })
    } catch (cause) {
      const currentAssociation = snapshot.taskBoardAssociation
      if (current(scope) && revision === dialogRevision && currentAssociation)
        publish({
          taskBoardAssociation: { ...currentAssociation, pending: false },
          todoBindingError:
            cause instanceof Error
              ? cause.message
              : input.t('workbench.cloud_project_bind_failed', '关联项目空间失败'),
        })
    }
  }
  const prepare = (description: string): CloudSubmissionContext => {
    const address = task(),
      scope = contextIdentity(address),
      frame = input
    if (!current(scope)) throw new Error('Project-space submission context changed')
    let project = address ? snapshot.boundCloudProject : snapshot.pendingCloudProject
    let item = address ? snapshot.boundCloudItem : snapshot.pendingTodoItem
    const selectionKey = `${frame.paneKey}:${frame.currentProjectId ?? 'none'}`
    if (!address && !project && snapshot.dismissedDefaultCloudProjectKey !== selectionKey)
      project = defaultWorkbenchCloudProject(input, snapshot)
    if (!address && !project) project = input.projects.find(isDefaultWorkItemProject) ?? null
    if (!project) item = null
    if (!address) {
      setPending(project, item)
      pendingAutoJoin =
        !project &&
        snapshot.dismissedDefaultCloudProjectKey !== selectionKey &&
        contextApis().length
          ? { target: null, description }
          : null
    }
    let preparedBinding = registry.get(address, frame.paneKey)
    if (preparedBinding)
      preparedBinding = registry.store({ ...preparedBinding, description }, preparedBinding)
    const lateDefault = pendingAutoJoin
    const hasContext = projectHasModelContext(project, item)
    const selectedReference = hasContext && project ? projectSpaceRef(project) : undefined
    const session = address?.projectSession
    const knownReference = session
      ? { projectStore: 'backend' as const, projectId: session.projectId }
      : address
        ? projectSpaceForRuntimeTask(address)
        : undefined
    const reference = knownReference ?? selectedReference
    const itemId =
      session?.issueId ??
      (sameProjectSpace(reference, selectedReference) ? (item?.id ?? null) : null)
    return {
      additionalContext: cloudProjectAdditionalContext(reference, itemId),
      cloudProjectId: reference?.projectStore === 'backend' ? reference.projectId : undefined,
      origin:
        reference && itemId && !(project && isDefaultWorkItemProject(project))
          ? {
              type: 'board_task',
              projectStore: reference.projectStore,
              cloudProjectId: reference.projectId,
              loopItemId: itemId,
            }
          : undefined,
      onRuntimeTaskCreated(address) {
        const selected = preparedBinding ?? lateDefault?.binding
        if (
          selected &&
          (registry.get(null, frame.paneKey) === selected ||
            registry.get(address, frame.paneKey) === selected)
        )
          registry.store({ ...selected, target: address }, selected)
        if (lateDefault && pendingAutoJoin === lateDefault) lateDefault.target = address
        if (current(contextIdentity(task()))) {
          autoJoin()
          bindPending()
        }
      },
    }
  }
  return {
    getSnapshot: () => snapshot,
    projectSpaceApiFor: projectApi,
    prepareSubmission: prepare,
    openBoundProjectSpaceTask: openBound,
    finishDelivery() {
      publish({ deliveryDialogOpen: false })
      openBound()
    },
    openDelivery() {
      if (
        snapshot.deliveryItem &&
        task() &&
        snapshot.deliveryItem.runtimeRefs.some(
          ref => runtimeTaskKey(ref) === runtimeTaskKey(task()!)
        )
      )
        publish({ deliveryDialogOpen: true })
    },
    closeDeliveryDialog() {
      publish({ deliveryDialogOpen: false })
    },
    clearCloudActionNotice() {
      publish({ cloudActionNotice: null })
    },
    clearTodoBindingError() {
      publish({ todoBindingError: null, contextAvailabilityError: null })
    },
    clearPendingProjectContext() {
      pendingAutoJoin = null
      publish({
        dismissedDefaultCloudProjectKey: `${input.paneKey}:${input.currentProjectId ?? 'none'}`,
      })
      setPending(null, null)
    },
    handleTodoBound(project: CloudProject | null, item: CloudLoopItem | null) {
      if (!task()) {
        setPending(project, item)
        return
      }
      lookupRevision++
      publish({
        boundCloudProject: project,
        boundCloudItem: item,
        deliveryItem: item ? cloudItemAsLocalWorkItem(item, runtimeContextAddress(task()!)) : null,
      })
    },
    handleSelectCloudProject(project: CloudProject) {
      if (!listeners.size) return
      publish({ dismissedDefaultCloudProjectKey: null })
      if (isDefaultWorkItemProject(project)) {
        if (!task()) setPending(project, null)
        return
      }
      const api = projectApi(project)
      if (!api) return
      const revision = ++dialogRevision
      const associationTaskKey = task() ? runtimeTaskKey(task()!) : null
      publish({
        taskBoardAssociation: {
          taskKey: associationTaskKey,
          project,
          items: [],
          loading: true,
          pending: false,
        },
      })
      void api
        .listLoopItems(project.id)
        .then(response => {
          if (
            listeners.size &&
            revision === dialogRevision &&
            snapshot.taskBoardAssociation?.project === project &&
            snapshot.taskBoardAssociation.taskKey === associationTaskKey
          )
            publish({
              taskBoardAssociation: {
                ...snapshot.taskBoardAssociation,
                items: response.items,
                loading: false,
              },
            })
        })
        .catch(cause => {
          if (
            listeners.size &&
            revision === dialogRevision &&
            snapshot.taskBoardAssociation?.project === project
          )
            publish({
              taskBoardAssociation: { ...snapshot.taskBoardAssociation, loading: false },
              todoBindingError:
                cause instanceof Error
                  ? cause.message
                  : input.t('workbench.task_board_items_load_failed', '加载看板任务失败'),
            })
        })
    },
    closeTaskBoardAssociation() {
      if (!snapshot.taskBoardAssociation?.pending) {
        dialogRevision++
        publish({ taskBoardAssociation: null })
      }
    },
    associateRuntimeTaskWithNewItem() {
      void associate(null)
    },
    associateRuntimeTaskWithExistingItem(item: CloudLoopItem) {
      void associate(item)
    },
    removeCloudProjectContext() {
      if (!listeners.size) return
      const address = task(),
        project = snapshot.boundCloudProject
      if (!address) {
        pendingAutoJoin = null
        publish({
          dismissedDefaultCloudProjectKey: `${input.paneKey}:${input.currentProjectId ?? 'none'}`,
        })
        setPending(null, null)
        return
      }
      if (!project) return
      const api = projectTaskRuntimeApiForProject(input.services, project)
      if (!api) return
      const scope = contextIdentity(address)
      void api
        .unbindCloudContext(address)
        .then(() => {
          if (!current(scope)) return
          lookupRevision++
          publishProjectSpaceTaskBindingChanged({
            task: address,
            project: projectSpaceRef(project),
            type: 'unbound',
          })
          publish({
            boundCloudProject: null,
            boundCloudItem: null,
            boundRuntimeTaskAddress: null,
            deliveryItem: null,
          })
        })
        .catch(cause => {
          if (current(scope))
            publish({
              todoBindingError:
                cause instanceof Error
                  ? cause.message
                  : input.t('workbench.cloud_project_unbind_failed', '从工作空间移除失败'),
            })
        })
    },
    subscribe(next: CloudProjectContextObservation, listener: () => void) {
      input = next
      listeners.add(listener)
      if (!releases.length) {
        releases.push(
          registry.subscribe(update => {
            if (!listeners.size || !matches(update.task)) return
            registry.confirmBound(update)

            lookupRevision++
            apply(update.task, update.project, update.item)
            clearPending(update.task)
            void resolve()
          })
        )
        releases.push(
          subscribeProjectSpaceTaskContextChanged(({ task: address }) => {
            if (matches(address)) {
              void resolve()
            }
          })
        )
        releases.push(
          subscribeProjectSpaceTaskBindingChanged(change => {
            if (
              change === publication ||
              change === registry.getPublication() ||
              !matches(change.task)
            )
              return

            if (change.type === 'unbound' && !projectSpaceForRuntimeTask(change.task))
              publish({
                boundCloudProject: null,
                boundCloudItem: null,
                boundRuntimeTaskAddress: null,
                deliveryItem: null,
              })
            void resolve()
          })
        )
      }
      observe()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          lookupRevision++
          mentionRevision++
          dialogRevision++
          lookupKeys = undefined
          mentionKeys = undefined
          releases.forEach(release => release())
          releases = []
        })
      }
    },
  }
}
