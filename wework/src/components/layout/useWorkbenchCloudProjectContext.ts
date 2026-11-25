import { runtimeTasksShareOwner } from '@/lib/workbench-device'
import { useRuntimeTaskOwnerKey } from '@/features/workbench/useRuntimeTaskOwnerKey'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import {
  projectSpaceKey,
  projectSpaceRef,
  type ProjectSpaceApi,
} from '@/features/todo/projectSpaceSelection'
import type { ComposerCloudMentionCandidate } from '@/components/chat/composer/composerMentionCandidates'
import { useProjectSpaceProjects } from './useProjectSpaceProjects'
import { workbenchCloudProjectPendingBindings } from './workbenchCloudProjectPendingBindings'
import {
  createWorkbenchCloudProjectContextSource,
  defaultWorkbenchCloudProject,
  workbenchCloudMentionScope,
  type CloudProjectContextObservation,
} from './workbenchCloudProjectContextSource'
import {
  runtimeContextIdentity,
  runtimeTaskKey,
  type UseWorkbenchCloudProjectContextOptions,
} from './workbenchCloudProjectContextModel'
export { cloudItemAsLocalWorkItem } from './workbenchCloudProjectContextModel'

const EMPTY_MENTION_CANDIDATES: ComposerCloudMentionCandidate[] = []

export function useWorkbenchCloudProjectContext(options: UseWorkbenchCloudProjectContextOptions) {
  const { t } = useTranslation('common')
  const tabs = useOptionalWorkspaceTabs()
  const { active, currentRuntimeTask, paneKey, services, userId } = options
  const taskOwnerKey = useRuntimeTaskOwnerKey(currentRuntimeTask, options.devices ?? [])
  const ownerKey = taskOwnerKey ?? paneKey
  const local = services?.projectSpaceApis?.local,
    cloud = services?.projectSpaceApis?.cloud,
    delivery = services?.deliveryApi
  const apis = useMemo(() => {
    const entries = [local, cloud, delivery]
    return entries.filter(
      (api, index): api is ProjectSpaceApi => Boolean(api) && entries.indexOf(api) === index
    )
  }, [local, cloud, delivery])
  const cloudProjects = useProjectSpaceProjects(active, apis, userId)
  const observation: CloudProjectContextObservation = {
    ...options,
    taskOwnerKey,
    projects: cloudProjects,
    t,
    tabs,
  }
  const registry = workbenchCloudProjectPendingBindings(userId, services)
  const [owner, setOwner] = useState(() => ({
    registry,
    ownerKey,
    source: createWorkbenchCloudProjectContextSource(observation, registry),
  }))
  if (owner.registry !== registry || owner.ownerKey !== ownerKey)
    setOwner({
      registry,
      ownerKey,
      source: createWorkbenchCloudProjectContextSource(observation, registry),
    })
  const source = owner.source
  const snapshot = useSyncExternalStore(
    listener => source.subscribe(observation, listener),
    source.getSnapshot,
    source.getSnapshot
  )
  const sameTask = snapshot.taskScope === runtimeContextIdentity(currentRuntimeTask, taskOwnerKey)
  const boundCloudProject = sameTask ? snapshot.boundCloudProject : null
  const boundCloudItem = sameTask ? snapshot.boundCloudItem : null
  const pending = registry.get(currentRuntimeTask, paneKey)
  const pendingCloudProject = sameTask ? snapshot.pendingCloudProject : (pending?.project ?? null)
  const pendingTodoItem = sameTask ? snapshot.pendingTodoItem : (pending?.item ?? null)
  const composerCloudProject = currentRuntimeTask ? boundCloudProject : pendingCloudProject
  const composerTodoItem = currentRuntimeTask ? boundCloudItem : pendingTodoItem
  const defaultProject = defaultWorkbenchCloudProject(observation, snapshot)
  const defaultProjectOptionKey = defaultProject
    ? projectSpaceKey(projectSpaceRef(defaultProject))
    : null
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
  const activeDeliveryItem =
    sameTask &&
    currentRuntimeTask &&
    snapshot.deliveryItem?.runtimeRefs.some(
      ref => runtimeTaskKey(ref) === runtimeTaskKey(currentRuntimeTask)
    )
      ? snapshot.deliveryItem
      : null
  const mentionScope = workbenchCloudMentionScope(composerCloudProject, composerTodoItem)
  const mutationError = sameTask ? snapshot.todoBindingError : null
  const contextError = sameTask ? snapshot.contextAvailabilityError : null
  const retryProjectSpaceContext =
    !mutationError && contextError ? source.retryProjectSpaceContext : undefined
  const projectSpaceContextRetryAction = useMemo(
    () =>
      retryProjectSpaceContext
        ? {
            label: t('workbench.retry'),
            testId: 'project-space-context-retry',
            onClick: retryProjectSpaceContext,
            pending: false,
          }
        : undefined,
    [retryProjectSpaceContext, t]
  )
  return {
    activeDeliveryItem,
    boundCloudItem,
    boundCloudProject,
    boundRuntimeTaskAddress:
      sameTask &&
      currentRuntimeTask &&
      snapshot.boundRuntimeTaskAddress &&
      runtimeTasksShareOwner(
        snapshot.boundRuntimeTaskAddress,
        currentRuntimeTask,
        options.devices ?? []
      )
        ? { ...snapshot.boundRuntimeTaskAddress, deviceId: currentRuntimeTask.deviceId }
        : null,
    boundProjectSpaceApi: boundCloudProject
      ? source.projectSpaceApiFor(boundCloudProject)
      : undefined,
    clearCloudActionNotice: source.clearCloudActionNotice,
    clearPendingProjectContext: source.clearPendingProjectContext,
    clearTodoBindingError: mutationError
      ? source.clearTodoBindingError
      : source.clearContextAvailabilityError,
    closeDeliveryDialog: source.closeDeliveryDialog,
    cloudActionNotice: snapshot.cloudActionNotice,
    cloudProjects,
    cloudProjectMentionCandidates,
    composerCloudProject,
    defaultProject,
    deliveryDialogOpen: snapshot.deliveryDialogOpen,
    finishDelivery: source.finishDelivery,
    handleSelectCloudProject: source.handleSelectCloudProject,
    handleTodoBound: source.handleTodoBound,
    openDelivery: source.openDelivery,
    openBoundProjectSpaceTask: source.openBoundProjectSpaceTask,
    openIssueExecutionSource: source.openIssueExecutionSource,
    pendingCloudProject,
    pendingTodoItem,
    prepareSubmission: source.prepareSubmission,
    removeCloudProjectContext: source.removeCloudProjectContext,
    projectSpaceContextRetryAction,
    taskBoardAssociation: snapshot.taskBoardAssociation,
    closeTaskBoardAssociation: source.closeTaskBoardAssociation,
    associateRuntimeTaskWithNewItem: source.associateRuntimeTaskWithNewItem,
    associateRuntimeTaskWithExistingItem: source.associateRuntimeTaskWithExistingItem,
    todoBindingError: mutationError ?? contextError,
    visibleCloudMentionCandidates:
      mentionScope && snapshot.mentions?.scope === mentionScope
        ? snapshot.mentions.candidates
        : EMPTY_MENTION_CANDIDATES,
  }
}
