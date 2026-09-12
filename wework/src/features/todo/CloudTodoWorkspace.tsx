import { useAssignmentNotificationChoice } from '@/features/notifications/useAssignmentNotificationChoice'
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Ellipsis,
  File,
  Grid3X3,
  HardDrive,
  ListTodo,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  Search,
  X,
} from 'lucide-react'
import type {
  CloudLoopItem,
  CloudLoopItemAttachment,
  CloudProject,
  CloudProjectMember,
  PullRequestAutoRepairStatus,
  WorkflowExecutionConfig,
} from '@/api/deliveries'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import type { AITableField } from '@/api/aitable'
import { ApiError } from '@/api/http'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import {
  CollaborationProjectViewShell,
  ProjectIssueTable,
  ProjectCreateDialog,
  ProjectSpaceSidebar,
  projectCreateLabels,
  useCollaborationWorkspaceController,
  useIssueAssignmentsByIssueId,
  type CollaborationIssue,
  type CollaborationProject,
  type ProjectCreateTarget,
  type SharedWorkspaceApi,
  type CollaborationProjectView,
  type WorkspaceTaskBinding,
} from '@wegent/collaboration'
import {
  createStandardCloudBoardColumns,
  executeStandardCloudBoardMutation,
  ProjectBoardBody,
  useStandardCloudBoardController,
  type ProjectBoardColumn,
  type ProjectBoardGroupBy,
  type StandardCloudBoardMutation,
  type StandardCloudBoardMutationUpdate,
} from '@wegent/collaboration/project-board'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import {
  DesktopSidebarAccount,
  type DesktopSidebarAccountSettingsOptions,
} from '@/components/layout/DesktopSidebarAccount'
import { DesktopSidebarHeader } from '@/components/layout/DesktopSidebarPrimitives'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { ActionMenu } from '@/components/common/ActionMenu'
import { Tooltip } from '@/components/ui/tooltip'
import type { ArchiveRuntimeConversationsResult } from '@/features/workbench/workbenchContextTypes'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotAvailable } from '@/features/dsh-runtime/useDshSlotAvailable'
import type { DeliveryApi, WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { runtimeTaskProjectUiId } from '@/lib/runtime-task-workspace-binding'
import { cn } from '@/lib/utils'
import { track } from '@/telemetry/client'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import {
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import {
  getChangeRequestMonitor,
  runtimeTaskChangeRequestTarget,
  useTaskChangeRequest,
  type ChangeRequestMonitor,
} from '@/features/workbench/changeRequestMonitor'
import {
  autoRepairStatus,
  buildChangeRequestRepairPrompt,
  changeRequestRepairEventKey,
  claimChangeRequestAutoRepair,
  completeChangeRequestAutoRepair,
} from '@/features/workbench/changeRequestStatus'
import {
  isRuntimePaneTranscriptConfirmedIdle,
  isRuntimeTaskExecutionRunning,
  projectRuntimePaneTranscript,
  runtimeTaskTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import {
  findRuntimeTask,
  hydrateRuntimeTaskAddress,
} from '@/features/workbench/workbenchRuntimeHelpers'
import { AITableView } from '@/features/todo/AITableView'
import {
  AutomationSelectionDialog,
  type AutomationSelectionCandidate,
} from '@/features/todo/AutomationSelectionDialog'
import type {
  CloneGitRepositoryInput,
  CreatedRuntimeProject,
  ModelSelectionConfig,
  ProjectWithTasks,
  RuntimeProjectSpaceRef,
  RuntimeGoal,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import { CloudTodoModal as Modal } from './CloudTodoModal'
import {
  effectiveWorkflowNodeExecutionConfig,
  itemNeedsExecutionConfiguration,
} from './workflowExecutionConfig'
import {
  CloudTodoBoardCard,
  CloudTodoCardContent,
  type BoardCardDisplaySettings,
  type BoardCardProgressDisplay,
  type CloudTodoBoardTaskBinding,
} from './CloudTodoBoardCard'
import { CloudProjectManageView, LocalProjectManageView } from './CloudProjectManageView'
import { waitForDwsAuthentication } from './dwsAuth'
import { ProjectAutomationView } from './ProjectAutomationView'
import {
  canEditProjectSpaceIssue,
  type LocatedProjectSpace,
  publishProjectSpaceTaskBindingChanged,
  projectSpaceKey,
  projectSpaceRef,
  projectSupportsRobotAutomation,
  sameProjectSpace,
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
} from './projectSpaceSelection'
import { CloudFilesView, LocalFilesView } from './CloudFilesView'
import { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'
import { GlobalTodoSearch } from './GlobalTodoSearch'
import { BoardQuickCreate } from './BoardQuickCreate'
import { BoardQuickStartGuide } from './BoardQuickStartGuide'
import { parseDingTalkAITableLink } from './projectProviderConfig'
import { createWeworkDeliverySharedWorkspaceApi } from '@/features/collaboration'
import { isLoopItemExecutionActive } from './cloudMyWorkModel'
import { rememberProjectTaskStore } from '@/features/workbench/projectTaskTracking'
import { TaskSearchPanel } from './TaskSearchPanel'
import { TodoEditor } from './TodoEditor'
import {
  IssueExecutionConfigDialog,
  type IssueExecutionConfigResult,
} from './IssueExecutionConfigDialog'
import { IssueComposer } from './IssueComposer'
import { issueDraftFromText } from './issueComposerDraft'
import { preferNewestLoopItemSnapshot } from '@/api/issueWorkflow'
import { associateLoopItemTags, loopItemLocalProject } from '@/api/localProjectAssociation'
import { emptyTaskSearchFilters, type TaskSearchFilters } from './taskSearch'
import { boardStatusColorClasses, columnDotClasses, columns } from './todoShared'
import { AiChatModal } from './AiChatModal'
import { BackgroundTaskStarter } from './BackgroundTaskStarter'
import {
  shouldPrepareWorkItemTask,
  shouldRevealWorkItemWorkflowActions,
  workItemTaskInput,
} from './workItemTaskInput'
import {
  isRuntimeMyWorkItem,
  mergeRuntimeMyWorkItems,
  projectBoundRuntimeTaskStatuses,
  runtimeMyWorkItems,
  runtimeWorkItemReference,
} from './runtimeMyWork'
type ProjectView = Extract<
  CollaborationProjectView,
  'board' | 'table' | 'files' | 'automation' | 'manage'
>
type WeworkStandardBoardUpdate = Omit<StandardCloudBoardMutationUpdate, 'priority'> & {
  priority?: CollaborationIssue['priority']
} & Partial<IssueExecutionConfigResult> & {
    automation_rule_id?: string
  }

function IssueResourceSection({
  icon,
  title,
  count,
  empty,
  children,
}: {
  icon: ReactNode
  title: string
  count: number
  empty: string
  children: ReactNode
}) {
  return (
    <section className="task-conversation-resource-section">
      <header className="task-conversation-resource-heading">
        <span className="text-text-muted">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="task-conversation-resource-count">{count}</span>
      </header>
      {count > 0 ? (
        <div className="space-y-0.5 px-2 pb-2">{children}</div>
      ) : (
        <p className="px-4 pb-3 text-xs text-text-muted">{empty}</p>
      )}
    </section>
  )
}

function formatCompactFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
type NativeBoardGroupBy = ProjectBoardGroupBy
type PendingExecutionConfiguration = {
  item: LocatedLoopItem
  continuation:
    | {
        type: 'move'
        column: ProjectBoardColumn
        beforeItemId: string | null
        mutation: StandardCloudBoardMutation<LocatedLoopItem>
      }
    | {
        type: 'save'
        afterSave?: (item: LocatedLoopItem) => void
      }
}
type ExecutionConfigurationRequestResult = 'not-needed' | 'opened' | 'unavailable'

const nativeBoardGroupFields: AITableField[] = [
  { id: 'status', name: '状态', type: 'status', config: null, raw: {} },
  { id: 'priority', name: '优先级', type: 'singleSelect', config: null, raw: {} },
  { id: 'assignee', name: '负责人', type: 'user', config: null, raw: {} },
  { id: 'tag', name: '标签', type: 'tag', config: null, raw: {} },
]

function taskBindingWorkflowNodeId(
  binding: WorkspaceTaskBinding | LoopItemTaskBinding
): string | null | undefined {
  const legacyBinding = binding as LoopItemTaskBinding
  return legacyBinding.workflow_node_id ?? (binding as WorkspaceTaskBinding).workflowNodeId
}

function taskBindingAddress(
  binding: WorkspaceTaskBinding | LoopItemTaskBinding
): RuntimeTaskAddress {
  return 'device_id' in binding
    ? { deviceId: binding.device_id, taskId: binding.task_id }
    : { deviceId: binding.deviceId, taskId: binding.taskId }
}

function workflowStageInstruction(
  context:
    | Awaited<ReturnType<SharedWorkspaceApi['workflowPlans']['getStageContext']>>
    | Awaited<ReturnType<DeliveryApi['getWorkflowStageContext']>>
    | null
): string {
  if (!context) return ''
  const instruction =
    'compiled_task_instruction' in context
      ? context.compiled_task_instruction
      : context.compiledTaskInstruction
  return typeof instruction === 'string' ? instruction : ''
}

const nativeBoardStatusColors: Record<
  CloudLoopItem['status'],
  'gray' | 'blue' | 'orange' | 'purple' | 'green'
> = {
  inbox: 'gray',
  pending: 'blue',
  in_progress: 'orange',
  in_review: 'purple',
  completed: 'green',
}
const localExternalBoardStatuses = [
  'inbox',
  'pending',
  'in_progress',
  'in_review',
  'completed',
] as const
const externalBoardColumnPageSize = 10

function aitableCellLabels(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return []
  return (Array.isArray(value) ? value : [value])
    .map(entry => {
      if (typeof entry === 'object' && entry !== null) {
        const object = entry as Record<string, unknown>
        return String(object.name ?? object.title ?? object.text ?? '')
      }
      return String(entry)
    })
    .filter(Boolean)
}

function AITableGroupFieldPicker({
  fields,
  value,
  onChange,
  testIdPrefix = 'dingtalk-board-group',
  searchPlaceholder = '搜索表格字段',
}: {
  fields: AITableField[]
  value: string
  onChange: (fieldId: string) => void
  testIdPrefix?: string
  searchPlaceholder?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 })
  const [query, setQuery] = useState('')
  const selected = fields.find(field => field.id === value)
  const visibleFields = fields
    .filter(field => `${field.name} ${field.type}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => {
      const recommended = (field: AITableField) =>
        /状态|负责人|优先级|所属项目/.test(field.name) ? 0 : 1
      return recommended(left) - recommended(right)
    })

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const closeOnScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', closeOnScroll, true)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('scroll', closeOnScroll, true)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const openMenu = () => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuWidth = 256
    const margin = 8
    const estimatedHeight = 320
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - menuWidth - margin))
    const below = Math.round(rect.bottom + 4)
    const top =
      below + estimatedHeight <= window.innerHeight - margin
        ? below
        : Math.max(margin, Math.round(rect.top - 4 - estimatedHeight))
    setMenuPosition({ left: Math.round(left), top })
    setOpen(true)
    setQuery('')
  }

  return (
    <div ref={rootRef} className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid={`${testIdPrefix}-by`}
        onClick={openMenu}
        className="flex h-8 min-w-32 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted"
        aria-expanded={open}
      >
        <span className="max-w-32 truncate">{selected?.name ?? '选择分组字段'}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              data-testid={`${testIdPrefix}-menu`}
              style={{ left: menuPosition.left, top: menuPosition.top }}
              className="fixed z-system-popover w-64 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-lg"
            >
              <label className="flex h-8 items-center gap-2 rounded-lg bg-muted px-2.5 text-text-muted">
                <Search className="h-3.5 w-3.5" />
                <input
                  autoFocus
                  data-testid={`${testIdPrefix}-search`}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none"
                />
              </label>
              <div className="mt-1 max-h-72 overflow-y-auto overscroll-contain">
                {visibleFields.map(field => (
                  <button
                    key={field.id}
                    type="button"
                    data-testid={`${testIdPrefix}-option-${field.id}`}
                    onClick={() => {
                      onChange(field.id)
                      setOpen(false)
                      setQuery('')
                    }}
                    className={cn(
                      'flex h-9 w-full items-center rounded-lg px-2.5 text-left text-sm hover:bg-muted',
                      field.id === value && 'bg-muted font-medium'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{field.name}</span>
                    <span className="ml-2 shrink-0 text-xs text-text-muted">{field.type}</span>
                    {field.id === value ? <Check className="ml-2 h-3.5 w-3.5" /> : null}
                  </button>
                ))}
                {visibleFields.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-text-muted">没有匹配字段</p>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

type LocatedCloudProject = LocatedProjectSpace
type LocatedLoopItem = CloudLoopItem & {
  project_store?: RuntimeProjectSpaceRef['projectStore']
}
type LoopItemTaskBinding = Awaited<ReturnType<DeliveryApi['listTaskBindings']>>[number]
type BoardReadResult = {
  items: CloudLoopItem[]
  task_bindings?: LoopItemTaskBinding[]
  members?: CloudProjectMember[]
  agents?: ProjectChatAgent[]
  page_cursors?: Record<string, string | null>
}

function toWeworkTaskBinding(binding: WorkspaceTaskBinding): LoopItemTaskBinding {
  return {
    id: binding.id,
    cloud_project_id: binding.projectId,
    loop_item_id: binding.issueId,
    task_user_id: binding.taskUserId,
    device_id: binding.deviceId,
    task_id: binding.taskId,
    task_title: binding.taskTitle,
    backend_task_id: binding.backendTaskId,
    modelSelection: binding.modelSelection as LoopItemTaskBinding['modelSelection'],
    workflow_node_id: binding.workflowNodeId,
    binding_type: binding.bindingType,
    linked_at: binding.linkedAt,
  }
}

function toWeworkCloudProject(project: CollaborationProject): CloudProject {
  return project as CloudProject
}

function toCloudLoopItem(issue: Awaited<ReturnType<SharedWorkspaceApi['issues']['get']>>) {
  return issue as CloudLoopItem
}

function modelSelectionFromExecutionConfig(
  config: WorkflowExecutionConfig | null | undefined
): ModelSelectionConfig | null {
  if (!config?.model) return null
  return {
    modelName: config.model,
    modelType: config.model_type,
    options: { ...config.model_options },
  }
}

function boardTaskModelSelection(
  item: CloudLoopItem,
  binding: CloudTodoBoardTaskBinding,
  runtimeWork: RuntimeWorkListResponse | null | undefined
): ModelSelectionConfig | null {
  if (binding.modelSelection) return binding.modelSelection

  const runtimeSelection = findRuntimeTask(runtimeWork, {
    deviceId: binding.device_id,
    taskId: binding.task_id,
  })?.modelSelection
  if (runtimeSelection) return runtimeSelection

  const workflowNode = item.workflow?.nodes.find(
    node =>
      node.id === binding.workflow_node_id ||
      String(node.task_binding_id ?? '') === String(binding.id) ||
      node.task_ids?.includes(binding.task_id)
  )
  if (item.workflow && workflowNode) {
    return modelSelectionFromExecutionConfig(
      effectiveWorkflowNodeExecutionConfig(item.workflow, workflowNode)
    )
  }
  return modelSelectionFromExecutionConfig(item.execution_config)
}

function withBoardTaskModelSelection(
  item: CloudLoopItem,
  binding: CloudTodoBoardTaskBinding,
  runtimeWork: RuntimeWorkListResponse | null | undefined
): CloudTodoBoardTaskBinding {
  return {
    ...binding,
    modelSelection: boardTaskModelSelection(item, binding, runtimeWork),
  }
}

function ProjectChangeRequestAutoRepairObserver({
  itemId,
  binding,
  monitor,
  statuses,
  onRepair,
}: {
  itemId: string
  binding: CloudTodoBoardTaskBinding
  monitor: ChangeRequestMonitor
  statuses: PullRequestAutoRepairStatus[]
  onRepair: (
    binding: CloudTodoBoardTaskBinding,
    snapshot: TaskChangeRequestSnapshot
  ) => Promise<void>
}) {
  const snapshot = useTaskChangeRequest(monitor, binding.changeRequestTarget ?? null)

  useEffect(() => {
    const changeRequest = snapshot?.changeRequest
    const status = changeRequest ? autoRepairStatus(changeRequest) : null
    if (!snapshot || !changeRequest || !status || !statuses.includes(status)) return
    const eventKey = `${itemId}\0${binding.task_id}\0${changeRequestRepairEventKey(changeRequest)}`
    if (!claimChangeRequestAutoRepair(eventKey)) return
    queueMicrotask(() => {
      void onRepair(binding, snapshot)
        .then(() => completeChangeRequestAutoRepair(eventKey, true))
        .catch(error => {
          completeChangeRequestAutoRepair(eventKey, false)
          console.error('[Wework change requests] Automatic repair failed', {
            itemId,
            taskId: binding.task_id,
            error,
          })
        })
    })
  }, [binding, itemId, onRepair, snapshot, statuses])

  return null
}
type SelectedTaskBinding = Pick<
  LoopItemTaskBinding,
  'id' | 'device_id' | 'task_id' | 'task_title'
> & {
  work_item_id: string
}
type TaskComposerRequest = {
  workItemId: string
  initialInput: string
  backgroundAfterSend: boolean
  taskRequest?: RuntimeTaskCreateRequest
  workflowNodeId?: string
  inheritFromTask?: RuntimeTaskAddress | null
}

export interface CloudTodoWorkspaceProps {
  user: UserProfile
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  services: WorkbenchServices
  embedded?: boolean
  embeddedTitle?: 'workspace' | 'project'
  startupActive?: boolean
  activeProjectRef?: RuntimeProjectSpaceRef | null
  defaultProjectRequested?: boolean
  focusedItemId?: string | null
  onFocusedItemHandled?: () => void
  onActiveProjectChange?: (project: LocatedCloudProject | null) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onCreateLocalCodeProject?: (data: {
    deviceId: string
    name: string
    roots: string[]
  }) => Promise<CreatedRuntimeProject>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory?: (deviceId: string, path: string) => Promise<void>
  onCloneGitRepository?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  onArchiveRuntimeTasks?: (
    addresses: RuntimeTaskAddress[]
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout?: () => void
}

function boardStatusFromDropId(id: string | number | undefined): string | null {
  if (typeof id !== 'string' || !id.startsWith('todo-column:')) return null
  return id.slice('todo-column:'.length) || null
}

// Signature of the complete first-screen snapshot. Live events or fallback
// polling compare against the last applied value so unchanged reads do not
// re-render the workspace or downstream views.
function boardSnapshotKey(
  projectKey: string,
  items: CloudLoopItem[],
  error: string | null,
  context?: {
    taskBindings: LoopItemTaskBinding[]
    members: CloudProjectMember[]
    agents: ProjectChatAgent[]
  }
): string {
  return `${projectKey}\u0000${error ?? ''}\u0000${JSON.stringify([items, context ?? null])}`
}

function boardCardIdFromDropId(id: string | number | undefined): string | null {
  if (typeof id !== 'string' || !id.startsWith('todo-card:')) return null
  return id.slice('todo-card:'.length)
}

// Cards sit inside their lane dropzone, so both match under the pointer.
// Prefer the card target: dropping on a card inserts before it, dropping on
// the lane itself appends at the end.
const boardCollisionDetection: CollisionDetection = args => {
  const collisions = pointerWithin(args)
  const cardCollision = collisions.find(collision => boardCardIdFromDropId(collision.id))
  return cardCollision ? [cardCollision] : collisions.slice(0, 1)
}

// Placeholder shown while a project's items load. Renders the familiar board
// column layout with pulsing blocks instead of content, matching the modern
// skeleton ("留白加载") pattern.
function CloudTodoBoardSkeleton() {
  return (
    <div
      data-testid="cloud-todo-board-loading"
      aria-busy="true"
      className="flex h-full min-h-0 items-start gap-3.5 px-6"
    >
      {columns.map((column, columnIndex) => (
        <section
          key={column.status}
          className="flex max-h-full w-[292px] shrink-0 flex-col rounded-2xl bg-muted p-0.5"
        >
          <header className="flex items-center px-2.5 pb-2 pt-1.5">
            <span className={cn('mr-2 h-2 w-2 rounded-full', columnDotClasses[column.status])} />
            <span className="text-sm font-semibold">{column.label}</span>
          </header>
          <div className="animate-pulse space-y-2 px-2 pb-2 pt-2">
            {Array.from({ length: columnIndex % 2 === 0 ? 2 : 1 }, (_, cardIndex) => (
              <div
                key={cardIndex}
                className="rounded-xl border border-border bg-background px-3 py-3 shadow-sm"
              >
                <div className="h-3 w-24 rounded-md bg-text-primary/10" />
                <div className="mt-2.5 h-4 w-4/5 rounded-md bg-text-primary/10" />
                <div className="mt-2.5 flex items-center gap-2">
                  <div className="h-4 w-12 rounded-full bg-text-primary/10" />
                  <div className="ml-auto h-3 w-9 rounded-md bg-text-primary/10" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function cloudProjectRequestError(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return cause instanceof Error ? cause.message : '创建项目空间失败'
  }
  if (cause.status === 422) {
    const payload = cause.detail as { errors?: Array<{ loc?: string[]; msg?: string }> } | undefined
    const fieldError = payload?.errors?.[0]
    return fieldError?.msg
      ? `${fieldError.loc?.at(-1) ?? '参数'}：${fieldError.msg}`
      : '项目标识只能包含 2–16 位字母和数字'
  }
  if (cause.status === 404) {
    return '项目空间接口返回 404，请重启当前分支的 Backend 后重试'
  }
  return cause.message || `创建项目空间失败（HTTP ${cause.status}）`
}

function automationSelectionCandidates(cause: unknown): AutomationSelectionCandidate[] | null {
  if (
    !(cause instanceof ApiError) ||
    cause.status !== 409 ||
    cause.errorCode !== 'automation_selection_required'
  ) {
    return null
  }
  const detail = cause.detail
  if (!detail || typeof detail !== 'object' || !('candidates' in detail)) return null
  const candidates = (detail as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates)) return null
  const normalized = candidates.flatMap(candidate => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !('id' in candidate) ||
      !('name' in candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string'
    ) {
      return []
    }
    return [
      {
        id: candidate.id,
        name: candidate.name,
        description:
          'description' in candidate && typeof candidate.description === 'string'
            ? candidate.description
            : '',
      },
    ]
  })
  return normalized.length > 1 ? normalized : null
}

export function CloudTodoWorkspace({
  user,
  localProjects,
  runtimeWork,
  runtimeTaskLifecycle,
  services,
  embedded = false,
  embeddedTitle = 'workspace',
  startupActive = false,
  activeProjectRef,
  defaultProjectRequested = false,
  focusedItemId,
  onFocusedItemHandled,
  onActiveProjectChange,
  onOpenRuntimeTask,
  onCreateLocalCodeProject,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onCloneGitRepository,
  onArchiveRuntimeTasks,
  onOpenSettings,
  onLogout,
}: CloudTodoWorkspaceProps) {
  const notificationChoice = useAssignmentNotificationChoice()
  const { t, i18n } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const taskStatusExtensionsAvailable = useDshSlotAvailable(WEWORK_DSH_SLOTS.taskStatus)
  const preferences = useAppPreferencesState()
  const changeRequestStatusEnabled =
    taskStatusExtensionsAvailable && (preferences?.preferences.changeRequestStatusEnabled ?? true)
  const changeRequestMonitor = useMemo(
    () =>
      changeRequestStatusEnabled && services.deviceApi
        ? getChangeRequestMonitor(services.deviceApi)
        : null,
    [changeRequestStatusEnabled, services.deviceApi]
  )
  const cloudWorkspaceApi = services.sharedWorkspaceApi
  const [internalSelectedProjectRef, setSelectedProjectRef] =
    useState<RuntimeProjectSpaceRef | null>(null)
  const requestedProjectRef =
    activeProjectRef === undefined ? internalSelectedProjectRef : activeProjectRef
  const activeProjectKey =
    activeProjectRef === undefined
      ? undefined
      : activeProjectRef
        ? projectSpaceKey(activeProjectRef)
        : null
  const [projectView, setProjectView] = useState<ProjectView>('board')
  const [selectedItem, setSelectedItem] = useState<LocatedLoopItem | null>(null)
  const [boardParentId, setBoardParentId] = useState<string | null>(null)
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
      view:
        projectView === 'files'
          ? 'files'
          : projectView === 'automation'
            ? 'automation'
            : projectView === 'manage'
              ? 'manage'
              : 'board',
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
  const availableProjectSpaceApis = useMemo(() => {
    const available: ProjectCreateTarget[] = []
    if (projectSpaceApis.local) {
      const localWorkspaceApi = createWeworkDeliverySharedWorkspaceApi(projectSpaceApis.local)
      available.push({
        location: 'local',
        create: localWorkspaceApi.projects.create,
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
    projectSpaceApis.local,
  ])
  const [localProjectSpaces, setLocalProjectSpaces] = useState<LocatedCloudProject[]>([])
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
  useEffect(() => {
    if (requestedProjectRef === null && defaultProject) {
      onActiveProjectChange?.(defaultProject)
    }
  }, [defaultProject, onActiveProjectChange, requestedProjectRef])
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
    [cloudWorkspace.commands]
  )
  const removeProjectFromList = useCallback((projectToRemove: LocatedCloudProject) => {
    if (projectToRemove.location === 'cloud') return
    const key = projectSpaceKey(projectSpaceRef(projectToRemove))
    setLocalProjectSpaces(current =>
      current.filter(project => projectSpaceKey(projectSpaceRef(project)) !== key)
    )
  }, [])
  const prependProject = useCallback(
    (project: LocatedCloudProject) => {
      if (project.location === 'cloud') {
        cloudWorkspace.commands.replaceProject(project as CollaborationProject)
        return
      }
      setLocalProjectSpaces(current => [project, ...current])
    },
    [cloudWorkspace.commands]
  )
  // These caches are local-project state only. Cloud projects are read
  // directly from the shared collaboration controller below.
  const [localProjectCounts, setLocalProjectCounts] = useState<Record<string, number>>({})
  const [localProjectMembers, setLocalProjectMembers] = useState<
    Record<string, CloudProjectMember[]>
  >({})
  // Active robots of the selected project, used to resolve the assignee name
  // of robot-assigned tasks (local loop items only carry the agent id).
  const [localProjectAgents, setLocalProjectAgents] = useState<Record<string, ProjectChatAgent[]>>(
    {}
  )
  // Every project's loop items, cached for the projects-home overview
  // (stats, recent activity). Keyed by project store and project id.
  const [localProjectItems, setLocalProjectItems] = useState<Record<string, CloudLoopItem[]>>({})
  const [items, setItems] = useState<LocatedLoopItem[]>([])
  const [localItemTaskBindings, setLocalItemTaskBindings] = useState<
    Record<string, LoopItemTaskBinding[]>
  >({})
  const [itemTaskBindingsProjectKey, setItemTaskBindingsProjectKey] = useState<string | null>(null)
  // Which project's items are currently in `items`. Anything else rendered on
  // the board would be stale, so the board shows the skeleton instead.
  const [itemsProjectKey, setItemsProjectKey] = useState<string | null>(null)
  const [localExternalPageCursors, setLocalExternalPageCursors] = useState<
    Record<string, string | null>
  >({})
  const [localExternalPageLoading, setLocalExternalPageLoading] = useState<Record<string, boolean>>(
    {}
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
  const [backgroundTaskItemId, setBackgroundTaskItemId] = useState<string | null>(null)
  // Items of the detail drawer's project when it differs from the board project,
  // so the drawer can stay open without switching the board view.
  const [detailItems, setDetailItems] = useState<LocatedLoopItem[]>([])
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createTodoOpen, setCreateTodoOpen] = useState(false)
  const [createTodoParent, setCreateTodoParent] = useState<LocatedLoopItem | null>(null)
  const [createTodoStatus, setCreateTodoStatus] = useState<CloudLoopItem['status']>('inbox')
  const [createTodoInitialTitle, setCreateTodoInitialTitle] = useState<string | undefined>()
  const [createTodoNonce, setCreateTodoNonce] = useState(0)
  const [createTodoStartRuntime, setCreateTodoStartRuntime] = useState(false)
  const [createTodoContinueCreating, setCreateTodoContinueCreating] = useState(false)
  const [issueComposerOpen, setIssueComposerOpen] = useState(false)
  const [issueComposerBoardKey, setIssueComposerBoardKey] = useState('')
  const [issueComposerStatus, setIssueComposerStatus] = useState<CloudLoopItem['status']>('inbox')
  const [issueComposerInitialContent, setIssueComposerInitialContent] = useState('')
  const [issueComposerPresentation, setIssueComposerPresentation] = useState<'page' | 'popup'>(
    'page'
  )
  const [issueComposerBusy, setIssueComposerBusy] = useState(false)
  const [issueComposerError, setIssueComposerError] = useState<string | null>(null)
  const [pendingAutomationSelection, setPendingAutomationSelection] = useState<{
    candidates: AutomationSelectionCandidate[]
    onCancel: () => void
    onConfirm: (automationId: string) => Promise<void>
  } | null>(null)
  const [projectAssistantOpen, setProjectAssistantOpen] = useState(false)
  const openProjectAssistant = () => {
    workbench?.projectChat.requestCatalogs?.()
    setProjectAssistantOpen(true)
  }
  const [selectedTaskBinding, setSelectedTaskBinding] = useState<SelectedTaskBinding | null>(null)
  const [taskComposerRequest, setTaskComposerRequest] = useState<TaskComposerRequest | null>(null)
  const [taskPanelSessionId, setTaskPanelSessionId] = useState(0)
  const taskPanelSessionIdRef = useRef(0)
  const advanceTaskPanelSession = useCallback(() => {
    taskPanelSessionIdRef.current += 1
    setTaskPanelSessionId(taskPanelSessionIdRef.current)
  }, [])
  const openTaskComposer = (request: TaskComposerRequest) => {
    workbench?.projectChat.requestCatalogs?.()
    advanceTaskPanelSession()
    setTaskComposerRequest(request)
  }
  const openTaskBinding = (binding: SelectedTaskBinding) => {
    advanceTaskPanelSession()
    setTaskComposerRequest(null)
    setSelectedTaskBinding(binding)
  }
  const [aitableFields, setAitableFields] = useState<AITableField[]>([])
  const [aitableGroupFieldId, setAitableGroupFieldId] = useState('')
  const [localProjectFilter, setLocalProjectFilter] = useState('all')
  const [groupScopeBusy, setGroupScopeBusy] = useState(false)
  const [pinnedBoardPreview, setPinnedBoardPreview] = useState<{
    contextKey: string
    itemId: string
  } | null>(null)
  const openBoardRuntimeTask = useCallback(
    (address: RuntimeTaskAddress) => {
      setPinnedBoardPreview(null)
      return onOpenRuntimeTask?.(address)
    },
    [onOpenRuntimeTask]
  )
  const [pendingExecutionConfiguration, setPendingExecutionConfiguration] =
    useState<PendingExecutionConfiguration | null>(null)
  const executionFailureByItemRef = useRef(new Map<string, boolean>())
  const boardSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [projectSearchOpen, setProjectSearchOpen] = useState(false)
  const [projectSearchQuery, setProjectSearchQuery] = useState('')
  const [projectSearchFilters, setProjectSearchFilters] =
    useState<TaskSearchFilters>(emptyTaskSearchFilters)
  const locallyRequestedProjectRef = useRef<RuntimeProjectSpaceRef | null | undefined>(undefined)
  const focusedItemRequestRef = useRef<string | null>(null)
  const boardSnapshotSignatureRef = useRef<string | null>(null)
  const boardLiveSubscriptionActiveRef = useRef(false)
  const markingReadItemKeysRef = useRef(new Set<string>())
  const resetProjectViewState = useCallback(() => {
    setProjectView('board')
    setBoardParentId(null)
    setNativeGroupFilter('')
    setNativeBoardQuery('')
    setProjectSearchOpen(false)
    setProjectSearchQuery('')
    setProjectSearchFilters(emptyTaskSearchFilters)
  }, [])

  useEffect(() => {
    if (activeProjectKey === undefined) return
    const locallyRequestedProject = locallyRequestedProjectRef.current
    const locallyRequestedProjectKey =
      locallyRequestedProject === undefined
        ? undefined
        : locallyRequestedProject
          ? projectSpaceKey(locallyRequestedProject)
          : null
    if (locallyRequestedProjectKey === activeProjectKey) {
      locallyRequestedProjectRef.current = undefined
      return
    }
    resetProjectViewState()
  }, [activeProjectKey, resetProjectViewState])

  const [localProjectsLoading, setLocalProjectsLoading] = useState(Boolean(projectSpaceApis.local))
  const [localProjectsError, setLocalProjectsError] = useState<string | null>(null)
  const [localProjectsRefreshNonce, setLocalProjectsRefreshNonce] = useState(0)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [dingtalkAuthPrompt, setDingtalkAuthPrompt] = useState(false)
  const [dingtalkAuthBusy, setDingtalkAuthBusy] = useState(false)
  const [boardRefreshNonce, setBoardRefreshNonce] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [renameProject, setRenameProject] = useState<LocatedCloudProject | null>(null)
  const [renameProjectName, setRenameProjectName] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [archiveProject, setArchiveProject] = useState<LocatedCloudProject | null>(null)
  const [archiveItem, setArchiveItem] = useState<CloudLoopItem | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [runtimeBatchArchiveItems, setRuntimeBatchArchiveItems] = useState<
    LocatedLoopItem[] | null
  >(null)
  const [runtimeGoalsByAddress, setRuntimeGoalsByAddress] = useState<
    Record<string, RuntimeGoal | null>
  >({})
  const runtimeConversationRequestsRef = useRef(new Set<string>())
  const runtimeConversationLatestSignatureRef = useRef(new Map<string, string>())
  const runtimeConversationLoadedSignatureRef = useRef(new Map<string, string>())
  const runtimeGoalRequestsRef = useRef(new Set<string>())
  // Applies a freshly fetched board snapshot. `boardError` distinguishes a
  // loaded-but-empty project (renders empty columns) from a failed fetch
  // (renders the skeleton plus the error banner instead of an empty board).
  const applyBoardItems = useCallback(
    (spaceKey: string, fetchedItems: LocatedLoopItem[], error: string | null) => {
      let newlyFailed: LocatedLoopItem | null = null
      for (const candidate of fetchedItems) {
        const failed =
          candidate.execution_state === 'failed' ||
          Boolean(candidate.workflow?.nodes.some(node => node.status === 'failed'))
        const previous = executionFailureByItemRef.current.get(candidate.id)
        if (previous === false && failed && candidate.can_view_detail !== false) {
          newlyFailed = candidate
        }
        executionFailureByItemRef.current.set(candidate.id, failed)
      }
      setItems(current => {
        const currentById = new Map(current.map(item => [item.id, item]))
        return fetchedItems.map(incoming => {
          const existing = currentById.get(incoming.id)
          return existing &&
            existing.cloud_project_id === incoming.cloud_project_id &&
            existing.project_store === incoming.project_store
            ? preferNewestLoopItemSnapshot(existing, incoming)
            : incoming
        })
      })
      setItemsProjectKey(spaceKey)
      setBoardError(error)
      if (newlyFailed) {
        setBackgroundTaskItemId(null)
        setSelectedTaskBinding(null)
        setTaskComposerRequest(null)
        setSelectedItem(newlyFailed)
      }
    },
    []
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
  const selectedProjectForViewAccess =
    selectedProject &&
    selectedProject.project_store === 'backend' &&
    selectedProject.access_role === undefined &&
    selectedProject.created_by_user_id === user.id
      ? { ...selectedProject, access_role: 'Owner' as const }
      : selectedProject
  const selectedProjectForBoardLoadRef = useRef(selectedProject)
  selectedProjectForBoardLoadRef.current = selectedProject
  const localProjectOptions = useMemo(() => {
    const runtimeProjectOrder = new Map(
      (runtimeWork?.projects ?? []).flatMap((entry, index) =>
        entry.project.id ? [[entry.project.id, index] as const] : []
      )
    )
    return [...localProjects].sort((left, right) => {
      const leftOrder = runtimeProjectOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = runtimeProjectOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.name.localeCompare(right.name, 'zh-CN')
    })
  }, [localProjects, runtimeWork])
  const isMyTasksBoard = isDefaultWorkItemProject(selectedProject)
  const runtimeTaskStatusSignature =
    isMyTasksBoard && runtimeTaskLifecycle
      ? [...runtimeTaskLifecycle.tasks.entries()]
          .flatMap(([key, lifecycle]) => {
            const status = runtimeTaskTrackingExecutionStatus(lifecycle)
            return status ? [`${key}:${status}`] : []
          })
          .sort()
          .join('|')
      : ''
  const activeLocalProjectFilter =
    localProjectFilter === '' || localProjectFilter === 'all'
      ? 'all'
      : localProjectOptions.some(project => String(project.id) === localProjectFilter)
        ? localProjectFilter
        : 'all'
  const selectedLocalProject =
    localProjectOptions.find(project => String(project.id) === activeLocalProjectFilter) ?? null
  const runtimeProjectIdByTask = useMemo(() => {
    const result = new Map<string, number>()
    for (const projectWork of runtimeWork?.projects ?? []) {
      if (!projectWork.project.id) continue
      for (const workspace of projectWork.deviceWorkspaces) {
        for (const task of workspace.tasks) {
          result.set(`${workspace.deviceId}:${task.taskId}`, projectWork.project.id)
        }
      }
    }
    return result
  }, [runtimeWork])
  const runtimeTasksByKey = useMemo(() => {
    const result = new Map<string, RuntimeTaskSummary>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(projectWork => projectWork.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const workspace of workspaces) {
      for (const task of workspace.tasks) {
        result.set(
          runtimeConversationKey({
            deviceId: workspace.deviceId,
            taskId: task.taskId,
          }),
          task
        )
      }
    }
    return result
  }, [runtimeWork])
  const runtimeTaskKeys = useMemo(() => {
    const keys = new Set(runtimeTasksByKey.keys())
    for (const lifecycle of runtimeTaskLifecycle?.tasks.values() ?? []) {
      keys.add(runtimeConversationKey(lifecycle.address))
    }
    return keys
  }, [runtimeTaskLifecycle, runtimeTasksByKey])
  const runtimeAddressesByWorkItem = useMemo(() => {
    const result = new Map<string, RuntimeTaskAddress[]>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(projectWork => projectWork.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const workspace of workspaces) {
      for (const task of workspace.tasks) {
        const reference = runtimeWorkItemReference(task)
        if (!reference) continue
        const key = `${reference.projectId}:${reference.itemId}`
        const addresses = result.get(key) ?? []
        addresses.push({
          deviceId: workspace.deviceId,
          taskId: task.taskId,
          runtime: task.runtime,
          threadId: task.threadId,
          workspacePath: task.workspacePath || workspace.workspacePath,
          runtimeHandle: task.runtimeHandle,
        })
        result.set(key, addresses)
      }
    }
    return result
  }, [runtimeWork])
  const runtimeTaskRunningByAddress = useMemo(() => {
    const result = new Map<string, boolean>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(projectWork => projectWork.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const workspace of workspaces) {
      for (const task of workspace.tasks) {
        result.set(
          runtimeConversationKey({
            deviceId: workspace.deviceId,
            taskId: task.taskId,
          }),
          isRuntimeTaskExecutionRunning(task)
        )
      }
    }
    return result
  }, [runtimeWork])
  const runtimeTaskByAddress = useMemo(() => {
    const result = new Map<
      string,
      {
        workspace: RuntimeWorkListResponse['projects'][number]['deviceWorkspaces'][number]
        task: RuntimeWorkListResponse['projects'][number]['deviceWorkspaces'][number]['tasks'][number]
      }
    >()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(projectWork => projectWork.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const workspace of workspaces) {
      for (const task of workspace.tasks) {
        result.set(runtimeConversationKey({ deviceId: workspace.deviceId, taskId: task.taskId }), {
          workspace,
          task,
        })
      }
    }
    return result
  }, [runtimeWork])
  const activeItemTaskBindings = useMemo(() => {
    if (selectedProject?.location !== 'cloud') return localItemTaskBindings
    const bindings = cloudWorkspace.state.taskBindings.map(toWeworkTaskBinding)
    const visibleBindings = isMyTasksBoard
      ? bindings.filter(binding =>
          runtimeTaskKeys.has(
            runtimeConversationKey({
              deviceId: binding.device_id,
              taskId: binding.task_id,
            })
          )
        )
      : bindings
    const byItem: Record<string, LoopItemTaskBinding[]> = {}
    for (const binding of visibleBindings) {
      if (!binding.loop_item_id) continue
      byItem[binding.loop_item_id] = [...(byItem[binding.loop_item_id] ?? []), binding]
    }
    return byItem
  }, [
    cloudWorkspace.state.taskBindings,
    isMyTasksBoard,
    localItemTaskBindings,
    runtimeTaskKeys,
    selectedProject?.location,
  ])
  const boardTaskBindings = useMemo<Record<string, CloudTodoBoardTaskBinding[]>>(
    () =>
      Object.fromEntries(
        Object.entries(activeItemTaskBindings).map(([itemId, bindings]) => [
          itemId,
          bindings.map(binding => {
            const addressKey = runtimeConversationKey({
              deviceId: binding.device_id,
              taskId: binding.task_id,
            })
            const runtimeTask = runtimeTaskByAddress.get(addressKey)
            const runtimeGoalLoaded = Object.prototype.hasOwnProperty.call(
              runtimeGoalsByAddress,
              addressKey
            )

            return {
              id: binding.id,
              device_id: binding.device_id,
              task_id: binding.task_id,
              task_title: binding.task_title,
              workflow_node_id: binding.workflow_node_id,
              modelSelection: binding.modelSelection,
              running: runtimeTaskRunningByAddress.get(addressKey) ?? false,
              changeRequestTarget: runtimeTask
                ? runtimeTaskChangeRequestTarget(runtimeTask.workspace, runtimeTask.task)
                : null,
              runtimeGoal: runtimeGoalsByAddress[addressKey] ?? null,
              runtimeGoalLoaded,
            }
          }),
        ])
      ),
    [
      activeItemTaskBindings,
      runtimeGoalsByAddress,
      runtimeTaskByAddress,
      runtimeTaskRunningByAddress,
    ]
  )
  const loadBoardTaskRuntimeGoal = useCallback(
    async (address: RuntimeTaskAddress): Promise<void> => {
      const runtimeWorkApi = services.runtimeWorkApi
      if (!runtimeWorkApi) return
      const addressKey = runtimeConversationKey(address)
      if (
        Object.prototype.hasOwnProperty.call(runtimeGoalsByAddress, addressKey) ||
        runtimeGoalRequestsRef.current.has(addressKey)
      ) {
        return
      }

      runtimeGoalRequestsRef.current.add(addressKey)
      try {
        const response = await runtimeWorkApi.getRuntimeGoal({ address })
        setRuntimeGoalsByAddress(current => ({
          ...current,
          [addressKey]: response.accepted ? response.goal : null,
        }))
      } catch (error) {
        console.warn('[Wework project board] failed to load task goal', {
          address,
          error,
        })
        setRuntimeGoalsByAddress(current => ({
          ...current,
          [addressKey]: null,
        }))
      } finally {
        runtimeGoalRequestsRef.current.delete(addressKey)
      }
    },
    [runtimeGoalsByAddress, services.runtimeWorkApi]
  )
  const localProjectIdForItem = useCallback(
    (item: CloudLoopItem): number | null => {
      const storedAssociation = loopItemLocalProject(item)
      if (storedAssociation) return storedAssociation.id
      for (const binding of activeItemTaskBindings[item.id] ?? []) {
        const projectId = runtimeProjectIdByTask.get(`${binding.device_id}:${binding.task_id}`)
        if (projectId) return projectId
      }
      return null
    },
    [activeItemTaskBindings, runtimeProjectIdByTask]
  )
  const selectedProjectKey = selectedProject
    ? projectSpaceKey(projectSpaceRef(selectedProject))
    : null
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
    const changeRequest = snapshot.changeRequest
    if (!changeRequest || !workbench || !selectedProject) return
    const hydratedAddress = hydrateRuntimeTaskAddress(runtimeWork, {
      deviceId: binding.device_id,
      taskId: binding.task_id,
    })
    const address = binding.modelSelection
      ? {
          ...hydratedAddress,
          runtimeHandle: {
            ...(hydratedAddress.runtimeHandle ?? {}),
            modelSelection: binding.modelSelection,
          },
        }
      : hydratedAddress
    const prompt = buildChangeRequestRepairPrompt(
      changeRequest,
      binding.task_title || binding.task_id,
      selectedProject.pull_request_automation?.prompt
    )
    const optimisticUserMessage = createRuntimeUserMessage(prompt)
    const accepted = await workbench.sendRuntimePaneMessage(
      {
        address,
        message: prompt,
        source: { source: 'manual' },
        cloudProjectId: String(selectedProject.id),
      },
      { optimisticUserMessage }
    )
    if (!accepted) {
      throw new Error(t('workbench.change_request_continue_repair_failed', '无法继续任务'))
    }
  }
  const projectForItem = useCallback(
    (item: Pick<LocatedLoopItem, 'cloud_project_id' | 'project_store'>) => {
      if (item.project_store) {
        return projects.find(project =>
          sameProjectSpace(projectSpaceRef(project), {
            projectStore: item.project_store!,
            projectId: item.cloud_project_id,
          })
        )
      }
      const matches = projects.filter(project => project.id === item.cloud_project_id)
      if (selectedProjectKey) {
        const selectedMatch = matches.find(
          project => projectSpaceKey(projectSpaceRef(project)) === selectedProjectKey
        )
        if (selectedMatch) return selectedMatch
      }
      return matches.length === 1 ? matches[0] : undefined
    },
    [projects, selectedProjectKey]
  )
  const locateItems = useCallback(
    <T extends CloudLoopItem>(
      sourceItems: T[],
      projectStore: RuntimeProjectSpaceRef['projectStore']
    ): Array<T & { project_store: RuntimeProjectSpaceRef['projectStore'] }> =>
      sourceItems.map(item => ({ ...item, project_store: projectStore })),
    []
  )
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
  const pendingExecutionProject = pendingExecutionConfiguration
    ? projectForItem(pendingExecutionConfiguration.item)
    : undefined
  const pendingExecutionServices = pendingExecutionProject
    ? services.projectSpaceDetailServices?.[pendingExecutionProject.location]
    : undefined
  function openExecutionConfiguration(
    pending: PendingExecutionConfiguration
  ): Exclude<ExecutionConfigurationRequestResult, 'not-needed'> {
    const project = projectForItem(pending.item)
    if (!project || !services.projectSpaceDetailServices?.[project.location]) {
      setBoardError(t('todo.run_unavailable', '运行服务当前不可用'))
      return 'unavailable'
    }
    setPendingExecutionConfiguration(pending)
    return 'opened'
  }
  const selectedProjectApi =
    selectedProject?.location === 'local'
      ? apiForProject(selectedProject)
      : selectedProjectServices?.deliveryApi
  const selectedProjectAgentApi = selectedProjectServices?.projectChatAgentApi
  const selectedProjectChatClient = selectedProjectServices?.projectChatClient
  const selectedProjectSelfManagedExecution = selectedProject?.location === 'local'
  const selectedProjectLocation = selectedProject?.location
  const isAITableProject = selectedProject?.task_provider === 'dingtalk_aitable'
  const isExternalGitBoard =
    selectedProject?.task_provider === 'github' || selectedProject?.task_provider === 'gitlab'
  const usesSharedCloudBoard = selectedProject?.location === 'cloud'
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
  const selectedProjectAgents = selectedProjectKey
    ? (collaborationProjectAgents[selectedProjectKey] ?? [])
    : []
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
  useEffect(() => {
    if (!usesSharedCloudBoard || boardRefreshNonce === 0 || !selectedProjectId) {
      return
    }
    void cloudWorkspace.commands.loadProject(String(selectedProjectId), false)
  }, [boardRefreshNonce, cloudWorkspace.commands, selectedProjectId, usesSharedCloudBoard])
  useEffect(() => {
    if (
      !usesSharedCloudBoard ||
      cloudWorkspace.state.errorSource !== 'load' ||
      !cloudWorkspace.state.error ||
      !selectedProjectKey
    ) {
      return
    }
    if (isAITableProject && services.dwsApi) {
      let active = true
      void services.dwsApi.authStatus().then(status => {
        if (!active) return
        if (!status.authenticated || status.token_valid === false) {
          setDingtalkAuthPrompt(true)
          setBoardError(null)
        }
      })
      return () => {
        active = false
      }
    }
    let active = true
    window.queueMicrotask(() => {
      if (active) setBoardError(cloudWorkspace.state.error)
    })
    return () => {
      active = false
    }
  }, [
    cloudWorkspace.state.error,
    cloudWorkspace.state.errorSource,
    isAITableProject,
    selectedProjectKey,
    services.dwsApi,
    usesSharedCloudBoard,
  ])
  useEffect(() => {
    if (!selectedProjectId || !selectedProjectLocation) return
    track('board_view_opened', {
      source: selectedProjectLocation,
      view: projectView,
    })
  }, [projectView, selectedProjectId, selectedProjectLocation])
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
  // Distinct tags across the project (registry plus item usage), used by the
  // board tag grouping and filter.
  const availableTags = Array.from(
    new Set([
      ...(selectedProject?.tags ?? []),
      ...selectedProjectBoardItems.flatMap(item => item.tags ?? []),
    ])
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'))
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
                  'bg-zinc-400')
                : nextGroupBy === 'priority'
                  ? (columnDotClasses[value] ?? 'bg-zinc-400')
                  : nextGroupBy === 'assignee' && value
                    ? 'bg-indigo-500'
                    : 'bg-zinc-400',
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
            tags: selectedProject?.tags ?? [],
          }),
    [
      aitableGroupFieldId,
      aitableGroupValues,
      collaborationProjectMembers,
      isAITableProject,
      selectedProject?.tags,
      selectedProjectAgents,
      selectedProjectBoardItems,
      selectedProjectKey,
      visibleNativeStatuses,
    ]
  )
  const aitableApi = isAITableProject ? services.aitableApi : undefined

  useEffect(() => {
    if (!isAITableProject || !selectedProject || !aitableApi) return
    let active = true
    void aitableApi
      .describe(selectedProject.id)
      .then(description => {
        if (!active) return
        setAitableFields(description.fields)
        const mapping = selectedProject.provider_config.board_mapping
        const mappedStatus =
          typeof mapping === 'object' && mapping !== null
            ? (mapping as Record<string, unknown>).status_field_id
            : null
        const defaultField =
          description.fields.find(field => field.id === mappedStatus) ??
          description.fields.find(field => /select|member|checkbox/i.test(field.type)) ??
          description.fields[0]
        setAitableGroupFieldId(current =>
          description.fields.some(field => field.id === current)
            ? current
            : (defaultField?.id ?? '')
        )
      })
      .catch(cause => {
        if (active) setBoardError(cause instanceof Error ? cause.message : '读取钉钉字段失败')
      })
    return () => {
      active = false
    }
  }, [aitableApi, isAITableProject, selectedProject])

  const canCreateBoardTask = selectedProject !== null
  const cloudBoardItems = useMemo(() => {
    if (!isMyTasksBoard) return selectedCloudProjectItems
    const bindings = Object.values(activeItemTaskBindings).flat()
    const boundItemIds = new Set(
      bindings.flatMap(binding => (binding.loop_item_id ? [binding.loop_item_id] : []))
    )
    return projectBoundRuntimeTaskStatuses(
      selectedCloudProjectItems.filter(item => boundItemIds.has(item.id)),
      bindings,
      runtimeTaskLifecycle
    )
  }, [activeItemTaskBindings, isMyTasksBoard, runtimeTaskLifecycle, selectedCloudProjectItems])
  const persistedBoardItems = selectedProject?.location === 'cloud' ? cloudBoardItems : items
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
    return mergeRuntimeMyWorkItems(
      persistedBoardItems,
      runtimeItems,
      bindings,
      selectedProjectBoardItems.map(item => item.id)
    )
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
  // Only render board items that belong to the selected project. On a project
  // switch this flips to the skeleton in the same render, before the fetch.
  // `boardError` distinguishes a failed fetch (skeleton stays) from a
  // successfully loaded but empty project (renders the empty columns).
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
  useEffect(() => {
    if (!startupBoardReady || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') {
      return
    }
    void invokeDesktopHost<void>('renderer.startupReady').catch(error => {
      console.error('[Wework] Failed to reveal the ready project space', error)
    })
  }, [startupBoardReady])
  const selectedItemProject = selectedItem ? projectForItem(selectedItem) : undefined
  const selectedItemApi = apiForProject(selectedItemProject)
  const selectedItemServices = selectedItemProject
    ? services.projectSpaceDetailServices?.[selectedItemProject.location]
    : undefined
  const markItemRead = useCallback(
    async (item: LocatedLoopItem) => {
      if (!item.is_unread) return
      const project = projectForItem(item)
      const itemApi = apiForProject(project)
      if (!project || (project.location === 'cloud' ? !cloudWorkspaceApi : !itemApi)) return
      const projectKey = projectSpaceKey(projectSpaceRef(project))
      const requestKey = `${projectKey}\0${item.id}`
      if (markingReadItemKeysRef.current.has(requestKey)) return
      markingReadItemKeysRef.current.add(requestKey)

      try {
        const updated = {
          ...(project.location === 'cloud'
            ? toCloudLoopItem(await cloudWorkspaceApi!.issues.markRead(item.id))
            : await itemApi!.markLoopItemRead(item.id)),
          project_store: item.project_store,
        }
        const applyReadSnapshot = (current: LocatedLoopItem) => ({
          ...preferNewestLoopItemSnapshot(current, updated),
          is_unread: false,
        })
        if (project.location === 'cloud') {
          cloudWorkspace.commands.replaceIssue(updated as CollaborationIssue)
        }
        setSelectedItem(current => (current?.id === item.id ? applyReadSnapshot(current) : current))
        if (project.location === 'local') {
          setDetailItems(current =>
            current.map(candidate =>
              candidate.id === item.id ? applyReadSnapshot(candidate) : candidate
            )
          )
        }
        if (project.location === 'local') {
          setItems(current =>
            current.map(candidate =>
              candidate.id === item.id ? applyReadSnapshot(candidate) : candidate
            )
          )
          setLocalProjectItems(current => ({
            ...current,
            [projectKey]: (current[projectKey] ?? []).map(candidate =>
              candidate.id === item.id ? applyReadSnapshot(candidate) : candidate
            ),
          }))
        }
      } catch (error) {
        console.warn('[Wework project board] mark Issue read failed', {
          itemId: item.id,
          error,
        })
      } finally {
        markingReadItemKeysRef.current.delete(requestKey)
      }
    },
    [apiForProject, cloudWorkspaceApi, projectForItem]
  )
  useEffect(() => {
    if (
      !selectedItem ||
      selectedItem.detail_loaded !== false ||
      !selectedItemProject ||
      (selectedItemProject.location === 'cloud' ? !cloudWorkspaceApi : !selectedItemApi)
    ) {
      return
    }
    let active = true
    const itemId = selectedItem.id
    const projectStore = selectedItem.project_store
    const request =
      selectedItemProject.location === 'cloud'
        ? cloudWorkspace.commands.getIssue(itemId).then(item => {
            if (!item) throw new Error(cloudWorkspaceMessages.loadFailed)
            return toCloudLoopItem(item)
          })
        : selectedItemApi!.getLoopItem(itemId)
    void request
      .then(item => {
        if (!active) return
        const locatedItem = { ...item, project_store: projectStore }
        setSelectedItem(current => (current?.id === itemId ? locatedItem : current))
        if (selectedItemProject.location === 'local') {
          setItems(current =>
            current.map(candidate => (candidate.id === itemId ? locatedItem : candidate))
          )
        }
      })
      .catch(error => {
        if (active) {
          setBoardError(
            error instanceof Error ? error.message : t('todo.work_item_detail_load_failed')
          )
        }
      })
    return () => {
      active = false
    }
  }, [cloudWorkspaceApi, selectedItem, selectedItemApi, selectedItemProject, t])
  useEffect(() => {
    if (!selectedItem?.is_unread || selectedItemProject?.task_provider !== 'local') {
      return
    }
    window.queueMicrotask(() => void markItemRead(selectedItem))
  }, [markItemRead, selectedItem, selectedItemProject])
  // Source for the detail drawer / creation dialog when the selected todo lives
  // in a project other than the one shown on the board.
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
  const standardBoardController = useStandardCloudBoardController({
    createColumns: createBoardColumns,
    currentParentId: boardParentId,
    defaultGroupBy: selectedProject?.board_config?.group_by ?? 'status',
    extensions: standardBoardExtensions,
    focusStorageKey: focusExecutionColumnsKey,
    items: boardItems,
    onCurrentParentIdChange: setBoardParentId,
    onMove: async (item, column, beforeItemId, mutation) => {
      await performStandardBoardMove(item, column, beforeItemId, mutation)
    },
    personalGroupStorageKey: personalGroupKey,
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
    externalGroupFilter: aitableGroupFilter,
    externalQuery: aitableBoardQuery,
    groupBy: nativeGroupBy,
    groupFilter: nativeGroupFilter,
    query: nativeBoardQuery,
    setExternalGroupFilter: setAitableGroupFilter,
    setGroupFilter: setNativeGroupFilter,
    setQuery: setNativeBoardQuery,
    setQuickCreateStatus,
  } = boardState
  const boardPreviewContextKey = [
    selectedProjectKey,
    boardParentId,
    projectView,
    localProjectFilter,
    nativeGroupFilter,
    nativeBoardQuery,
    aitableBoardQuery,
    aitableGroupFilter,
  ].join(':')
  const pinnedBoardPreviewItemId =
    pinnedBoardPreview?.contextKey === boardPreviewContextKey ? pinnedBoardPreview.itemId : null
  const boardLayerCount = boardItems.filter(item => item.parent_id === boardParentId).length
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
  const columnDragHints: Record<CloudLoopItem['status'], string> = {
    inbox: t('todo.column_drag_hint_inbox', '移到这里：返回收集箱'),
    pending: t('todo.column_drag_hint_pending', '移到这里：等待开始'),
    in_progress: t('todo.column_drag_hint_in_progress', '移到这里：开始推进'),
    in_review: t('todo.column_drag_hint_in_review', '移到这里：等待确认'),
    completed: t('todo.column_drag_hint_completed', '移到这里：标记完成'),
  }
  useEffect(() => {
    if (!usesSharedCloudBoard || !selectedProjectId) return
    let active = true
    const load = async () => {
      try {
        const project = selectedProjectForBoardLoadRef.current
        if (!project) return
        if (isAITableProject && services.dwsApi) {
          const status = await services.dwsApi.authStatus()
          if (!active) return
          if (!status.authenticated || status.token_valid === false) {
            setDingtalkAuthPrompt(true)
          }
        }
        if (isAITableProject && services.aitableApi) {
          await services.aitableApi.configureProject(project)
        }
        if (active) await cloudWorkspace.commands.loadProject(String(selectedProjectId))
      } catch (cause) {
        if (!active) return
        if (isAITableProject && services.dwsApi) {
          const status = await services.dwsApi.authStatus()
          if (!active) return
          if (!status.authenticated || status.token_valid === false) {
            setDingtalkAuthPrompt(true)
            return
          }
        }
        setBoardError(cause instanceof Error ? cause.message : cloudWorkspaceMessages.loadFailed)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [
    boardParentId,
    cloudWorkspace.commands,
    cloudWorkspaceMessages.loadFailed,
    isAITableProject,
    selectedProjectId,
    selectedProjectKey,
    services.aitableApi,
    services.dwsApi,
    usesSharedCloudBoard,
  ])

  function applyProjectSelection(project: LocatedCloudProject | null) {
    const ref = project ? projectSpaceRef(project) : null
    if (!sameProjectSpace(selectedProjectRef, ref)) {
      setItems([])
      setItemsProjectKey(null)
      boardSnapshotSignatureRef.current = null
    }
    locallyRequestedProjectRef.current = ref
    setSelectedProjectRef(ref)
    resetProjectViewState()
  }

  function selectProject(project: LocatedCloudProject | null) {
    applyProjectSelection(project)
    onActiveProjectChange?.(project)
  }

  async function renameSelectedProject() {
    if (!renameProject) return
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
    setArchiveBusy(true)
    setArchiveError(null)
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
      setRuntimeBatchArchiveItems(failedItems.length > 0 ? failedItems : null)
      if (failedItems.length > 0) {
        setArchiveError(
          t('todo.batch_archive_failed', '{{count}} 个任务归档失败，请稍后重试', {
            count: failedItems.length,
          })
        )
      }
    } catch (error) {
      console.error('[Wework my tasks] batch archive failed', error)
      setRuntimeBatchArchiveItems(completedItems)
      setArchiveError(
        t('todo.batch_archive_failed', '{{count}} 个任务归档失败，请稍后重试', {
          count: completedItems.length,
        })
      )
    } finally {
      setArchiveBusy(false)
    }
  }

  useEffect(() => {
    const handleGlobalSearchShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setGlobalSearchOpen(true)
      } else if (event.key === 'Escape') {
        setGlobalSearchOpen(false)
        setProjectSearchOpen(false)
      }
    }
    window.addEventListener('keydown', handleGlobalSearchShortcut)
    return () => window.removeEventListener('keydown', handleGlobalSearchShortcut)
  }, [])

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

  function requestCreatedItemExecutionConfiguration(
    item: LocatedLoopItem,
    afterSave?: (item: LocatedLoopItem) => void
  ): ExecutionConfigurationRequestResult {
    if (!isProcessingStatus(item.status) || !itemNeedsExecutionConfiguration(item)) {
      return 'not-needed'
    }
    return openExecutionConfiguration({
      item,
      continuation: { type: 'save', afterSave },
    })
  }

  function openCreatedItemRuntimeTask(
    item: LocatedLoopItem,
    project: LocatedCloudProject,
    taskRequest?: RuntimeTaskCreateRequest
  ) {
    setSelectedTaskBinding(null)
    setSelectedItem(item)
    setBackgroundTaskItemId(item.id)
    openTaskComposer({
      workItemId: item.id,
      initialInput: workItemTaskInput(item),
      backgroundAfterSend: true,
      taskRequest: taskRequest
        ? {
            ...taskRequest,
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
                  automationRuleId,
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
      const locatedItem = addCreatedTodo(created, selectedProject)
      requestCreatedItemExecutionConfiguration(locatedItem)
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

  useEffect(() => {
    const api = projectSpaceApis.local
    if (!api) return
    let active = true
    void api
      .listCloudProjects()
      .then(response => {
        if (!active) return
        setLocalProjectsError(null)
        setLocalProjectSpaces(
          response.items.map(project => ({
            ...project,
            project_store: 'local',
            location: 'local',
          }))
        )
      })
      .catch(error => {
        console.error('[Wework project spaces] local list failed', error)
        if (active) {
          setLocalProjectsError(error instanceof Error ? error.message : '本地项目空间加载失败')
        }
      })
      .finally(() => {
        if (active) setLocalProjectsLoading(false)
      })
    return () => {
      active = false
    }
  }, [localProjectsRefreshNonce, projectSpaceApis.local])

  useEffect(() => {
    if (
      !usesSharedCloudBoard ||
      !selectedProject ||
      !selectedProjectId ||
      !selectedProjectKey ||
      cloudWorkspace.state.project?.id !== String(selectedProjectId)
    ) {
      return
    }
    const visibleItems = cloudWorkspace.state.issues.map(issue => ({
      ...toCloudLoopItem(issue),
      project_store: selectedProject.project_store,
    }))
    let active = true
    window.queueMicrotask(() => {
      if (!active) return
      setSelectedItem(current =>
        current &&
        sameProjectSpace(
          {
            projectStore: current.project_store ?? selectedProject.project_store,
            projectId: current.cloud_project_id,
          },
          projectSpaceRef(selectedProject)
        )
          ? (visibleItems.find(item => item.id === current.id) ?? null)
          : current
      )
    })
    return () => {
      active = false
    }
  }, [
    cloudWorkspace.state.issues,
    cloudWorkspace.state.project?.id,
    selectedProject,
    selectedProjectId,
    selectedProjectKey,
    usesSharedCloudBoard,
  ])
  useEffect(() => {
    if (
      !usesSharedCloudBoard ||
      !selectedProject ||
      cloudWorkspace.state.project?.id !== String(selectedProject.id)
    ) {
      return
    }
    let active = true
    window.queueMicrotask(() => {
      if (!active) return
      setDingtalkAuthPrompt(false)
      setBoardError(null)
    })
    return () => {
      active = false
    }
  }, [
    cloudWorkspace.state.boardLoadRevision,
    cloudWorkspace.state.project?.id,
    selectedProject,
    usesSharedCloudBoard,
  ])
  useEffect(() => {
    if (
      !selectedProject ||
      !selectedProjectId ||
      !selectedProjectKey ||
      selectedProject.location !== 'local' ||
      !selectedProjectApi
    ) {
      return
    }
    let active = true
    const refreshItems = () => {
      const prepare =
        selectedProject?.task_provider === 'dingtalk_aitable' && services.aitableApi
          ? services.aitableApi.configureProject(selectedProject)
          : Promise.resolve()
      const readBoard = async (): Promise<BoardReadResult> => {
        await prepare
        if (isExternalGitBoard) {
          const [pages, members, agents] = await Promise.all([
            Promise.all(
              localExternalBoardStatuses.map(async status => {
                return selectedProjectApi.listLoopItemsPage(selectedProjectId, {
                  status,
                  parentId: boardParentId,
                  limit: externalBoardColumnPageSize,
                })
              })
            ),
            selectedProjectApi.listCloudProjectMembers(selectedProjectId),
            selectedProjectAgentApi?.list(selectedProjectId) ?? Promise.resolve([]),
          ])
          return {
            items: locateItems(
              pages.flatMap(page => page.items),
              selectedProject.project_store
            ),
            task_bindings: pages.flatMap(page => page.task_bindings),
            members,
            agents,
            page_cursors: Object.fromEntries(
              pages.map((page, index) => [localExternalBoardStatuses[index], page.next_cursor])
            ),
          }
        }
        const [selectedResponse, agents] = await Promise.all([
          selectedProjectApi.getBoardSnapshot(selectedProjectId),
          selectedProjectAgentApi?.list(selectedProjectId),
        ])
        const selectedItems = locateItems(selectedResponse.items, selectedProject.project_store)
        const boardResponse = {
          ...selectedResponse,
          items: selectedItems,
          agents: agents ?? selectedResponse.agents,
        }
        if (!isMyTasksBoard) return boardResponse
        const activeBindings = (selectedResponse.task_bindings ?? []).filter(binding =>
          runtimeTaskKeys.has(
            runtimeConversationKey({
              deviceId: binding.device_id,
              taskId: binding.task_id,
            })
          )
        )
        const activeItemIds = new Set(
          activeBindings.flatMap(binding => (binding.loop_item_id ? [binding.loop_item_id] : []))
        )
        const activeItems = selectedItems.filter(item => activeItemIds.has(item.id))
        return {
          ...boardResponse,
          items: projectBoundRuntimeTaskStatuses(activeItems, activeBindings, runtimeTaskLifecycle),
          task_bindings: activeBindings,
        }
      }
      void readBoard()
        .then(response => {
          if (!active) return
          setDingtalkAuthPrompt(false)
          const boardContext = response.task_bindings
            ? {
                taskBindings: response.task_bindings,
                members: response.members ?? [],
                agents: response.agents ?? [],
              }
            : undefined
          const snapshotSpaceKey = isExternalGitBoard
            ? `${selectedProjectKey}:${boardParentId ?? 'root'}`
            : selectedProjectKey
          const signature = boardSnapshotKey(snapshotSpaceKey, response.items, null, boardContext)
          if (boardSnapshotSignatureRef.current === signature) return
          boardSnapshotSignatureRef.current = signature
          const locatedItems = response.items
          if (isExternalGitBoard) {
            setItems(current => {
              const retained = current.filter(
                item =>
                  String(item.cloud_project_id) === String(selectedProject.id) &&
                  item.project_store === selectedProject.project_store &&
                  item.parent_id !== boardParentId
              )
              return [...retained, ...locatedItems]
            })
            setItemsProjectKey(selectedProjectKey)
            setBoardError(null)
            setLocalExternalPageCursors(response.page_cursors ?? {})
          } else {
            applyBoardItems(selectedProjectKey, locatedItems, null)
            setLocalExternalPageCursors({})
          }
          if (boardContext) {
            const bindingsByItem: Record<string, LoopItemTaskBinding[]> = {}
            for (const binding of boardContext.taskBindings) {
              if (!binding.loop_item_id) continue
              const itemBindings = bindingsByItem[binding.loop_item_id] ?? []
              itemBindings.push(binding)
              bindingsByItem[binding.loop_item_id] = itemBindings
            }
            setLocalItemTaskBindings(current =>
              isExternalGitBoard ? { ...current, ...bindingsByItem } : bindingsByItem
            )
            setItemTaskBindingsProjectKey(selectedProjectKey)
          }
          if (boardContext) {
            setLocalProjectMembers(current => ({
              ...current,
              [selectedProjectKey]: boardContext.members,
            }))
            setLocalProjectAgents(current => ({
              ...current,
              [selectedProjectKey]: boardContext.agents.filter(agent => agent.status === 'active'),
            }))
          }
          // Keep the projects-home cache in sync with the board fetch.
          setLocalProjectItems(current => ({
            ...current,
            [selectedProjectKey]: isExternalGitBoard
              ? Array.from(
                  new Map(
                    [...(current[selectedProjectKey] ?? []), ...locatedItems].map(item => [
                      item.id,
                      item,
                    ])
                  ).values()
                )
              : locatedItems,
          }))
          setLocalProjectCounts(current => ({
            ...current,
            [selectedProjectKey]: response.items.length,
          }))
          // Only sync the open drawer when it belongs to this project; a drawer
          // opened from another view (e.g. my work) must not be closed here.
          setSelectedItem(current =>
            current &&
            sameProjectSpace(
              {
                projectStore: current.project_store ?? selectedProject.project_store,
                projectId: current.cloud_project_id,
              },
              projectSpaceRef(selectedProject)
            )
              ? (locatedItems.find(item => item.id === current.id) ??
                (isExternalGitBoard ? current : null))
              : current
          )
        })
        .catch(async error => {
          console.error('[Wework project board] issue refresh failed', {
            projectId: selectedProjectId,
            error,
          })
          if (!active) return
          if (selectedProject?.task_provider === 'dingtalk_aitable' && services.dwsApi) {
            try {
              const status = await services.dwsApi.authStatus()
              if (!status.authenticated || status.token_valid === false) {
                if (!active) return
                setDingtalkAuthPrompt(true)
                applyBoardItems(selectedProjectKey, [], null)
                return
              }
            } catch {
              // Fall through to the raw board error.
            }
          }
          if (!active) return
          setDingtalkAuthPrompt(false)
          const message = error instanceof Error ? error.message : '任务加载失败'
          const signature = boardSnapshotKey(
            isExternalGitBoard
              ? `${selectedProjectKey}:${boardParentId ?? 'root'}`
              : selectedProjectKey,
            [],
            message
          )
          if (boardSnapshotSignatureRef.current === signature) return
          boardSnapshotSignatureRef.current = signature
          applyBoardItems(selectedProjectKey, [], message)
          setLocalExternalPageCursors({})
          setLocalItemTaskBindings({})
          setItemTaskBindingsProjectKey(selectedProjectKey)
          setLocalProjectMembers(current => ({ ...current, [selectedProjectKey]: [] }))
          setLocalProjectAgents(current => ({ ...current, [selectedProjectKey]: [] }))
        })
    }
    refreshItems()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !boardLiveSubscriptionActiveRef.current) {
        refreshItems()
      }
    }, 15_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [
    applyBoardItems,
    boardParentId,
    boardRefreshNonce,
    isExternalGitBoard,
    isMyTasksBoard,
    selectedProject,
    selectedProjectApi,
    selectedProjectAgentApi,
    selectedProjectId,
    selectedProjectKey,
    locateItems,
    runtimeTaskLifecycle,
    runtimeTaskStatusSignature,
    runtimeTaskKeys,
    services.aitableApi,
    services.dwsApi,
  ])

  async function loadMoreExternalColumn(itemStatus: string): Promise<void> {
    if (selectedProject?.location === 'cloud') {
      await cloudWorkspace.commands.loadMoreExternalColumn(itemStatus)
      return
    }
    const cursor = localExternalPageCursors[itemStatus]
    if (
      !isExternalGitBoard ||
      !selectedProject ||
      !selectedProjectId ||
      !selectedProjectKey ||
      !selectedProjectApi ||
      !cursor ||
      localExternalPageLoading[itemStatus]
    ) {
      return
    }
    setLocalExternalPageLoading(current => ({ ...current, [itemStatus]: true }))
    try {
      const page = await selectedProjectApi.listLoopItemsPage(selectedProjectId, {
        status: itemStatus,
        parentId: boardParentId,
        cursor,
        limit: externalBoardColumnPageSize,
      })
      const locatedItems = locateItems(page.items, selectedProject.project_store)
      setItems(current => {
        return Array.from(
          new Map([...current, ...locatedItems].map(item => [item.id, item])).values()
        )
      })
      setLocalExternalPageCursors(current => ({
        ...current,
        [itemStatus]: page.next_cursor,
      }))
      setLocalItemTaskBindings(current => {
        const next = { ...current }
        for (const binding of page.task_bindings) {
          if (!binding.loop_item_id) continue
          next[binding.loop_item_id] = [
            ...(next[binding.loop_item_id] ?? []).filter(candidate => candidate.id !== binding.id),
            binding,
          ]
        }
        return next
      })
      setItemTaskBindingsProjectKey(selectedProjectKey)
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : t('todo.load_more_issues_failed'))
    } finally {
      setLocalExternalPageLoading(current => ({ ...current, [itemStatus]: false }))
    }
  }

  useEffect(() => {
    const refreshBoard = () => {
      setBoardRefreshNonce(value => value + 1)
    }
    const unsubscribeContextChanged = subscribeProjectSpaceTaskContextChanged(refreshBoard)
    const unsubscribeBindingChanged = subscribeProjectSpaceTaskBindingChanged(refreshBoard)
    return () => {
      unsubscribeContextChanged()
      unsubscribeBindingChanged()
    }
  }, [])
  useEffect(() => {
    const subscribe = selectedProjectChatClient?.subscribeLoopItemChanges
    boardLiveSubscriptionActiveRef.current = false
    if (!subscribe || !selectedProjectId) return
    let active = true
    let unsubscribe: (() => void) | undefined
    void subscribe(event => {
      if (!active || event.projectId !== String(selectedProjectId)) return
      setBoardRefreshNonce(value => value + 1)
    })
      .then(release => {
        if (!active) {
          release()
          return
        }
        unsubscribe = release
        boardLiveSubscriptionActiveRef.current = true
      })
      .catch(error => {
        boardLiveSubscriptionActiveRef.current = false
        console.warn('[Wework project board] issue-change subscription failed', error)
      })
    return () => {
      active = false
      boardLiveSubscriptionActiveRef.current = false
      unsubscribe?.()
    }
  }, [selectedProjectChatClient, selectedProjectId])
  useEffect(() => {
    const runtimeWorkApi = services.runtimeWorkApi
    if (
      !runtimeWorkApi?.getRuntimeTranscript ||
      !selectedProjectKey ||
      (selectedProject?.location === 'local' && itemTaskBindingsProjectKey !== selectedProjectKey)
    ) {
      return
    }
    for (const item of activeBoardSourceItems) {
      if (item.status !== 'in_review' && !isLoopItemExecutionActive(item)) continue
      for (const binding of activeItemTaskBindings[item.id] ?? []) {
        const addressKey = runtimeConversationKey({
          deviceId: binding.device_id,
          taskId: binding.task_id,
        })
        const task = runtimeTasksByKey.get(addressKey)
        const signature = [
          task?.updatedAt ?? '',
          task?.completedAt ?? '',
          task?.status ?? '',
          task?.turnStatus ?? '',
        ].join(':')
        if (runtimeConversationLoadedSignatureRef.current.get(addressKey) === signature) continue
        const requestKey = `${addressKey}:${signature}`
        if (runtimeConversationRequestsRef.current.has(requestKey)) continue
        runtimeConversationRequestsRef.current.add(requestKey)
        runtimeConversationLatestSignatureRef.current.set(addressKey, signature)
        void runtimeWorkApi
          .getRuntimeTranscript({
            deviceId: binding.device_id,
            taskId: binding.task_id,
            runtime: task?.runtime,
            threadId: task?.threadId,
            workspacePath: task?.workspacePath,
            runtimeHandle: task?.runtimeHandle,
            limit: 20,
          })
          .then(transcript => {
            if (runtimeConversationLatestSignatureRef.current.get(addressKey) !== signature) {
              return
            }
            const projectedTranscript = projectRuntimePaneTranscript(transcript)
            const address = {
              deviceId: binding.device_id,
              taskId: binding.task_id,
              runtime: task?.runtime,
              threadId: task?.threadId,
              workspacePath: task?.workspacePath,
              runtimeHandle: task?.runtimeHandle,
            }
            if (
              projectedTranscript.fullContent === true &&
              isRuntimePaneTranscriptConfirmedIdle(projectedTranscript)
            ) {
              replaceRuntimeConversationSnapshot(address, projectedTranscript.turns)
            } else {
              reconcileRuntimeConversationSnapshot(address, projectedTranscript.turns)
            }
            runtimeConversationLoadedSignatureRef.current.set(addressKey, signature)
          })
          .catch(error => {
            console.warn('[Wework project board] failed to preload task conversation', {
              address: {
                deviceId: binding.device_id,
                taskId: binding.task_id,
              },
              error,
            })
            if (runtimeConversationLatestSignatureRef.current.get(addressKey) !== signature) {
              return
            }
          })
          .finally(() => {
            runtimeConversationRequestsRef.current.delete(requestKey)
          })
      }
    }
  }, [
    activeItemTaskBindings,
    activeBoardSourceItems,
    itemTaskBindingsProjectKey,
    runtimeTasksByKey,
    selectedProjectKey,
    selectedProject?.location,
    services.runtimeWorkApi,
  ])
  useEffect(() => {
    if (
      selectedProject?.location !== 'local' ||
      !selectedProjectId ||
      !selectedProjectKey ||
      !selectedProjectApi
    ) {
      return
    }
    let active = true
    void selectedProjectApi
      .listCloudProjectMembers(selectedProjectId)
      .then(members => {
        if (active)
          setLocalProjectMembers(current => ({ ...current, [selectedProjectKey]: members }))
      })
      .catch(error => {
        console.warn('[Wework project board] member refresh failed', {
          projectId: selectedProjectId,
          error,
        })
      })
    return () => {
      active = false
    }
  }, [selectedProject, selectedProjectApi, selectedProjectId, selectedProjectKey])
  useEffect(() => {
    if (!focusedItemId) {
      focusedItemRequestRef.current = null
      return
    }
    if (
      !selectedProjectId ||
      !selectedProjectKey ||
      (selectedProject?.location === 'cloud'
        ? cloudWorkspace.state.project?.id !== String(selectedProject.id)
        : itemsProjectKey !== selectedProjectKey)
    ) {
      return
    }
    const requestKey = `${selectedProjectKey}:${focusedItemId}`
    if (focusedItemRequestRef.current === requestKey) return
    const focusedItem = activeBoardSourceItems.find(item => item.id === focusedItemId)
    if (!focusedItem || focusedItem.can_view_detail === false) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      focusedItemRequestRef.current = requestKey
      setProjectView('board')
      setBoardParentId(focusedItem.parent_id)
      setSelectedItem(focusedItem)
      onFocusedItemHandled?.()
    })
    return () => {
      active = false
    }
  }, [
    focusedItemId,
    activeBoardSourceItems,
    cloudWorkspace.state.project?.id,
    itemsProjectKey,
    onFocusedItemHandled,
    selectedProjectId,
    selectedProjectKey,
    selectedProject,
  ])
  useEffect(() => {
    if (!globalSearchOpen) return
    let active = true
    void Promise.allSettled(
      projects.map(async project => {
        const api = apiForProject(project)
        if (project.location === 'cloud') {
          const cachedItems = cloudWorkspace.state.projectItems[String(project.id)]
          const snapshot = cachedItems
            ? null
            : await cloudWorkspace.commands.loadProjectSnapshot(String(project.id))
          const items = cachedItems ?? snapshot?.items
          return items ? { project, items: items.map(toCloudLoopItem) } : null
        }
        if (!api) return null
        const response = await api.listLoopItems(project.id)
        return { project, items: response.items }
      })
    ).then(results => {
      if (!active) return
      setLocalProjectItems(current => {
        const next = { ...current }
        results.forEach(result => {
          if (
            result.status === 'fulfilled' &&
            result.value &&
            result.value.project.location === 'local'
          ) {
            next[projectSpaceKey(projectSpaceRef(result.value.project))] = result.value.items
          }
        })
        return next
      })
    })
    return () => {
      active = false
    }
  }, [
    apiForProject,
    cloudWorkspace.commands,
    cloudWorkspace.state.projectItems,
    globalSearchOpen,
    projects,
  ])
  // Load the drawer project's items when the drawer shows a todo from a project
  // other than the one on the board, so subtasks and parent options stay correct.
  useEffect(() => {
    if (
      !selectedItem ||
      (selectedItemProject &&
        sameProjectSpace(projectSpaceRef(selectedItemProject), selectedProjectRef))
    ) {
      return
    }
    const detailApi = apiForProject(selectedItemProject)
    if (
      !selectedItemProject ||
      (selectedItemProject.location === 'cloud' ? !cloudWorkspaceApi : !detailApi)
    ) {
      return
    }
    let active = true
    if (selectedItemProject.location === 'cloud') {
      if (!cloudWorkspace.state.projectItems[String(selectedItem.cloud_project_id)]) {
        void cloudWorkspace.commands.loadProjectSnapshot(String(selectedItem.cloud_project_id))
      }
    } else {
      void detailApi!.listLoopItems(selectedItem.cloud_project_id).then(itemsResponse => {
        if (active) {
          setDetailItems(locateItems(itemsResponse.items, selectedItemProject.project_store))
        }
      })
    }
    return () => {
      active = false
    }
  }, [
    apiForProject,
    cloudWorkspace.commands,
    cloudWorkspace.state.projectItems,
    locateItems,
    selectedItem,
    selectedItemProject,
    selectedProjectRef,
  ])

  async function saveExecutionConfiguration(
    item: LocatedLoopItem,
    result: IssueExecutionConfigResult
  ): Promise<LocatedLoopItem> {
    const project = projectForItem(item)
    const itemApi = apiForProject(project)
    if (!project || (project.location === 'cloud' ? !cloudWorkspaceApi : !itemApi)) {
      throw new Error('项目空间当前不可用')
    }

    setBoardError(null)
    const updated =
      project.location === 'cloud'
        ? await cloudWorkspace.commands
            .updateIssue(item.id, {
              version: item.version,
              workflow: result.workflow as unknown as Record<string, unknown> | undefined,
              executionConfig: result.execution_config as unknown as
                | Record<string, unknown>
                | undefined,
            })
            .then(updated => {
              if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
              return toCloudLoopItem(updated)
            })
        : await itemApi!.updateLoopItem(item.id, {
            version: item.version,
            ...result,
          })
    const locatedUpdated = { ...updated, project_store: item.project_store }
    const projectKey = projectSpaceKey(projectSpaceRef(project))

    if (project.location === 'local') {
      setItems(current =>
        current.map(candidate => (candidate.id === updated.id ? locatedUpdated : candidate))
      )
      setLocalProjectItems(current => ({
        ...current,
        [projectKey]: (current[projectKey] ?? []).map(candidate =>
          candidate.id === updated.id ? locatedUpdated : candidate
        ),
      }))
    }
    if (project.location === 'local') {
      setDetailItems(current =>
        current.map(candidate => (candidate.id === updated.id ? locatedUpdated : candidate))
      )
    }
    setSelectedItem(current => (current?.id === updated.id ? locatedUpdated : current))
    return locatedUpdated
  }

  async function performStandardBoardMove(
    item: LocatedLoopItem,
    column: ProjectBoardColumn,
    beforeItemId: string | null,
    mutation: StandardCloudBoardMutation<LocatedLoopItem>,
    executionResult?: IssueExecutionConfigResult,
    automationRuleId?: string
  ): Promise<boolean> {
    if (!canEditProjectSpaceIssue(item) || isAITableProject) return false
    const enteringExecution = mutation.kind === 'status' && isProcessingStatus(mutation.status)
    const forceStart =
      mutation.kind === 'status' && item.status === 'pending' && isProcessingStatus(mutation.status)
    const itemProject = projectForItem(item)
    let executionItem = item
    if (enteringExecution && !item.workflow && item.can_view_detail !== false) {
      const itemApi = apiForProject(itemProject)
      if (!itemProject || (itemProject.location === 'cloud' ? !cloudWorkspaceApi : !itemApi)) {
        setBoardError('项目空间当前不可用')
        return false
      }
      try {
        const refreshed =
          itemProject.location === 'cloud'
            ? await cloudWorkspace.commands.getIssue(item.id).then(refreshed => {
                if (!refreshed) throw new Error(cloudWorkspaceMessages.loadFailed)
                return toCloudLoopItem(refreshed)
              })
            : await itemApi!.getLoopItem(item.id)
        executionItem = { ...refreshed, project_store: item.project_store }
        if (itemProject.location === 'local') {
          setItems(current =>
            current.map(candidate => (candidate.id === item.id ? executionItem : candidate))
          )
        }
      } catch (cause) {
        setBoardError(cause instanceof Error ? cause.message : '读取 Issue 配置失败')
        return false
      }
    }
    const needsExecutionConfig = enteringExecution && itemNeedsExecutionConfiguration(executionItem)
    if (needsExecutionConfig && !executionResult) {
      openExecutionConfiguration({
        item: executionItem,
        continuation: { type: 'move', column, beforeItemId, mutation },
      })
      return false
    }
    const notifyAssignee =
      mutation.kind === 'assignee' &&
      mutation.assigneeType === 'user' &&
      Number(mutation.assigneeId) !== user.id &&
      Number(mutation.assigneeId) !== item.assignee_user_id &&
      item.project_store === 'backend'
        ? await notificationChoice.request()
        : true
    if (notifyAssignee === null) return false
    const taskBindingCount = Math.max(
      activeItemTaskBindings[item.id]?.length ?? 0,
      runtimeAddressesByWorkItem.get(`${item.cloud_project_id}:${item.id}`)?.length ?? 0
    )
    const previousItems = activeBoardSourceItems
    if (itemProject?.location !== 'cloud') {
      setItems(mutation.optimisticItems)
    }
    setBoardError(null)
    try {
      const itemApi = apiForProject(itemProject)
      if (!itemProject || (itemProject.location === 'cloud' ? !cloudWorkspaceApi : !itemApi)) {
        throw new Error('项目空间当前不可用')
      }
      const updateItem = async (
        target: LocatedLoopItem,
        update: WeworkStandardBoardUpdate
      ): Promise<CloudLoopItem> => {
        if (itemProject.location === 'local') {
          return itemApi!.updateLoopItem(target.id, {
            version: target.version,
            ...update,
          })
        }
        return cloudWorkspace.commands
          .updateIssue(
            target.id,
            {
              version: target.version,
              status: update.status,
              priority: update.priority as CollaborationIssue['priority'] | undefined,
              assigneeUserId: update.assignee_user_id,
              assigneeAgentId: update.assignee_agent_id,
              assigneeTeamId: update.assignee_team_id,
              tags: update.tags,
              workflow: update.workflow as unknown as Record<string, unknown> | undefined,
              executionConfig: update.execution_config as unknown as
                | Record<string, unknown>
                | undefined,
              automationRuleId: update.automation_rule_id,
            },
            { throwOnError: true }
          )
          .then(updated => {
            if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
            return toCloudLoopItem(updated)
          })
      }
      const assignItem =
        itemProject.location === 'cloud' || typeof itemApi!.assignLoopItem === 'function'
          ? async (
              target: LocatedLoopItem,
              assignment: {
                assigneeId: string
                assigneeType: 'user' | 'agent' | 'team'
                notifyAssignee: boolean
              }
            ): Promise<CloudLoopItem> =>
              itemProject.location === 'cloud'
                ? cloudWorkspace.commands
                    .assignIssue(String(target.cloud_project_id), target.id, {
                      version: target.version,
                      assigneeType: assignment.assigneeType,
                      assigneeId: assignment.assigneeId,
                      notifyAssignee: assignment.notifyAssignee,
                    })
                    .then(updated => {
                      if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
                      return toCloudLoopItem(updated)
                    })
                : itemApi!.assignLoopItem!(target.cloud_project_id, target.id, {
                    version: target.version,
                    assigneeType: assignment.assigneeType,
                    assigneeId: assignment.assigneeId,
                    notifyAssignee: assignment.notifyAssignee,
                  })
          : undefined
      const updated = await executeStandardCloudBoardMutation({
        additionalUpdate: {
          ...executionResult,
          ...(automationRuleId ? { automation_rule_id: automationRuleId } : {}),
        },
        commands: {
          update: updateItem,
          assign: assignItem,
          reorder: isMyTasksBoard
            ? undefined
            : async (reorderedItem, reorder) => {
                if (itemProject.location === 'cloud') {
                  const optimisticItems = cloudWorkspace.state.issues.map(candidate => {
                    const optimistic = reorder.optimisticItems.find(
                      boardItem => boardItem.id === candidate.id
                    )
                    return optimistic ?? candidate
                  })
                  await cloudWorkspace.commands.reorderIssue({
                    issue: reorderedItem as unknown as CollaborationIssue,
                    status: reorder.status,
                    laneIds: reorder.laneIds,
                    optimisticItems: optimisticItems as unknown as CollaborationIssue[],
                  })
                  return
                }
                await itemApi!.reorderLoopItems(item.cloud_project_id, {
                  parent_id: item.parent_id,
                  status: reorder.status,
                  item_ids: reorder.laneIds,
                })
              },
        },
        item,
        mutation,
        notifyAssignee,
      })
      const locatedUpdated = { ...updated, project_store: item.project_store }
      if (itemProject.location === 'local') {
        setItems(current =>
          current.map(candidate => (candidate.id === updated.id ? locatedUpdated : candidate))
        )
      }
      setSelectedItem(current => (current?.id === updated.id ? locatedUpdated : current))
      const automationAddedIncompleteWorkflow =
        enteringExecution && !executionResult && itemNeedsExecutionConfiguration(locatedUpdated)
      if (automationAddedIncompleteWorkflow) {
        openExecutionConfiguration({
          item: locatedUpdated,
          continuation: { type: 'save' },
        })
        return false
      }
      const shouldOpenTaskComposer =
        enteringExecution &&
        shouldPrepareWorkItemTask(locatedUpdated, item.status, taskBindingCount)
      if (shouldOpenTaskComposer) {
        const initialInput = workItemTaskInput(locatedUpdated)
        setSelectedTaskBinding(null)
        setSelectedItem(locatedUpdated)
        setBackgroundTaskItemId(
          mutation.kind === 'status' && mutation.status === 'in_progress' ? locatedUpdated.id : null
        )
        openTaskComposer({
          workItemId: locatedUpdated.id,
          initialInput,
          backgroundAfterSend: column.status === 'in_progress',
          taskRequest: forceStart
            ? {
                runtime: 'codex',
                message: initialInput,
                forceStart: true,
              }
            : undefined,
        })
      } else if (forceStart && workbench) {
        const addresses = new Map<string, RuntimeTaskAddress>()
        for (const binding of activeItemTaskBindings[item.id] ?? []) {
          const address = { deviceId: binding.device_id, taskId: binding.task_id }
          addresses.set(runtimeConversationKey(address), address)
        }
        for (const address of runtimeAddressesByWorkItem.get(
          `${item.cloud_project_id}:${item.id}`
        ) ?? []) {
          addresses.set(runtimeConversationKey(address), address)
        }
        const queuedAddresses = [...addresses.values()].filter(address => {
          const task = runtimeTasksByKey.get(runtimeConversationKey(address))
          return task?.status?.trim().toLowerCase() === 'queued'
        })
        const forceStartResults = await Promise.allSettled(
          queuedAddresses.map(address => workbench.forceStartRuntimeTask(address))
        )
        const failedForceStart = forceStartResults.find(result => result.status === 'rejected')
        if (failedForceStart?.status === 'rejected') {
          console.error('[Wework project board] queued task force start failed', {
            itemId: locatedUpdated.id,
            error: failedForceStart.reason,
          })
          setBoardError(t('workbench.runtime_task_force_start_failed'))
        }
      } else if (
        enteringExecution &&
        shouldRevealWorkItemWorkflowActions(
          locatedUpdated,
          item.status !== locatedUpdated.status
        ) &&
        locatedUpdated.can_view_detail !== false
      ) {
        setBackgroundTaskItemId(null)
        setSelectedTaskBinding(null)
        setSelectedItem(locatedUpdated)
      }
      track('board_item_moved', {
        group_by: nativeGroupBy,
        reordered: beforeItemId !== null,
        source: projectForItem(item)?.location ?? 'unknown',
      })
      return true
    } catch (cause) {
      if (itemProject?.location === 'local') setItems(previousItems)
      const candidates = automationSelectionCandidates(cause)
      if (candidates && !automationRuleId) {
        setBoardError(null)
        setPendingAutomationSelection({
          candidates,
          onCancel: () => setPendingAutomationSelection(null),
          onConfirm: async selectedAutomationId => {
            const moved = await performStandardBoardMove(
              item,
              column,
              beforeItemId,
              mutation,
              executionResult,
              selectedAutomationId
            )
            if (!moved) {
              throw new Error(
                t('todo.automation_selection_move_failed', '移动 Issue 失败，请重新选择')
              )
            }
            setPendingAutomationSelection(null)
          },
        })
        return false
      }
      setBoardError(cause instanceof Error ? cause.message : '移动任务失败')
      if (executionResult && item.can_view_detail !== false) {
        setSelectedItem(item)
      }
      track('operation_failed', { operation: 'board_item_move' })
      if (executionResult) throw cause
      return false
    }
  }

  function finishBoardDrop(event: DragEndEvent) {
    setActiveDragItemId(null)
    const beforeCardId = boardCardIdFromDropId(event.over?.id)
    standardBoardController.moveDroppedItem({
      activeItemId: String(event.active.id),
      beforeItemId: beforeCardId,
      columnDropKey: beforeCardId ? null : boardStatusFromDropId(event.over?.id),
    })
  }

  async function saveGlobalGroupBy() {
    if (!selectedProject || groupScopeBusy) return
    const projectApi = projectSpaceApis[selectedProject.location]
    if (selectedProject.location === 'cloud' ? !cloudWorkspaceApi : !projectApi) return
    setGroupScopeBusy(true)
    setBoardError(null)
    try {
      const boardConfig = {
        group_by: nativeGroupBy,
        processing_start_status_id: processingStartStatusId,
        statuses: nativeStatuses,
      }
      const updated =
        selectedProject.location === 'cloud'
          ? await cloudWorkspace.commands
              .updateProject(String(selectedProject.id), {
                version: selectedProject.version,
                boardConfig,
              })
              .then(updated => {
                if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
                return toWeworkCloudProject(updated)
              })
          : await projectApi!.updateCloudProject(selectedProject.id, {
              version: selectedProject.version,
              board_config: boardConfig,
            })
      if (personalGroupKey) localStorage.removeItem(personalGroupKey)
      replaceProject(selectedProject, updated)
      track('feature_action_completed', { domain: 'project_space', action: 'save_grouping' })
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setBoardError(cause instanceof Error ? cause.message : '保存全局分组失败')
    } finally {
      setGroupScopeBusy(false)
    }
  }

  const aiChatProject = selectedItemProject

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
      if (input.assigneeUserId) {
        if (targetProject.location === 'cloud') {
          created = await cloudWorkspace.commands
            .assignIssue(String(targetProject.id), created.id, {
              version: created.version,
              assigneeType: 'user',
              assigneeId: String(input.assigneeUserId),
              notifyAssignee,
            })
            .then(issue => {
              if (!issue) throw new Error(cloudWorkspaceMessages.saveFailed)
              return toCloudLoopItem(issue)
            })
        } else if (typeof targetApi!.assignLoopItem === 'function') {
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
      const executionConfigurationResult = requestCreatedItemExecutionConfiguration(locatedItem)
      if (input.createTask && executionConfigurationResult === 'not-needed') {
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

  const taskPanelOpen = Boolean(
    selectedItem &&
    aiChatProject &&
    backgroundTaskItemId !== selectedItem.id &&
    (selectedTaskBinding?.work_item_id === selectedItem.id ||
      taskComposerRequest?.workItemId === selectedItem.id)
  )
  const taskStartingInBackground = backgroundTaskItemId === selectedItem?.id
  const [issueResourceAttachmentState, setIssueResourceAttachmentState] = useState<{
    itemId: string | null
    attachments: CloudLoopItemAttachment[]
  }>({ itemId: null, attachments: [] })
  const issueResourceAttachments =
    issueResourceAttachmentState.itemId === selectedItem?.id
      ? issueResourceAttachmentState.attachments
      : []
  const issueResourceAttachmentsLoading = Boolean(
    taskPanelOpen &&
    selectedItem &&
    selectedItemProject &&
    (selectedItemProject.location === 'cloud' ? cloudWorkspaceApi : selectedItemApi) &&
    issueResourceAttachmentState.itemId !== selectedItem.id
  )

  useEffect(() => {
    if (
      !taskPanelOpen ||
      !selectedItem ||
      !selectedItemProject ||
      (selectedItemProject.location === 'cloud' ? !cloudWorkspaceApi : !selectedItemApi)
    ) {
      return
    }
    let active = true
    const request =
      selectedItemProject.location === 'cloud'
        ? cloudWorkspaceApi!.attachments
            .list(selectedItem.id)
            .then(attachments => attachments as CloudLoopItemAttachment[])
        : selectedItemApi!.listLoopItemAttachments(selectedItem.id)
    void request.then(
      attachments => {
        if (!active) return
        setIssueResourceAttachmentState({ itemId: selectedItem.id, attachments })
      },
      () => {
        if (!active) return
        setIssueResourceAttachmentState({ itemId: selectedItem.id, attachments: [] })
      }
    )
    return () => {
      active = false
    }
  }, [cloudWorkspaceApi, selectedItem, selectedItemApi, selectedItemProject, taskPanelOpen])

  const closeTaskPanel = useCallback(() => {
    advanceTaskPanelSession()
    setSelectedTaskBinding(null)
    setTaskComposerRequest(null)
  }, [advanceTaskPanelSession])

  const closeIssuePanelStack = useCallback(() => {
    setBackgroundTaskItemId(null)
    setSelectedItem(null)
    closeTaskPanel()
  }, [closeTaskPanel])

  const openBoardItem = useCallback(
    (item: LocatedLoopItem) => {
      if (item.can_view_detail === false) return
      setPinnedBoardPreview(null)
      setBackgroundTaskItemId(null)
      closeTaskPanel()
      if (isRuntimeMyWorkItem(item)) {
        void openBoardRuntimeTask(item.runtime_address)
        return
      }
      setSelectedItem(item)
    },
    [closeTaskPanel, openBoardRuntimeTask]
  )

  function closeTopPanel() {
    closeIssuePanelStack()
  }

  async function prepareSelectedItemTask(address: RuntimeTaskAddress) {
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
      const workflowNodeId =
        taskComposerRequest?.workItemId === selectedItem.id
          ? taskComposerRequest.workflowNodeId
          : undefined
      await runtimeBindingApi.bindTask(latest.id, address, latest.title, workflowNodeId)
      rememberProjectTaskStore(address, selectedItem.project_store ?? 'backend')
      publishProjectSpaceTaskBindingChanged(address)
      setBoardRefreshNonce(value => value + 1)
      return async () => {
        await runtimeBindingApi.unbindTask(latest.id, address)
        publishProjectSpaceTaskBindingChanged(address)
        setBoardRefreshNonce(value => value + 1)
      }
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : '关联任务与 Issue 失败，请重试')
      setBoardRefreshNonce(value => value + 1)
      throw cause
    }
  }

  async function handleSelectedItemTaskCreated(
    _address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null
  ) {
    if (!selectedItem || !selectedItemProject) return
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
      const associatedTags =
        isMyTasksBoard && localProject ? associateLoopItemTags(latest, localProject) : latest.tags
      const associationChanged =
        associatedTags.length !== latest.tags.length ||
        associatedTags.some((tag, index) => tag !== latest.tags[index])
      const updated =
        latest.status === 'inbox' || associationChanged
          ? selectedItemProject.location === 'cloud'
            ? await cloudWorkspace.commands
                .updateIssue(latest.id, {
                  version: latest.version,
                  ...(latest.status === 'inbox' ? { status: 'pending' } : {}),
                  ...(associationChanged ? { tags: associatedTags } : {}),
                })
                .then(updated => {
                  if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
                  return toCloudLoopItem(updated)
                })
            : await localApi!.updateLoopItem(latest.id, {
                version: latest.version,
                ...(latest.status === 'inbox' ? { status: 'pending' } : {}),
                ...(associationChanged ? { tags: associatedTags } : {}),
              })
          : latest
      const locatedUpdated = {
        ...updated,
        project_store: selectedItem.project_store,
      }
      if (selectedItemProject.location === 'local') {
        setItems(current =>
          current.map(item =>
            item.id === locatedUpdated.id
              ? preferNewestLoopItemSnapshot(item, locatedUpdated)
              : item
          )
        )
      }
      setSelectedItem(current =>
        current?.id === locatedUpdated.id
          ? preferNewestLoopItemSnapshot(current, locatedUpdated)
          : current
      )
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : '关联任务与 Issue 失败，请重试')
      setBoardRefreshNonce(value => value + 1)
    }
  }

  useEffect(() => {
    if (!selectedItem || backgroundTaskItemId === selectedItem.id) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeIssuePanelStack()
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [backgroundTaskItemId, closeIssuePanelStack, selectedItem])

  return (
    <div
      className={cn(
        'z-content flex min-h-0 min-w-0 overflow-hidden bg-background text-text-primary',
        embedded ? 'relative flex-1' : 'absolute inset-0 w-full'
      )}
      data-testid="cloud-todo-workspace"
      data-embedded={embedded}
      data-sidebar-collapsed={embedded || sidebarCollapsed}
    >
      {notificationChoice.dialog}
      {(selectedProject?.location === 'cloud'
        ? cloudWorkspace.state.project?.id === String(selectedProject.id)
        : selectedProjectKey === itemTaskBindingsProjectKey) &&
      selectedProject?.pull_request_automation?.enabled &&
      changeRequestMonitor
        ? Object.entries(boardTaskBindings).map(([itemId, bindings]) => {
            const binding = bindings.find(candidate => candidate.running) ?? bindings[0]
            return binding?.changeRequestTarget ? (
              <ProjectChangeRequestAutoRepairObserver
                key={`${itemId}:${binding.device_id}:${binding.task_id}`}
                itemId={itemId}
                binding={binding}
                monitor={changeRequestMonitor}
                statuses={selectedProject.pull_request_automation!.statuses}
                onRepair={continueChangeRequestRepair}
              />
            ) : null
          })
        : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!embedded ? (
          <aside
            className={cn(
              'relative shrink-0 overflow-hidden border-r border-black/[0.08] bg-[rgb(var(--color-sidebar))] transition-[width,background-color] duration-200',
              sidebarCollapsed ? 'w-0 border-r-0' : 'w-[240px]'
            )}
          >
            <ProjectSpaceSidebar
              header={
                <DesktopSidebarHeader
                  actionsTestId="cloud-todo-sidebar-chrome-controls"
                  actions={
                    <>
                      <DesktopWindowControls
                        sidebarCollapsed={false}
                        onToggleSidebar={() => setSidebarCollapsed(true)}
                        className="gap-0"
                        toggleTestId="cloud-todo-collapse-sidebar"
                      />
                      <Tooltip label={t('workbench.search')} side="bottom" align="end">
                        <button
                          type="button"
                          data-testid="cloud-search-toggle"
                          onClick={() => setGlobalSearchOpen(true)}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                          aria-label={t('workbench.search')}
                        >
                          <Search className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    </>
                  }
                />
              }
              navItems={[
                {
                  icon: <Plus className="h-4 w-4 text-current" />,
                  label: isMyTasksBoard
                    ? t('todo.new_task', '新建任务')
                    : t('todo.new_issue', '新建 Issue'),
                  testId: 'cloud-create-issue',
                  selected: issueComposerOpen || createTodoOpen,
                  onClick: () => openIssueCreation(),
                },
              ]}
              sectionLabel={t('todo.boards', '看板')}
              addLabel={t('todo.new_project_space', '新建项目空间')}
              addIcon={<Plus className="mx-auto h-3.5 w-3.5" />}
              onAdd={() => setCreateProjectOpen(true)}
              onSelectProject={spaceKey => {
                const project = projects.find(
                  candidate => projectSpaceKey(projectSpaceRef(candidate)) === spaceKey
                )
                if (!project) return
                setIssueComposerOpen(false)
                setCreateTodoOpen(false)
                selectProject(project)
                setProjectView('board')
                setSelectedItem(null)
              }}
              labels={{
                actions: t('todo.project_actions', '项目操作'),
                archive: '归档项目',
                copied: t('todo.project_id_copied', '项目 ID 已复制'),
                copyId: t('todo.copy_project_id', '复制项目 ID'),
                rename: '修改项目名称',
              }}
              moreIcon={<Ellipsis className="h-3.5 w-3.5" />}
              checkIcon={<Check className="h-3.5 w-3.5 text-green-600" />}
              copyIcon={<Copy className="h-3.5 w-3.5" />}
              projects={projects.map(project => {
                const ProjectLocationIcon = project.location === 'local' ? HardDrive : Cloud
                const spaceKey = projectSpaceKey(projectSpaceRef(project))
                return {
                  canManage:
                    project.created_by_user_id === user.id ||
                    project.access_role === 'Owner' ||
                    project.access_role === 'Maintainer',
                  count: collaborationProjectCounts[spaceKey],
                  icon: (
                    <ProjectLocationIcon className="h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))]" />
                  ),
                  id: String(project.id),
                  key: spaceKey,
                  name: project.name,
                  selected: sameProjectSpace(selectedProjectRef, projectSpaceRef(project)),
                  onArchive: () => {
                    setArchiveError(null)
                    setArchiveProject(project)
                  },
                  onCopyId: () => copyTextToClipboard(String(project.id)),
                  onRename: () => {
                    setRenameProject(project)
                    setRenameProjectName(project.name)
                    setRenameError(null)
                  },
                }
              })}
              renderTooltip={({ align, children, className, label, side }) => (
                <Tooltip label={label} side={side} align={align} className={className}>
                  {children}
                </Tooltip>
              )}
              account={
                onOpenSettings && onLogout ? (
                  <DesktopSidebarAccount
                    user={user}
                    onOpenSettings={onOpenSettings}
                    onLogout={onLogout}
                  />
                ) : null
              }
            />
          </aside>
        ) : null}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {!embedded && !selectedProject && (
            <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
          )}
          {!embedded && sidebarCollapsed && (
            <div
              data-testid="cloud-todo-collapsed-chrome-controls"
              className="electron-titlebar-interactive-region pointer-events-auto absolute left-2 top-0 z-20 flex h-[38px] items-center gap-1"
            >
              <DesktopWindowControls
                sidebarCollapsed
                onToggleSidebar={() => setSidebarCollapsed(false)}
                className="gap-1"
                toggleTestId="cloud-todo-expand-sidebar"
              />
            </div>
          )}
          {!selectedProject && projects.length > 0 && localProjectsError ? (
            <div
              data-testid="local-project-spaces-error"
              className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive"
            >
              <span>本地项目空间加载失败：{localProjectsError}</span>
              <button
                type="button"
                data-testid="local-project-spaces-retry"
                onClick={retryLocalProjects}
                className="h-7 shrink-0 rounded-md border border-destructive/30 px-2 text-xs font-medium hover:bg-destructive/10"
              >
                {t('common.retry', '重试')}
              </button>
            </div>
          ) : null}
          {issueComposerOpen ? (
            <IssueComposer
              key={`${issueComposerBoardKey}:${issueComposerStatus}:${issueComposerInitialContent}`}
              projects={projects}
              initialBoardKey={issueComposerBoardKey}
              initialStartExecution={isProcessingStatus(issueComposerStatus)}
              initialContent={issueComposerInitialContent}
              localProjects={localProjectOptions}
              projectMembers={collaborationProjectMembers}
              initialLocalProjectId={selectedLocalProject?.id ?? null}
              presentation={issueComposerPresentation}
              busy={issueComposerBusy}
              error={issueComposerError}
              onCancel={() => setIssueComposerOpen(false)}
              onCreate={createIssueFromComposer}
            />
          ) : !selectedProject && localProjectsError ? (
            <div
              data-testid="local-project-spaces-error"
              className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-sm text-destructive"
            >
              <span>本地项目空间加载失败：{localProjectsError}</span>
              <button
                type="button"
                data-testid="local-project-spaces-retry"
                onClick={retryLocalProjects}
                className="h-8 rounded-lg border border-destructive/30 px-3 text-sm font-medium hover:bg-destructive/10"
              >
                {t('common.retry', '重试')}
              </button>
            </div>
          ) : (projectSpaceApis.local ? localProjectsLoading : cloudWorkspace.state.loading) ? (
            <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
              正在加载项目…
            </div>
          ) : !selectedProject ? (
            <div
              data-testid="cloud-project-unavailable"
              className="flex flex-1 items-center justify-center text-sm text-text-muted"
            >
              未找到要打开的项目
            </div>
          ) : (
            <CollaborationProjectViewShell
              project={selectedProjectForViewAccess ?? selectedProject}
              view={projectView}
              labels={{
                board: '看板',
                table: t('todo.table_view', '数据视图'),
                files: '文件',
                automation: '自动化',
                manage: '管理',
              }}
              testIds={{
                board: 'cloud-project-board-view',
                table: 'cloud-project-table-view',
                files: 'cloud-project-files-view',
                automation: 'cloud-project-automation-view',
                manage: 'cloud-project-manage-view',
              }}
              automationSupported={selectedProjectAutomationSupported}
              compactSwitcherIcon={<ChevronDown className="h-3 w-3" />}
              onViewChange={view => setProjectView(view as ProjectView)}
              assistantAction={{
                icon: <Bot className="h-3.5 w-3.5" />,
                label: t('workbench.project_chat'),
                onClick: openProjectAssistant,
                renderTooltip: (children, label) => (
                  <Tooltip label={label} side="bottom" align="end">
                    {children}
                  </Tooltip>
                ),
              }}
              assistantOpen={projectAssistantOpen}
              dragRegion={
                !embedded ? (
                  <MacOSTitleBarDragRegion
                    className={cn(
                      'absolute right-0 top-0 z-0 h-full',
                      sidebarCollapsed ? 'left-12' : 'left-0'
                    )}
                  />
                ) : null
              }
              embedded={embedded}
              hasCreateAction={canCreateBoardTask}
              renderRightActions={({ actionRefs, level, showLabels }) => (
                <>
                  {projectView === 'board' && level < 2 ? (
                    <>
                      <Tooltip
                        label={
                          boardParent || isMyTasksBoard
                            ? t('todo.search_tasks', '搜索任务')
                            : t('todo.search_issues', '搜索 Issue')
                        }
                        side="bottom"
                        align="end"
                      >
                        <button
                          ref={actionRefs.search}
                          type="button"
                          data-testid="cloud-project-task-search-toggle"
                          aria-label={
                            boardParent || isMyTasksBoard
                              ? t('todo.search_tasks', '搜索任务')
                              : t('todo.search_issues', '搜索 Issue')
                          }
                          onClick={() => setProjectSearchOpen(current => !current)}
                          className="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary transition hover:bg-muted"
                        >
                          <Search className="h-3.5 w-3.5" />
                          {showLabels
                            ? boardParent || isMyTasksBoard
                              ? t('todo.search_tasks', '搜索任务')
                              : t('todo.search_issues', '搜索 Issue')
                            : null}
                        </button>
                      </Tooltip>
                      {canCreateBoardTask ? (
                        <Tooltip
                          label={
                            boardParent || isMyTasksBoard
                              ? t('todo.new_task', '新建任务')
                              : t('todo.new_issue', '新建 Issue')
                          }
                          side="bottom"
                          align="end"
                        >
                          <button
                            ref={actionRefs.add}
                            type="button"
                            data-testid="cloud-todo-add"
                            aria-label={
                              boardParent || isMyTasksBoard
                                ? t('todo.new_task', '新建任务')
                                : t('todo.new_issue', '新建 Issue')
                            }
                            onClick={() =>
                              boardParent ? openTodoCreation(boardParent) : openIssueCreation()
                            }
                            className="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition hover:opacity-90"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {showLabels
                              ? boardParent || isMyTasksBoard
                                ? t('todo.new_task', '新建任务')
                                : t('todo.new_issue', '新建 Issue')
                              : null}
                          </button>
                        </Tooltip>
                      ) : null}
                    </>
                  ) : null}
                  {level >= 2 && (!projectAssistantOpen || projectView === 'board') ? (
                    <ActionMenu
                      ariaLabel={t('workbench.more', '更多')}
                      testId="cloud-project-header-more"
                      icon={Ellipsis}
                      placement="bottom-end"
                      triggerClassName="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-text-secondary transition hover:bg-muted hover:text-text-primary"
                      items={[
                        ...(!projectAssistantOpen
                          ? [
                              {
                                label: t('workbench.project_chat'),
                                icon: Bot,
                                testId: 'cloud-project-header-more-ask-ai',
                                onSelect: openProjectAssistant,
                              },
                            ]
                          : []),
                        ...(projectView === 'board'
                          ? [
                              {
                                label:
                                  boardParent || isMyTasksBoard
                                    ? t('todo.search_tasks', '搜索任务')
                                    : t('todo.search_issues', '搜索 Issue'),
                                icon: Search,
                                testId: 'cloud-project-header-more-search',
                                onSelect: () => setProjectSearchOpen(true),
                              },
                            ]
                          : []),
                      ]}
                    />
                  ) : null}
                  {projectView === 'board' && level >= 2 && canCreateBoardTask ? (
                    <Tooltip
                      label={
                        boardParent || isMyTasksBoard
                          ? t('todo.new_task', '新建任务')
                          : t('todo.new_issue', '新建 Issue')
                      }
                      side="bottom"
                      align="end"
                    >
                      <button
                        ref={actionRefs.add}
                        type="button"
                        data-testid="cloud-todo-add"
                        aria-label={
                          boardParent || isMyTasksBoard
                            ? t('todo.new_task', '新建任务')
                            : t('todo.new_issue', '新建 Issue')
                        }
                        onClick={() =>
                          boardParent ? openTodoCreation(boardParent) : openIssueCreation()
                        }
                        className="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 w-8 items-center justify-center rounded-lg bg-text-primary text-background transition hover:opacity-90"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  ) : null}
                </>
              )}
              searchPanel={
                projectView === 'board' && projectSearchOpen ? (
                  <TaskSearchPanel
                    items={boardItems}
                    members={
                      selectedProjectKey
                        ? (collaborationProjectMembers[selectedProjectKey] ?? [])
                        : []
                    }
                    query={projectSearchQuery}
                    filters={projectSearchFilters}
                    tags={availableTags}
                    onQueryChange={setProjectSearchQuery}
                    onFiltersChange={setProjectSearchFilters}
                    onSelect={item => {
                      openBoardItem(item)
                      setProjectSearchOpen(false)
                    }}
                  />
                ) : null
              }
              sidebarCollapsed={sidebarCollapsed}
              title={
                embedded && embeddedTitle === 'workspace'
                  ? t('workbench.workspace_tab_board', '协作')
                  : selectedProject.name
              }
              titleIcon={
                embedded ? (
                  <Grid3X3 className="h-4 w-4 shrink-0 text-text-muted" />
                ) : selectedProject.location === 'local' ? (
                  <HardDrive className="h-4 w-4 shrink-0 text-text-muted" />
                ) : (
                  <Cloud className="h-4 w-4 shrink-0 text-text-muted" />
                )
              }
              slots={{
                table:
                  isAITableProject && aitableApi ? (
                    <AITableView api={aitableApi} project={selectedProject} />
                  ) : (
                    <ProjectIssueTable
                      issues={selectedProjectBoardItems}
                      assignmentsByIssueId={issueTableAssignmentsByIssue}
                      emptyLabel={t('todo.issue_table_empty', '暂无 Issue')}
                      issueLabel={t('todo.issue_column', 'Issue')}
                      statusLabel={t('todo.status', '状态')}
                      assignmentsLabel={t('todo.assignments', '分配')}
                      updatedLabel={t('todo.updated_at', '更新时间')}
                      onOpen={item => {
                        if (item.can_view_detail !== false) {
                          setSelectedItem(item as LocatedLoopItem)
                        }
                      }}
                    />
                  ),
                files: (
                  selectedProject.location === 'cloud' ? cloudWorkspaceApi : selectedProjectApi
                ) ? (
                  selectedProject.location === 'cloud' ? (
                    <CloudFilesView api={cloudWorkspaceApi!} project={selectedProject} />
                  ) : (
                    <LocalFilesView api={selectedProjectApi!} project={selectedProject} />
                  )
                ) : null,
                automation:
                  selectedProjectAutomationSupported &&
                  (selectedProject.location === 'cloud' ? cloudWorkspaceApi : selectedProjectApi) &&
                  selectedProjectServices ? (
                    <ProjectAutomationView
                      key={selectedProject.id}
                      api={selectedProject.location === 'local' ? selectedProjectApi : undefined}
                      workspaceApi={
                        selectedProject.location === 'cloud' ? cloudWorkspaceApi : undefined
                      }
                      projectChatAgentApi={selectedProjectAgentApi}
                      projectAutomationApi={
                        selectedProject.location === 'local'
                          ? selectedProjectServices?.projectAutomationApi
                          : undefined
                      }
                      projectIncomingHookApi={
                        selectedProject.location === 'local'
                          ? selectedProjectServices?.projectIncomingHookApi
                          : undefined
                      }
                      runtimeProfileApi={selectedProjectServices?.runtimeProfileApi}
                      deviceApi={selectedProjectServices.deviceApi}
                      modelApi={services.modelApi}
                      teamApi={selectedProjectServices?.teamApi}
                      pluginApi={selectedProjectServices?.pluginApi}
                      localProjects={localProjectOptions}
                      runtimeWork={runtimeWork}
                      onCreateLocalCodeProject={onCreateLocalCodeProject}
                      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
                      onListDeviceDirectories={onListDeviceDirectories}
                      onCreateDeviceDirectory={onCreateDeviceDirectory}
                      onCloneGitRepository={onCloneGitRepository}
                      project={selectedProject}
                      currentUserId={selectedProject.current_user_id}
                      projectMembers={
                        selectedProjectKey
                          ? (collaborationProjectMembers[selectedProjectKey] ?? [])
                          : []
                      }
                      canManageAgents={['Owner', 'Maintainer'].includes(
                        selectedProject.access_role ?? 'Owner'
                      )}
                      onOpenTask={item => {
                        setDetailItems(current =>
                          current.some(existing => existing.id === item.id)
                            ? current
                            : [...current, item]
                        )
                        setSelectedItem(item)
                      }}
                      onProjectUpdated={updated => replaceProject(selectedProject, updated)}
                    />
                  ) : null,
                manage: (
                  selectedProject.location === 'cloud' ? cloudWorkspaceApi : selectedProjectApi
                ) ? (
                  selectedProject.location === 'cloud' ? (
                    <CloudProjectManageView
                      api={cloudWorkspaceApi!}
                      aitableApi={aitableApi}
                      dwsApi={services.dwsApi}
                      project={selectedProject}
                      boardCardDisplay={boardCardDisplay}
                      onProjectUpdated={updated => replaceProject(selectedProject, updated)}
                    />
                  ) : (
                    <LocalProjectManageView
                      api={selectedProjectApi!}
                      aitableApi={aitableApi}
                      dwsApi={services.dwsApi}
                      project={selectedProject}
                      boardCardDisplay={boardCardDisplay}
                      onProjectUpdated={updated => replaceProject(selectedProject, updated)}
                    />
                  )
                ) : null,
                board: (
                  <ProjectBoardBody<LocatedLoopItem>
                    state={boardState}
                    activeDragItemId={activeDragItemId}
                    boardError={boardError}
                    boardItemsLoading={boardItemsLoading}
                    breadcrumb={boardBreadcrumb}
                    columns={boardColumns as ProjectBoardColumn[]}
                    currentParent={boardParent}
                    currentParentId={boardParentId}
                    dnd={{ DndContext, DragOverlay, useDroppable }}
                    dndContextProps={{
                      sensors: boardSensors,
                      collisionDetection: boardCollisionDetection,
                      onDragStart: (event: DragStartEvent) => {
                        setPinnedBoardPreview(null)
                        setActiveDragItemId(String(event.active.id))
                      },
                      onDragCancel: () => setActiveDragItemId(null),
                      onDragEnd: finishBoardDrop,
                    }}
                    externalGroupLabel={selectedGroupField?.name ?? '记录'}
                    externalGroupValues={aitableGroupValues}
                    externalManagedLabel="数据由钉钉托管 · AI 可直接管理"
                    externalSearchPlaceholder="搜索记录"
                    focusLabels={{
                      enter: t('todo.focus_view_description', '展开进行中与待确认列'),
                      exit: t('todo.exit_focus_view_description', '退出执行阶段专注视图'),
                      title: t('todo.focus_view', '专注视图'),
                    }}
                    getColumnDragHint={column =>
                      activeDragItemId && nativeGroupBy === 'status'
                        ? columnDragHints[column.status as CloudLoopItem['status']]
                        : undefined
                    }
                    getColumnEmptyState={column => {
                      const status = column.status as CloudLoopItem['status']
                      const hint = (
                        boardParent || isMyTasksBoard ? taskColumnEmptyHints : issueColumnEmptyHints
                      )[status]
                      if (!hint) return undefined
                      if (status !== 'inbox' && status !== 'pending') return { hint }
                      const onClick = () => {
                        if (!boardParent && status === 'pending')
                          openIssueCreation('pending', '', 'popup')
                        else setQuickCreateStatus(status)
                      }
                      return {
                        hint,
                        action: {
                          label:
                            status === 'inbox'
                              ? t(
                                  boardParent || isMyTasksBoard
                                    ? 'todo.create_first_task'
                                    : 'todo.create_first_issue',
                                  boardParent || isMyTasksBoard
                                    ? '创建第一个任务'
                                    : '创建第一个 Issue'
                                )
                              : t(
                                  boardParent || isMyTasksBoard
                                    ? 'todo.create_task_in_pending'
                                    : 'todo.create_issue_in_pending',
                                  boardParent || isMyTasksBoard
                                    ? '创建到待开始'
                                    : '创建 Issue 到待开始'
                                ),
                          ariaLabel: t(
                            boardParent || isMyTasksBoard
                              ? 'todo.new_task_in_column'
                              : 'todo.new_issue_in_column',
                            { column: column.label }
                          ),
                          onClick,
                        },
                      }
                    }}
                    getColumnItems={(column, state) => {
                      const standardItems = isAITableProject
                        ? boardItems
                        : standardBoardController.getColumnItems(column, state)
                      return standardItems.filter(
                        item =>
                          (isAITableProject
                            ? item.parent_id === boardParentId &&
                              (!column.groupValue ||
                                (column.groupValue === '未设置'
                                  ? !aitableCellLabels(item.source_cells?.[aitableGroupFieldId])
                                      .length
                                  : aitableCellLabels(
                                      item.source_cells?.[aitableGroupFieldId]
                                    ).includes(column.groupValue)))
                            : true) &&
                          (!isMyTasksBoard ||
                            activeLocalProjectFilter === 'all' ||
                            !selectedLocalProject ||
                            localProjectIdForItem(item) === selectedLocalProject.id ||
                            (item.status === 'inbox' && localProjectIdForItem(item) === null)) &&
                          (!state.externalGroupFilter ||
                            column.groupValue === state.externalGroupFilter) &&
                          (!state.externalQuery.trim() ||
                            `${item.title} ${item.description ?? ''}`
                              .toLowerCase()
                              .includes(state.externalQuery.trim().toLowerCase()))
                      )
                    }}
                    getItemKey={item => item.id}
                    groupFields={
                      nativeBoardGroupFields as Array<{ id: ProjectBoardGroupBy; name: string }>
                    }
                    isExternalBoard={isAITableProject}
                    isMyTasksBoard={isMyTasksBoard}
                    layerCount={boardLayerCount}
                    localProjectFilter={
                      isMyTasksBoard
                        ? {
                            activeId: activeLocalProjectFilter,
                            allLabel: t('todo.all_local_projects', '全部项目'),
                            ariaLabel: t('todo.local_project_filter', '本地项目'),
                            label: t('todo.project_with_name', '项目：{{project}}', {
                              project: '{{project}}',
                            }),
                            options: localProjectOptions,
                            selectedName:
                              activeLocalProjectFilter === 'all'
                                ? t('todo.all_local_projects', '全部项目')
                                : (selectedLocalProject?.name ??
                                  t('todo.select_local_project', '选择项目')),
                            onChange: setLocalProjectFilter,
                          }
                        : undefined
                    }
                    onBreadcrumbSelect={setBoardParentId}
                    onSaveGlobalGroupBy={saveGlobalGroupBy}
                    renderAddIcon={() => <Plus className="h-5 w-5" />}
                    renderChevronDown={className => <ChevronDown className={className} />}
                    renderChevronRight={className => <ChevronRight className={className} />}
                    renderColumnFooter={(column, _items, state) => {
                      const status = column.status as CloudLoopItem['status']
                      return canCreateBoardTask &&
                        !isAITableProject &&
                        state.groupBy === 'status' &&
                        status === 'inbox' &&
                        state.quickCreateStatus === status ? (
                        <BoardQuickCreate
                          key={`${selectedProjectKey}:${boardParentId ?? 'root'}:${column.key}`}
                          columnKey={column.key}
                          columnLabel={column.label}
                          localProjects={isMyTasksBoard ? localProjectOptions : undefined}
                          localProjectId={selectedLocalProject?.id}
                          onLocalProjectChange={
                            isMyTasksBoard ? id => setLocalProjectFilter(String(id)) : undefined
                          }
                          onCancel={() => setQuickCreateStatus(null)}
                          onCreate={title => createTodoInBoardColumn(status, title)}
                          onOpenFull={title =>
                            boardParent
                              ? openTodoCreation(boardParent, status, title)
                              : openIssueCreation(status, title, 'popup')
                          }
                        />
                      ) : null
                    }}
                    renderColumnHeaderActions={(column, columnItems, state) => {
                      const status = column.status as CloudLoopItem['status']
                      const open = () =>
                        !boardParent && status === 'pending'
                          ? openIssueCreation('pending', '', 'popup')
                          : setQuickCreateStatus(status)
                      return (
                        <>
                          {isMyTasksBoard &&
                          state.groupBy === 'status' &&
                          status === 'completed' &&
                          columnItems.length > 0 &&
                          onArchiveRuntimeTasks ? (
                            <Tooltip
                              label={t('todo.archive_completed_tasks', '批量归档已完成任务')}
                              side="bottom"
                              align="end"
                            >
                              <button
                                type="button"
                                data-testid="cloud-my-tasks-archive-completed"
                                onClick={() => setRuntimeBatchArchiveItems([...columnItems])}
                                className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 group-hover:opacity-100"
                                aria-label={t('todo.archive_completed_tasks', '批量归档已完成任务')}
                              >
                                <Archive className="h-3.5 w-3.5" />
                              </button>
                            </Tooltip>
                          ) : null}
                          {canCreateBoardTask &&
                          !isAITableProject &&
                          state.groupBy === 'status' &&
                          (status === 'inbox' || status === 'pending') ? (
                            <Tooltip
                              label={t(
                                boardParent || isMyTasksBoard
                                  ? 'todo.new_task_in_column'
                                  : 'todo.new_issue_in_column',
                                boardParent || isMyTasksBoard
                                  ? '在{{column}}中新建任务'
                                  : '在{{column}}中新建 Issue',
                                { column: column.label }
                              )}
                              side="bottom"
                              align="end"
                            >
                              <button
                                type="button"
                                data-testid={`cloud-todo-column-add-${column.key}`}
                                onClick={open}
                                className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 group-hover:opacity-100"
                                aria-label={t(
                                  boardParent || isMyTasksBoard
                                    ? 'todo.new_task_in_column'
                                    : 'todo.new_issue_in_column',
                                  { column: column.label }
                                )}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                            </Tooltip>
                          ) : null}
                        </>
                      )
                    }}
                    renderDragOverlay={() =>
                      activeDragItemId ? (
                        <div className="w-[272px] rotate-1 rounded-xl border border-border bg-background p-3 text-left shadow-lg">
                          <CloudTodoCardContent
                            item={
                              activeBoardSourceItems.find(item => item.id === activeDragItemId)!
                            }
                            display={boardCardDisplay}
                            processingStatus={isProcessingStatus(
                              activeBoardSourceItems.find(item => item.id === activeDragItemId)!
                                .status
                            )}
                            agentNames={agentNameById}
                          />
                        </div>
                      ) : null
                    }
                    renderExternalGroupPicker={() => (
                      <AITableGroupFieldPicker
                        fields={aitableFields}
                        value={aitableGroupFieldId}
                        onChange={id => {
                          setAitableGroupFieldId(id)
                          setAitableGroupFilter('')
                        }}
                      />
                    )}
                    renderFocusIcon={focused =>
                      focused ? (
                        <Minimize2 className="h-3.5 w-3.5" />
                      ) : (
                        <Maximize2 className="h-3.5 w-3.5" />
                      )
                    }
                    renderGroupPicker={(value, onChange) => (
                      <AITableGroupFieldPicker
                        fields={nativeBoardGroupFields}
                        value={value}
                        testIdPrefix="cloud-board-group"
                        searchPlaceholder="搜索分组字段"
                        onChange={id => onChange(id as NativeBoardGroupBy)}
                      />
                    )}
                    renderItem={(item, column, state) => {
                      const progressDisplay: BoardCardProgressDisplay =
                        state.focusExecutionColumns &&
                        state.groupBy === 'status' &&
                        (column.status === 'in_progress' || column.status === 'in_review')
                          ? 'focused'
                          : 'compact'
                      return (
                        <CloudTodoBoardCard
                          item={item}
                          processingStatus={isProcessingStatus(item.status)}
                          taskBindings={
                            (
                              selectedProject.location === 'cloud'
                                ? cloudWorkspace.state.project?.id === String(selectedProject.id)
                                : itemTaskBindingsProjectKey === selectedProjectKey
                            )
                              ? (boardTaskBindings[item.id] ?? []).map(binding =>
                                  withBoardTaskModelSelection(item, binding, runtimeWork)
                                )
                              : []
                          }
                          onClick={() => {
                            openBoardItem(item)
                          }}
                          onConfigureExecution={() =>
                            openExecutionConfiguration({ item, continuation: { type: 'save' } })
                          }
                          onArchive={() => {
                            setArchiveError(null)
                            setArchiveItem(item)
                          }}
                          previewPinned={pinnedBoardPreviewItemId === item.id}
                          onPreviewPinnedChange={pinned =>
                            setPinnedBoardPreview(
                              pinned
                                ? { contextKey: boardPreviewContextKey, itemId: item.id }
                                : null
                            )
                          }
                          onMarkRead={markItemRead}
                          onLoadRuntimeGoal={loadBoardTaskRuntimeGoal}
                          onOpenRuntimeTask={openBoardRuntimeTask}
                          display={boardCardDisplay}
                          agentNames={agentNameById}
                          dragDisabled={isAITableProject}
                          previewDisabled={
                            selectedItem !== null ||
                            activeDragItemId !== null ||
                            (pinnedBoardPreviewItemId !== null &&
                              pinnedBoardPreviewItemId !== item.id)
                          }
                          archiveDisabled={isAITableProject}
                          progressDisplay={progressDisplay}
                          changeRequestMonitor={changeRequestMonitor}
                          onContinueChangeRequestRepair={
                            workbench ? continueChangeRequestRepair : undefined
                          }
                        />
                      )
                    }}
                    renderItemsFooter={column =>
                      isExternalGitBoard &&
                      activeExternalPageCursors[column.status as CloudLoopItem['status']] ? (
                        <button
                          type="button"
                          data-testid={`cloud-todo-column-load-more-${column.key}`}
                          disabled={
                            activeExternalPageLoading[column.status as CloudLoopItem['status']]
                          }
                          onClick={() =>
                            void loadMoreExternalColumn(column.status as CloudLoopItem['status'])
                          }
                          className="flex h-8 w-full items-center justify-center rounded-lg border border-border bg-background text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-text-primary disabled:opacity-50"
                        >
                          {activeExternalPageLoading[column.status as CloudLoopItem['status']]
                            ? t('todo.loading_more_issues')
                            : t('todo.load_more_issues')}
                        </button>
                      ) : null
                    }
                    renderQuickStart={() =>
                      quickStartStorageKey ? (
                        <BoardQuickStartGuide
                          key={quickStartStorageKey}
                          storageKey={quickStartStorageKey}
                          itemKind={isMyTasksBoard ? 'task' : 'issue'}
                          hasCreatedItem={rootBoardItems.length > 0}
                          hasAdvancedItem={rootBoardItems.some(item => item.status !== 'inbox')}
                          detailOpened={quickStartDetailOpened}
                          onCreateItem={() => openIssueCreation()}
                          onOpenFirstItem={() => {
                            if (firstRootBoardItem) openBoardItem(firstRootBoardItem)
                          }}
                        />
                      ) : null
                    }
                    renderSearchIcon={() => <Search className="h-3.5 w-3.5" />}
                    renderSkeleton={() => <CloudTodoBoardSkeleton />}
                    renderStatus={() =>
                      isAITableProject && dingtalkAuthPrompt ? (
                        <div className="mx-6 mb-2 flex items-center gap-3 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-text-secondary">
                          <span className="flex-1">{t('todo.dingtalk_board_not_connected')}</span>
                          <button
                            type="button"
                            data-testid="aitable-board-dws-login"
                            disabled={dingtalkAuthBusy}
                            onClick={() => void connectDingTalkBoard()}
                            className="h-7 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-text-primary transition hover:bg-muted disabled:opacity-50"
                          >
                            {dingtalkAuthBusy
                              ? t('todo.dingtalk_board_connecting')
                              : t('todo.dingtalk_board_connect')}
                          </button>
                        </div>
                      ) : boardError ? (
                        <p className="mx-6 mb-2 text-xs text-destructive" role="alert">
                          {boardError}
                        </p>
                      ) : null
                    }
                    renderTooltip={(label, child) => <Tooltip label={label}>{child}</Tooltip>}
                    rootLabel={isMyTasksBoard ? '任务' : isAITableProject ? '父任务' : 'Issue'}
                    rootUnitLabel={
                      isMyTasksBoard ? '个任务' : isAITableProject ? '条记录' : '个 Issue'
                    }
                    saveGlobalDisabled={
                      groupScopeBusy ||
                      !['Owner', 'Maintainer'].includes(selectedProject.access_role ?? 'Owner')
                    }
                    saveGlobalLabel="应用到全局"
                    searchPlaceholder={
                      boardParent
                        ? t('todo.search_tasks', '搜索任务')
                        : t('todo.search_issues', '搜索 Issue')
                    }
                    showQuickStart={Boolean(
                      quickStartStorageKey &&
                      !boardItemsLoading &&
                      !isAITableProject &&
                      !boardParent &&
                      nativeGroupBy === 'status' &&
                      !nativeGroupFilter &&
                      !nativeBoardQuery.trim()
                    )}
                    showSaveGlobal={Boolean(
                      personalGroupKey && localStorage.getItem(personalGroupKey)
                    )}
                  />
                ),
              }}
            />
          )}
        </main>
        {pendingAutomationSelection ? (
          <AutomationSelectionDialog
            candidates={pendingAutomationSelection.candidates}
            onCancel={pendingAutomationSelection.onCancel}
            onConfirm={pendingAutomationSelection.onConfirm}
          />
        ) : null}
        {pendingExecutionConfiguration && pendingExecutionServices ? (
          <IssueExecutionConfigDialog
            item={pendingExecutionConfiguration.item}
            projectChatAgentApi={
              pendingExecutionServices?.projectChatAgentApi ?? services.projectChatAgentApi
            }
            runtimeProfileApi={
              pendingExecutionServices?.runtimeProfileApi ?? services.runtimeProfileApi
            }
            modelApi={services.modelApi}
            deviceApi={pendingExecutionServices.deviceApi}
            localProjects={localProjects}
            onClose={() => setPendingExecutionConfiguration(null)}
            onConfirm={async result => {
              const pending = pendingExecutionConfiguration
              if (pending.continuation.type === 'move') {
                await performStandardBoardMove(
                  pending.item,
                  pending.continuation.column,
                  pending.continuation.beforeItemId,
                  pending.continuation.mutation,
                  result
                )
              } else {
                const updated = await saveExecutionConfiguration(pending.item, result)
                pending.continuation.afterSave?.(updated)
              }
              setPendingExecutionConfiguration(null)
            }}
          />
        ) : null}
        {selectedItem && backgroundTaskItemId !== selectedItem.id ? (
          <button
            type="button"
            data-testid="cloud-todo-detail-dismiss-layer"
            aria-label={taskPanelOpen ? '关闭任务对话' : '关闭 Issue 详情'}
            onClick={closeTopPanel}
            className="todo-panel-backdrop"
          />
        ) : null}
        {selectedItem && !taskStartingInBackground ? (
          <div
            data-testid="cloud-todo-panel-stack"
            data-conversation-open={taskPanelOpen ? 'true' : 'false'}
            className={cn('todo-panel-stack', taskPanelOpen && 'has-conversation')}
          >
            {taskPanelOpen && backgroundTaskItemId !== selectedItem.id ? (
              <aside
                data-testid="cloud-todo-compact-issue"
                className="task-conversation-issue-context flex min-h-0 flex-col bg-background"
              >
                <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
                  <button
                    type="button"
                    data-testid="cloud-todo-compact-issue-back"
                    onClick={closeTaskPanel}
                    aria-label="返回 Issue 详情"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">
                    {selectedItem.id} · Issue 附件
                  </span>
                  <button
                    type="button"
                    data-testid="cloud-todo-panel-close"
                    onClick={closeIssuePanelStack}
                    aria-label="关闭"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto py-2">
                  <IssueResourceSection
                    icon={<File className="h-3.5 w-3.5" />}
                    title="文件附件"
                    count={issueResourceAttachments.length}
                    empty={issueResourceAttachmentsLoading ? '正在加载…' : '暂无文件附件'}
                  >
                    {issueResourceAttachments.map(attachment => (
                      <button
                        key={attachment.id}
                        type="button"
                        data-testid={`cloud-todo-resource-attachment-${attachment.id}`}
                        onClick={() =>
                          void selectedItemApi?.downloadLoopItemAttachment(
                            attachment.id,
                            attachment.display_name
                          )
                        }
                        className="task-conversation-resource-row"
                      >
                        <File className="h-4 w-4 shrink-0 text-text-muted" />
                        <span className="min-w-0 flex-1 truncate">{attachment.display_name}</span>
                        <span className="shrink-0 text-xs text-text-muted">
                          {formatCompactFileSize(attachment.size_bytes)}
                        </span>
                      </button>
                    ))}
                  </IssueResourceSection>

                  <IssueResourceSection
                    icon={<MessageSquare className="h-3.5 w-3.5" />}
                    title="任务会话"
                    count={(activeItemTaskBindings[selectedItem.id] ?? []).length}
                    empty="暂无任务会话"
                  >
                    {(activeItemTaskBindings[selectedItem.id] ?? []).map(binding => {
                      const selected = selectedTaskBinding?.id === binding.id
                      return (
                        <button
                          key={binding.id}
                          type="button"
                          data-testid={`cloud-todo-resource-conversation-${binding.id}`}
                          data-selected={selected ? 'true' : 'false'}
                          onClick={() => {
                            openTaskBinding({
                              ...binding,
                              work_item_id: selectedItem.id,
                            })
                          }}
                          className={cn(
                            'task-conversation-resource-row',
                            selected && 'is-selected'
                          )}
                        >
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              selected ? 'bg-primary' : 'bg-text-muted/50'
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {binding.task_title || binding.task_id}
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                        </button>
                      )
                    })}
                  </IssueResourceSection>

                  <IssueResourceSection
                    icon={<ListTodo className="h-3.5 w-3.5" />}
                    title="子 Issue"
                    count={
                      detailAllItems.filter(candidate => candidate.parent_id === selectedItem.id)
                        .length
                    }
                    empty="暂无子 Issue"
                  >
                    {detailAllItems
                      .filter(candidate => candidate.parent_id === selectedItem.id)
                      .map(child => (
                        <button
                          key={child.id}
                          type="button"
                          data-testid={`cloud-todo-resource-child-${child.id}`}
                          onClick={() => {
                            closeTaskPanel()
                            setSelectedItem(child)
                          }}
                          className="task-conversation-resource-row"
                        >
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              columnDotClasses[child.status]
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">{child.title}</span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                        </button>
                      ))}
                  </IssueResourceSection>
                </div>
              </aside>
            ) : null}
            {backgroundTaskItemId !== selectedItem.id &&
            selectedItem.can_view_detail !== false &&
            selectedItem.detail_loaded !== false &&
            (selectedItemProject?.location === 'cloud' ? cloudWorkspaceApi : selectedItemApi) ? (
              <TodoEditor
                key={selectedItem.id}
                mode="edit"
                presentation="workspace-panel"
                selectedTaskId={
                  selectedTaskBinding?.work_item_id === selectedItem.id
                    ? selectedTaskBinding.task_id
                    : null
                }
                {...(selectedItemProject?.location === 'cloud'
                  ? { sharedApi: cloudWorkspaceApi! }
                  : { api: selectedItemApi! })}
                projectChatAgentApi={selectedProjectAgentApi}
                projectAutomationApi={
                  selectedItemProject?.location === 'local'
                    ? selectedItemServices?.projectAutomationApi
                    : undefined
                }
                teamApi={services.teamApi}
                projectChatClient={selectedProjectChatClient}
                selfManagedExecution={selectedProjectSelfManagedExecution}
                currentUserId={user.id}
                localProjects={localProjects}
                aitableApi={
                  selectedItemProject?.task_provider === 'dingtalk_aitable'
                    ? services.aitableApi
                    : undefined
                }
                item={selectedItem}
                project={selectedItemProject}
                allItems={detailAllItems}
                showChildren={false}
                taskRefreshKey={boardRefreshNonce}
                onWorkflowPlanChanged={() => {
                  setBoardRefreshNonce(value => value + 1)
                }}
                onOpenChildTask={child => {
                  const locatedChild = {
                    ...child,
                    project_store: selectedItem.project_store,
                  }
                  closeTaskPanel()
                  setSelectedItem(locatedChild)
                }}
                onCreateTask={async workflowNodeId => {
                  setSelectedTaskBinding(null)
                  setBackgroundTaskItemId(null)
                  if (!selectedItemProject) return
                  const sharedApi =
                    selectedItemProject.location === 'cloud' ? cloudWorkspaceApi : undefined
                  let inheritFromTask: RuntimeTaskAddress | null = null
                  const workflowNode = selectedItem.workflow?.nodes.find(
                    node => node.id === workflowNodeId
                  )
                  const stageContext = workflowNode
                    ? sharedApi
                      ? await sharedApi.workflowPlans.getStageContext(
                          selectedItem.id,
                          workflowNode.id
                        )
                      : await selectedItemApi!.getWorkflowStageContext(
                          selectedItem.id,
                          workflowNode.id
                        )
                    : null
                  if (
                    workflowNode?.workspace_policy === 'inherit' &&
                    workflowNode.depends_on.length > 0
                  ) {
                    const bindings = sharedApi
                      ? await sharedApi.taskBindings.list(
                          selectedItem.id,
                          String(selectedItemProject.id)
                        )
                      : await selectedItemApi!.listTaskBindings(selectedItem.id)
                    const predecessor = bindings.find(binding =>
                      workflowNode.depends_on.includes(taskBindingWorkflowNodeId(binding) ?? '')
                    )
                    if (predecessor) {
                      inheritFromTask = hydrateRuntimeTaskAddress(
                        runtimeWork,
                        taskBindingAddress(predecessor)
                      )
                    }
                  }
                  setBackgroundTaskItemId(null)
                  openTaskComposer({
                    workItemId: selectedItem.id,
                    initialInput: workflowStageInstruction(stageContext),
                    backgroundAfterSend: false,
                    workflowNodeId,
                    inheritFromTask,
                  })
                }}
                onClose={closeIssuePanelStack}
                onOpenTaskConversation={task => {
                  openTaskBinding({
                    ...task,
                    work_item_id: selectedItem.id,
                  })
                }}
                onUpdated={updated => {
                  const locatedUpdated = {
                    ...updated,
                    project_store: selectedItem.project_store,
                  }
                  if (selectedItemProject?.location === 'cloud') {
                    cloudWorkspace.commands.replaceIssue(updated as CollaborationIssue)
                  } else if (selectedItemProject?.location === 'local') {
                    setItems(current =>
                      current.map(item => (item.id === updated.id ? locatedUpdated : item))
                    )
                  }
                  if (selectedItemProject?.location === 'local') {
                    setDetailItems(current =>
                      current.map(item => (item.id === updated.id ? locatedUpdated : item))
                    )
                  }
                  setSelectedItem(locatedUpdated)
                  track('feature_action_completed', { domain: 'board_item', action: 'update' })
                }}
              />
            ) : selectedItem.detail_loaded === false ? (
              <div
                data-testid="cloud-todo-detail-loading"
                className="flex min-h-0 flex-1 items-center justify-center text-sm text-text-muted"
              >
                {t('todo.loading_work_item_detail')}
              </div>
            ) : null}
            {taskPanelOpen && aiChatProject ? (
              <AiChatModal
                key={
                  selectedTaskBinding?.work_item_id === selectedItem.id
                    ? `ai-chat-${selectedItem.id}:${selectedTaskBinding.device_id}:${selectedTaskBinding.task_id}`
                    : `ai-chat-new-${selectedItem.id}`
                }
                project={aiChatProject}
                localProjects={localProjects}
                task={selectedItem}
                initialLocalProjectId={
                  taskComposerRequest?.workItemId === selectedItem.id
                    ? runtimeTaskProjectUiId(runtimeWork, taskComposerRequest.taskRequest)
                    : (localProjectIdForItem(selectedItem) ??
                      (isMyTasksBoard ? selectedLocalProject?.id : null))
                }
                initialTaskRequest={
                  taskComposerRequest?.workItemId === selectedItem.id
                    ? taskComposerRequest.taskRequest
                    : undefined
                }
                inheritFromTask={
                  taskComposerRequest?.workItemId === selectedItem.id
                    ? taskComposerRequest.inheritFromTask
                    : null
                }
                initialAddress={
                  selectedTaskBinding?.work_item_id === selectedItem.id
                    ? {
                        deviceId: selectedTaskBinding.device_id,
                        taskId: selectedTaskBinding.task_id,
                      }
                    : null
                }
                taskTitle={
                  selectedTaskBinding?.work_item_id === selectedItem.id
                    ? selectedTaskBinding.task_title
                    : null
                }
                open={
                  selectedTaskBinding?.work_item_id !== selectedItem.id ||
                  backgroundTaskItemId !== selectedItem.id
                }
                embedded
                initialTaskInput={
                  taskComposerRequest?.workItemId === selectedItem.id
                    ? taskComposerRequest.initialInput
                    : ''
                }
                workflowNodeId={
                  taskComposerRequest?.workItemId === selectedItem.id
                    ? taskComposerRequest.workflowNodeId
                    : undefined
                }
                onClose={closeIssuePanelStack}
                onBack={closeTaskPanel}
                onAddressChange={address => {
                  if (taskPanelSessionId !== taskPanelSessionIdRef.current) return
                  const activeTaskComposerRequest =
                    taskComposerRequest?.workItemId === selectedItem.id ? taskComposerRequest : null
                  if (!activeTaskComposerRequest) return
                  advanceTaskPanelSession()
                  if (activeTaskComposerRequest.backgroundAfterSend) {
                    setBackgroundTaskItemId(null)
                    setSelectedItem(null)
                    setSelectedTaskBinding(null)
                  } else {
                    setSelectedTaskBinding({
                      id: -Date.now(),
                      device_id: address.deviceId,
                      task_id: address.taskId,
                      task_title: null,
                      work_item_id: selectedItem.id,
                    })
                  }
                  setTaskComposerRequest(null)
                  setBoardRefreshNonce(value => value + 1)
                }}
                prepareTask={prepareSelectedItemTask}
                onTaskCreated={handleSelectedItemTaskCreated}
                onOpenRuntimeTask={onOpenRuntimeTask}
              />
            ) : null}
          </div>
        ) : null}
        {selectedItem &&
        aiChatProject &&
        taskStartingInBackground &&
        taskComposerRequest?.workItemId === selectedItem.id ? (
          <BackgroundTaskStarter
            project={aiChatProject}
            localProjects={localProjects}
            task={selectedItem}
            input={taskComposerRequest.initialInput}
            initialLocalProjectId={
              localProjectIdForItem(selectedItem) ??
              (isMyTasksBoard ? selectedLocalProject?.id : null)
            }
            taskRequest={taskComposerRequest.taskRequest}
            inheritFromTask={taskComposerRequest.inheritFromTask}
            workflowNodeId={taskComposerRequest.workflowNodeId}
            onAddressChange={() => {
              closeIssuePanelStack()
              setBoardRefreshNonce(value => value + 1)
            }}
            prepareTask={prepareSelectedItemTask}
            onTaskCreated={handleSelectedItemTaskCreated}
            onError={setBoardError}
          />
        ) : null}
        {selectedProject && projectAssistantOpen && !selectedItem ? (
          <ProjectSpaceChatSidebar
            key={`${selectedProject.id}:project`}
            project={selectedProject}
            localProjects={localProjects}
            onClose={() => {
              setProjectAssistantOpen(false)
            }}
          />
        ) : null}
      </div>

      {globalSearchOpen && (
        <GlobalTodoSearch
          projects={projects}
          projectItems={collaborationProjectItems}
          projectMembers={collaborationProjectMembers}
          query={globalSearchQuery}
          onQueryChange={setGlobalSearchQuery}
          onClose={() => setGlobalSearchOpen(false)}
          onSelectProject={project => {
            selectProject(project)
            setProjectView('board')
            setSelectedItem(null)
            setGlobalSearchOpen(false)
          }}
          onSelectItem={(project, item) => {
            if (item.can_view_detail === false) return
            selectProject(project)
            setProjectView('board')
            setSelectedItem({ ...item, project_store: project.project_store })
            setGlobalSearchOpen(false)
          }}
        />
      )}
      {createProjectOpen && (
        <ProjectCreateDialog
          targets={availableProjectSpaceApis}
          defaultLocation={projectSpaceApis.defaultLocation}
          allowDingTalkAITable
          labels={projectCreateLabels[i18n.language.startsWith('zh') ? 'zh-CN' : 'en']}
          host={{
            renderModal: ({ title, children, onClose }) => (
              <Modal title={title} width="wide" onClose={onClose}>
                {children}
              </Modal>
            ),
            parseDingTalkAITableLink,
            formatError: cloudProjectRequestError,
            track: event => {
              if (event === 'created') {
                track('feature_action_completed', {
                  domain: 'project_space',
                  action: 'create',
                })
              } else {
                track('operation_failed', { operation: 'project_space_action' })
              }
            },
          }}
          onClose={() => setCreateProjectOpen(false)}
          onCreated={(project, location) => {
            const weworkProject = toWeworkCloudProject(project)
            const locatedProject: LocatedCloudProject = {
              ...weworkProject,
              project_store: location === 'local' ? 'local' : 'backend',
              location,
            }
            prependProject(locatedProject)
            const membersRequest =
              location === 'local'
                ? projectSpaceApis.local?.listCloudProjectMembers(weworkProject.id)
                : undefined
            if (membersRequest) {
              const spaceKey = projectSpaceKey(projectSpaceRef(locatedProject))
              void membersRequest.then(members =>
                setLocalProjectMembers(current => ({ ...current, [spaceKey]: members }))
              )
            }
            applyProjectSelection(locatedProject)
            onActiveProjectChange?.(locatedProject)
            setCreateProjectOpen(false)
          }}
        />
      )}
      {createTodoOpen &&
        createTodoProject &&
        (createTodoProject.location === 'cloud' ? cloudWorkspaceApi : createTodoApi) && (
          <TodoEditor
            key={`${projectSpaceKey(projectSpaceRef(createTodoProject))}:${createTodoNonce}`}
            mode="create"
            {...(createTodoProject.location === 'cloud'
              ? { sharedApi: cloudWorkspaceApi! }
              : { api: createTodoApi! })}
            projectChatAgentApi={selectedProjectAgentApi}
            teamApi={services.teamApi}
            project={createTodoProject}
            initialParent={createTodoParent}
            initialStatus={createTodoStatus}
            initialTitle={createTodoInitialTitle}
            allItems={createTodoParent ? detailAllItems : items}
            createOptions={
              createTodoProject.location === 'cloud' && !createTodoParent ? (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-text-secondary">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      data-testid="cloud-todo-create-runtime-option"
                      checked={createTodoStartRuntime}
                      onChange={event => setCreateTodoStartRuntime(event.target.checked)}
                    />
                    {t('todo.create_runtime_task_after_issue', '创建后启动 Runtime 任务')}
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      data-testid="cloud-todo-continue-creating-option"
                      checked={createTodoContinueCreating}
                      onChange={event => setCreateTodoContinueCreating(event.target.checked)}
                    />
                    {t('todo.continue_creating', '继续创建')}
                  </label>
                </div>
              ) : undefined
            }
            onClose={() => {
              setCreateTodoOpen(false)
              setCreateTodoParent(null)
              setCreateTodoInitialTitle(undefined)
            }}
            onCreateError={(cause, retry) => {
              const candidates = automationSelectionCandidates(cause)
              if (!candidates) return false
              setPendingAutomationSelection({
                candidates,
                onCancel: () => setPendingAutomationSelection(null),
                onConfirm: async automationId => {
                  await retry({ automation_rule_id: automationId })
                  setPendingAutomationSelection(null)
                },
              })
              return true
            }}
            onCreated={item => {
              const locatedItem = addCreatedTodo(item, createTodoProject)
              if (createTodoProject.location === 'cloud') {
                cloudWorkspace.commands.appendIssue(item as CollaborationIssue)
              }
              const openRuntime = (configuredItem: LocatedLoopItem) =>
                openCreatedItemRuntimeTask(configuredItem, createTodoProject)
              const executionConfigurationResult = requestCreatedItemExecutionConfiguration(
                locatedItem,
                createTodoStartRuntime ? openRuntime : undefined
              )
              if (createTodoStartRuntime && executionConfigurationResult === 'not-needed') {
                openRuntime(locatedItem)
              } else if (!createTodoContinueCreating) {
                setSelectedItem(locatedItem)
              }
              if (createTodoContinueCreating && !createTodoParent) {
                setCreateTodoInitialTitle(undefined)
                setCreateTodoNonce(current => current + 1)
              } else {
                setCreateTodoOpen(false)
                setCreateTodoParent(null)
                setCreateTodoInitialTitle(undefined)
              }
            }}
          />
        )}
      {renameProject && (
        <Modal title="修改项目名称" onClose={() => !renameBusy && setRenameProject(null)}>
          <div className="px-5 pb-5 pt-4">
            <label className="block text-sm font-medium text-text-secondary">
              项目名称
              <input
                data-testid="cloud-project-rename-input"
                value={renameProjectName}
                autoFocus
                onFocus={event => event.currentTarget.select()}
                onChange={event => {
                  setRenameProjectName(event.target.value)
                  setRenameError(null)
                }}
                className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>
            <p className="mt-2 text-xs text-text-muted">新名称会显示在项目空间和看板侧栏中。</p>
            {renameError ? <p className="mt-3 text-xs text-red-600">{renameError}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameProject(null)}
                disabled={renameBusy}
                className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                data-testid="cloud-project-rename-confirm"
                disabled={!renameProjectName.trim() || renameBusy}
                onClick={() => void renameSelectedProject()}
                className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
              >
                {renameBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {runtimeBatchArchiveItems && (
        <Modal
          title={t('todo.archive_completed_tasks_title', '归档已完成任务？')}
          onClose={() => {
            if (archiveBusy) return
            setRuntimeBatchArchiveItems(null)
            setArchiveError(null)
          }}
        >
          <div className="px-5 pb-5 pt-4">
            <p className="text-sm leading-5 text-text-secondary">
              {t(
                'todo.archive_completed_tasks_description',
                '将从任务列表中归档 {{count}} 个已完成任务。归档后可在设置中恢复。',
                { count: runtimeBatchArchiveItems.length }
              )}
            </p>
            {archiveError ? (
              <p className="mt-3 text-xs text-destructive" role="alert">
                {archiveError}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                data-testid="cloud-my-tasks-archive-completed-cancel"
                disabled={archiveBusy}
                onClick={() => {
                  setRuntimeBatchArchiveItems(null)
                  setArchiveError(null)
                }}
                className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="cloud-my-tasks-archive-completed-confirm"
                disabled={archiveBusy}
                onClick={() => void archiveCompletedItems(runtimeBatchArchiveItems)}
                className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {archiveBusy
                  ? t('todo.archiving', '归档中…')
                  : t('todo.confirm_archive', '确认归档')}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {(archiveProject || archiveItem) && (
        <Modal
          title={archiveProject ? '归档项目？' : '归档任务？'}
          onClose={() => {
            if (archiveBusy) return
            setArchiveProject(null)
            setArchiveItem(null)
            setArchiveError(null)
          }}
        >
          <div className="px-5 pb-5 pt-4">
            <p className="text-sm leading-5 text-text-secondary">
              {archiveProject
                ? `“${archiveProject.name}”及其中任务将从项目列表中隐藏。`
                : `“${archiveItem?.title}”${items.some(item => item.parent_id === archiveItem?.id) ? '及其子任务' : ''}将从看板中隐藏。`}
            </p>
            <p className="mt-2 text-xs text-text-muted">归档数据会保留，不会立即永久删除。</p>
            {archiveError ? <p className="mt-3 text-xs text-red-600">{archiveError}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                data-testid="cloud-archive-cancel"
                disabled={archiveBusy}
                onClick={() => {
                  setArchiveProject(null)
                  setArchiveItem(null)
                  setArchiveError(null)
                }}
                className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                data-testid={
                  archiveProject ? 'cloud-project-archive-confirm' : 'cloud-todo-archive-confirm'
                }
                disabled={archiveBusy}
                onClick={() => {
                  void (archiveProject ? confirmArchiveProject() : confirmArchiveItem())
                }}
                className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {archiveBusy ? '归档中…' : '确认归档'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
