import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
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
} from '@dnd-kit/core'
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Cloud,
  Copy,
  Ellipsis,
  File,
  GitBranch,
  Grid3X3,
  HardDrive,
  ListTodo,
  LockKeyhole,
  MessageSquare,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react'
import type {
  CloudLoopItem,
  CloudLoopItemAttachment,
  CloudMyWorkItem,
  CloudProject,
  CloudProjectMember,
  DeliveryFulfillment,
  PullRequestAutoRepairStatus,
} from '@/api/deliveries'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import type { AITableField } from '@/api/aitable'
import { ApiError } from '@/api/http'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import {
  DesktopSidebarAccount,
  type DesktopSidebarAccountSettingsOptions,
} from '@/components/layout/DesktopSidebarAccount'
import {
  DesktopSidebarHeader,
  DesktopSidebarNavItem,
} from '@/components/layout/DesktopSidebarPrimitives'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { ActionMenu } from '@/components/common/ActionMenu'
import { Tooltip } from '@/components/ui/tooltip'
import type {
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotAvailable } from '@/features/dsh-runtime/useDshSlotAvailable'
import type {
  DeliveryApi,
  ProjectSpaceLocation,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { runtimeTaskProjectUiId } from '@/lib/runtime-task-workspace-binding'
import { cn } from '@/lib/utils'
import { track } from '@/telemetry/client'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
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
  isRuntimeTaskExecutionRunning,
  runtimeTaskTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { hydrateRuntimeTaskAddress } from '@/features/workbench/workbenchRuntimeHelpers'
import { AITableView } from '@/features/todo/AITableView'
import {
  AutomationSelectionDialog,
  type AutomationSelectionCandidate,
} from '@/features/todo/AutomationSelectionDialog'
import type {
  CloneGitRepositoryInput,
  CreatedRuntimeProject,
  ProjectWithTasks,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import { CloudTodoModal as Modal } from './CloudTodoModal'
import { CloudMyWorkView } from './CloudMyWorkView'
import { stopLocalRobotQueueExecution } from './localRobotQueueDispatcher'
import { itemNeedsExecutionConfiguration } from './workflowExecutionConfig'
import {
  CloudTodoBoardCard,
  CloudTodoCardContent,
  type BoardCardDisplaySettings,
  type CloudTodoBoardTaskBinding,
} from './CloudTodoBoardCard'
import { CloudProjectManageView } from './CloudProjectManageView'
import { waitForDwsAuthentication } from './dwsAuth'
import { ProjectAutomationView } from './ProjectAutomationView'
import { ProjectSpaceSettings } from './ProjectSpaceSettings'
import {
  type LocatedProjectSpace,
  publishProjectSpaceTaskBindingChanged,
  projectSpaceKey,
  projectSpaceRef,
  projectSupportsRobotAutomation,
  sameProjectSpace,
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
} from './projectSpaceSelection'
import { CloudProjectsHome } from './CloudProjectsHome'
import { CloudFilesView } from './CloudFilesView'
import { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'
import { GlobalTodoSearch } from './GlobalTodoSearch'
import { BoardQuickCreate } from './BoardQuickCreate'
import { BoardQuickStartGuide } from './BoardQuickStartGuide'
import { parseDingTalkAITableLink, repositoryProviderConfig } from './projectProviderConfig'
import { isRuntimeMyWorkItem, runtimeMyWorkItems } from './runtimeMyWork'
import { finalAssistantTranscriptText } from './runtimeTaskResponsePreview'
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
import { boardStatusColorClasses, columnDotClasses, columns, reorderLaneItems } from './todoShared'
import { AiChatModal } from './AiChatModal'
import { BackgroundTaskStarter } from './BackgroundTaskStarter'
import {
  shouldPrepareWorkItemTask,
  shouldRevealWorkItemWorkflowActions,
  workItemTaskInput,
} from './workItemTaskInput'
import type { WorkflowDeliverableDraft } from './WorkflowStageCompletionDialog'

type ProjectView = 'board' | 'table' | 'files' | 'automation' | 'manage'
type RootView = 'projects' | 'my-work' | 'settings'
type ProjectTaskProvider = 'local' | 'github' | 'gitlab' | 'dingtalk_aitable'

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
type NativeBoardGroupBy = 'status' | 'priority' | 'assignee' | 'tag'
type PendingExecutionConfiguration = {
  item: LocatedLoopItem
  continuation:
    | {
        type: 'move'
        columnKey: string
        beforeItemId: string | null
      }
    | {
        type: 'save'
      }
}
type ExecutionConfigurationRequestResult = 'not-needed' | 'opened' | 'unavailable'

const nativeBoardGroupFields: AITableField[] = [
  { id: 'status', name: '状态', type: 'status', config: null, raw: {} },
  { id: 'priority', name: '优先级', type: 'singleSelect', config: null, raw: {} },
  { id: 'assignee', name: '负责人', type: 'user', config: null, raw: {} },
  { id: 'tag', name: '标签', type: 'tag', config: null, raw: {} },
]

async function uploadWorkflowDeliverables(
  api: DeliveryApi,
  deliveryId: string,
  values: WorkflowDeliverableDraft[]
): Promise<DeliveryFulfillment[]> {
  const fulfillments: DeliveryFulfillment[] = []
  for (const value of values) {
    const requirementId = value.requirement.id
    if (value.requirement.value_type === 'text' && value.text?.trim()) {
      fulfillments.push({
        requirement_id: requirementId,
        kind: 'text',
        text: value.text.trim(),
      })
    } else if (value.requirement.value_type === 'url' && value.url?.trim()) {
      fulfillments.push({
        requirement_id: requirementId,
        kind: 'url',
        url: value.url.trim(),
        title: value.title?.trim() ?? '',
      })
    } else if (value.requirement.value_type === 'file' && value.files?.length) {
      const assets = []
      for (const file of value.files) {
        assets.push(await api.addAsset(deliveryId, file, `${requirementId}/${file.name}`))
      }
      fulfillments.push({
        requirement_id: requirementId,
        kind: 'file',
        asset_ids: assets.map(asset => asset.id),
      })
    } else if (value.requirement.value_type === 'code_snapshot' && value.files?.[0]) {
      const file = value.files[0]
      const asset = await api.addAsset(deliveryId, file, `${requirementId}/${file.name}`)
      fulfillments.push({
        requirement_id: requirementId,
        kind: 'code_snapshot',
        asset_id: asset.id,
        changed_files: [file.name],
        base_revision: null,
        head_revision: null,
        sha256: asset.sha256,
      })
    } else if (
      value.requirement.value_type === 'git_branch' &&
      value.remoteUrl?.trim() &&
      value.branch?.trim() &&
      value.commitSha?.trim()
    ) {
      fulfillments.push({
        requirement_id: requirementId,
        kind: 'git_branch',
        remote_url: value.remoteUrl.trim(),
        branch: value.branch.trim(),
        commit_sha: value.commitSha.trim(),
      })
    } else if (
      value.requirement.value_type === 'pull_request' &&
      value.url?.trim() &&
      value.number?.trim() &&
      value.headBranch?.trim() &&
      value.baseBranch?.trim() &&
      value.commitSha?.trim()
    ) {
      fulfillments.push({
        requirement_id: requirementId,
        kind: 'pull_request',
        provider: value.provider ?? 'github',
        url: value.url.trim(),
        number: Number(value.number),
        state: 'draft',
        head_branch: value.headBranch.trim(),
        base_branch: value.baseBranch.trim(),
        head_commit: value.commitSha.trim(),
      })
    }
  }
  return fulfillments
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
const externalBoardStatuses = ['inbox', 'pending', 'in_progress', 'in_review', 'completed'] as const
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
  const [open, setOpen] = useState(false)
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
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        data-testid={`${testIdPrefix}-by`}
        onClick={() => setOpen(current => !current)}
        className="flex h-8 min-w-32 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted"
        aria-expanded={open}
      >
        <span className="max-w-32 truncate">{selected?.name ?? '选择分组字段'}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-40 w-64 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-lg">
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
        </div>
      ) : null}
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

interface AvailableProjectSpaceApi {
  api: DeliveryApi
  location: ProjectSpaceLocation
}

function runtimeWorkItemReference(
  task: RuntimeTaskSummary
): { projectId: string; itemId: string } | null {
  const handle = task.runtimeHandle
  const origin =
    handle?.origin && typeof handle.origin === 'object'
      ? (handle.origin as Record<string, unknown>)
      : null
  const projectId =
    handle?.cloudProjectId ??
    handle?.cloud_project_id ??
    origin?.cloudProjectId ??
    origin?.cloud_project_id
  const itemId =
    handle?.loopItemId ?? handle?.loop_item_id ?? origin?.loopItemId ?? origin?.loop_item_id
  return (typeof projectId === 'string' || typeof projectId === 'number') &&
    typeof itemId === 'string' &&
    itemId
    ? { projectId: String(projectId), itemId }
    : null
}

interface CloudTodoWorkspaceProps {
  user: UserProfile
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  services: WorkbenchServices
  embedded?: boolean
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
  onArchiveRuntimeTask?: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult | void> | ArchiveRuntimeTaskResult | void
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout?: () => void
}

function boardStatusFromDropId(id: string | number | undefined): string | null {
  if (typeof id !== 'string' || !id.startsWith('todo-column:')) return null
  return id.slice('todo-column:'.length) || null
}

function itemMatchesAssigneeGroup(item: CloudLoopItem, groupValue: string): boolean {
  if (groupValue.startsWith('team:')) {
    return item.assignee_team_id === Number(groupValue.slice('team:'.length))
  }
  if (groupValue.startsWith('agent:')) {
    return item.assignee_agent_id === groupValue.slice('agent:'.length)
  }
  if (groupValue === '') {
    return !item.assignee_user_id && !item.assignee_agent_id && !item.assignee_team_id
  }
  return String(item.assignee_user_id ?? '') === groupValue
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

function TodoColumnDropzone({
  status,
  dragHint,
  children,
}: {
  status: string
  dragHint?: string
  children: React.ReactNode
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `todo-column:${status}` })
  return (
    <div
      ref={setNodeRef}
      data-testid={`cloud-todo-column-dropzone-${status}`}
      className={cn(
        'relative min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain px-2 pb-2 pt-2 transition-colors',
        isOver && 'rounded-xl bg-muted ring-1 ring-inset ring-focus/50'
      )}
    >
      {isOver && dragHint ? (
        <div
          data-testid={`cloud-todo-column-drag-hint-${status}`}
          className="pointer-events-none sticky top-0 z-20 rounded-lg border border-border bg-background/95 px-2 py-1.5 text-center text-xs font-medium text-text-secondary shadow-sm"
        >
          {dragHint}
        </div>
      ) : null}
      {children}
    </div>
  )
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

function ProjectDialog({
  availableApis,
  defaultLocation,
  onClose,
  onCreated,
}: {
  availableApis: AvailableProjectSpaceApi[]
  defaultLocation: ProjectSpaceLocation
  onClose: () => void
  onCreated: (project: CloudProject, location: ProjectSpaceLocation) => void
}) {
  const { t } = useTranslation('common')
  const initialLocation =
    availableApis.find(option => option.location === defaultLocation)?.location ??
    availableApis[0]?.location ??
    'local'
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState<ProjectSpaceLocation>(initialLocation)
  const [taskProvider, setTaskProvider] = useState<ProjectTaskProvider>('local')
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [repositoryAddress, setRepositoryAddress] = useState('')
  const [token, setToken] = useState('')
  const [aitableUrl, setAitableUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const repositoryProvider = taskProvider === 'github' || taskProvider === 'gitlab'
  const isAITableProvider = taskProvider === 'dingtalk_aitable'
  const aitableLink = parseDingTalkAITableLink(aitableUrl)
  const canSubmit = Boolean(
    name.trim() &&
    (!repositoryProvider || repositoryAddress.trim()) &&
    (!isAITableProvider || aitableLink) &&
    !saving
  )

  async function submit() {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const selectedApi = availableApis.find(option => option.location === location)?.api
      if (!selectedApi) throw new Error('所选项目空间位置当前不可用')
      const providerConfig = isAITableProvider
        ? {
            base_id: aitableLink!.baseId,
            table_id: aitableLink!.tableId,
            source_url: aitableLink!.url,
            ...(aitableLink!.viewId ? { view_id: aitableLink!.viewId } : {}),
          }
        : repositoryProvider
          ? {
              ...repositoryProviderConfig(repositoryAddress, taskProvider),
              ...(token.trim() ? { token: token.trim() } : {}),
            }
          : {}
      const project = await selectedApi.createCloudProject({
        name: name.trim(),
        description: description.trim(),
        task_provider: taskProvider,
        provider_config: providerConfig,
        ...(location === 'cloud' ? { visibility } : {}),
      })
      track('feature_action_completed', { domain: 'project_space', action: 'create' })
      onCreated(project, location)
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setError(cloudProjectRequestError(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="新建项目空间" width="wide" onClose={onClose}>
      <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-5 pt-4">
        <label className="block text-sm font-medium text-text-primary">
          名称
          <input
            data-testid="cloud-project-name"
            value={name}
            onChange={event => {
              setName(event.target.value)
              setError(null)
            }}
            className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-base font-normal text-text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
            placeholder="例如：Wegent V4"
            autoFocus
          />
        </label>

        <section>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-text-primary">保存位置</h3>
            <p className="text-xs text-text-muted">创建后不可更改</p>
          </div>
          <div
            className={cn(
              'mt-2 grid gap-2',
              availableApis.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
            )}
          >
            {availableApis.map(option => {
              const selected = location === option.location
              const isLocal = option.location === 'local'
              const LocationIcon = isLocal ? HardDrive : Cloud
              return (
                <button
                  key={option.location}
                  type="button"
                  data-testid={`cloud-project-location-${option.location}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setLocation(option.location)
                    setError(null)
                  }}
                  className={cn(
                    'flex min-h-16 items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
                    selected
                      ? 'border-text-primary bg-muted/70 ring-1 ring-text-primary/10'
                      : 'border-border hover:bg-muted/40'
                  )}
                >
                  <LocationIcon className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">
                      {isLocal ? '本地空间' : '云端空间'}
                    </span>
                    <span className="mt-0.5 block text-xs leading-4 text-text-muted">
                      {isLocal
                        ? '保存在当前设备，可接入 GitHub 或 GitLab Issues'
                        : '保存在 Wegent 云端，可在不同设备访问'}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        {location === 'cloud' && (
          <section>
            <h3 className="text-sm font-medium text-text-primary">
              {t('todo.project_visibility')}
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  [
                    'private',
                    LockKeyhole,
                    t('todo.project_visibility_private'),
                    t('todo.project_visibility_private_description'),
                  ],
                  [
                    'public',
                    Cloud,
                    t('todo.project_visibility_public'),
                    t('todo.project_visibility_public_description'),
                  ],
                ] as const
              ).map(([value, VisibilityIcon, label, detail]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`cloud-project-visibility-${value}`}
                  aria-pressed={visibility === value}
                  onClick={() => setVisibility(value)}
                  className={cn(
                    'rounded-xl border px-3 py-2.5 text-left transition',
                    visibility === value
                      ? 'border-text-primary bg-muted/70 ring-1 ring-text-primary/10'
                      : 'border-border hover:bg-muted/40'
                  )}
                >
                  <VisibilityIcon className="h-4 w-4 text-text-secondary" />
                  <span className="mt-2 block text-sm font-medium">{label}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">{detail}</span>
                </button>
              ))}
            </div>
            {visibility === 'public' && (
              <p className="mt-2 text-xs leading-4 text-text-muted">
                {t('todo.project_visibility_public_notice')}
              </p>
            )}
          </section>
        )}

        <section>
          <h3 className="text-sm font-medium text-text-primary">任务来源</h3>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ['local', ListTodo, '内置任务', location === 'local' ? '保存在本机' : '保存在云端'],
                ['github', GitBranch, 'GitHub', '读取 Issues'],
                ['gitlab', GitBranch, 'GitLab', '读取 Issues'],
                ['dingtalk_aitable', Grid3X3, '钉钉多维表格', '同步表格记录'],
              ] as const
            ).map(([value, ProviderIcon, label, detail]) => (
              <button
                key={value}
                type="button"
                data-testid={`cloud-project-task-provider-${value}`}
                aria-pressed={taskProvider === value}
                onClick={() => {
                  setTaskProvider(value)
                  setError(null)
                }}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left transition',
                  taskProvider === value
                    ? 'border-text-primary bg-muted/70 ring-1 ring-text-primary/10'
                    : 'border-border hover:bg-muted/40'
                )}
              >
                <ProviderIcon className="h-4 w-4 text-text-secondary" />
                <span className="mt-2 block text-sm font-medium">{label}</span>
                <span className="mt-0.5 block text-xs text-text-muted">{detail}</span>
              </button>
            ))}
          </div>
        </section>

        {repositoryProvider && (
          <section className="space-y-4 rounded-xl bg-muted/40 p-3">
            <label className="block text-sm font-medium text-text-primary">
              仓库地址
              <input
                data-testid="cloud-project-provider-repository"
                value={repositoryAddress}
                onChange={event => {
                  setRepositoryAddress(event.target.value)
                  setError(null)
                }}
                className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal text-text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
                placeholder={
                  taskProvider === 'github'
                    ? 'https://github.com/owner/repository'
                    : 'https://gitlab.com/group/project'
                }
              />
              <span className="mt-1.5 block text-xs font-normal text-text-muted">
                支持 HTTPS、SSH 或 owner/repository 格式；自托管地址会自动识别。
              </span>
            </label>
            <label className="block text-sm font-medium text-text-primary">
              访问令牌
              <span className="ml-1 text-xs font-normal text-text-muted">可选</span>
              <div className="relative mt-2">
                <LockKeyhole className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-text-muted" />
                <input
                  data-testid="cloud-project-provider-token"
                  type="password"
                  autoComplete="new-password"
                  value={token}
                  onChange={event => setToken(event.target.value)}
                  className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm font-normal text-text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
                  placeholder="私有仓库需要访问令牌"
                />
              </div>
              <span className="mt-1.5 block text-xs font-normal text-text-muted">
                {location === 'cloud'
                  ? '令牌会加密保存在 Wegent Backend，并安全下发给本地 Executor。'
                  : '令牌会加密保存在当前设备，不会写入项目文件。'}
              </span>
            </label>
          </section>
        )}

        {isAITableProvider && (
          <section className="space-y-4 rounded-xl bg-muted/40 p-3">
            <label className="block text-sm font-medium text-text-primary">
              多维表格链接
              <input
                data-testid="cloud-project-aitable-url"
                value={aitableUrl}
                onChange={event => {
                  setAitableUrl(event.target.value)
                  setError(null)
                }}
                className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
                placeholder="粘贴 alidocs.dingtalk.com 多维表格链接"
              />
              {aitableUrl && !aitableLink ? (
                <span className="mt-1.5 block text-xs font-normal text-destructive">
                  无法识别这个链接，请复制打开多维表格后的完整浏览器地址。
                </span>
              ) : (
                <span className="mt-1.5 block text-xs font-normal text-text-muted">
                  将自动识别表格和当前数据表，无需查找内部 ID。
                </span>
              )}
            </label>
            <p className="text-xs text-text-muted">
              表格读写统一由本机 Executor 通过 DWS
              执行。创建后连接钉钉账号，并确保该账号已获得此表格权限。
            </p>
          </section>
        )}

        <label className="block text-sm font-medium text-text-primary">
          说明
          <span className="ml-1 text-xs font-normal text-text-muted">可选</span>
          <textarea
            value={description}
            onChange={event => setDescription(event.target.value)}
            className="mt-2 h-20 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm font-normal text-text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
            placeholder="这个项目空间用于什么？"
          />
        </label>

        {error && (
          <p
            className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-text-primary transition hover:bg-muted"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="cloud-project-create-confirm"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? '正在创建…' : '创建项目'}
        </button>
      </footer>
    </Modal>
  )
}

export function CloudTodoWorkspace({
  user,
  localProjects,
  runtimeWork,
  runtimeTaskLifecycle,
  services,
  embedded = false,
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
  onArchiveRuntimeTask,
  onOpenSettings,
  onLogout,
}: CloudTodoWorkspaceProps) {
  const { t } = useTranslation('common')
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
  const projectSpaceApis = useMemo(() => {
    if (services.projectSpaceApis) return services.projectSpaceApis
    return {
      cloud: services.deliveryApi,
      defaultLocation: 'cloud' as const,
    }
  }, [services])
  const availableProjectSpaceApis = useMemo(
    () =>
      (['local', 'cloud'] as const).flatMap(location => {
        const api = projectSpaceApis[location]
        return api ? [{ api, location }] : []
      }),
    [projectSpaceApis]
  )
  const [localProjectSpaces, setLocalProjectSpaces] = useState<LocatedCloudProject[]>([])
  const [cloudProjectSpaces, setCloudProjectSpaces] = useState<LocatedCloudProject[]>([])
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
  const replaceProject = useCallback(
    (currentProject: LocatedCloudProject, updated: CloudProject) => {
      const setProjectSpaces =
        currentProject.location === 'local' ? setLocalProjectSpaces : setCloudProjectSpaces
      setProjectSpaces(current =>
        current.map(project =>
          projectSpaceKey(projectSpaceRef(project)) ===
          projectSpaceKey(projectSpaceRef(currentProject))
            ? { ...updated, location: currentProject.location }
            : project
        )
      )
    },
    []
  )
  const removeProjectFromList = useCallback((projectToRemove: LocatedCloudProject) => {
    const setProjectSpaces =
      projectToRemove.location === 'local' ? setLocalProjectSpaces : setCloudProjectSpaces
    const key = projectSpaceKey(projectSpaceRef(projectToRemove))
    setProjectSpaces(current =>
      current.filter(project => projectSpaceKey(projectSpaceRef(project)) !== key)
    )
  }, [])
  const prependProject = useCallback((project: LocatedCloudProject) => {
    const setProjectSpaces =
      project.location === 'local' ? setLocalProjectSpaces : setCloudProjectSpaces
    setProjectSpaces(current => [project, ...current])
  }, [])
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>({})
  const [projectMembers, setProjectMembers] = useState<Record<string, CloudProjectMember[]>>({})
  // Active robots of the selected project, used to resolve the assignee name
  // of robot-assigned tasks (local loop items only carry the agent id).
  const [projectAgents, setProjectAgents] = useState<Record<string, ProjectChatAgent[]>>({})
  // Every project's loop items, cached for the projects-home overview
  // (stats, recent activity). Keyed by project store and project id.
  const [projectItems, setProjectItems] = useState<Record<string, CloudLoopItem[]>>({})
  const [internalSelectedProjectRef, setSelectedProjectRef] =
    useState<RuntimeProjectSpaceRef | null>(null)
  const selectedProjectRef =
    activeProjectRef === undefined ? internalSelectedProjectRef : activeProjectRef
  const selectedProjectId = selectedProjectRef?.projectId ?? null
  const activeProjectKey =
    activeProjectRef === undefined
      ? undefined
      : activeProjectRef
        ? projectSpaceKey(activeProjectRef)
        : null
  const [items, setItems] = useState<LocatedLoopItem[]>([])
  const [itemTaskBindings, setItemTaskBindings] = useState<Record<string, LoopItemTaskBinding[]>>(
    {}
  )
  const [itemTaskBindingsProjectKey, setItemTaskBindingsProjectKey] = useState<string | null>(null)
  // Which project's items are currently in `items`. Anything else rendered on
  // the board would be stale, so the board shows the skeleton instead.
  const [itemsProjectKey, setItemsProjectKey] = useState<string | null>(null)
  const [externalPageCursors, setExternalPageCursors] = useState<Record<string, string | null>>({})
  const [externalPageLoading, setExternalPageLoading] = useState<Record<string, boolean>>({})
  const myWork = useMemo(
    () => runtimeMyWorkItems(runtimeWork, runtimeTaskLifecycle),
    [runtimeTaskLifecycle, runtimeWork]
  )
  const [rootView, setRootView] = useState<RootView>('projects')
  const [projectView, setProjectView] = useState<ProjectView>('board')
  const [selectedItem, setSelectedItem] = useState<LocatedLoopItem | null>(null)
  const [backgroundTaskItemId, setBackgroundTaskItemId] = useState<string | null>(null)
  // Items of the detail drawer's project when it differs from the board project,
  // so the drawer can stay open without switching the board view.
  const [detailItems, setDetailItems] = useState<LocatedLoopItem[]>([])
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createTodoOpen, setCreateTodoOpen] = useState(false)
  const [createTodoParent, setCreateTodoParent] = useState<LocatedLoopItem | null>(null)
  const [createTodoStatus, setCreateTodoStatus] = useState<CloudLoopItem['status']>('inbox')
  const [createTodoInitialTitle, setCreateTodoInitialTitle] = useState<string | undefined>()
  const [quickCreateStatus, setQuickCreateStatus] = useState<CloudLoopItem['status'] | null>(null)
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
  const [boardParentId, setBoardParentId] = useState<string | null>(null)
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
  const [aitableGroupFilter, setAitableGroupFilter] = useState('')
  const [aitableBoardQuery, setAitableBoardQuery] = useState('')
  const [nativeGroupBy, setNativeGroupBy] = useState<NativeBoardGroupBy>('status')
  const [nativeGroupFilter, setNativeGroupFilter] = useState('')
  const [nativeBoardQuery, setNativeBoardQuery] = useState('')
  const [localProjectFilter, setLocalProjectFilter] = useState('all')
  const [groupScopeBusy, setGroupScopeBusy] = useState(false)
  const [activeDragItemId, setActiveDragItemId] = useState<string | null>(null)
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
  const projectHeaderRef = useRef<HTMLElement>(null)
  const projectHeaderContentRef = useRef<HTMLDivElement>(null)
  const projectHeaderTabsRef = useRef<HTMLElement>(null)
  const projectHeaderAskAiRef = useRef<HTMLButtonElement>(null)
  const projectHeaderSearchRef = useRef<HTMLButtonElement>(null)
  const projectHeaderAddRef = useRef<HTMLButtonElement>(null)
  const projectHeaderNaturalWidthsRef = useRef({
    content: 0,
    tabs: 0,
    askAi: 0,
    search: 0,
    add: 0,
  })
  const [projectHeaderLevel, setProjectHeaderLevel] = useState(0)
  const boardSnapshotSignatureRef = useRef<string | null>(null)
  const boardLiveSubscriptionActiveRef = useRef(false)
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

  useLayoutEffect(() => {
    const header = projectHeaderRef.current
    const content = projectHeaderContentRef.current
    if (!header || !content) return

    const compute = () => {
      if (header.clientWidth <= 0) return
      const style = getComputedStyle(header)
      const base =
        header.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0)
      const rememberWidth = (
        key: keyof typeof projectHeaderNaturalWidthsRef.current,
        el: HTMLElement | null
      ) => {
        const measured = el?.getBoundingClientRect().width ?? 0
        if (measured > projectHeaderNaturalWidthsRef.current[key]) {
          projectHeaderNaturalWidthsRef.current[key] = measured
        }
        return projectHeaderNaturalWidthsRef.current[key] > 0
          ? projectHeaderNaturalWidthsRef.current[key] + 8
          : 0
      }
      const contentW = rememberWidth('content', content)
      const tabsW = rememberWidth('tabs', projectHeaderTabsRef.current)
      const askAiW = projectAssistantOpen
        ? 0
        : rememberWidth('askAi', projectHeaderAskAiRef.current)
      const searchW = rememberWidth('search', projectHeaderSearchRef.current)
      const addW = rememberWidth('add', projectHeaderAddRef.current)
      const tabsDropdownW = 96
      const compactControlW = 48
      const overflowW = !projectAssistantOpen || projectView === 'board' ? compactControlW : 0
      const compactAddW = projectView === 'board' && selectedProjectId ? compactControlW : 0

      const usedAt = (lv: number): number => {
        let used = lv < 2 ? contentW + 8 : 0
        used += lv < 2 ? tabsW : tabsDropdownW
        if (lv >= 2) return used + overflowW + compactAddW
        used += lv >= 1 ? compactControlW : searchW
        if (!projectAssistantOpen) used += lv >= 1 ? compactControlW : askAiW
        used += lv >= 1 ? compactControlW : addW
        return used
      }

      let next = 0
      while (next < 2 && usedAt(next) > base) next += 1
      setProjectHeaderLevel(next)
    }

    compute()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(compute)
    observer.observe(header)
    return () => observer.disconnect()
  }, [items, projectAssistantOpen, projectHeaderLevel, projectView, selectedProjectId])

  const [localProjectsLoading, setLocalProjectsLoading] = useState(Boolean(projectSpaceApis.local))
  const [cloudProjectsLoading, setCloudProjectsLoading] = useState(Boolean(projectSpaceApis.cloud))
  const [localProjectsError, setLocalProjectsError] = useState<string | null>(null)
  const [localProjectsRefreshNonce, setLocalProjectsRefreshNonce] = useState(0)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [dingtalkAuthPrompt, setDingtalkAuthPrompt] = useState(false)
  const [dingtalkAuthBusy, setDingtalkAuthBusy] = useState(false)
  const [boardRefreshNonce, setBoardRefreshNonce] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [copiedProjectId, setCopiedProjectId] = useState<string | null>(null)
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null)
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
  const [runtimeForceArchiveItems, setRuntimeForceArchiveItems] = useState<
    LocatedLoopItem[] | null
  >(null)
  const [runtimeConversationPreviews, setRuntimeConversationPreviews] = useState<
    Record<
      string,
      {
        signature: string
        text: string | null
      }
    >
  >({})
  const runtimeConversationRequestsRef = useRef(new Set<string>())
  const runtimeConversationLatestSignatureRef = useRef(new Map<string, string>())
  useEffect(() => {
    if (projectMenuId === null) return

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-cloud-project-menu-root]')
      ) {
        setProjectMenuId(null)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectMenuId(null)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [projectMenuId])
  // Applies a freshly fetched board snapshot. `boardError` distinguishes a
  // loaded-but-empty project (renders empty columns) from a failed fetch
  // (renders the skeleton plus the error banner instead of an empty board).
  const applyBoardItems = useCallback(
    (spaceKey: string, fetchedItems: LocatedLoopItem[], error: string | null) => {
      console.info('[Wework project board] snapshot applied', {
        projectSpace: spaceKey,
        itemCount: fetchedItems.length,
        outcome: error ? 'failed' : 'loaded',
      })
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
      setItems(fetchedItems)
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
    ) ?? (defaultProjectRequested ? (projects.find(isDefaultWorkItemProject) ?? null) : null)
  useEffect(() => {
    if (!defaultProjectRequested || selectedProjectRef || !selectedProject) return
    onActiveProjectChange?.(selectedProject)
  }, [defaultProjectRequested, onActiveProjectChange, selectedProject, selectedProjectRef])
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
  const runtimeTaskKeys = useMemo(() => new Set(runtimeTasksByKey.keys()), [runtimeTasksByKey])
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
  const boardTaskBindings = useMemo<Record<string, CloudTodoBoardTaskBinding[]>>(
    () =>
      Object.fromEntries(
        Object.entries(itemTaskBindings).map(([itemId, bindings]) => [
          itemId,
          bindings.map(binding => {
            const addressKey = runtimeConversationKey({
              deviceId: binding.device_id,
              taskId: binding.task_id,
            })
            const runtimeTask = runtimeTaskByAddress.get(addressKey)
            const preview = runtimeConversationPreviews[addressKey]

            return {
              id: binding.id,
              device_id: binding.device_id,
              task_id: binding.task_id,
              task_title: binding.task_title,
              running: runtimeTaskRunningByAddress.get(addressKey) ?? false,
              changeRequestTarget: runtimeTask
                ? runtimeTaskChangeRequestTarget(runtimeTask.workspace, runtimeTask.task)
                : null,
              finalResponsePreview: preview?.text ?? null,
            }
          }),
        ])
      ),
    [
      itemTaskBindings,
      runtimeConversationPreviews,
      runtimeTaskByAddress,
      runtimeTaskRunningByAddress,
    ]
  )
  const localProjectIdForItem = useCallback(
    (item: CloudLoopItem): number | null => {
      const storedAssociation = loopItemLocalProject(item)
      if (storedAssociation) return storedAssociation.id
      for (const binding of itemTaskBindings[item.id] ?? []) {
        const projectId = runtimeProjectIdByTask.get(`${binding.device_id}:${binding.task_id}`)
        if (projectId) return projectId
      }
      return null
    },
    [itemTaskBindings, runtimeProjectIdByTask]
  )
  const selectedProjectKey = selectedProject
    ? projectSpaceKey(projectSpaceRef(selectedProject))
    : null
  async function continueChangeRequestRepair(
    binding: CloudTodoBoardTaskBinding,
    snapshot: TaskChangeRequestSnapshot
  ): Promise<void> {
    const changeRequest = snapshot.changeRequest
    if (!changeRequest || !workbench || !selectedProject) return
    const address = hydrateRuntimeTaskAddress(runtimeWork, {
      deviceId: binding.device_id,
      taskId: binding.task_id,
    })
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
  const projectForItem = (item: Pick<LocatedLoopItem, 'cloud_project_id' | 'project_store'>) => {
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
  }
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
      if (!project) return undefined
      if (project.task_provider === 'dingtalk_aitable' && projectSpaceApis.local) {
        return projectSpaceApis.local
      }
      return projectSpaceApis[project.location]
    },
    [projectSpaceApis]
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
    selectedProject?.task_provider === 'dingtalk_aitable'
      ? apiForProject(selectedProject)
      : selectedProjectServices?.deliveryApi
  const selectedProjectAgentApi = selectedProjectServices?.projectChatAgentApi
  const selectedProjectChatClient = selectedProjectServices?.projectChatClient
  const selectedProjectSelfManagedExecution = selectedProject?.location === 'local'
  const selectedProjectLocation = selectedProject?.location
  const isAITableProject = selectedProject?.task_provider === 'dingtalk_aitable'
  const isExternalGitBoard =
    selectedProject?.task_provider === 'github' || selectedProject?.task_provider === 'gitlab'
  // Stable handle for the automation queue: the cloud executions API is
  // wrapped once per selected project API instead of being recreated on every
  // render, so unrelated workspace re-renders do not restart the queue load
  // (which flashed the loading state).
  const automationExecutionApi = useMemo(() => {
    if (selectedProjectLocation === 'local') {
      const local = selectedProjectServices?.loopItemExecutionApi
      if (!local) return undefined
      return {
        ...local,
        stop: (_projectId: string, executionId: number) =>
          stopLocalRobotQueueExecution(local, services.runtimeWorkApi, executionId),
      }
    }
    if (!selectedProjectApi) return undefined
    return {
      list: (projectId: string, options: { agent_id?: string; status?: string }) =>
        selectedProjectApi
          .listLoopItemExecutions(projectId, options)
          .then(response => response.items),
      stop: (projectId: string, executionId: number) =>
        selectedProjectApi.stopExecution(projectId, executionId),
    }
  }, [
    selectedProjectLocation,
    selectedProjectApi,
    services.runtimeWorkApi,
    selectedProjectServices?.loopItemExecutionApi,
  ])
  const selectedProjectAgents = selectedProjectKey ? (projectAgents[selectedProjectKey] ?? []) : []
  const agentNameById = (() => {
    const names: Record<string, string> = {}
    for (const agent of selectedProjectAgents) names[agent.id] = agent.name
    return names
  })()
  const boardCardDisplay: BoardCardDisplaySettings = {
    showAssignee: selectedProject?.card_display?.show_assignee ?? true,
    showPriority: selectedProject?.card_display?.show_priority ?? true,
    showTags: selectedProject?.card_display?.show_tags ?? true,
    showDate: selectedProject?.card_display?.show_date ?? true,
  }
  const personalGroupKey = selectedProject
    ? `wework-board-group:${user.id}:${selectedProject.id}`
    : null

  useEffect(() => {
    if (
      selectedProject?.location !== 'local' ||
      !selectedProjectId ||
      !selectedProjectKey ||
      !selectedProjectAgentApi
    ) {
      return
    }
    let cancelled = false
    void selectedProjectAgentApi
      .list(selectedProjectId)
      .then(agents => {
        if (cancelled) return
        setProjectAgents(current => ({
          ...current,
          [selectedProjectKey]: agents.filter(agent => agent.status === 'active'),
        }))
      })
      .catch(() => {
        if (!cancelled) {
          setProjectAgents(current => ({ ...current, [selectedProjectKey]: [] }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedProject, selectedProjectAgentApi, selectedProjectId, selectedProjectKey])

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

  useEffect(() => {
    if (!selectedProject || isAITableProject) return
    const personal = personalGroupKey ? localStorage.getItem(personalGroupKey) : null
    // The selected project changes the external localStorage key we synchronize from.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNativeGroupBy(
      personal === 'status' ||
        personal === 'priority' ||
        personal === 'assignee' ||
        personal === 'tag'
        ? personal
        : (selectedProject.board_config?.group_by ?? 'status')
    )
  }, [isAITableProject, personalGroupKey, selectedProject])

  const selectedGroupField = aitableFields.find(field => field.id === aitableGroupFieldId)
  const configuredGroupValues = Array.isArray(selectedGroupField?.config?.options)
    ? selectedGroupField.config.options.flatMap(option => aitableCellLabels(option))
    : []
  const aitableGroupValues = Array.from(
    new Set([
      ...configuredGroupValues,
      ...items.flatMap(item => aitableCellLabels(item.source_cells?.[aitableGroupFieldId])),
      ...(items.some(item => !aitableCellLabels(item.source_cells?.[aitableGroupFieldId]).length)
        ? ['未设置']
        : []),
    ])
  )
  // Distinct tags across the project (registry plus item usage), used by the
  // board tag grouping and filter.
  const availableTags = Array.from(
    new Set([...(selectedProject?.tags ?? []), ...items.flatMap(item => item.tags ?? [])])
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const boardColumns = isAITableProject
    ? aitableGroupValues.map((groupValue, index) => ({
        key: `field-${aitableGroupFieldId}-${groupValue}`,
        label: groupValue,
        status: 'inbox' as CloudLoopItem['status'],
        sourceStatus: null,
        groupValue,
        dotClass: ['bg-zinc-400', 'bg-indigo-500', 'bg-amber-500', 'bg-violet-500'][index % 4],
      }))
    : nativeGroupBy === 'priority'
      ? (['none', 'low', 'medium', 'high', 'urgent'] as const).map(priority => ({
          key: `priority-${priority}`,
          label: priority === 'none' ? '普通' : priority,
          status: 'inbox',
          sourceStatus: null,
          groupValue: priority,
          dotClass: columnDotClasses[priority] ?? 'bg-zinc-400',
        }))
      : nativeGroupBy === 'assignee'
        ? [
            ...Array.from(
              new Map(
                [
                  ...(selectedProjectKey ? (projectMembers[selectedProjectKey] ?? []) : []),
                  ...items.flatMap(item =>
                    item.assignee_user_id && item.assignee_name
                      ? [{ user_id: item.assignee_user_id, user_name: item.assignee_name }]
                      : []
                  ),
                ].map(member => [member.user_id, member])
              ).values()
            ).map(member => ({
              key: `assignee-${member.user_id}`,
              label: member.user_name,
              status: 'inbox',
              sourceStatus: null,
              groupValue: String(member.user_id),
              dotClass: 'bg-indigo-500',
            })),
            ...Array.from(
              new Map(
                [
                  ...selectedProjectAgents.map(agent => ({
                    agent_id: agent.id,
                    agent_name: agent.name,
                  })),
                  ...items.flatMap(item =>
                    item.assignee_agent_id
                      ? [
                          {
                            agent_id: item.assignee_agent_id,
                            agent_name:
                              item.assignee_agent_name ||
                              agentNameById[item.assignee_agent_id] ||
                              '',
                          },
                        ]
                      : []
                  ),
                ].map(agent => [agent.agent_id, agent])
              ).values()
            ).map(agent => ({
              key: `assignee-agent-${agent.agent_id}`,
              label: agent.agent_name || agent.agent_id,
              status: 'inbox',
              sourceStatus: null,
              groupValue: `agent:${agent.agent_id}`,
              dotClass: 'bg-indigo-500',
            })),
            {
              key: 'assignee-unassigned',
              label: '未指定',
              status: 'inbox',
              sourceStatus: null,
              groupValue: '',
              dotClass: 'bg-zinc-400',
            },
          ]
        : nativeGroupBy === 'tag'
          ? [
              ...availableTags.map(tag => ({
                key: `tag-${tag}`,
                label: tag,
                status: 'inbox' as CloudLoopItem['status'],
                sourceStatus: null,
                groupValue: tag,
                dotClass: 'bg-zinc-400',
              })),
              {
                key: 'tag-untagged',
                label: '无标签',
                status: 'inbox' as CloudLoopItem['status'],
                sourceStatus: null,
                groupValue: '',
                dotClass: 'bg-zinc-400',
              },
            ]
          : visibleNativeStatuses.map(status => ({
              key: status.id,
              label: status.name,
              status: status.id,
              sourceStatus: null,
              groupValue: status.id,
              dotClass:
                boardStatusColorClasses[status.color] ??
                columnDotClasses[status.id] ??
                'bg-zinc-400',
            }))
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
  // Only render board items that belong to the selected project. On a project
  // switch this flips to the skeleton in the same render, before the fetch.
  // `boardError` distinguishes a failed fetch (skeleton stays) from a
  // successfully loaded but empty project (renders the empty columns).
  const boardItemsLoading = selectedProject !== null && itemsProjectKey !== selectedProjectKey
  const startupProjectsLoading =
    (Boolean(projectSpaceApis.local) && localProjectsLoading) ||
    (Boolean(projectSpaceApis.cloud) && cloudProjectsLoading)
  const startupProjectRouteReady =
    !activeProjectRef ||
    Boolean(selectedProject && sameProjectSpace(projectSpaceRef(selectedProject), activeProjectRef))
  const focusedStartupItem = focusedItemId
    ? items.find(item => item.id === focusedItemId)
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
  useEffect(() => {
    if (!selectedItem || selectedItem.detail_loaded !== false || !selectedItemApi) return
    let active = true
    const itemId = selectedItem.id
    const projectStore = selectedItem.project_store
    void selectedItemApi
      .getLoopItem(itemId)
      .then(item => {
        if (!active) return
        const locatedItem = { ...item, project_store: projectStore }
        setSelectedItem(current => (current?.id === itemId ? locatedItem : current))
        setItems(current =>
          current.map(candidate => (candidate.id === itemId ? locatedItem : candidate))
        )
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
  }, [selectedItem, selectedItemApi, t])
  useEffect(() => {
    if (
      !selectedItem?.is_unread ||
      !selectedItemApi ||
      selectedItemProject?.location !== 'cloud' ||
      selectedItemProject.task_provider !== 'local'
    ) {
      return
    }
    let active = true
    const itemId = selectedItem.id
    const projectKey = projectSpaceKey(projectSpaceRef(selectedItemProject))
    void selectedItemApi
      .markLoopItemRead(itemId)
      .then(updated => {
        if (!active) return
        const locatedUpdated = {
          ...updated,
          project_store: selectedItem.project_store,
        }
        setSelectedItem(current => (current?.id === itemId ? locatedUpdated : current))
        setItems(current => current.map(item => (item.id === itemId ? locatedUpdated : item)))
        setDetailItems(current => current.map(item => (item.id === itemId ? locatedUpdated : item)))
        setProjectItems(current => ({
          ...current,
          [projectKey]: (current[projectKey] ?? []).map(item =>
            item.id === itemId ? locatedUpdated : item
          ),
        }))
      })
      .catch(error => {
        console.warn('[Wework project board] mark Issue read failed', {
          itemId,
          error,
        })
      })
    return () => {
      active = false
    }
  }, [
    selectedItem?.id,
    selectedItem?.is_unread,
    selectedItem?.project_store,
    selectedItemApi,
    selectedItemProject,
  ])
  // Source for the detail drawer / creation dialog when the selected todo lives
  // in a project other than the one shown on the board.
  const detailAllItems =
    selectedItemProject &&
    !sameProjectSpace(projectSpaceRef(selectedItemProject), selectedProjectRef)
      ? detailItems
      : items
  const createTodoProject = createTodoParent
    ? (projectForItem(createTodoParent) ?? null)
    : selectedProject
  const createTodoApi = apiForProject(createTodoProject)
  const boardItems = items
  const boardParent = boardItems.find(item => item.id === boardParentId) ?? null
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
  const boardBreadcrumb: CloudLoopItem[] = []
  let breadcrumbItem = boardParent
  const breadcrumbIds = new Set<string>()
  while (breadcrumbItem && !breadcrumbIds.has(breadcrumbItem.id)) {
    boardBreadcrumb.unshift(breadcrumbItem)
    breadcrumbIds.add(breadcrumbItem.id)
    breadcrumbItem =
      boardItems.find(candidate => candidate.id === breadcrumbItem?.parent_id) ?? null
  }

  function applyProjectSelection(project: LocatedCloudProject | null) {
    const ref = project ? projectSpaceRef(project) : null
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
    if (!api) throw new Error('项目空间接口当前不可用')
    setRenameBusy(true)
    setRenameError(null)
    try {
      const updated = await api.updateCloudProject(renameProject.id, {
        name: renameProjectName.trim(),
        version: renameProject.version,
      })
      replaceProject(renameProject, updated)
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
    if (!api) return
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      await api.archiveCloudProject(archiveProject.id, archiveProject.version)
      removeProjectFromList(archiveProject)
      setProjectCounts(current => {
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
    const api = apiForProject(projectForItem(archiveItem))
    if (!api) return
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      await api.archiveLoopItem(archiveItem.id)
      const archivedIds = new Set([archiveItem.id])
      let changed = true
      while (changed) {
        changed = false
        for (const candidate of items) {
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
      setItems(current => current.filter(item => !archivedIds.has(item.id)))
      const archiveProjectKey = selectedProjectKey
      if (archiveProjectKey) {
        setProjectItems(current => ({
          ...current,
          [archiveProjectKey]: (current[archiveProjectKey] ?? []).filter(
            item => !archivedIds.has(item.id)
          ),
        }))
        setProjectCounts(current => ({
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

  async function archiveCompletedItems(
    completedItems: LocatedLoopItem[],
    options?: ArchiveRuntimeTaskOptions
  ) {
    if (!onArchiveRuntimeTask || archiveBusy || completedItems.length === 0) return
    setArchiveBusy(true)
    setArchiveError(null)
    const archivedItemKeys = new Set<string>()
    const dirtyItems: LocatedLoopItem[] = []
    const failedItems: LocatedLoopItem[] = []
    try {
      for (const item of completedItems) {
        const addresses = new Map<string, RuntimeTaskAddress>()
        for (const binding of itemTaskBindings[item.id] ?? []) {
          const address = { deviceId: binding.device_id, taskId: binding.task_id }
          addresses.set(runtimeConversationKey(address), address)
        }
        for (const address of runtimeAddressesByWorkItem.get(
          `${item.cloud_project_id}:${item.id}`
        ) ?? []) {
          addresses.set(runtimeConversationKey(address), address)
        }
        let itemIsDirty = false
        let itemFailed = false
        try {
          for (const address of addresses.values()) {
            const result = await onArchiveRuntimeTask(address, options)
            if (!options?.force && result?.status === 'dirty_worktree') {
              itemIsDirty = true
            } else if (result?.status === 'failed') {
              itemFailed = true
            }
          }
          if (itemIsDirty) {
            dirtyItems.push(item)
            continue
          }
          if (itemFailed) {
            failedItems.push(item)
            continue
          }
          const api = apiForProject(projectForItem(item))
          if (!api) throw new Error('项目空间当前不可用')
          await api.archiveLoopItem(item.id)
          archivedItemKeys.add(`${item.project_store ?? 'backend'}:${item.id}`)
        } catch (error) {
          failedItems.push(item)
          console.error('[Wework my tasks] archive runtime task failed', error)
        }
      }
      if (archivedItemKeys.size > 0) {
        setItems(current =>
          current.filter(
            item => !archivedItemKeys.has(`${item.project_store ?? 'backend'}:${item.id}`)
          )
        )
      }
      setRuntimeBatchArchiveItems(dirtyItems.length === 0 ? failedItems : null)
      setRuntimeForceArchiveItems(!options?.force && dirtyItems.length > 0 ? dirtyItems : null)
      if (failedItems.length > 0) {
        setArchiveError(
          t('todo.batch_archive_failed', '{{count}} 个任务归档失败，请稍后重试', {
            count: failedItems.length,
          })
        )
      }
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
    initialTitle?: string
  ) {
    setQuickCreateStatus(null)
    setCreateTodoParent(parent)
    setCreateTodoStatus(status)
    setCreateTodoInitialTitle(initialTitle)
    setCreateTodoOpen(true)
  }

  function openMyWorkItem(item: CloudMyWorkItem) {
    if (isRuntimeMyWorkItem(item)) {
      void onOpenRuntimeTask?.(item.runtime_address)
      return
    }
    if (item.can_view_detail !== false) setSelectedItem(item)
  }

  function addCreatedTodo(item: CloudLoopItem, project: LocatedCloudProject) {
    const locatedItem = {
      ...item,
      project_store: project.project_store,
    }
    if (
      selectedProject &&
      sameProjectSpace(projectSpaceRef(project), projectSpaceRef(selectedProject))
    ) {
      setItems(current => [...current, locatedItem])
    } else {
      setDetailItems(current => [...current, locatedItem])
    }
    const targetProjectKey = projectSpaceKey(projectSpaceRef(project))
    setProjectCounts(current => ({
      ...current,
      [targetProjectKey]: (current[targetProjectKey] ?? 0) + 1,
    }))
    setProjectItems(current => ({
      ...current,
      [targetProjectKey]: [...(current[targetProjectKey] ?? []), locatedItem],
    }))
    track('board_item_created', {
      has_parent: item.parent_id !== null,
      source: project.location,
    })
    return locatedItem
  }

  function requestCreatedItemExecutionConfiguration(
    item: LocatedLoopItem
  ): ExecutionConfigurationRequestResult {
    if (!isProcessingStatus(item.status) || !itemNeedsExecutionConfiguration(item)) {
      return 'not-needed'
    }
    return openExecutionConfiguration({
      item,
      continuation: { type: 'save' },
    })
  }

  async function createTodoInBoardColumn(
    status: CloudLoopItem['status'],
    content: string,
    automationRuleId?: string
  ) {
    if (!selectedProject || !selectedProjectApi) throw new Error('项目空间接口当前不可用')
    if (isMyTasksBoard && status !== 'inbox' && !selectedLocalProject) {
      throw new Error(t('todo.select_local_project_before_create', '请先选择要修改的本地项目'))
    }
    const draft = issueDraftFromText(content)
    try {
      const created = await selectedProjectApi.createLoopItem(selectedProject.id, {
        title: draft.title,
        description: draft.description,
        priority: 'none',
        status,
        tags: [],
        ...(isMyTasksBoard && status !== 'inbox' && selectedLocalProject
          ? {
              local_project_id: selectedLocalProject.id,
              local_project_name: selectedLocalProject.name,
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
    const api = projectSpaceApis.cloud
    if (!api) return
    let active = true
    void api
      .listCloudProjects()
      .then(response => {
        if (!active) return
        setCloudProjectSpaces(
          response.items.map(project => ({
            ...project,
            project_store: 'backend',
            location: 'cloud',
          }))
        )
      })
      .catch(error => {
        console.warn('[Wework project spaces] cloud list failed', error)
        if (active) setCloudProjectSpaces([])
      })
      .finally(() => {
        if (active) setCloudProjectsLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectSpaceApis.cloud])
  useEffect(() => {
    if (!selectedProject || !selectedProjectId || !selectedProjectKey || !selectedProjectApi) return
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
              externalBoardStatuses.map(status =>
                selectedProjectApi.listLoopItemsPage(selectedProjectId, {
                  status,
                  parentId: boardParentId,
                  limit: externalBoardColumnPageSize,
                })
              )
            ),
            selectedProjectApi.listCloudProjectMembers(selectedProjectId),
            selectedProjectAgentApi?.list(selectedProjectId) ?? Promise.resolve([]),
          ])
          console.info('[Wework project board] column pages loaded', {
            projectSpace: selectedProjectKey,
            parentId: boardParentId,
            pages: pages.map((page, index) => ({
              status: externalBoardStatuses[index],
              itemIds: page.items.map(item => item.id),
              nextCursor: page.next_cursor,
            })),
          })
          return {
            items: locateItems(
              pages.flatMap(page => page.items),
              selectedProject.project_store
            ),
            task_bindings: pages.flatMap(page => page.task_bindings),
            members,
            agents,
            page_cursors: Object.fromEntries(
              pages.map((page, index) => [externalBoardStatuses[index], page.next_cursor])
            ),
          }
        }
        const selectedResponse: BoardReadResult =
          await selectedProjectApi.getBoardSnapshot(selectedProjectId)
        const selectedItems = locateItems(selectedResponse.items, selectedProject.project_store)
        if (!isMyTasksBoard) return { ...selectedResponse, items: selectedItems }
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
        return {
          ...selectedResponse,
          items: selectedItems.filter(item => activeItemIds.has(item.id)),
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
                members: selectedProject.location === 'cloud' ? (response.members ?? []) : [],
                agents: selectedProject.location === 'cloud' ? (response.agents ?? []) : [],
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
            setExternalPageCursors(response.page_cursors ?? {})
          } else {
            applyBoardItems(selectedProjectKey, locatedItems, null)
            setExternalPageCursors({})
          }
          if (boardContext) {
            const bindingsByItem: Record<string, LoopItemTaskBinding[]> = {}
            for (const binding of boardContext.taskBindings) {
              if (!binding.loop_item_id) continue
              const itemBindings = bindingsByItem[binding.loop_item_id] ?? []
              itemBindings.push(binding)
              bindingsByItem[binding.loop_item_id] = itemBindings
            }
            setItemTaskBindings(current =>
              isExternalGitBoard ? { ...current, ...bindingsByItem } : bindingsByItem
            )
            setItemTaskBindingsProjectKey(selectedProjectKey)
          }
          if (selectedProject.location === 'cloud' && boardContext) {
            setProjectMembers(current => ({
              ...current,
              [selectedProjectKey]: boardContext.members,
            }))
            setProjectAgents(current => ({
              ...current,
              [selectedProjectKey]: boardContext.agents.filter(agent => agent.status === 'active'),
            }))
          }
          // Keep the projects-home cache in sync with the board fetch.
          setProjectItems(current => ({
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
          setProjectCounts(current => ({
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
          setExternalPageCursors({})
          setItemTaskBindings({})
          setItemTaskBindingsProjectKey(selectedProjectKey)
          if (selectedProject.location === 'cloud') {
            setProjectMembers(current => ({ ...current, [selectedProjectKey]: [] }))
            setProjectAgents(current => ({ ...current, [selectedProjectKey]: [] }))
          }
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
    runtimeTaskStatusSignature,
    runtimeTaskKeys,
    services.aitableApi,
    services.dwsApi,
  ])

  async function loadMoreExternalColumn(itemStatus: string): Promise<void> {
    const cursor = externalPageCursors[itemStatus]
    if (
      !isExternalGitBoard ||
      !selectedProject ||
      !selectedProjectApi ||
      !selectedProjectId ||
      !selectedProjectKey ||
      !cursor ||
      externalPageLoading[itemStatus]
    ) {
      return
    }
    setExternalPageLoading(current => ({ ...current, [itemStatus]: true }))
    try {
      const page = await selectedProjectApi.listLoopItemsPage(selectedProjectId, {
        status: itemStatus,
        parentId: boardParentId,
        cursor,
        limit: externalBoardColumnPageSize,
      })
      const locatedItems = locateItems(page.items, selectedProject.project_store)
      setItems(current => {
        const currentColumnItems = current.filter(
          item => item.status === itemStatus && item.parent_id === boardParentId
        )
        const existingIds = new Set(current.map(item => item.id))
        const receivedIds = locatedItems.map(item => item.id)
        const duplicateIds = receivedIds.filter(id => existingIds.has(id))
        const merged = Array.from(
          new Map([...current, ...locatedItems].map(item => [item.id, item])).values()
        )
        console.info('[Wework project board] column page merged', {
          projectSpace: selectedProjectKey,
          parentId: boardParentId,
          status: itemStatus,
          cursor,
          nextCursor: page.next_cursor,
          existingTailIds: currentColumnItems.slice(-3).map(item => item.id),
          receivedIds,
          duplicateIds,
          beforeCount: current.length,
          afterCount: merged.length,
        })
        return merged
      })
      setExternalPageCursors(current => ({
        ...current,
        [itemStatus]: page.next_cursor,
      }))
      setItemTaskBindings(current => {
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
      setExternalPageLoading(current => ({ ...current, [itemStatus]: false }))
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
      itemTaskBindingsProjectKey !== selectedProjectKey
    ) {
      return
    }
    for (const item of items) {
      for (const binding of itemTaskBindings[item.id] ?? []) {
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
        if (runtimeConversationPreviews[addressKey]?.signature === signature) continue
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
            limit: 50,
          })
          .then(transcript => {
            if (runtimeConversationLatestSignatureRef.current.get(addressKey) !== signature) {
              return
            }
            const text = finalAssistantTranscriptText(transcript)
            setRuntimeConversationPreviews(current => ({
              ...current,
              [addressKey]: {
                signature,
                text,
              },
            }))
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
            setRuntimeConversationPreviews(current => ({
              ...current,
              [addressKey]: {
                signature,
                text: null,
              },
            }))
          })
          .finally(() => {
            runtimeConversationRequestsRef.current.delete(requestKey)
          })
      }
    }
  }, [
    itemTaskBindings,
    itemTaskBindingsProjectKey,
    items,
    runtimeConversationPreviews,
    runtimeTasksByKey,
    selectedProjectKey,
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
        if (active) setProjectMembers(current => ({ ...current, [selectedProjectKey]: members }))
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
    if (!selectedProjectId || !selectedProjectKey || itemsProjectKey !== selectedProjectKey) return
    const requestKey = `${selectedProjectKey}:${focusedItemId}`
    if (focusedItemRequestRef.current === requestKey) return
    const focusedItem = items.find(item => item.id === focusedItemId)
    if (!focusedItem || focusedItem.can_view_detail === false) return
    focusedItemRequestRef.current = requestKey
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setRootView('projects')
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
    items,
    itemsProjectKey,
    onFocusedItemHandled,
    selectedProjectId,
    selectedProjectKey,
  ])
  useEffect(() => {
    if (!globalSearchOpen) return
    let active = true
    void Promise.allSettled(
      projects.map(async project => {
        const api = apiForProject(project)
        if (!api) return null
        const response = await api.listLoopItems(project.id)
        return { project, items: response.items }
      })
    ).then(results => {
      if (!active) return
      setProjectItems(current => {
        const next = { ...current }
        results.forEach(result => {
          if (result.status === 'fulfilled' && result.value) {
            next[projectSpaceKey(projectSpaceRef(result.value.project))] = result.value.items
          }
        })
        return next
      })
    })
    return () => {
      active = false
    }
  }, [apiForProject, globalSearchOpen, projects])
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
    if (!detailApi) return
    let active = true
    void detailApi.listLoopItems(selectedItem.cloud_project_id).then(response => {
      if (active && selectedItemProject) {
        setDetailItems(locateItems(response.items, selectedItemProject.project_store))
      }
    })
    return () => {
      active = false
    }
  }, [apiForProject, locateItems, selectedItem, selectedItemProject, selectedProjectRef])

  async function saveExecutionConfiguration(
    item: LocatedLoopItem,
    result: IssueExecutionConfigResult
  ): Promise<void> {
    const project = projectForItem(item)
    const itemApi = apiForProject(project)
    if (!project || !itemApi) throw new Error('项目空间当前不可用')

    setBoardError(null)
    const updated = await itemApi.updateLoopItem(item.id, {
      version: item.version,
      ...result,
    })
    const locatedUpdated = { ...updated, project_store: item.project_store }
    const projectKey = projectSpaceKey(projectSpaceRef(project))

    setItems(current =>
      current.map(candidate => (candidate.id === updated.id ? locatedUpdated : candidate))
    )
    setDetailItems(current =>
      current.map(candidate => (candidate.id === updated.id ? locatedUpdated : candidate))
    )
    setSelectedItem(current => (current?.id === updated.id ? locatedUpdated : current))
    setProjectItems(current => ({
      ...current,
      [projectKey]: (current[projectKey] ?? []).map(candidate =>
        candidate.id === updated.id ? locatedUpdated : candidate
      ),
    }))
  }

  async function moveItem(
    itemId: string,
    columnKey: string,
    beforeItemId: string | null = null,
    executionResult?: IssueExecutionConfigResult,
    automationRuleId?: string
  ): Promise<boolean> {
    const item = items.find(candidate => candidate.id === itemId)
    const column = boardColumns.find(candidate => candidate.key === columnKey)
    if (!item || !column || item.can_edit === false || isAITableProject) return false
    const enteringExecution = nativeGroupBy === 'status' && isProcessingStatus(column.status)
    let executionItem = item
    if (enteringExecution && !item.workflow && item.can_view_detail !== false) {
      const itemApi = apiForProject(projectForItem(item))
      if (!itemApi) {
        setBoardError('项目空间当前不可用')
        return false
      }
      try {
        const refreshed = await itemApi.getLoopItem(item.id)
        executionItem = { ...refreshed, project_store: item.project_store }
        setItems(current =>
          current.map(candidate => (candidate.id === item.id ? executionItem : candidate))
        )
      } catch (cause) {
        setBoardError(cause instanceof Error ? cause.message : '读取 Issue 配置失败')
        return false
      }
    }
    const needsExecutionConfig = enteringExecution && itemNeedsExecutionConfiguration(executionItem)
    if (needsExecutionConfig && !executionResult) {
      openExecutionConfiguration({
        item: executionItem,
        continuation: { type: 'move', columnKey, beforeItemId },
      })
      return false
    }
    const taskBindingCount = Math.max(
      itemTaskBindings[item.id]?.length ?? 0,
      runtimeAddressesByWorkItem.get(`${item.cloud_project_id}:${item.id}`)?.length ?? 0
    )
    const reordered =
      nativeGroupBy === 'status' && !isMyTasksBoard
        ? reorderLaneItems(items, itemId, column.status, beforeItemId)
        : null
    const previousItems = items
    if (reordered) {
      setItems(reordered.items)
    } else {
      setItems(current =>
        current.map(candidate => {
          if (candidate.id !== itemId) return candidate
          if (nativeGroupBy === 'priority') {
            return { ...candidate, priority: column.groupValue as CloudLoopItem['priority'] }
          }
          if (nativeGroupBy === 'assignee') {
            return column.groupValue.startsWith('team:')
              ? {
                  ...candidate,
                  assignee_user_id: null,
                  assignee_agent_id: null,
                  assignee_team_id: Number(column.groupValue.slice('team:'.length)),
                }
              : column.groupValue.startsWith('agent:')
                ? {
                    ...candidate,
                    assignee_user_id: null,
                    assignee_agent_id: column.groupValue.slice('agent:'.length),
                    assignee_team_id: null,
                  }
                : {
                    ...candidate,
                    assignee_user_id: column.groupValue ? Number(column.groupValue) : null,
                    assignee_agent_id: null,
                    assignee_team_id: null,
                  }
          }
          return { ...candidate, tags: column.groupValue ? [column.groupValue] : [] }
        })
      )
    }
    setBoardError(null)
    try {
      const itemApi = apiForProject(projectForItem(item))
      if (!itemApi) throw new Error('项目空间当前不可用')
      const update =
        nativeGroupBy === 'status'
          ? {
              status: column.status,
              ...executionResult,
              ...(automationRuleId ? { automation_rule_id: automationRuleId } : {}),
            }
          : nativeGroupBy === 'priority'
            ? { priority: column.groupValue as CloudLoopItem['priority'] }
            : nativeGroupBy === 'assignee'
              ? column.groupValue.startsWith('team:')
                ? {
                    assignee_user_id: null,
                    assignee_agent_id: null,
                    assignee_team_id: Number(column.groupValue.slice('team:'.length)),
                  }
                : column.groupValue.startsWith('agent:')
                  ? {
                      assignee_user_id: null,
                      assignee_agent_id: column.groupValue.slice('agent:'.length),
                      assignee_team_id: null,
                    }
                  : {
                      assignee_user_id: column.groupValue ? Number(column.groupValue) : null,
                      assignee_agent_id: null,
                      assignee_team_id: null,
                    }
              : { tags: column.groupValue ? [column.groupValue] : [] }
      const updated = await itemApi.updateLoopItem(item.id, { version: item.version, ...update })
      const locatedUpdated = { ...updated, project_store: item.project_store }
      setItems(current =>
        current.map(candidate => (candidate.id === updated.id ? locatedUpdated : candidate))
      )
      setSelectedItem(current => (current?.id === updated.id ? locatedUpdated : current))
      const automationAddedIncompleteWorkflow =
        enteringExecution && !executionResult && itemNeedsExecutionConfiguration(locatedUpdated)
      console.info('[Wework project board] status update execution snapshot', {
        itemId: locatedUpdated.id,
        previousStatus: item.status,
        status: locatedUpdated.status,
        enteringExecution,
        executionConfigProvided: Boolean(executionResult),
        hasWorkflow: Boolean(locatedUpdated.workflow),
        workflowNodeIds: locatedUpdated.workflow?.nodes.map(node => node.id) ?? [],
        workflowNodeStatuses: locatedUpdated.workflow?.nodes.map(node => node.status) ?? [],
        needsExecutionConfiguration: automationAddedIncompleteWorkflow,
      })
      if (automationAddedIncompleteWorkflow) {
        console.info('[Wework project board] execution route selected', {
          itemId: locatedUpdated.id,
          route: 'workflow_configuration',
        })
        openExecutionConfiguration({
          item: locatedUpdated,
          continuation: { type: 'save' },
        })
        return false
      }
      if (reordered) {
        await itemApi.reorderLoopItems(item.cloud_project_id, {
          parent_id: item.parent_id,
          status: column.status,
          item_ids: reordered.laneIds,
        })
      }
      const shouldOpenTaskComposer =
        enteringExecution &&
        shouldPrepareWorkItemTask(locatedUpdated, item.status, taskBindingCount)
      console.info('[Wework project board] execution route selected', {
        itemId: locatedUpdated.id,
        route: shouldOpenTaskComposer
          ? 'single_task'
          : locatedUpdated.workflow
            ? 'workflow'
            : 'none',
        taskBindingCount,
      })
      if (shouldOpenTaskComposer) {
        setSelectedTaskBinding(null)
        setSelectedItem(locatedUpdated)
        setBackgroundTaskItemId(column.status === 'in_progress' ? locatedUpdated.id : null)
        openTaskComposer({
          workItemId: locatedUpdated.id,
          initialInput: workItemTaskInput(locatedUpdated),
          backgroundAfterSend: column.status === 'in_progress',
        })
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
      setItems(previousItems)
      const candidates = automationSelectionCandidates(cause)
      if (candidates && !automationRuleId) {
        setBoardError(null)
        setPendingAutomationSelection({
          candidates,
          onCancel: () => setPendingAutomationSelection(null),
          onConfirm: async selectedAutomationId => {
            const moved = await moveItem(
              itemId,
              columnKey,
              beforeItemId,
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
    const activeId = String(event.active.id)
    const beforeCardId = boardCardIdFromDropId(event.over?.id)
    if (beforeCardId) {
      if (beforeCardId === activeId) return
      const target = items.find(candidate => candidate.id === beforeCardId)
      const targetColumn = target
        ? boardColumns.find(column => {
            if (nativeGroupBy === 'priority') return target.priority === column.groupValue
            if (nativeGroupBy === 'assignee') {
              return itemMatchesAssigneeGroup(target, column.groupValue)
            }
            if (nativeGroupBy === 'tag') {
              return column.groupValue
                ? (target.tags ?? []).includes(column.groupValue)
                : !(target.tags ?? []).length
            }
            return target.status === column.status
          })
        : null
      if (targetColumn) void moveItem(activeId, targetColumn.key, beforeCardId)
      return
    }
    const status = boardStatusFromDropId(event.over?.id)
    if (status) {
      const column = boardColumns.find(candidate => candidate.key === status)
      if (column) void moveItem(activeId, column.key)
    }
  }

  function savePersonalGroupBy(groupBy: NativeBoardGroupBy) {
    setNativeGroupBy(groupBy)
    setNativeGroupFilter('')
    if (personalGroupKey) localStorage.setItem(personalGroupKey, groupBy)
  }

  async function saveGlobalGroupBy() {
    if (!selectedProject || groupScopeBusy) return
    const projectApi = projectSpaceApis[selectedProject.location] ?? selectedProjectApi
    if (!projectApi) return
    setGroupScopeBusy(true)
    setBoardError(null)
    try {
      const updated = await projectApi.updateCloudProject(selectedProject.id, {
        version: selectedProject.version,
        board_config: {
          group_by: nativeGroupBy,
          processing_start_status_id: processingStartStatusId,
          statuses: nativeStatuses,
        },
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
    setQuickCreateStatus(null)
    setIssueComposerBoardKey(projectSpaceKey(projectSpaceRef(targetProject)))
    setIssueComposerStatus(status)
    setIssueComposerInitialContent(initialContent)
    setIssueComposerPresentation(presentation)
    setIssueComposerError(null)
    setIssueComposerOpen(true)
    setRootView('projects')
    setSelectedItem(null)
  }

  async function createIssue(input: {
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
    if (!targetProject || !targetApi || issueComposerBusy) return false
    setIssueComposerBusy(true)
    setIssueComposerError(null)
    try {
      const taskRuntimeProjectId = runtimeTaskProjectUiId(runtimeWork, input.taskRequest)
      const issueLocalProject =
        localProjectOptions.find(project => project.id === taskRuntimeProjectId) ?? null
      let created = await targetApi.createLoopItem(targetProject.id, {
        title: input.title,
        description: input.description,
        status: input.status ?? (input.createTask ? 'pending' : 'inbox'),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.automationRuleId ? { automation_rule_id: input.automationRuleId } : {}),
        parent_id: null,
        ...(input.createTask && isDefaultWorkItemProject(targetProject) && issueLocalProject
          ? {
              local_project_id: issueLocalProject.id,
              local_project_name: issueLocalProject.name,
            }
          : {}),
      })
      if (input.files.length > 0) {
        const uploadedAttachments = await Promise.all(
          input.files.map(file => targetApi.addLoopItemAttachment(created.id, file))
        )
        const attachmentMarkdown = uploadedAttachments
          .map(attachment => attachment.markdown)
          .filter(Boolean)
          .join('\n')
        if (attachmentMarkdown) {
          created = await targetApi.updateLoopItem(created.id, {
            version: created.version,
            description: [input.description, attachmentMarkdown].filter(Boolean).join('\n\n'),
          })
        }
      }
      if (input.assigneeUserId) {
        if (typeof targetApi.assignLoopItem === 'function') {
          created = await targetApi.assignLoopItem(targetProject.id, created.id, {
            version: created.version,
            assigneeType: 'user',
            assigneeId: String(input.assigneeUserId),
          })
        } else {
          created = await targetApi.updateLoopItem(created.id, {
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
      setProjectCounts(current => ({
        ...current,
        [targetProjectKey]: (current[targetProjectKey] ?? 0) + 1,
      }))
      setProjectItems(current => ({
        ...current,
        [targetProjectKey]: [...(current[targetProjectKey] ?? []), locatedItem],
      }))
      if (
        selectedProject &&
        sameProjectSpace(projectSpaceRef(targetProject), projectSpaceRef(selectedProject))
      ) {
        setItems(current => [...current, locatedItem])
      }
      selectProject(targetProject)
      setRootView('projects')
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
        setBackgroundTaskItemId(locatedItem.id)
        openTaskComposer({
          workItemId: locatedItem.id,
          initialInput: workItemTaskInput(locatedItem),
          backgroundAfterSend: true,
          taskRequest: input.taskRequest
            ? {
                ...input.taskRequest,
                message: workItemTaskInput(locatedItem),
                title: locatedItem.title,
                cloudProjectId: String(targetProject.id),
                origin: {
                  type: 'board_task',
                  cloudProjectId: String(targetProject.id),
                  loopItemId: String(locatedItem.id),
                  projectStore: targetProject.project_store,
                },
              }
            : undefined,
        })
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
            const created = await createIssue({ ...input, automationRuleId: automationId })
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
    selectedItemApi &&
    issueResourceAttachmentState.itemId !== selectedItem.id
  )

  useEffect(() => {
    if (!taskPanelOpen || !selectedItem || !selectedItemApi) return
    let active = true
    void selectedItemApi.listLoopItemAttachments(selectedItem.id).then(
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
  }, [selectedItem, selectedItemApi, taskPanelOpen])

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

  function closeTopPanel() {
    closeIssuePanelStack()
  }

  async function prepareSelectedItemTask(address: RuntimeTaskAddress) {
    if (!selectedItem) return
    const itemApi = apiForProject(selectedItemProject)
    if (!itemApi) return
    try {
      const latest = await itemApi.getLoopItem(selectedItem.id)
      const workflowNodeId =
        taskComposerRequest?.workItemId === selectedItem.id
          ? taskComposerRequest.workflowNodeId
          : undefined
      await itemApi.bindTask(latest.id, address, latest.title, workflowNodeId)
      rememberProjectTaskStore(address, selectedItem.project_store ?? 'backend')
      publishProjectSpaceTaskBindingChanged(address)
      setBoardRefreshNonce(value => value + 1)
      return async () => {
        await itemApi.unbindTask(latest.id, address)
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
    if (!selectedItem) return
    const itemApi = apiForProject(selectedItemProject)
    if (!itemApi) return
    try {
      const latest = await itemApi.getLoopItem(selectedItem.id)
      const associatedTags =
        isMyTasksBoard && localProject ? associateLoopItemTags(latest, localProject) : latest.tags
      const associationChanged =
        associatedTags.length !== latest.tags.length ||
        associatedTags.some((tag, index) => tag !== latest.tags[index])
      const updated =
        latest.status === 'inbox' || associationChanged
          ? await itemApi.updateLoopItem(latest.id, {
              version: latest.version,
              ...(latest.status === 'inbox' ? { status: 'pending' } : {}),
              ...(associationChanged ? { tags: associatedTags } : {}),
            })
          : latest
      const locatedUpdated = {
        ...updated,
        project_store: selectedItem.project_store,
      }
      setItems(current =>
        current.map(item =>
          item.id === locatedUpdated.id ? preferNewestLoopItemSnapshot(item, locatedUpdated) : item
        )
      )
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
      {selectedProjectKey === itemTaskBindingsProjectKey &&
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
            <div className="flex h-full w-[240px] flex-col px-1.5 pt-1.5">
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
              <nav className="space-y-0.5">
                <DesktopSidebarNavItem
                  icon={Plus}
                  label={
                    isMyTasksBoard
                      ? t('todo.new_task', '新建任务')
                      : t('todo.new_issue', '新建 Issue')
                  }
                  testId="cloud-create-issue"
                  selected={issueComposerOpen}
                  onClick={() => openIssueCreation()}
                />
                <DesktopSidebarNavItem
                  icon={CircleUserRound}
                  label="我的工作"
                  testId="cloud-my-work"
                  selected={rootView === 'my-work'}
                  onClick={() => {
                    setIssueComposerOpen(false)
                    setRootView('my-work')
                    selectProject(null)
                  }}
                />
                <DesktopSidebarNavItem
                  icon={Settings}
                  label={t('workbench.project_settings_title')}
                  testId="cloud-project-settings"
                  selected={rootView === 'settings'}
                  onClick={() => {
                    setIssueComposerOpen(false)
                    setRootView('settings')
                    selectProject(null)
                    setSelectedItem(null)
                  }}
                />
              </nav>
              <div className="mt-6 flex h-[30px] items-center px-2.5 text-xs font-medium text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
                {t('todo.boards', '看板')}
                <Tooltip
                  label={t('todo.new_project_space', '新建项目空间')}
                  side="bottom"
                  align="end"
                  className="ml-auto"
                >
                  <button
                    type="button"
                    data-testid="cloud-project-add"
                    onClick={() => setCreateProjectOpen(true)}
                    className="h-6 w-6 rounded-md hover:bg-muted"
                    aria-label={t('todo.new_project_space', '新建项目空间')}
                  >
                    <Plus className="mx-auto h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
                {projects.map(project => {
                  const ProjectLocationIcon = project.location === 'local' ? HardDrive : Cloud
                  const spaceKey = projectSpaceKey(projectSpaceRef(project))
                  return (
                    <div
                      key={spaceKey}
                      data-cloud-project-menu-root
                      className={cn(
                        'group relative flex h-[30px] w-full items-center rounded-[10px] px-0 text-base leading-5',
                        rootView === 'projects' &&
                          sameProjectSpace(selectedProjectRef, projectSpaceRef(project))
                          ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
                          : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
                      )}
                    >
                      <button
                        type="button"
                        data-testid={`cloud-sidebar-project-${project.id}`}
                        onClick={() => {
                          setIssueComposerOpen(false)
                          selectProject(project)
                          setRootView('projects')
                          setProjectView('board')
                          setSelectedItem(null)
                        }}
                        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-base"
                      >
                        <ProjectLocationIcon className="h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))]" />
                        <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                      </button>
                      {projectCounts[spaceKey] ? (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-xs text-[rgb(var(--color-sidebar-text-muted))] group-hover:hidden">
                          {projectCounts[spaceKey]}
                        </span>
                      ) : null}
                      <Tooltip
                        label={t('todo.project_actions', '项目操作')}
                        side="bottom"
                        align="end"
                      >
                        <button
                          type="button"
                          data-testid={`cloud-sidebar-project-more-${project.id}`}
                          onClick={() => {
                            setProjectMenuId(current =>
                              current === project.id ? null : project.id
                            )
                          }}
                          className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-muted))] transition hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] focus:flex group-hover:flex"
                          aria-expanded={projectMenuId === project.id}
                          aria-label={t('todo.project_actions', '项目操作')}
                        >
                          <Ellipsis className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                      {projectMenuId === project.id ? (
                        <div
                          data-testid={`cloud-sidebar-project-menu-${project.id}`}
                          role="menu"
                          className="absolute right-0 top-8 z-30 w-36 rounded-lg border border-border bg-background p-1 shadow-md"
                        >
                          {project.created_by_user_id === user.id ||
                          project.access_role === 'Owner' ||
                          project.access_role === 'Maintainer' ? (
                            <>
                              <button
                                type="button"
                                data-testid={`cloud-sidebar-rename-project-${project.id}`}
                                onClick={() => {
                                  setRenameProject(project)
                                  setRenameProjectName(project.name)
                                  setRenameError(null)
                                  setProjectMenuId(null)
                                }}
                                role="menuitem"
                                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
                              >
                                <span className="w-3.5 text-center" aria-hidden="true">
                                  Aa
                                </span>
                                修改项目名称
                              </button>
                              <button
                                type="button"
                                data-testid={`cloud-sidebar-archive-project-${project.id}`}
                                onClick={() => {
                                  setArchiveError(null)
                                  setArchiveProject(project)
                                  setProjectMenuId(null)
                                }}
                                role="menuitem"
                                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-red-600 hover:bg-muted"
                              >
                                <span className="w-3.5 text-center" aria-hidden="true">
                                  ×
                                </span>
                                归档项目
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            data-testid={`cloud-sidebar-copy-project-id-${project.id}`}
                            onClick={() => {
                              void copyTextToClipboard(String(project.id)).then(() => {
                                setCopiedProjectId(project.id)
                                window.setTimeout(() => setCopiedProjectId(null), 2000)
                              })
                              setProjectMenuId(null)
                            }}
                            role="menuitem"
                            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
                          >
                            {copiedProjectId === project.id ? (
                              <Check className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                            {copiedProjectId === project.id
                              ? t('todo.project_id_copied', '项目 ID 已复制')
                              : t('todo.copy_project_id', '复制项目 ID')}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
              {onOpenSettings && onLogout ? (
                <DesktopSidebarAccount
                  user={user}
                  onOpenSettings={onOpenSettings}
                  onLogout={onLogout}
                />
              ) : null}
            </div>
          </aside>
        ) : null}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {!embedded && !selectedProject && (
            <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
          )}
          {!embedded && sidebarCollapsed && (
            <div
              data-testid="cloud-todo-collapsed-chrome-controls"
              className="absolute left-2 top-0 z-20 flex h-[38px] items-center gap-1"
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
              projectMembers={projectMembers}
              initialLocalProjectId={selectedLocalProject?.id ?? null}
              presentation={issueComposerPresentation}
              busy={issueComposerBusy}
              error={issueComposerError}
              onCancel={() => setIssueComposerOpen(false)}
              onCreate={createIssue}
            />
          ) : rootView === 'settings' ? (
            <ProjectSpaceSettings
              deviceApi={services.deviceApi}
              projects={projects}
              projectServices={services.projectSpaceDetailServices}
            />
          ) : rootView === 'my-work' ? (
            <CloudMyWorkView items={myWork} onSelectItem={openMyWorkItem} />
          ) : !selectedProject && projects.length === 0 && localProjectsError ? (
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
          ) : (projectSpaceApis.local ? localProjectsLoading : cloudProjectsLoading) ? (
            <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
              正在加载项目空间…
            </div>
          ) : !selectedProject && projects.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center">
              <Cloud className="h-8 w-8 text-text-muted" />
              <h1 className="mt-4 text-heading-md font-semibold">创建第一个项目空间</h1>
              <p className="mt-2 text-sm text-text-muted">
                共享任务、文件与交付，让成员和 AI 在不同本地工作区协作。
              </p>
              <button
                type="button"
                onClick={() => setCreateProjectOpen(true)}
                className="mt-5 h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background"
              >
                新建项目空间
              </button>
            </div>
          ) : !selectedProject ? (
            <CloudProjectsHome
              projects={projects}
              projectCounts={projectCounts}
              projectMembers={projectMembers}
              projectItems={projectItems}
              myWork={myWork}
              searchQuery=""
              onCreateProject={() => setCreateProjectOpen(true)}
              onSelectProject={selectProject}
              onManageProject={project => {
                selectProject(project)
                setProjectView('manage')
              }}
              onSelectItem={item => {
                if (item.can_view_detail !== false) setSelectedItem(item)
              }}
              onOpenMyWork={() => setRootView('my-work')}
            />
          ) : (
            <>
              <header
                ref={projectHeaderRef}
                data-testid="cloud-project-header"
                className={cn(
                  'relative z-10 flex h-[52px] shrink-0 items-center border-b border-border bg-background pr-6',
                  !embedded && sidebarCollapsed ? 'pl-[240px]' : 'pl-6'
                )}
              >
                {!embedded && (
                  <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />
                )}
                <div
                  ref={projectHeaderContentRef}
                  data-testid="cloud-project-header-title"
                  className={cn(
                    'relative z-10 min-w-0 items-center',
                    projectHeaderLevel < 2 ? 'flex' : 'hidden'
                  )}
                >
                  {embedded ? (
                    <Grid3X3 className="h-4 w-4 shrink-0 text-text-muted" />
                  ) : selectedProject.location === 'local' ? (
                    <HardDrive className="h-4 w-4 shrink-0 text-text-muted" />
                  ) : (
                    <Cloud className="h-4 w-4 shrink-0 text-text-muted" />
                  )}
                  {embedded ? (
                    <span className="ml-2 min-w-0 truncate text-base font-semibold">
                      {t('workbench.work_items', '工作空间')}
                    </span>
                  ) : (
                    <span className="ml-2 min-w-0 truncate text-base font-semibold">
                      {selectedProject.name}
                    </span>
                  )}
                </div>
                {projectHeaderLevel < 2 ? (
                  <nav
                    ref={projectHeaderTabsRef}
                    className="electron-titlebar-interactive-region relative z-10 ml-8 flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
                  >
                    <button
                      type="button"
                      data-testid="cloud-project-board-view"
                      onClick={() => setProjectView('board')}
                      className={cn(
                        'rounded-md px-3.5 py-1 text-sm',
                        projectView === 'board'
                          ? 'bg-background font-medium text-text-primary shadow-sm'
                          : 'text-text-secondary hover:text-text-primary'
                      )}
                    >
                      看板
                    </button>
                    {isAITableProject && aitableApi ? (
                      <button
                        type="button"
                        data-testid="cloud-project-table-view"
                        onClick={() => setProjectView('table')}
                        className={cn(
                          'rounded-md px-3.5 py-1 text-sm',
                          projectView === 'table'
                            ? 'bg-background font-medium text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        数据视图
                      </button>
                    ) : null}
                    {selectedProject.access_role !== 'RestrictedAnalyst' && (
                      <button
                        type="button"
                        data-testid="cloud-project-files-view"
                        onClick={() => setProjectView('files')}
                        className={cn(
                          'rounded-md px-3.5 py-1 text-sm',
                          projectView === 'files'
                            ? 'bg-background font-medium text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        文件
                      </button>
                    )}
                    {selectedProject.access_role !== 'RestrictedAnalyst' &&
                    selectedProjectAutomationSupported ? (
                      <button
                        type="button"
                        data-testid="cloud-project-automation-view"
                        onClick={() => setProjectView('automation')}
                        className={cn(
                          'rounded-md px-3.5 py-1 text-sm',
                          projectView === 'automation'
                            ? 'bg-background font-medium text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        自动化
                      </button>
                    ) : null}
                    {['Owner', 'Maintainer'].includes(selectedProject.access_role ?? 'Owner') && (
                      <button
                        type="button"
                        data-testid="cloud-project-manage-view"
                        onClick={() => setProjectView('manage')}
                        className={cn(
                          'rounded-md px-3.5 py-1 text-sm',
                          projectView === 'manage'
                            ? 'bg-background font-medium text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        管理
                      </button>
                    )}
                  </nav>
                ) : (
                  <span
                    ref={projectHeaderTabsRef}
                    className="electron-titlebar-interactive-region relative z-10 ml-2 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary"
                  >
                    <select
                      aria-label="视图切换"
                      value={projectView}
                      onChange={event => setProjectView(event.target.value as ProjectView)}
                      className="h-8 cursor-pointer bg-transparent text-xs outline-none"
                    >
                      <option value="board">看板</option>
                      {isAITableProject && aitableApi ? (
                        <option value="table">数据视图</option>
                      ) : null}
                      {selectedProject.access_role !== 'RestrictedAnalyst' ? (
                        <option value="files">文件</option>
                      ) : null}
                      {selectedProject.access_role !== 'RestrictedAnalyst' &&
                      selectedProjectAutomationSupported ? (
                        <option value="automation">自动化</option>
                      ) : null}
                      {['Owner', 'Maintainer'].includes(selectedProject.access_role ?? 'Owner') ? (
                        <option value="manage">管理</option>
                      ) : null}
                    </select>
                    <ChevronDown className="h-3 w-3" />
                  </span>
                )}
                <span className="flex-1" />
                {selectedProject && !projectAssistantOpen && projectHeaderLevel < 2 ? (
                  <Tooltip label={t('workbench.project_chat')} side="bottom" align="end">
                    <button
                      ref={projectHeaderAskAiRef}
                      type="button"
                      data-testid="cloud-project-ask-ai"
                      aria-label={t('workbench.project_chat')}
                      onClick={openProjectAssistant}
                      className="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition hover:bg-muted"
                    >
                      <Bot className="h-3.5 w-3.5" />
                      {projectHeaderLevel < 1 ? t('workbench.project_chat') : null}
                    </button>
                  </Tooltip>
                ) : null}
                {projectView === 'board' && projectHeaderLevel < 2 && (
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
                        ref={projectHeaderSearchRef}
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
                        {projectHeaderLevel < 1
                          ? boardParent || isMyTasksBoard
                            ? t('todo.search_tasks', '搜索任务')
                            : t('todo.search_issues', '搜索 Issue')
                          : null}
                      </button>
                    </Tooltip>
                    {canCreateBoardTask && (
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
                          ref={projectHeaderAddRef}
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
                          {projectHeaderLevel < 1
                            ? boardParent || isMyTasksBoard
                              ? t('todo.new_task', '新建任务')
                              : t('todo.new_issue', '新建 Issue')
                            : null}
                        </button>
                      </Tooltip>
                    )}
                  </>
                )}
                {projectHeaderLevel >= 2 && (!projectAssistantOpen || projectView === 'board') ? (
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
                {projectView === 'board' && projectHeaderLevel >= 2 && canCreateBoardTask ? (
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
                {projectView === 'board' && projectSearchOpen ? (
                  <TaskSearchPanel
                    items={boardItems}
                    members={selectedProjectKey ? (projectMembers[selectedProjectKey] ?? []) : []}
                    query={projectSearchQuery}
                    filters={projectSearchFilters}
                    tags={availableTags}
                    onQueryChange={setProjectSearchQuery}
                    onFiltersChange={setProjectSearchFilters}
                    onSelect={item => {
                      if (item.can_view_detail === false) return
                      setSelectedItem(item)
                      setProjectSearchOpen(false)
                    }}
                  />
                ) : null}
              </header>
              {projectView === 'files' && selectedProjectApi ? (
                <CloudFilesView api={selectedProjectApi} project={selectedProject} />
              ) : projectView === 'table' && isAITableProject && aitableApi ? (
                <AITableView api={aitableApi} project={selectedProject} />
              ) : projectView === 'automation' &&
                selectedProjectAutomationSupported &&
                selectedProjectApi &&
                selectedProjectServices ? (
                <ProjectAutomationView
                  key={selectedProject.id}
                  api={selectedProjectApi}
                  projectChatAgentApi={selectedProjectAgentApi}
                  projectAutomationApi={selectedProjectServices?.projectAutomationApi}
                  runtimeProfileApi={selectedProjectServices?.runtimeProfileApi}
                  executionApi={automationExecutionApi}
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
                    selectedProjectKey ? (projectMembers[selectedProjectKey] ?? []) : []
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
              ) : projectView === 'manage' && selectedProjectApi ? (
                <CloudProjectManageView
                  api={selectedProjectApi}
                  aitableApi={aitableApi}
                  dwsApi={services.dwsApi}
                  incomingHookApi={selectedProjectServices?.projectIncomingHookApi}
                  project={selectedProject}
                  boardCardDisplay={boardCardDisplay}
                  onProjectUpdated={updated => replaceProject(selectedProject, updated)}
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col pb-6 pt-4">
                  {isAITableProject ? (
                    <div className="flex shrink-0 items-center gap-2 px-6 pb-3">
                      <AITableGroupFieldPicker
                        fields={aitableFields}
                        value={aitableGroupFieldId}
                        onChange={fieldId => {
                          setAitableGroupFieldId(fieldId)
                          setAitableGroupFilter('')
                        }}
                      />
                      <span className="relative inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs text-text-secondary">
                        {aitableGroupFilter || `全部${selectedGroupField?.name ?? '记录'}`}
                        <ChevronDown className="ml-2 h-3 w-3" />
                        <select
                          data-testid="dingtalk-board-assignee-filter"
                          value={aitableGroupFilter}
                          onChange={event => setAitableGroupFilter(event.target.value)}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          aria-label="分组值筛选"
                        >
                          <option value="">全部</option>
                          {aitableGroupValues.map(name => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </span>
                      <label className="flex h-8 min-w-52 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-text-muted focus-within:border-focus">
                        <Search className="h-3.5 w-3.5" />
                        <input
                          data-testid="dingtalk-board-search"
                          value={aitableBoardQuery}
                          onChange={event => setAitableBoardQuery(event.target.value)}
                          placeholder="搜索记录"
                          className="min-w-0 flex-1 bg-transparent text-text-primary outline-none"
                        />
                      </label>
                      <span className="ml-auto text-xs text-text-muted">
                        数据由钉钉托管 · AI 可直接管理
                      </span>
                    </div>
                  ) : (
                    <div
                      data-testid="cloud-board-toolbar"
                      className="scrollbar-none flex shrink-0 items-center gap-2 overflow-x-auto overscroll-x-contain px-6 pb-3"
                    >
                      {isMyTasksBoard && localProjectOptions.length > 0 ? (
                        <label className="relative inline-flex h-8 min-w-40 shrink-0 cursor-pointer items-center rounded-lg border border-border bg-background pl-3 pr-8 text-xs font-medium text-text-primary hover:bg-muted">
                          <span className="sr-only">
                            {t('todo.local_project_filter', '本地项目')}
                          </span>
                          <span className="pointer-events-none min-w-0 truncate">
                            {t('todo.project_with_name', '项目：{{project}}', {
                              project:
                                activeLocalProjectFilter === 'all'
                                  ? t('todo.all_local_projects', '全部项目')
                                  : (selectedLocalProject?.name ??
                                    t('todo.select_local_project', '选择项目')),
                            })}
                          </span>
                          <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-text-muted" />
                          <select
                            data-testid="cloud-local-project-filter"
                            aria-label={t('todo.local_project_filter', '本地项目')}
                            value={activeLocalProjectFilter}
                            onChange={event => {
                              setQuickCreateStatus(null)
                              setLocalProjectFilter(event.target.value)
                            }}
                            className="absolute inset-0 cursor-pointer opacity-0"
                          >
                            <option value="all">{t('todo.all_local_projects', '全部项目')}</option>
                            {localProjectOptions.map(project => (
                              <option key={project.id} value={project.id}>
                                {project.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      <AITableGroupFieldPicker
                        fields={nativeBoardGroupFields}
                        value={nativeGroupBy}
                        testIdPrefix="cloud-board-group"
                        searchPlaceholder="搜索分组字段"
                        onChange={fieldId => savePersonalGroupBy(fieldId as NativeBoardGroupBy)}
                      />
                      <label className="relative inline-flex h-8 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted">
                        <span data-testid="cloud-board-group-filter-label">
                          {nativeGroupFilter
                            ? boardColumns.find(column => column.key === nativeGroupFilter)?.label
                            : `全部${nativeBoardGroupFields.find(field => field.id === nativeGroupBy)?.name ?? '任务'}`}
                        </span>
                        <ChevronDown className="ml-2 h-3 w-3" />
                        <select
                          data-testid="cloud-board-group-filter"
                          value={nativeGroupFilter}
                          onChange={event => setNativeGroupFilter(event.target.value)}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          aria-label="分组值筛选"
                        >
                          <option value="">全部</option>
                          {boardColumns.map(column => (
                            <option key={column.key} value={column.key}>
                              {column.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex h-8 min-w-52 shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-text-muted focus-within:border-focus">
                        <Search className="h-3.5 w-3.5" />
                        <input
                          data-testid="cloud-board-search"
                          value={nativeBoardQuery}
                          onChange={event => setNativeBoardQuery(event.target.value)}
                          placeholder={
                            boardParent
                              ? t('todo.search_tasks', '搜索任务')
                              : t('todo.search_issues', '搜索 Issue')
                          }
                          className="min-w-0 flex-1 bg-transparent text-text-primary outline-none"
                        />
                      </label>
                      {personalGroupKey && localStorage.getItem(personalGroupKey) ? (
                        <button
                          type="button"
                          data-testid="cloud-board-save-global"
                          disabled={
                            groupScopeBusy ||
                            !['Owner', 'Maintainer'].includes(
                              selectedProject.access_role ?? 'Owner'
                            )
                          }
                          onClick={() => void saveGlobalGroupBy()}
                          className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-border bg-background px-3 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
                        >
                          应用到全局
                        </button>
                      ) : null}
                    </div>
                  )}
                  <nav
                    data-testid="cloud-todo-board-breadcrumb"
                    aria-label="任务层级"
                    className="px-6"
                  >
                    {boardParent ? (
                      <>
                        <div className="flex h-7 items-center gap-1 text-xs">
                          <button
                            type="button"
                            onClick={() => setBoardParentId(null)}
                            className="rounded-lg px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                          >
                            Issue
                          </button>
                          {boardBreadcrumb.map(parent => (
                            <span key={parent.id} className="flex min-w-0 items-center gap-1">
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                              <button
                                type="button"
                                data-testid={`cloud-todo-board-breadcrumb-${parent.id}`}
                                onClick={() => setBoardParentId(parent.id)}
                                className={cn(
                                  'max-w-48 truncate rounded-lg px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary',
                                  parent.id === boardParentId && 'font-medium text-text-primary'
                                )}
                              >
                                {parent.title}
                              </button>
                            </span>
                          ))}
                        </div>
                        <div className="flex items-baseline gap-3 px-2 pb-3.5 pt-1.5">
                          <h1 className="text-heading-sm font-semibold">{boardParent.title}</h1>
                          <span className="text-xs text-text-muted">
                            {boardLayerCount} 个任务 · 仅显示当前层的直接子任务
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-baseline gap-3 px-2 pb-3.5 pt-1.5">
                        <h1 className="text-heading-sm font-semibold">
                          {isMyTasksBoard ? '任务' : isAITableProject ? '父任务' : 'Issue'}
                        </h1>
                        <span className="text-xs text-text-muted">
                          {boardLayerCount}{' '}
                          {isMyTasksBoard ? '个任务' : isAITableProject ? '条记录' : '个 Issue'}
                        </span>
                      </div>
                    )}
                  </nav>
                  {quickStartStorageKey &&
                  !boardItemsLoading &&
                  !isAITableProject &&
                  !boardParent &&
                  nativeGroupBy === 'status' &&
                  !nativeGroupFilter &&
                  !nativeBoardQuery.trim() ? (
                    <BoardQuickStartGuide
                      key={quickStartStorageKey}
                      storageKey={quickStartStorageKey}
                      itemKind={isMyTasksBoard ? 'task' : 'issue'}
                      hasCreatedItem={rootBoardItems.length > 0}
                      hasAdvancedItem={rootBoardItems.some(item => item.status !== 'inbox')}
                      detailOpened={quickStartDetailOpened}
                      onCreateItem={() => openIssueCreation()}
                      onOpenFirstItem={() => {
                        if (firstRootBoardItem?.can_view_detail !== false) {
                          setSelectedItem(firstRootBoardItem)
                        }
                      }}
                    />
                  ) : null}
                  {isAITableProject && dingtalkAuthPrompt && !boardItemsLoading ? (
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
                  ) : null}
                  {boardItemsLoading ? (
                    <div className="min-h-0 flex-1 overflow-x-auto">
                      <CloudTodoBoardSkeleton />
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-x-auto">
                      <DndContext
                        sensors={boardSensors}
                        collisionDetection={boardCollisionDetection}
                        onDragStart={event => setActiveDragItemId(String(event.active.id))}
                        onDragCancel={() => setActiveDragItemId(null)}
                        onDragEnd={finishBoardDrop}
                      >
                        <div className="flex h-full min-h-0 items-start gap-3.5 px-6">
                          {boardColumns.map(column => {
                            const columnItems = boardItems.filter(
                              item =>
                                item.parent_id === boardParentId &&
                                (!isMyTasksBoard ||
                                  activeLocalProjectFilter === 'all' ||
                                  !selectedLocalProject ||
                                  localProjectIdForItem(item) === selectedLocalProject?.id ||
                                  (item.status === 'inbox' &&
                                    localProjectIdForItem(item) === null)) &&
                                (!isAITableProject ||
                                  !column.groupValue ||
                                  (column.groupValue === '未设置'
                                    ? !aitableCellLabels(item.source_cells?.[aitableGroupFieldId])
                                        .length
                                    : aitableCellLabels(
                                        item.source_cells?.[aitableGroupFieldId]
                                      ).includes(column.groupValue))) &&
                                (isAITableProject ||
                                  (nativeGroupBy === 'status'
                                    ? item.status === column.status
                                    : nativeGroupBy === 'priority'
                                      ? item.priority === column.groupValue
                                      : nativeGroupBy === 'assignee'
                                        ? itemMatchesAssigneeGroup(item, column.groupValue)
                                        : column.groupValue
                                          ? (item.tags ?? []).includes(column.groupValue)
                                          : !(item.tags ?? []).length)) &&
                                (isAITableProject ||
                                  !nativeGroupFilter ||
                                  column.key === nativeGroupFilter) &&
                                (isAITableProject ||
                                  !nativeBoardQuery.trim() ||
                                  `${item.title} ${item.description ?? ''}`
                                    .toLowerCase()
                                    .includes(nativeBoardQuery.trim().toLowerCase())) &&
                                (!aitableGroupFilter || column.groupValue === aitableGroupFilter) &&
                                (!aitableBoardQuery.trim() ||
                                  `${item.title} ${item.description ?? ''}`
                                    .toLowerCase()
                                    .includes(aitableBoardQuery.trim().toLowerCase()))
                            )
                            const canCreateInColumn =
                              column.status === 'inbox' || column.status === 'pending'
                            const canQuickCreateInColumn = column.status === 'inbox'
                            const emptyHint =
                              boardParent || isMyTasksBoard
                                ? taskColumnEmptyHints[column.status]
                                : issueColumnEmptyHints[column.status]
                            const emptyActionLabel =
                              column.status === 'inbox'
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
                                  )
                            const openColumnCreation = () => {
                              if (!boardParent && column.status === 'pending') {
                                openIssueCreation('pending', '', 'popup')
                                return
                              }
                              setQuickCreateStatus(column.status)
                            }
                            return (
                              <section
                                key={column.key}
                                data-testid={`cloud-todo-column-${column.key}`}
                                className={cn(
                                  'group flex max-h-full w-[292px] shrink-0 flex-col rounded-2xl bg-muted p-0.5',
                                  // While a drag is active, outline every column with a dashed
                                  // border at its natural (content) height so each one reads as
                                  // a potential drop target without any layout shift.
                                  activeDragItemId !== null &&
                                    'outline-dashed outline-1 -outline-offset-1 outline-border'
                                )}
                              >
                                <header className="flex items-center justify-between px-2.5 pb-2 pt-1.5">
                                  <span className="flex min-w-0 items-center">
                                    <span
                                      className={cn('mr-2 h-2 w-2 rounded-full', column.dotClass)}
                                    />
                                    <span className="text-sm font-semibold">{column.label}</span>
                                    <span className="ml-2 text-xs text-text-muted">
                                      {columnItems.length}
                                    </span>
                                  </span>
                                  <span className="flex items-center gap-1">
                                    {isMyTasksBoard &&
                                    nativeGroupBy === 'status' &&
                                    column.status === 'completed' &&
                                    columnItems.length > 0 &&
                                    onArchiveRuntimeTask ? (
                                      <Tooltip
                                        label={t(
                                          'todo.archive_completed_tasks',
                                          '批量归档已完成任务'
                                        )}
                                        side="bottom"
                                        align="end"
                                      >
                                        <button
                                          type="button"
                                          data-testid="cloud-my-tasks-archive-completed"
                                          onClick={() => setRuntimeBatchArchiveItems(columnItems)}
                                          className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 group-hover:opacity-100"
                                          aria-label={t(
                                            'todo.archive_completed_tasks',
                                            '批量归档已完成任务'
                                          )}
                                        >
                                          <Archive className="h-3.5 w-3.5" />
                                        </button>
                                      </Tooltip>
                                    ) : null}
                                    {canCreateBoardTask &&
                                      !isAITableProject &&
                                      nativeGroupBy === 'status' &&
                                      canCreateInColumn && (
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
                                            onClick={openColumnCreation}
                                            className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 group-hover:opacity-100"
                                            aria-label={t(
                                              boardParent || isMyTasksBoard
                                                ? 'todo.new_task_in_column'
                                                : 'todo.new_issue_in_column',
                                              boardParent || isMyTasksBoard
                                                ? '在{{column}}中新建任务'
                                                : '在{{column}}中新建 Issue',
                                              { column: column.label }
                                            )}
                                          >
                                            <Plus className="h-3.5 w-3.5" />
                                          </button>
                                        </Tooltip>
                                      )}
                                  </span>
                                </header>
                                <TodoColumnDropzone
                                  status={column.key}
                                  dragHint={
                                    activeDragItemId && nativeGroupBy === 'status'
                                      ? columnDragHints[column.status]
                                      : undefined
                                  }
                                >
                                  {columnItems.map(item => (
                                    <CloudTodoBoardCard
                                      key={item.id}
                                      item={item}
                                      processingStatus={isProcessingStatus(item.status)}
                                      taskBindings={
                                        itemTaskBindingsProjectKey === selectedProjectKey
                                          ? (boardTaskBindings[item.id] ?? [])
                                          : []
                                      }
                                      onClick={() => {
                                        if (item.can_view_detail !== false) {
                                          setBackgroundTaskItemId(null)
                                          closeTaskPanel()
                                          setSelectedItem(item)
                                        }
                                      }}
                                      onConfigureExecution={() =>
                                        openExecutionConfiguration({
                                          item,
                                          continuation: { type: 'save' },
                                        })
                                      }
                                      onArchive={() => {
                                        setArchiveError(null)
                                        setArchiveItem(item)
                                      }}
                                      onOpenActivity={() => {
                                        if (item.can_view_detail === false) return
                                        const binding =
                                          boardTaskBindings[item.id]?.find(
                                            candidate => candidate.running
                                          ) ?? boardTaskBindings[item.id]?.[0]
                                        if (!binding) return
                                        setBackgroundTaskItemId(null)
                                        setSelectedItem(item)
                                        openTaskBinding({
                                          id: binding.id,
                                          device_id: binding.device_id,
                                          task_id: binding.task_id,
                                          task_title: binding.task_title,
                                          work_item_id: item.id,
                                        })
                                      }}
                                      display={boardCardDisplay}
                                      agentNames={agentNameById}
                                      dragDisabled={isAITableProject}
                                      previewDisabled={
                                        selectedItem !== null || activeDragItemId !== null
                                      }
                                      archiveDisabled={isAITableProject}
                                      changeRequestMonitor={changeRequestMonitor}
                                      onContinueChangeRequestRepair={
                                        workbench ? continueChangeRequestRepair : undefined
                                      }
                                    />
                                  ))}
                                  {isExternalGitBoard && externalPageCursors[column.status] ? (
                                    <button
                                      type="button"
                                      data-testid={`cloud-todo-column-load-more-${column.key}`}
                                      disabled={externalPageLoading[column.status]}
                                      onClick={() => void loadMoreExternalColumn(column.status)}
                                      className="flex h-8 w-full items-center justify-center rounded-lg border border-border bg-background text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-text-primary disabled:opacity-50"
                                    >
                                      {externalPageLoading[column.status]
                                        ? t('todo.loading_more_issues')
                                        : t('todo.load_more_issues')}
                                    </button>
                                  ) : null}
                                  {columnItems.length === 0 && emptyHint && (
                                    <>
                                      {canCreateInColumn ? (
                                        <button
                                          type="button"
                                          data-testid={`cloud-todo-column-empty-add-${column.key}`}
                                          onClick={openColumnCreation}
                                          className="flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border px-4 text-center text-text-muted transition hover:border-text-muted hover:bg-background hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
                                          aria-label={t(
                                            boardParent || isMyTasksBoard
                                              ? 'todo.new_task_in_column'
                                              : 'todo.new_issue_in_column',
                                            { column: column.label }
                                          )}
                                        >
                                          <Plus className="h-5 w-5" />
                                          <span className="text-sm font-medium text-text-secondary">
                                            {emptyActionLabel}
                                          </span>
                                          <span className="text-xs leading-4">{emptyHint}</span>
                                        </button>
                                      ) : (
                                        <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
                                          {emptyHint}
                                        </div>
                                      )}
                                    </>
                                  )}
                                </TodoColumnDropzone>
                                {canCreateBoardTask &&
                                  !isAITableProject &&
                                  nativeGroupBy === 'status' &&
                                  canQuickCreateInColumn &&
                                  quickCreateStatus === column.status && (
                                    <BoardQuickCreate
                                      key={`${selectedProjectKey}:${boardParentId ?? 'root'}:${column.key}`}
                                      columnKey={column.key}
                                      columnLabel={column.label}
                                      localProjects={
                                        isMyTasksBoard ? localProjectOptions : undefined
                                      }
                                      localProjectId={selectedLocalProject?.id}
                                      onLocalProjectChange={
                                        isMyTasksBoard
                                          ? projectId => setLocalProjectFilter(String(projectId))
                                          : undefined
                                      }
                                      onCancel={() => setQuickCreateStatus(null)}
                                      onCreate={title =>
                                        createTodoInBoardColumn(column.status, title)
                                      }
                                      onOpenFull={title =>
                                        boardParent
                                          ? openTodoCreation(boardParent, column.status, title)
                                          : openIssueCreation(column.status, title, 'popup')
                                      }
                                    />
                                  )}
                              </section>
                            )
                          })}
                        </div>
                        <DragOverlay dropAnimation={null}>
                          {activeDragItemId ? (
                            <div className="w-[272px] rotate-1 rounded-xl border border-border bg-background p-3 text-left shadow-lg">
                              <CloudTodoCardContent
                                item={items.find(item => item.id === activeDragItemId)!}
                                display={boardCardDisplay}
                                processingStatus={isProcessingStatus(
                                  items.find(item => item.id === activeDragItemId)!.status
                                )}
                                agentNames={agentNameById}
                              />
                            </div>
                          ) : null}
                        </DragOverlay>
                      </DndContext>
                    </div>
                  )}
                </div>
              )}
            </>
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
                await moveItem(
                  pending.item.id,
                  pending.continuation.columnKey,
                  pending.continuation.beforeItemId,
                  result
                )
              } else {
                await saveExecutionConfiguration(pending.item, result)
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
                    count={(itemTaskBindings[selectedItem.id] ?? []).length}
                    empty="暂无任务会话"
                  >
                    {(itemTaskBindings[selectedItem.id] ?? []).map(binding => {
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
            selectedItemApi ? (
              <TodoEditor
                key={selectedItem.id}
                mode="edit"
                presentation="workspace-panel"
                selectedTaskId={
                  selectedTaskBinding?.work_item_id === selectedItem.id
                    ? selectedTaskBinding.task_id
                    : null
                }
                api={selectedItemApi}
                projectChatAgentApi={selectedProjectAgentApi}
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
                  let inheritFromTask: RuntimeTaskAddress | null = null
                  const workflowNode = selectedItem.workflow?.nodes.find(
                    node => node.id === workflowNodeId
                  )
                  const stageContext = workflowNode
                    ? await selectedItemApi.getWorkflowStageContext(
                        selectedItem.id,
                        workflowNode.id
                      )
                    : null
                  if (
                    workflowNode?.workspace_policy === 'inherit' &&
                    workflowNode.depends_on.length > 0
                  ) {
                    const bindings = await selectedItemApi.listTaskBindings(selectedItem.id)
                    const predecessor = bindings.find(binding =>
                      workflowNode.depends_on.includes(binding.workflow_node_id ?? '')
                    )
                    if (predecessor) {
                      inheritFromTask = hydrateRuntimeTaskAddress(runtimeWork, {
                        deviceId: predecessor.device_id,
                        taskId: predecessor.task_id,
                      })
                    }
                  }
                  setBackgroundTaskItemId(null)
                  openTaskComposer({
                    workItemId: selectedItem.id,
                    initialInput: stageContext?.compiled_task_instruction ?? '',
                    backgroundAfterSend: false,
                    workflowNodeId,
                    inheritFromTask,
                  })
                }}
                onRunWorkflowNode={async (workflowNodeId, automationRuleId) => {
                  const automationApi = selectedProjectServices?.projectAutomationApi
                  if (!automationApi || !selectedItemProject) {
                    throw new Error(t('todo.workflow_action_failed', '节点操作失败'))
                  }
                  const refreshSelectedWorkflowItem = async () => {
                    const updated = await selectedItemApi.getLoopItem(selectedItem.id)
                    const locatedUpdated = {
                      ...updated,
                      project_store: selectedItem.project_store,
                    }
                    setItems(current =>
                      current.map(item => (item.id === locatedUpdated.id ? locatedUpdated : item))
                    )
                    setSelectedItem(locatedUpdated)
                    return locatedUpdated
                  }
                  try {
                    await automationApi.runWorkflowNode(
                      String(selectedItemProject.id),
                      selectedItem.id,
                      workflowNodeId,
                      automationRuleId
                    )
                    await refreshSelectedWorkflowItem()
                  } catch (error) {
                    setBoardRefreshNonce(value => value + 1)
                    const refreshed = await refreshSelectedWorkflowItem().catch(() => null)
                    const stageStatus = refreshed?.workflow?.nodes.find(
                      node => node.id === workflowNodeId
                    )?.status
                    if (stageStatus && ['queued', 'running'].includes(stageStatus)) return
                    throw error
                  }
                }}
                onCompleteWorkflowStage={async (workflowNodeId, action, reason, values) => {
                  const stage = selectedItem.workflow?.nodes.find(
                    node => node.id === workflowNodeId
                  )
                  if (values.length > 0) {
                    const bindings = await selectedItemApi.listTaskBindings(selectedItem.id)
                    const source = bindings
                      .filter(binding => binding.workflow_node_id === workflowNodeId)
                      .at(-1)
                    if (!source) throw new Error('当前阶段没有可关联的执行任务')
                    const delivery = await selectedItemApi.createDelivery(selectedItem.id, {
                      markdown: [
                        `# ${stage?.name ?? workflowNodeId} 阶段交付物`,
                        ...(stage?.required_deliverables ?? []).map(
                          requirement => `- ${requirement.name} (${requirement.value_type})`
                        ),
                      ].join('\n'),
                      source_task: {
                        deviceId: source.device_id,
                        taskId: source.task_id,
                      },
                    })
                    try {
                      const fulfillments = await uploadWorkflowDeliverables(
                        selectedItemApi,
                        delivery.id,
                        values
                      )
                      await selectedItemApi.finalizeDelivery(delivery.id, { fulfillments })
                    } catch (error) {
                      await selectedItemApi.discardDraft(delivery.id).catch(() => undefined)
                      throw error
                    }
                  }
                  if (action !== 'submit') {
                    await selectedItemApi.decideWorkflowNode(
                      selectedItem.id,
                      workflowNodeId,
                      action,
                      reason,
                      Number(user.id)
                    )
                  }
                  const updated = await selectedItemApi.getLoopItem(selectedItem.id)
                  const locatedUpdated = {
                    ...updated,
                    project_store: selectedItem.project_store,
                  }
                  setItems(current =>
                    current.map(item => (item.id === locatedUpdated.id ? locatedUpdated : item))
                  )
                  setSelectedItem(locatedUpdated)
                  setBoardRefreshNonce(value => value + 1)
                }}
                onDecideWorkflowNode={async (workflowNodeId, action, reason) => {
                  const updated = await selectedItemApi.decideWorkflowNode(
                    selectedItem.id,
                    workflowNodeId,
                    action,
                    reason,
                    Number(user.id)
                  )
                  const locatedUpdated = {
                    ...updated,
                    project_store: selectedItem.project_store,
                  }
                  setItems(current =>
                    current.map(item => (item.id === locatedUpdated.id ? locatedUpdated : item))
                  )
                  setSelectedItem(locatedUpdated)
                  setBoardRefreshNonce(value => value + 1)
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
                  setItems(current =>
                    current.map(item => (item.id === updated.id ? locatedUpdated : item))
                  )
                  setDetailItems(current =>
                    current.map(item => (item.id === updated.id ? locatedUpdated : item))
                  )
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
          projectItems={projectItems}
          projectMembers={projectMembers}
          query={globalSearchQuery}
          onQueryChange={setGlobalSearchQuery}
          onClose={() => setGlobalSearchOpen(false)}
          onSelectProject={project => {
            selectProject(project)
            setRootView('projects')
            setProjectView('board')
            setSelectedItem(null)
            setGlobalSearchOpen(false)
          }}
          onSelectItem={(project, item) => {
            if (item.can_view_detail === false) return
            selectProject(project)
            setRootView('projects')
            setProjectView('board')
            setSelectedItem({ ...item, project_store: project.project_store })
            setGlobalSearchOpen(false)
          }}
        />
      )}
      {createProjectOpen && (
        <ProjectDialog
          availableApis={availableProjectSpaceApis}
          defaultLocation={projectSpaceApis.defaultLocation}
          onClose={() => setCreateProjectOpen(false)}
          onCreated={(project, location) => {
            const locatedProject: LocatedCloudProject = {
              ...project,
              project_store: location === 'local' ? 'local' : 'backend',
              location,
            }
            const spaceKey = projectSpaceKey(projectSpaceRef(locatedProject))
            const projectApi = projectSpaceApis[location]
            prependProject(locatedProject)
            if (projectApi) {
              void projectApi
                .listCloudProjectMembers(project.id)
                .then(members =>
                  setProjectMembers(current => ({ ...current, [spaceKey]: members }))
                )
            }
            applyProjectSelection(locatedProject)
            onActiveProjectChange?.(locatedProject)
            setCreateProjectOpen(false)
          }}
        />
      )}
      {createTodoOpen && createTodoProject && createTodoApi && (
        <TodoEditor
          mode="create"
          api={createTodoApi}
          projectChatAgentApi={selectedProjectAgentApi}
          teamApi={services.teamApi}
          project={createTodoProject}
          initialParent={createTodoParent}
          initialStatus={createTodoStatus}
          initialTitle={createTodoInitialTitle}
          allItems={createTodoParent ? detailAllItems : items}
          onClose={() => {
            setCreateTodoOpen(false)
            setCreateTodoParent(null)
            setCreateTodoInitialTitle(undefined)
          }}
          onCreated={item => {
            const locatedItem = addCreatedTodo(item, createTodoProject)
            setCreateTodoOpen(false)
            setCreateTodoParent(null)
            setCreateTodoInitialTitle(undefined)
            if (item.assignee_agent_id || item.assignee_team_id) setSelectedItem(locatedItem)
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
      {(runtimeBatchArchiveItems || runtimeForceArchiveItems) && (
        <Modal
          title={
            runtimeForceArchiveItems
              ? t('todo.force_archive_completed_tasks_title', '强制归档已完成任务？')
              : t('todo.archive_completed_tasks_title', '归档已完成任务？')
          }
          onClose={() => {
            if (archiveBusy) return
            setRuntimeBatchArchiveItems(null)
            setRuntimeForceArchiveItems(null)
            setArchiveError(null)
          }}
        >
          <div className="px-5 pb-5 pt-4">
            <p className="text-sm leading-5 text-text-secondary">
              {runtimeForceArchiveItems
                ? t(
                    'todo.force_archive_completed_tasks_description',
                    '{{count}} 个任务的工作树包含未提交修改。强制归档会删除这些工作树目录。',
                    { count: runtimeForceArchiveItems.length }
                  )
                : t(
                    'todo.archive_completed_tasks_description',
                    '将从任务列表中归档 {{count}} 个已完成任务。归档后可在设置中恢复。',
                    { count: runtimeBatchArchiveItems?.length ?? 0 }
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
                  setRuntimeForceArchiveItems(null)
                  setArchiveError(null)
                }}
                className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid={
                  runtimeForceArchiveItems
                    ? 'cloud-my-tasks-force-archive-completed-confirm'
                    : 'cloud-my-tasks-archive-completed-confirm'
                }
                disabled={archiveBusy}
                onClick={() =>
                  void archiveCompletedItems(
                    runtimeForceArchiveItems ?? runtimeBatchArchiveItems ?? [],
                    runtimeForceArchiveItems ? { force: true } : undefined
                  )
                }
                className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {archiveBusy
                  ? t('todo.archiving', '归档中…')
                  : runtimeForceArchiveItems
                    ? t('todo.force_archive', '强制归档')
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
