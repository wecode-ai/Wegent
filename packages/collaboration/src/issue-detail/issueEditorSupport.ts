import { type CommentIssueActions, type IssueCommentBoardContext } from './issueCommentActions'
import { type ReactNode } from 'react'
import { localizeStandardStatuses, type CollaborationTranslate } from '../i18n'
import type { IssueDetailDraftValue } from './IssueDetailDraft'
import {
  type DueDateSourceContext,
  type IssueAssigneeTarget,
  type SharedIssueDetailAgent,
  type SharedIssueDetailCollaborator,
  type SharedIssueDetailCreateInput,
  type SharedIssueDetailDelivery,
  type SharedIssueDetailPort,
  type SharedIssueDetailTaskBinding,
  type SharedIssueDetailTaskExecutionState,
} from './index'
import type {
  CollaborationAssignment,
  CollaborationAttachment,
  CollaborationDefaultAssistant,
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
  CollaborationStatus,
} from '../types'
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}
export interface SharedEditorIssue extends CollaborationIssue {
  automation?: { trigger?: string } | null
  execution_error?: string | null
  source_record_id?: string | null
  source_cells?: Record<string, unknown>
}
export interface SharedEditorProject extends CollaborationProject {
  board_config?: {
    group_by: 'status' | 'priority' | 'assignee' | 'tag'
    processing_start_status_id: string | null
    statuses: CollaborationStatus[]
    schedule_view?: import('../types').CollaborationScheduleViewConfig
  }
}
export interface SharedEditorTeam {
  id: number
  name: string
  displayName?: string | null
  is_active?: boolean
}
export interface SharedIssueDetailExtensionContext {
  commentActions?: CommentIssueActions
  commentAssignment?: import('./useCommentAssignment').CommentAssignment
  item: SharedEditorIssue
  project: SharedEditorProject
  editable: boolean
  tasks: SharedIssueDetailTaskBinding[]
  deliveries: SharedIssueDetailDelivery[]
  members: CollaborationMember[]
  agents: SharedIssueDetailAgent[]
  selectedTaskId?: string | null
  onExecutionArtifactsChange(): Promise<void>
  onItemChange(item: SharedEditorIssue): void
}
export interface SharedIssueDetailExtensions {
  onSaveError?(error: unknown): void
  normalizeDescription?(value: string): string
  normalizePastedFiles?(files: File[]): Promise<File[]>
  dueDateInputType?: 'date' | 'datetime-local'
  startDateFromSource?(value: string | null): string
  startDateToSource?(value: string, context: DueDateSourceContext): string
  dueDateFromSource?(value: string | null): string
  dueDateToSource?(value: string, context: DueDateSourceContext): string
  isExecutionActive?(item: SharedEditorIssue): boolean
  openAttachment?(
    attachmentId: string,
    filename: string,
    contentType: string | null,
    sizeBytes: number
  ): Promise<void>
  renderDescriptionEditor?(context: {
    testId?: string
    value: string
    editable: boolean
    placeholder: string
    onChange(value: string): void
    onPasteFiles(files: File[]): Promise<string | null>
    readAttachment(attachmentId: string): Promise<Blob>
    onInlineAttachmentIdsChange(attachmentIds: string[]): void
  }): ReactNode
  renderActivity?(
    context: Omit<SharedIssueDetailExtensionContext, 'project'> & {
      project?: SharedEditorProject
    }
  ): ReactNode
  renderAITableFields?(context: {
    item: SharedEditorIssue
    project: SharedEditorProject
  }): ReactNode
  renderAssignmentReceipts?(item: SharedEditorIssue): ReactNode
  renderAssignmentHistory?(context: {
    anchor: HTMLElement | null
    entries: NonNullable<SharedEditorIssue['assignment_history']>
    members: CollaborationMember[]
    onClose(): void
  }): ReactNode
  renderStatusHistory?(context: {
    anchor: HTMLElement | null
    entries: NonNullable<SharedEditorIssue['status_history']>
    members: CollaborationMember[]
    onClose(): void
  }): ReactNode
  renderCreateOptions?(context: { saving: boolean }): ReactNode
  renderPersonalTaskAction?(context: {
    item: SharedEditorIssue
    tasks: SharedIssueDetailTaskBinding[]
    onCreateTask(): void
  }): ReactNode
}
export type TodoEditorPort = SharedIssueDetailPort
export type CloudLoopItem = SharedEditorIssue
export type CloudLoopItemAttachment = CollaborationAttachment
export type CloudLoopItemCollaborator = SharedIssueDetailCollaborator
export type CloudProject = SharedEditorProject
export const columns = [
  { status: 'inbox', label: '收集箱' },
  { status: 'pending', label: '待开始' },
  { status: 'in_progress', label: '进行中' },
  { status: 'in_review', label: '待确认' },
  { status: 'completed', label: '已完成' },
]
export function issueEditorStatuses(
  configured: CollaborationStatus[] | undefined,
  translate: CollaborationTranslate,
  noProject = false
): CollaborationStatus[] {
  if (configured) return localizeStandardStatuses(configured, translate)
  return columns
    .filter(({ status }) => !noProject || ['pending', 'in_progress', 'completed'].includes(status))
    .map(({ status, label }) => ({
      id: status,
      name: translate(`todo.status_${status}`, label),
      color: 'gray',
    }))
}

export function issuePriorityLabels(t: CollaborationTranslate) {
  return {
    none: t('todo.priority_none', '无'),
    low: t('todo.priority_low', '低'),
    medium: t('todo.priority_medium', '普通'),
    high: t('todo.priority_high', '高'),
    urgent: t('todo.priority_urgent', '紧急'),
  }
}
export const columnDotClasses: Record<string, string> = {
  inbox: 'bg-zinc-400',
  pending: 'bg-indigo-500',
  in_progress: 'bg-amber-500',
  in_review: 'bg-violet-500',
  completed: 'bg-emerald-500',
}
export function memberNameById(
  members: CollaborationMember[],
  userId: number | null
): string | null {
  return members.find(member => member.user_id === userId)?.user_name ?? null
}
export type AttachmentRow = Pick<
  CloudLoopItemAttachment,
  'id' | 'display_name' | 'content_type' | 'size_bytes' | 'removable'
>
export type TodoDraft = {
  title: string
  markdown: string
  priority: CloudLoopItem['priority']
  parentId: string
  startDate: string
  dueDate: string
  assigneeTarget: IssueAssigneeTarget
  milestoneId: string | null
  tags: string[]
}
export const todoDraftPriorities: CloudLoopItem['priority'][] = [
  'none',
  'low',
  'medium',
  'high',
  'urgent',
]
export function isIssueAssigneeTarget(value: unknown): value is IssueAssigneeTarget {
  if (value === '') return true
  if (typeof value !== 'string') return false
  if (/^user:\d+$/.test(value) || /^team:\d+$/.test(value)) return true
  return /^(agent|group|resource):.+$/.test(value)
}
export function todoDraftKey(
  projectId: CloudProject['id'],
  status: CloudLoopItem['status']
): string {
  return `wework-todo-draft:${projectId}:${status}`
}
export function readTodoDraft(key: string): TodoDraft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TodoDraft>
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      markdown: typeof parsed.markdown === 'string' ? parsed.markdown : '',
      milestoneId: typeof parsed.milestoneId === 'string' ? parsed.milestoneId : null,
      priority: todoDraftPriorities.includes(parsed.priority as CloudLoopItem['priority'])
        ? (parsed.priority as CloudLoopItem['priority'])
        : 'none',
      parentId: typeof parsed.parentId === 'string' ? parsed.parentId : '',
      startDate: typeof parsed.startDate === 'string' ? parsed.startDate : '',
      dueDate: typeof parsed.dueDate === 'string' ? parsed.dueDate : '',
      assigneeTarget: isIssueAssigneeTarget(parsed.assigneeTarget) ? parsed.assigneeTarget : '',
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
    }
  } catch {
    return null
  }
}
export function descendantIds(items: CloudLoopItem[], itemId: string): Set<string> {
  const result = new Set<string>()
  const pending = [itemId]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const item of items) {
      if (item.parent_id === current && !result.has(item.id)) {
        result.add(item.id)
        pending.push(item.id)
      }
    }
  }
  return result
}
export function todoDueDateFromSource(dueAt: string | null): string {
  return dueAt?.slice(0, 10) ?? ''
}
export const propChipClass =
  'task-detail-pill relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-3 py-1.5 text-xs text-text-primary transition hover:bg-muted'
export const overlayControlClass = 'absolute inset-0 h-full w-full cursor-pointer opacity-0'
export const avatarPalette = [
  'bg-blue-500',
  'bg-violet-500',
  'bg-orange-500',
  'bg-zinc-600',
  'bg-rose-500',
]
export function scheduleRangeLabel(
  startDate: string,
  dueDate: string,
  notSetLabel: string
): string {
  const compact = (value: string) => value.replace('T', ' ').slice(5)
  if (startDate && dueDate) {
    return `${compact(startDate)} → ${compact(dueDate)}`
  }
  if (startDate) return `${compact(startDate)} →`
  if (dueDate) return `→ ${compact(dueDate)}`
  return notSetLabel
}
interface IssueDraftFormProps {
  mode: 'create'
  initialParent: CloudLoopItem | null
  initialStatus: CloudLoopItem['status']
  initialTitle?: string
  initialTags?: string[]
  initialMilestoneId?: string
  draftScope?: string
}

export interface TodoEditorCreateProps extends IssueDraftFormProps {
  project: CloudProject
  draftForm?: never
  onCreated: (item: CloudLoopItem) => void | Promise<void>
  onCreateError?: (
    error: unknown,
    retry: (overrides?: Partial<SharedIssueDetailCreateInput>) => Promise<CloudLoopItem>
  ) => boolean | Promise<boolean>
}

export interface TodoEditorDraftFormProps extends IssueDraftFormProps {
  project?: CloudProject
  draftForm: {
    initial: IssueDetailDraftValue
    submit(draft: IssueDetailDraftValue): Promise<void>
    onDirtyChange?(dirty: boolean): void
    renderParticipants?(input: {
      assignee: IssueAssigneeTarget
      onAssign(assignee: IssueAssigneeTarget): void
      saving: boolean
    }): ReactNode
    beforeDescription?: ReactNode
    afterDescription?: ReactNode
    propertiesDisclosure?: { testId: string; label: string }
    propertyTestIds?: {
      status: string
      destinationStatus: string
      priority: string
      schedule: string
      due: string
    }
    destinationStatus?: {
      options: CollaborationStatus[]
      value: string
      onChange(value: string): void
    }
    scrollTestId?: string
    footerTestId?: string
    confirmTestId?: string
    confirmLabel?: string
    cancelTestId?: string
    onCancel?(): void
    titleTestId?: string
    descriptionTestId?: string
    heading?: string
  }
}
export interface TodoEditorEditProps {
  mode: 'edit'
  item: CloudLoopItem
  project?: CloudProject
  editable: boolean
  onUpdated: (item: CloudLoopItem) => void
  onAddChild?: () => void
}
export type TodoEditorProps = {
  commentBoard?: IssueCommentBoardContext
  port: TodoEditorPort
  extensions?: SharedIssueDetailExtensions
  translate?: (key: string, fallback?: string, options?: Record<string, string | number>) => string
  loadTeams?: () => Promise<SharedEditorTeam[]>
  currentUserId?: string | number
  currentAssignment?: CollaborationAssignment | null
  allItems: CloudLoopItem[]
  onClose: () => void
  onEscape?: () => void
  presentation?: 'modal' | 'workspace-panel' | 'embedded'
  workspacePanelFill?: boolean
  readFirst?: boolean
  showPanelControls?: boolean
  showFullscreenControl?: boolean
  showChildren?: boolean
  showCurrentTaskOnly?: boolean
  showAssignee?: boolean
  canAssign?: boolean
  onAddAssigneeMember?: () => void
  onAddAssigneeAgent?: () => void
  /**
   * Starting work is independent from editing the Issue. A visible Issue may
   * start a host execution even when its content is read-only.
   */
  canStartWork?: boolean
  defaultAssistant?: CollaborationDefaultAssistant
  taskRefreshKey?: string | number
  initialTaskBindings?: SharedIssueDetailTaskBinding[]
  /** Live execution states keyed by the stable task-binding id. */
  taskExecutionStates?: Readonly<Record<string, SharedIssueDetailTaskExecutionState>>
  /** Device display names keyed by the device ID stored in task bindings. */
  deviceNamesById?: Readonly<Record<string, string>>
  headerActions?: ReactNode
  issueActions?: readonly {
    id: string
    label: string
    onSelect(): void
    disabled?: boolean
    destructive?: boolean
  }[]
  issueActionsTestId?: string
  closeTestId?: string
  closeDisabled?: boolean
  panelExpansion?: {
    expanded: boolean
    onChange(expanded: boolean): void
    testId: string
  }
  detailActions?: ReactNode
  /** Render the host-provided destructive or lifecycle action in the menu. */
  onDelete?: () => void
  deleteLabel?: string
  selectedTaskId?: string | null
  linkedTaskAction?: (tasks: SharedIssueDetailTaskBinding[]) => ReactNode
  onCreateTask?: () => void
  onOpenTaskConversation?: (task: SharedIssueDetailTaskBinding) => void
  onOpenChildTask?: (task: CloudLoopItem) => void
  onOpenRelatedIssue?: (issue: CloudLoopItem) => void
  onWorkflowPlanChanged?: () => void | Promise<void>
} & (TodoEditorCreateProps | TodoEditorDraftFormProps | TodoEditorEditProps)
