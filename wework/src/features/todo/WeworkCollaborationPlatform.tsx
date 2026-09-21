import { createLocalWorkspaceApi, LOCAL_WORKSPACE_ID } from './localWorkspaceApi'
import { createWeworkPlatformApi, withoutDefaultWorkItemProject } from './weworkPlatformApi'
// eslint-disable-next-line react-refresh/only-export-components
export { createLocalWorkspaceApi, createWeworkPlatformApi }
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  CollaborationApp,
  CollaborationPlatformApp,
  collaborationTestIds,
  createCollaborationTranslator,
  IssueConversationDrawers,
  toSharedIssueDetailTaskBinding,
  type CollaborationHostAdapter,
  type CollaborationIssue,
  type CollaborationPlatformLocation,
  type CollaborationProjectRendererWorkspaceContext,
  type CollaborationProject,
  type SharedWorkspaceApi,
  type WorkspaceTaskBinding,
} from '@wegent/collaboration'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  type CloudLoopItem,
  type CloudProject,
  type LoopItemTaskBinding,
} from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { AddCloudDeviceDialog } from '@/components/settings/AddCloudDeviceDialog'
import { resolveDeviceResourceSettingsOptions } from './deviceResourceSettings'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import {
  DesktopSidebarAccount,
  type DesktopSidebarAccountSettingsOptions,
} from '@/components/layout/DesktopSidebarAccount'
import { createWeworkProjectAgentConfigurationHost } from '@/features/collaboration/WeworkProjectAgentConfigurationHost'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { LocalProjectAgentForm } from '@/features/collaboration/LocalProjectAgentForm'
import { weworkProjectAgentConfigurationHost } from '@/features/collaboration/WeworkProjectAgentConfigurationHost'
import type { ArchiveRuntimeConversationsResult } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import type {
  ProjectSpaceDetailServices,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import type {
  ProjectWithTasks,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import {
  isRuntimeTaskExecutionRunning,
  runtimeTaskTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { AiChatModal } from './AiChatModal'
import { CloudTodoBoardCard, type CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'
import { projectBoundRuntimeTaskStatuses } from './runtimeMyWork'
import { TodoEditor } from './TodoEditor'
import {
  projectSpaceForRuntimeTask,
  publishProjectSpaceTaskBindingChanged,
  reconcileProjectSpaceTaskBindings,
  sameProjectSpace,
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
  type LocatedProjectSpace,
} from './projectSpaceSelection'

const initialLocation: CollaborationPlatformLocation = {
  platformView: 'spaces',
  workspaceId: null,
  workspaceView: 'home',
  projectId: null,
  projectView: 'board',
  issueId: null,
}
const PROJECT_STATUS_REFRESH_DELAYS_MS = [0, 500, 1_500] as const

// eslint-disable-next-line react-refresh/only-export-components
export function projectRuntimeStatusSignature(
  runtimeTaskLifecycle: RuntimeTaskLifecycleStoreSnapshot | undefined,
  project: RuntimeProjectSpaceRef
): string {
  return [...(runtimeTaskLifecycle?.tasks.entries() ?? [])]
    .flatMap(([key, lifecycle]) => {
      if (!sameProjectSpace(projectSpaceForRuntimeTask(lifecycle.address), project)) return []
      const status = runtimeTaskTrackingExecutionStatus(lifecycle)
      return status ? [`${key}:${status}`] : []
    })
    .sort()
    .join('|')
}

// eslint-disable-next-line react-refresh/only-export-components
export function toWeworkIssueTaskBinding(binding: WorkspaceTaskBinding): LoopItemTaskBinding {
  const mapped = toSharedIssueDetailTaskBinding(binding)
  return {
    ...mapped,
    modelSelection: mapped.modelSelection as LoopItemTaskBinding['modelSelection'],
  }
}

interface IssueRuntimeBindingPort {
  bindTask(
    issueId: string,
    task: RuntimeTaskAddress,
    taskTitle?: string | null,
    workflowNodeId?: string | null
  ): Promise<void>
  unbindTask(issueId: string, task: RuntimeTaskAddress): Promise<void>
}

export interface WeworkCollaborationPlatformProps {
  user: User
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  services: WorkbenchServices
  startupActive?: boolean
  activeProjectRef?: RuntimeProjectSpaceRef | null
  defaultProjectRequested?: boolean
  focusedItemId?: string | null
  onFocusedItemHandled?: () => void
  onActiveProjectChange?: (project: LocatedProjectSpace | null) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveRuntimeTasks?: (
    addresses: RuntimeTaskAddress[]
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onCancelRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout?: () => void
}

export function WeworkSharedProject({
  api,
  detailServices,
  focusedItemId,
  localProjects,
  locale,
  location,
  onFocusedItemHandled,
  onOpenRuntimeTask,
  onCancelRuntimeTask,
  project,
  runtimeTaskLifecycle,
  runtimeWork,
  runtimePort,
  services,
  setLocation,
  userId,
  workspace,
}: {
  api: SharedWorkspaceApi
  detailServices?: ProjectSpaceDetailServices
  focusedItemId?: string | null
  localProjects: ProjectWithTasks[]
  locale: 'zh-CN' | 'en'
  location: CollaborationPlatformLocation
  onFocusedItemHandled?: () => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onCancelRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  project: CollaborationProject
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  runtimeWork?: RuntimeWorkListResponse | null
  runtimePort?: IssueRuntimeBindingPort
  services: WorkbenchServices
  setLocation: Dispatch<SetStateAction<CollaborationPlatformLocation>>
  userId: string | number
  workspace: CollaborationProjectRendererWorkspaceContext
}) {
  const { t } = useTranslation('common')
  const [taskComposer, setTaskComposer] = useState<{
    address?: RuntimeTaskAddress
    issue: CollaborationIssue
    workflowStep?: string
    conversationKey: string
  } | null>(null)
  const [pinnedProgressIssueId, setPinnedProgressIssueId] = useState<string | null>(null)
  if (location.issueId && pinnedProgressIssueId !== null) setPinnedProgressIssueId(null)
  const [refreshProjectRequestKey, setRefreshProjectRequestKey] = useState(0)
  const [, setTaskBindingRevision] = useState(0)
  const runtimeTaskLifecycleRef = useRef(runtimeTaskLifecycle)
  useEffect(() => {
    runtimeTaskLifecycleRef.current = runtimeTaskLifecycle
  }, [runtimeTaskLifecycle])
  const hasFullWorkspaceAccess = 'access_role' in workspace
  const scopedApi = useMemo<SharedWorkspaceApi>(
    () => ({
      ...api,
      projects: {
        ...api.projects,
        list: async () => {
          if (hasFullWorkspaceAccess) return api.projects.list(workspace.id)
          const accessibleProjects = await api.projects.list()
          return accessibleProjects.filter(candidate => String(candidate.id) === String(project.id))
        },
        create: input =>
          api.projects.create({
            ...input,
            workspaceId: workspace.id,
          }),
      },
      issues: {
        ...api.issues,
        async getBoardSnapshot(projectId) {
          const snapshot = await api.issues.getBoardSnapshot(projectId)
          const currentProject = {
            projectStore: project.project_store,
            projectId: String(project.id),
          }
          const bindingsChanged = reconcileProjectSpaceTaskBindings(
            currentProject,
            snapshot.taskBindings.map(binding => ({
              deviceId: binding.deviceId,
              taskId: binding.taskId,
            }))
          )
          if (bindingsChanged) setTaskBindingRevision(value => value + 1)
          if (project.project_store !== 'local') return snapshot
          return {
            ...snapshot,
            items: projectBoundRuntimeTaskStatuses(
              snapshot.items as unknown as CloudLoopItem[],
              snapshot.taskBindings.map(binding => ({
                loop_item_id: binding.issueId,
                device_id: binding.deviceId,
                task_id: binding.taskId,
              })),
              runtimeTaskLifecycleRef.current
            ) as unknown as CollaborationIssue[],
          }
        },
      },
    }),
    [api, hasFullWorkspaceAccess, project.id, project.project_store, workspace.id]
  )
  const projectHost = useMemo<CollaborationHostAdapter>(
    () => ({
      capabilities: {
        automation: true,
        dingtalkAitable: true,
        projectLocation: project.project_store === 'local' ? 'local' : 'cloud',
      },
      location: {
        projectId: String(project.id),
        issueId: location.issueId,
        view: location.projectView,
        rootView: 'home',
      },
      navigate: next => {
        setTaskComposer(current => (current?.issue.id === next.issueId ? current : null))
        setLocation(current => ({
          ...current,
          workspaceId: workspace.id,
          workspaceView: 'projects',
          projectId: next.projectId,
          projectView: next.view,
          issueId: next.issueId,
        }))
        if (!next.issueId && focusedItemId) onFocusedItemHandled?.()
      },
      projectAgentConfiguration:
        project.project_store === 'local'
          ? {
              ...weworkProjectAgentConfigurationHost,
              supportsExistingAgentSelection: false,
              renderProjectAgentForm:
                services.localProjectChatAgentApi && detailServices
                  ? form => (
                      <LocalProjectAgentForm
                        key={form.agentId ?? 'new'}
                        {...form}
                        api={services.localProjectChatAgentApi!}
                        catalog={detailServices}
                        projectId={String(project.id)}
                        projects={localProjects}
                      />
                    )
                  : undefined,
            }
          : createWeworkProjectAgentConfigurationHost(services.agentResourceApi),
    }),
    [
      focusedItemId,
      location.issueId,
      location.projectView,
      onFocusedItemHandled,
      project.id,
      project.project_store,
      services.agentResourceApi,
      services.localProjectChatAgentApi,
      detailServices,
      localProjects,
      setLocation,
      workspace.id,
    ]
  )
  const editorProject = useMemo(
    () =>
      ({
        ...project,
        location: project.project_store === 'local' ? 'local' : 'cloud',
      }) as unknown as CloudProject,
    [project]
  )
  const runtimeRunningByAddress = useMemo(() => {
    const running = new Map<string, boolean>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(item => item.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const runtimeWorkspace of workspaces) {
      for (const task of runtimeWorkspace.tasks) {
        running.set(
          runtimeConversationKey({
            deviceId: runtimeWorkspace.deviceId,
            taskId: task.taskId,
          }),
          isRuntimeTaskExecutionRunning(task)
        )
      }
    }
    for (const lifecycle of runtimeTaskLifecycle?.tasks.values() ?? []) {
      running.set(
        runtimeConversationKey(lifecycle.address),
        lifecycle.execution.running || lifecycle.turn.active
      )
    }
    return running
  }, [runtimeTaskLifecycle, runtimeWork])
  // Stop any in-flight run bound to the Issue before it leaves the board, so a
  // deleted Issue never keeps an orphaned execution running on a device.
  const prepareIssueDelete = useCallback(
    async (issue: CollaborationIssue) => {
      if (!onCancelRuntimeTask) return
      const bindings = await scopedApi.taskBindings.list(issue.id)
      const running = bindings.filter(
        binding =>
          runtimeRunningByAddress.get(
            runtimeConversationKey({ deviceId: binding.deviceId, taskId: binding.taskId })
          ) ?? false
      )
      await Promise.all(
        running.map(binding =>
          onCancelRuntimeTask({ deviceId: binding.deviceId, taskId: binding.taskId })
        )
      )
    },
    [onCancelRuntimeTask, runtimeRunningByAddress, scopedApi]
  )
  const runtimeTaskStatusSignature =
    project.project_store === 'local'
      ? ''
      : projectRuntimeStatusSignature(runtimeTaskLifecycle, {
          projectStore: project.project_store,
          projectId: String(project.id),
        })
  const localRuntimeLifecycleVersion =
    project.project_store === 'local' ? runtimeTaskLifecycle?.version : undefined
  const previousLocalRuntimeRef = useRef({
    projectId: project.project_store === 'local' ? String(project.id) : null,
    version: localRuntimeLifecycleVersion,
  })

  useEffect(() => {
    if (!runtimeTaskStatusSignature) return
    const timeouts = PROJECT_STATUS_REFRESH_DELAYS_MS.map(delay =>
      window.setTimeout(() => {
        setRefreshProjectRequestKey(value => value + 1)
      }, delay)
    )
    return () => {
      for (const timeout of timeouts) window.clearTimeout(timeout)
    }
  }, [runtimeTaskStatusSignature])

  useEffect(() => {
    const projectId = project.project_store === 'local' ? String(project.id) : null
    const previous = previousLocalRuntimeRef.current
    previousLocalRuntimeRef.current = {
      projectId,
      version: localRuntimeLifecycleVersion,
    }
    if (
      projectId === null ||
      localRuntimeLifecycleVersion === undefined ||
      previous.projectId !== projectId ||
      previous.version === localRuntimeLifecycleVersion
    ) {
      return
    }
    const timeouts = PROJECT_STATUS_REFRESH_DELAYS_MS.map(delay =>
      window.setTimeout(() => {
        setRefreshProjectRequestKey(value => value + 1)
      }, delay)
    )
    return () => {
      for (const timeout of timeouts) window.clearTimeout(timeout)
    }
  }, [localRuntimeLifecycleVersion, project.id, project.project_store])

  useEffect(
    () =>
      subscribeProjectSpaceTaskBindingChanged(change => {
        if (
          !sameProjectSpace(change.project, {
            projectStore: project.project_store,
            projectId: String(project.id),
          })
        ) {
          return
        }
        setTaskBindingRevision(value => value + 1)
        setRefreshProjectRequestKey(value => value + 1)
      }),
    [project.id, project.project_store]
  )

  useEffect(
    () =>
      subscribeProjectSpaceTaskContextChanged(change => {
        if (
          !sameProjectSpace(change.project, {
            projectStore: project.project_store,
            projectId: String(project.id),
          })
        ) {
          return
        }
        setRefreshProjectRequestKey(value => value + 1)
      }),
    [project.id, project.project_store]
  )

  useEffect(() => {
    const subscribe = detailServices?.projectChatClient?.subscribeLoopItemChanges
    if (!subscribe) return
    let active = true
    let unsubscribe: (() => void) | undefined
    void subscribe(event => {
      if (!active || event.projectId !== String(project.id)) return
      setRefreshProjectRequestKey(value => value + 1)
    })
      .then(release => {
        if (!active) {
          release()
          return
        }
        unsubscribe = release
      })
      .catch(error => {
        if (!active) return
        console.warn('[Wework collaboration] issue-change subscription failed', error)
      })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [detailServices?.projectChatClient, project.id])

  const conversationPanel =
    taskComposer && runtimePort ? (
      <AiChatModal
        key={taskComposer.conversationKey}
        project={project as unknown as CloudProject}
        localProjects={localProjects}
        task={taskComposer.issue as unknown as CloudLoopItem}
        open
        embedded
        initialTaskInput={taskComposer.issue.description || taskComposer.issue.title}
        initialAddress={taskComposer.address}
        workflowNodeId={taskComposer.workflowStep}
        onClose={() => setTaskComposer(null)}
        onAddressChange={address => {
          setTaskComposer(current =>
            current?.conversationKey === taskComposer.conversationKey
              ? { ...current, address }
              : current
          )
        }}
        onOpenRuntimeTask={onOpenRuntimeTask}
        prepareTask={async address => {
          await runtimePort.bindTask(
            taskComposer.issue.id,
            address,
            taskComposer.issue.title,
            taskComposer.workflowStep
          )
          const projectRef = {
            projectStore: project.project_store,
            projectId: String(project.id),
          }
          publishProjectSpaceTaskBindingChanged({
            task: address,
            project: projectRef,
            type: 'bound',
          })
          return async () => {
            await runtimePort.unbindTask(taskComposer.issue.id, address)
            publishProjectSpaceTaskBindingChanged({
              task: address,
              project: projectRef,
              type: 'unbound',
            })
          }
        }}
        onTaskCreated={async address => {
          setTaskComposer(current =>
            current?.conversationKey === taskComposer.conversationKey
              ? { ...current, address }
              : current
          )
          const latest = await api.issues.get(taskComposer.issue.id)
          if (latest.status === 'inbox') {
            await api.issues.update(latest.id, {
              version: latest.version,
              status: 'pending',
            })
          }
          setRefreshProjectRequestKey(value => value + 1)
        }}
      />
    ) : null

  return (
    <div
      className="issue-drawer-workspace flex h-full min-h-0 min-w-0"
      data-testid="issue-drawer-workspace"
    >
      <div className="min-w-0 flex-1">
        <CollaborationApp
          api={scopedApi}
          host={projectHost}
          locale={locale}
          showProjectBack={false}
          refreshProjectRequestKey={refreshProjectRequestKey}
          issueDeleteEnabled
          onPrepareIssueDelete={prepareIssueDelete}
          onCreateTask={
            runtimePort
              ? (_taskProject, issue, workflowStep) => {
                  setTaskComposer({ issue, workflowStep, conversationKey: `${issue.id}:new` })
                  projectHost.navigate({ ...projectHost.location, issueId: issue.id })
                }
              : undefined
          }
          renderIssueDetail={({
            api: issueApi,
            issue,
            allIssues,
            assignments,
            taskBindings,
            onChange,
            onClose,
            onCreateTask,
            onDelete,
          }) => (
            <IssueConversationDrawers
              label={createCollaborationTranslator(locale)('todo.issue_details')}
              conversation={taskComposer?.issue.id === issue.id ? conversationPanel : null}
              conversationKey={taskComposer?.conversationKey}
              onClose={() => {
                setTaskComposer(null)
                onClose()
              }}
              onCloseConversation={() => setTaskComposer(null)}
            >
              {closeDrawers => (
                <TodoEditor
                  key={issue.id}
                  mode="edit"
                  sharedApi={issueApi}
                  presentation="workspace-panel"
                  workspacePanelFill
                  readFirst
                  showPanelControls
                  showFullscreenControl={false}
                  item={issue as unknown as CloudLoopItem}
                  project={editorProject}
                  allItems={allIssues as unknown as CloudLoopItem[]}
                  projectChatAgentApi={detailServices?.projectChatAgentApi}
                  projectAutomationApi={
                    project.project_store === 'local'
                      ? detailServices?.projectAutomationApi
                      : undefined
                  }
                  teamApi={services.teamApi}
                  projectChatClient={detailServices?.projectChatClient}
                  selfManagedExecution={project.project_store === 'local'}
                  currentUserId={userId}
                  currentAssignment={
                    assignments
                      .filter(assignment => assignment.status === 'active')
                      .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
                      .at(-1) ?? null
                  }
                  localProjects={localProjects}
                  showAdditionalTaskAction={
                    taskBindings.length > 0 &&
                    issue.workflow?.advancement_policy !== 'ai' &&
                    !issue.workflow?.nodes?.length
                  }
                  initialTaskBindings={taskBindings.map(toWeworkIssueTaskBinding)}
                  aitableApi={
                    project.task_provider === 'dingtalk_aitable' ? services.aitableApi : undefined
                  }
                  onCreateTask={onCreateTask}
                  onDelete={onDelete}
                  onOpenTaskConversation={
                    runtimePort
                      ? task =>
                          setTaskComposer({
                            issue,
                            conversationKey: `${issue.id}:${task.device_id}:${task.task_id}`,
                            address: {
                              deviceId: task.device_id,
                              taskId: task.task_id,
                            },
                          })
                      : onOpenRuntimeTask
                        ? task =>
                            onOpenRuntimeTask({
                              deviceId: task.device_id,
                              taskId: task.task_id,
                            })
                        : undefined
                  }
                  onEscape={
                    taskComposer?.issue.id === issue.id ? () => setTaskComposer(null) : closeDrawers
                  }
                  onUpdated={updated => onChange(updated as unknown as CollaborationIssue)}
                  onClose={closeDrawers}
                />
              )}
            </IssueConversationDrawers>
          )}
          renderBoardIssueCard={({
            display,
            focused,
            issue,
            onOpen,
            onDelete,
            onMarkRead,
            taskBindings,
          }) => {
            const boardTaskBindings = taskBindings.map(
              binding =>
                ({
                  id: binding.id,
                  device_id: binding.deviceId,
                  task_id: binding.taskId,
                  task_title: binding.taskTitle,
                  workflow_node_id: binding.workflowNodeId,
                  running:
                    runtimeRunningByAddress.get(
                      runtimeConversationKey({
                        deviceId: binding.deviceId,
                        taskId: binding.taskId,
                      })
                    ) ?? false,
                  modelSelection: binding.modelSelection,
                }) as CloudTodoBoardTaskBinding
            )
            return (
              <div className="w-full" data-testid={collaborationTestIds.issue(issue.id)}>
                <CloudTodoBoardCard
                  item={
                    {
                      ...issue,
                      project_store: project.project_store,
                    } as unknown as CloudLoopItem
                  }
                  taskBindings={boardTaskBindings}
                  onClick={onOpen}
                  onArchive={onDelete ?? (() => undefined)}
                  archiveLabel={t('todo.delete_issue', '删除任务')}
                  onMarkRead={onMarkRead}
                  previewPinned={pinnedProgressIssueId === issue.id}
                  previewDisabled={Boolean(location.issueId)}
                  onPreviewPinnedChange={pinned =>
                    setPinnedProgressIssueId(pinned ? issue.id : null)
                  }
                  onOpenRuntimeTask={
                    runtimePort
                      ? address => {
                          setTaskComposer({
                            issue,
                            address,
                            conversationKey: `${issue.id}:${address.deviceId}:${address.taskId}`,
                          })
                          projectHost.navigate({ ...projectHost.location, issueId: issue.id })
                        }
                      : onOpenRuntimeTask
                  }
                  display={display}
                  processingStatus={issue.status === 'in_progress' || issue.status === 'in_review'}
                  archiveDisabled={!onDelete}
                  progressDisplay={focused ? 'focused' : 'compact'}
                />
              </div>
            )
          }}
        />
      </div>
    </div>
  )
}

export function WeworkCollaborationPlatform(props: WeworkCollaborationPlatformProps) {
  const { i18n } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const [cloudLoginOpen, setCloudLoginOpen] = useState(false)
  const api = props.services.sharedWorkspaceApi
  const locale = useMemo(() => (i18n.language.startsWith('zh') ? 'zh-CN' : 'en'), [i18n.language])
  const collaborationUserName =
    props.user.user_name.trim().toLowerCase() === 'local'
      ? locale === 'zh-CN'
        ? '本地用户'
        : 'Local user'
      : props.user.user_name
  const personalOwnerLabel = locale === 'zh-CN' ? '个人' : 'Personal'
  const [ownerGroups, setOwnerGroups] = useState<Array<{ label: string; namespace: string }>>([])
  const workspaceOwnerOptions = useMemo(
    () => [{ label: personalOwnerLabel, namespace: 'default' }, ...ownerGroups],
    [ownerGroups, personalOwnerLabel]
  )
  const projectAgentConfiguration = useMemo(
    () =>
      createWeworkProjectAgentConfigurationHost(
        props.services.agentResourceApi,
        props.services.localProjectChatAgentApi,
        props.services.projectSpaceDetailServices?.local?.modelApi,
        props.services.projectSpaceDetailServices?.local?.pluginApi
      ),
    [
      props.services.agentResourceApi,
      props.services.projectSpaceDetailServices?.local?.modelApi,
      props.services.projectSpaceDetailServices?.local?.pluginApi,
      props.services.localProjectChatAgentApi,
    ]
  )
  useEffect(() => {
    let active = true
    const agentResourceApi = props.services.agentResourceApi
    if (!agentResourceApi?.listOwnerGroups) return
    void agentResourceApi
      .listOwnerGroups()
      .then(groups => {
        if (!active) return
        setOwnerGroups(
          groups.map(group => ({
            label: group.displayName,
            namespace: group.name,
          }))
        )
      })
      .catch(() => {
        if (active) setOwnerGroups([])
      })
    return () => {
      active = false
    }
  }, [props.services.agentResourceApi])
  const localProjectApi = useMemo(
    () =>
      createLocalWorkspaceApi(
        props.services.projectSpaceApis?.local,
        Number(props.user.id),
        collaborationUserName,
        props.user.email ?? null,
        props.services.projectSpaceDetailServices?.local,
        locale
      ),
    [
      props.services.projectSpaceApis?.local,
      props.services.projectSpaceDetailServices?.local,
      props.user.email,
      props.user.id,
      collaborationUserName,
      locale,
    ]
  )
  const platformApi = useMemo(
    () =>
      createWeworkPlatformApi(
        api,
        props.services.projectSpaceApis?.local,
        Number(props.user.id),
        collaborationUserName,
        props.user.email ?? null,
        props.services.projectSpaceDetailServices?.local,
        locale
      ),
    [
      api,
      props.services.projectSpaceApis?.local,
      props.services.projectSpaceDetailServices?.local,
      props.user.email,
      props.user.id,
      collaborationUserName,
      locale,
    ]
  )
  const navigationApis = useMemo(
    () =>
      [localProjectApi, api?.workspaces ? withoutDefaultWorkItemProject(api) : undefined].filter(
        (candidate): candidate is SharedWorkspaceApi => Boolean(candidate)
      ),
    [api, localProjectApi]
  )
  const activeProject =
    String(props.activeProjectRef?.projectId) === DEFAULT_WORK_ITEM_PROJECT_ID
      ? null
      : (props.activeProjectRef ?? null)
  const [location, setLocation] = useState<CollaborationPlatformLocation>(initialLocation)
  const [navigationSyncRevision, setNavigationSyncRevision] = useState(0)
  const startupReadySent = useRef(false)
  const pendingNavigationProjectIdRef = useRef<string | null | undefined>(undefined)
  const navigationRequestRevisionRef = useRef(0)

  useEffect(() => {
    const activeProjectId = activeProject ? String(activeProject.projectId) : null
    if (pendingNavigationProjectIdRef.current !== undefined) {
      if (pendingNavigationProjectIdRef.current !== activeProjectId) return
      pendingNavigationProjectIdRef.current = undefined
    }
    if (!platformApi?.projects.get || !activeProject) return
    if (String(location.projectId) === activeProjectId) return

    let cancelled = false
    void platformApi.projects.get(String(activeProject.projectId)).then(project => {
      if (cancelled || !project.workspace_id) return
      setLocation(current => ({
        ...current,
        workspaceId: project.workspace_id ?? null,
        workspaceView: 'projects',
        projectId: String(project.id),
        projectView: 'board',
        issueId: props.focusedItemId ?? null,
      }))
    })
    return () => {
      cancelled = true
    }
  }, [activeProject, location.projectId, navigationSyncRevision, platformApi, props.focusedItemId])

  const platformRouteReady =
    !activeProject || String(location.projectId) === String(activeProject.projectId)
  const handleReady = useCallback(() => {
    if (
      !props.startupActive ||
      !platformRouteReady ||
      startupReadySent.current ||
      !isElectronRuntime() ||
      getDesktopWindowLabel() !== 'main'
    ) {
      return
    }
    startupReadySent.current = true
    void invokeDesktopHost<void>('renderer.startupReady').catch(error => {
      console.error('[Wework] Failed to reveal the ready collaboration space', error)
    })
  }, [platformRouteReady, props.startupActive])
  if (!platformApi) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        协作服务当前不可用
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex-1" data-testid="wework-collaboration-platform">
      {cloudLoginOpen && (
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={0}
          onClose={() => setCloudLoginOpen(false)}
          onOpenSettings={() => {
            setCloudLoginOpen(false)
            props.onOpenSettings?.({ settingsPage: 'connections' })
          }}
        />
      )}
      <CollaborationPlatformApp
        api={platformApi}
        refreshKey={JSON.stringify([
          props.startupActive,
          props.localProjects.map(project => [project.id, project.name]),
        ])}
        navigationApis={navigationApis}
        locale={locale}
        onReady={handleReady}
        host={{
          cloudAccess: {
            authenticated: cloudConnection.isConnected,
            requestLogin: () => setCloudLoginOpen(true),
          },
          renderIssueComposer: props => <WeworkIssueHomeComposer {...props} />,
          location,
          capabilities: {
            automation: true,
            dingtalkAitable: true,
            projectLocation: location.workspaceId === LOCAL_WORKSPACE_ID ? 'local' : 'cloud',
            workspaceLocations: ['local', 'cloud'],
            sidebarPresentation: 'full',
          },
          navigate: nextLocation => {
            const navigationRevision = ++navigationRequestRevisionRef.current
            if (props.onActiveProjectChange) {
              pendingNavigationProjectIdRef.current = nextLocation.projectId
                ? String(nextLocation.projectId)
                : null
            }
            setLocation(nextLocation)
            if (!nextLocation.projectId) {
              props.onActiveProjectChange?.(null)
              return
            }
            const requestedProjectId = String(nextLocation.projectId)
            void platformApi.projects
              .get(requestedProjectId)
              .then(project => {
                if (navigationRequestRevisionRef.current !== navigationRevision) return
                props.onActiveProjectChange?.({
                  ...project,
                  location: project.project_store === 'local' ? 'local' : 'cloud',
                })
              })
              .catch(() => {
                if (navigationRequestRevisionRef.current !== navigationRevision) return
                pendingNavigationProjectIdRef.current = undefined
                setNavigationSyncRevision(value => value + 1)
              })
          },
          manageResource: (kind, resourceId, source) => {
            if (kind === 'environments') {
              props.onOpenSettings?.(resolveDeviceResourceSettingsOptions(resourceId, source))
              return
            }
            setLocation(current => ({
              ...current,
              rootView: current.workspaceId ? current.rootView : 'agents',
              workspaceView: current.workspaceId ? 'agents' : 'home',
              projectId: null,
              issueId: null,
            }))
          },
          renderDeviceCreator: ({ source, hasCloudDevice, onClose, onCreated }) =>
            source === 'cloud' ? (
              <AddCloudDeviceDialog
                open
                cloudConnection={cloudConnection}
                hasCloudDevice={hasCloudDevice}
                onClose={onClose}
                onCreated={(_devices, createdDeviceId) => onCreated(createdDeviceId)}
              />
            ) : (
              <div
                className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4"
                data-testid="local-device-resource-dialog"
                role="presentation"
                onClick={event => {
                  if (event.target === event.currentTarget) onClose()
                }}
              >
                <section
                  aria-modal="true"
                  className="w-full max-w-lg rounded-lg border border-border bg-popover p-5 shadow-lg"
                  role="dialog"
                >
                  <h2 className="text-sm font-semibold text-text-primary">
                    {locale === 'zh-CN' ? '本地设备' : 'Local device'}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    {locale === 'zh-CN'
                      ? '当前设备已自动加入本地空间，无需重复创建。安装并启用本机执行环境后，智能体和协作小组即可在这台设备上运行。'
                      : 'This device is already part of the local space. Install and enable its execution environments to run Agents and teams locally.'}
                  </p>
                  <div className="mt-5 flex justify-end">
                    <button
                      className="inline-flex h-8 items-center rounded-md bg-text-primary px-4 text-sm text-background"
                      data-testid="local-device-resource-confirm"
                      onClick={onClose}
                      type="button"
                    >
                      {locale === 'zh-CN' ? '知道了' : 'Done'}
                    </button>
                  </div>
                </section>
              </div>
            ),
          workspaceOwnerOptions,
          projectAgentConfiguration,
        }}
        sidebarFooter={
          props.onOpenSettings && props.onLogout ? (
            <DesktopSidebarAccount
              user={props.user}
              onOpenSettings={props.onOpenSettings}
              onLogout={props.onLogout}
            />
          ) : null
        }
        renderProject={({ project, workspace }) => {
          const projectApi = project.project_store === 'local' ? localProjectApi : api
          if (!projectApi) return null
          const localDeliveryApi = props.services.projectSpaceApis?.local
          const runtimePort =
            project.project_store === 'local' && localDeliveryApi
              ? {
                  bindTask: localDeliveryApi.bindTask,
                  unbindTask: localDeliveryApi.unbindTask,
                }
              : props.services.workspaceRuntimePort
          return (
            <WeworkSharedProject
              api={projectApi}
              detailServices={
                props.services.projectSpaceDetailServices?.[
                  project.project_store === 'local' ? 'local' : 'cloud'
                ]
              }
              focusedItemId={props.focusedItemId}
              localProjects={props.localProjects}
              locale={locale}
              location={location}
              onFocusedItemHandled={props.onFocusedItemHandled}
              onOpenRuntimeTask={props.onOpenRuntimeTask}
              project={project}
              runtimeTaskLifecycle={props.runtimeTaskLifecycle}
              runtimeWork={props.runtimeWork}
              runtimePort={runtimePort}
              services={props.services}
              setLocation={setLocation}
              userId={props.user.id}
              workspace={workspace}
            />
          )
        }}
      />
    </div>
  )
}
import { WeworkIssueHomeComposer } from './WeworkIssueHomeComposer'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
