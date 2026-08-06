import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ArrowLeft,
  Bot,
  Calendar,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleUserRound,
  Copy,
  Download,
  ArrowRight,
  File,
  FileText,
  Flag,
  Folder,
  Link2,
  ListTodo,
  Maximize2,
  Minimize2,
  Paperclip,
  Plus,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type {
  CloudLoopItem,
  CloudLoopItemAttachment,
  CloudLoopItemCollaborator,
  CloudProject,
  CloudProjectMember,
  Delivery,
  DeliveryDetail,
} from '@/api/deliveries'
import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import type { AITableApi } from '@/api/aitable'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { cn } from '@/lib/utils'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'
import { TagEditor } from './TagEditor'
import { normalizeTaskDescription } from './taskDescription'
import { AITableTaskFields } from './AITableTaskFields'
import { TaskActivityView } from './TaskActivityView'
import { markdownAttachmentRows } from './attachmentMarkdown'
import './task-detail-layout.css'
import {
  columnDotClasses,
  columns,
  memberAvatarClasses,
  memberNameById,
  priorityBadgeClasses,
} from './todoShared'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

function supportsAssignApi(api: DeliveryApi): boolean {
  return typeof (api as { assignLoopItem?: unknown }).assignLoopItem === 'function'
}

type AttachmentRow = Pick<CloudLoopItemAttachment, 'id' | 'display_name' | 'size_bytes'>

type TodoDraft = {
  title: string
  markdown: string
  priority: CloudLoopItem['priority']
  parentId: string
  dueDate: string
  tags: string[]
}

const todoDraftPriorities: CloudLoopItem['priority'][] = ['none', 'low', 'medium', 'high', 'urgent']

// Drafts are keyed per project and per lane so every swimlane keeps its own
// draft. File objects cannot be serialized, so staged attachments live in
// module memory under the same key.
const draftAttachmentStore = new Map<string, File[]>()

function todoDraftKey(projectId: CloudProject['id'], status: CloudLoopItem['status']): string {
  return `wework-todo-draft:${projectId}:${status}`
}

function readTodoDraft(key: string): TodoDraft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TodoDraft>
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      markdown: typeof parsed.markdown === 'string' ? parsed.markdown : '',
      priority: todoDraftPriorities.includes(parsed.priority as CloudLoopItem['priority'])
        ? (parsed.priority as CloudLoopItem['priority'])
        : 'none',
      parentId: typeof parsed.parentId === 'string' ? parsed.parentId : '',
      dueDate: typeof parsed.dueDate === 'string' ? parsed.dueDate : '',
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
    }
  } catch {
    return null
  }
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function descendantIds(items: CloudLoopItem[], itemId: string): Set<string> {
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

function appendAttachmentMarkdown(description: string, markdown: string): string {
  if (!markdown) return description
  return `${description.trimEnd()}\n\n${markdown}`.trim()
}

const propChipClass =
  'task-detail-pill relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-3 py-1.5 text-xs text-text-primary transition hover:bg-muted'
const overlayControlClass = 'absolute inset-0 h-full w-full cursor-pointer opacity-0'
const avatarPalette = [
  'bg-blue-500',
  'bg-violet-500',
  'bg-orange-500',
  'bg-zinc-600',
  'bg-rose-500',
]

function sourceCellText(cells: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!cells) return null
  for (const [key, value] of Object.entries(cells)) {
    const normalized = key.toLowerCase()
    if (!keys.some(candidate => normalized.includes(candidate))) continue
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
    if (Array.isArray(value)) {
      const text = value
        .map(entry => (typeof entry === 'string' || typeof entry === 'number' ? String(entry) : ''))
        .filter(Boolean)
        .join('、')
      if (text) return text
    }
  }
  return null
}

function tagByPattern(tags: string[], pattern: RegExp): string | null {
  return tags.find(tag => pattern.test(tag)) ?? null
}

function formatRailDueDate(dueAt: string | null | undefined, dueDate: string): string | null {
  if (!dueDate) return null
  const timeMatch = dueAt?.match(/[T ](\d{2}:\d{2})/)
  return `${dueDate.slice(5)} ${timeMatch?.[1] ?? '18:00'}`
}

function AvatarMark({
  name,
  index = 0,
  size = 'md',
}: {
  name: string
  index?: number
  size?: 'sm' | 'md'
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-background',
        size === 'md' ? 'h-6 w-6 text-xs' : 'h-6 w-6 text-xs',
        avatarPalette[index % avatarPalette.length]
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function RailProp({
  label,
  children,
  control,
  testId,
  clickable = Boolean(control),
  valueClassName,
}: {
  label: string
  children: ReactNode
  control?: ReactNode
  testId?: string
  clickable?: boolean
  valueClassName?: string
}) {
  return (
    <span
      data-testid={testId}
      className="task-detail-rail-prop relative flex min-w-0 items-center gap-2"
    >
      <span className="task-detail-rail-key w-[64px] shrink-0 text-xs font-medium leading-5 text-text-muted">
        {label}
      </span>
      <span
        className={cn(
          'task-detail-rail-value flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium leading-5 text-text-primary',
          clickable && 'group relative',
          valueClassName
        )}
      >
        {clickable ? (
          <span className="pointer-events-none absolute -inset-x-1.5 -inset-y-[3px] rounded-md transition group-hover:bg-muted" />
        ) : null}
        <span className="task-detail-rail-value-content relative flex min-w-0 items-center gap-1.5 truncate">
          {children}
        </span>
        {control}
      </span>
    </span>
  )
}

function TodoAttachmentSection({
  attachments,
  busy,
  error,
  editable,
  compactRail = false,
  onAdd,
  onOpen,
  onRemove,
}: {
  attachments: AttachmentRow[]
  busy: boolean
  error: string | null
  editable: boolean
  compactRail?: boolean
  onAdd: (files: FileList | null) => Promise<void>
  onOpen?: (attachment: AttachmentRow) => Promise<void>
  onRemove: (attachment: AttachmentRow) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const visibleRows = compactRail && !expanded ? attachments.slice(0, 2) : attachments
  const hasOverflow = compactRail && attachments.length > 2

  if (compactRail) {
    return (
      <section className={cn('task-detail-rail-section', dragging && 'is-dragging')}>
        <div className="task-detail-section-label">
          <h3>
            <Paperclip className="icon" />
            附件
          </h3>
          <span className="count">{attachments.length}</span>
          {editable && (
            <label className="add">
              {busy ? '上传中…' : '＋ 上传'}
              <input
                data-testid="cloud-todo-attachment-input"
                type="file"
                multiple
                disabled={busy}
                onChange={event => {
                  void onAdd(event.target.files)
                  event.target.value = ''
                }}
                className="sr-only"
              />
            </label>
          )}
        </div>
        {error && (
          <p className="task-detail-rail-error" role="alert">
            {error}
          </p>
        )}
        <div
          className={cn('task-detail-attachment-body', expanded && 'expanded-scroll')}
          onDragEnter={event => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragOver={event => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={event => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
            setDragging(false)
          }}
          onDrop={event => {
            event.preventDefault()
            setDragging(false)
            void onAdd(event.dataTransfer.files)
          }}
        >
          {attachments.length === 0 ? (
            <p className="task-detail-rail-empty">暂无附件</p>
          ) : (
            <div className="task-detail-rail-list">
              {visibleRows.map(attachment => (
                <div key={attachment.id} className="task-detail-rail-file group">
                  <span className="task-detail-rail-icon">
                    <File className="icon" />
                  </span>
                  <button
                    type="button"
                    data-testid={`cloud-todo-attachment-download-${attachment.id}`}
                    disabled={!onOpen}
                    onClick={() => {
                      if (onOpen) void onOpen(attachment)
                    }}
                    className="task-detail-rail-name text-left"
                    title={attachment.display_name}
                  >
                    {attachment.display_name}
                  </button>
                  <span className="task-detail-rail-meta">
                    {formatAttachmentSize(attachment.size_bytes)}
                  </span>
                  {editable && (
                    <button
                      type="button"
                      data-testid={`cloud-todo-attachment-delete-${attachment.id}`}
                      disabled={busy}
                      onClick={() => void onRemove(attachment)}
                      className="task-detail-rail-delete"
                      aria-label={`删除 ${attachment.display_name}`}
                    >
                      <Trash2 className="icon" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {editable && (
            <label className="task-detail-rail-dropzone">
              <Upload className="icon" />
              {busy ? '上传中…' : '点击上传或拖拽文件到这里'}
              <input
                type="file"
                multiple
                disabled={busy}
                onChange={event => {
                  void onAdd(event.target.files)
                  event.target.value = ''
                }}
                className="sr-only"
              />
            </label>
          )}
        </div>
        {hasOverflow && (
          <button
            type="button"
            className="task-detail-rail-more"
            onClick={() => setExpanded(current => !current)}
          >
            {expanded ? '收起' : `查看全部 ${attachments.length} 个`}
          </button>
        )}
      </section>
    )
  }

  return (
    <section>
      <span className="mb-3 flex select-none items-center gap-2 text-sm font-medium text-text-muted">
        <Paperclip className="h-4 w-4" />
        附件
        <span className="text-xs">{attachments.length}</span>
      </span>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {attachments.length > 0 && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {attachments.map(attachment => (
            <div
              key={attachment.id}
              className="group flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 transition hover:bg-muted"
            >
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600">
                <File className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {attachment.display_name}
                </span>
                <span className="block text-xs text-text-muted">
                  {formatAttachmentSize(attachment.size_bytes)}
                </span>
              </span>
              {onOpen && (
                <button
                  type="button"
                  data-testid={`cloud-todo-attachment-download-${attachment.id}`}
                  onClick={() => void onOpen(attachment)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-hover hover:text-text-primary group-hover:opacity-100"
                  aria-label={`下载 ${attachment.display_name}`}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}
              {editable && (
                <button
                  type="button"
                  data-testid={`cloud-todo-attachment-delete-${attachment.id}`}
                  disabled={busy}
                  onClick={() => void onRemove(attachment)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-hover hover:text-destructive group-hover:opacity-100 disabled:opacity-50"
                  aria-label={`删除 ${attachment.display_name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {editable && (
        <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-text-muted transition hover:bg-muted hover:text-text-secondary">
          <Upload className="h-4 w-4" />
          {busy ? '上传中…' : '点击上传或拖拽文件到这里'}
          <input
            data-testid="cloud-todo-attachment-input"
            type="file"
            multiple
            disabled={busy}
            onChange={event => {
              void onAdd(event.target.files)
              event.target.value = ''
            }}
            className="sr-only"
          />
        </label>
      )}
    </section>
  )
}

export interface TodoEditorCreateProps {
  mode: 'create'
  project: CloudProject
  initialParent: CloudLoopItem | null
  initialStatus: CloudLoopItem['status']
  onCreated: (item: CloudLoopItem) => void
}

export interface TodoEditorEditProps {
  mode: 'edit'
  item: CloudLoopItem
  project?: CloudProject
  onUpdated: (item: CloudLoopItem) => void
  onAddChild: () => void
  onStartConversation: () => void
}

export type TodoEditorProps = {
  api: DeliveryApi
  aitableApi?: AITableApi
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  projectChatClient?: ProjectChatClient
  currentUserId?: string | number
  allItems: CloudLoopItem[]
  onClose: () => void
} & (TodoEditorCreateProps | TodoEditorEditProps)

// Single panel for creating, viewing, and editing a todo. Create mode keeps a
// local draft and stages attachments until the item exists; edit mode loads the
// sections that require an item id (children, collaborators, executions,
// deliveries) and saves through a versioned update.
export function TodoEditor(props: TodoEditorProps) {
  const { api, allItems, onClose } = props
  const createProps = props.mode === 'create' ? props : null
  const editProps = props.mode === 'edit' ? props : null
  const isCreate = createProps !== null
  const item = editProps?.item ?? null
  const isAITableEdit = item !== null && editProps?.project?.task_provider === 'dingtalk_aitable'
  const project = createProps?.project ?? editProps?.project
  const statusOptions =
    project?.board_config?.statuses ??
    columns.map(column => ({ id: column.status, name: column.label, color: 'gray' as const }))

  const draftKey = createProps
    ? todoDraftKey(createProps.project.id, createProps.initialStatus)
    : null
  const [draft] = useState(() => (draftKey ? readTodoDraft(draftKey) : null))

  const [title, setTitle] = useState(item?.title ?? draft?.title ?? '')
  const normalizedItemDescription = normalizeTaskDescription(item?.description ?? '')
  const [description, setDescription] = useState(
    item ? normalizedItemDescription : (draft?.markdown ?? '')
  )
  const [status, setStatus] = useState<CloudLoopItem['status']>(
    item?.status ?? createProps?.initialStatus ?? 'inbox'
  )
  const [priority, setPriority] = useState<CloudLoopItem['priority']>(
    item?.priority ?? draft?.priority ?? 'none'
  )
  const [parentId, setParentId] = useState(
    item?.parent_id ?? draft?.parentId ?? createProps?.initialParent?.id ?? ''
  )
  const [dueDate, setDueDate] = useState(item?.due_at?.slice(0, 10) ?? draft?.dueDate ?? '')
  const [assigneeTarget, setAssigneeTarget] = useState(
    item?.assignee_agent_id
      ? `agent:${item.assignee_agent_id}`
      : item?.assignee_user_id
        ? `user:${item.assignee_user_id}`
        : ''
  )
  const [tags, setTags] = useState<string[]>(item?.tags ?? draft?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  // Track the item version the local editable state mirrors. External updates
  // (for example the project AI completing a run) bump the version; sync the
  // pristine fields in place instead of remounting the whole editor.
  const syncedItemRef = useRef<CloudLoopItem | null>(item)
  useEffect(() => {
    if (!item) return
    const previous = syncedItemRef.current
    if (previous && previous.id === item.id && previous.version === item.version) return
    const sameTask = previous?.id === item.id
    const previousAssigneeTarget = previous
      ? previous.assignee_agent_id
        ? `agent:${previous.assignee_agent_id}`
        : previous.assignee_user_id
          ? `user:${previous.assignee_user_id}`
          : ''
      : ''
    const nextAssigneeTarget = item.assignee_agent_id
      ? `agent:${item.assignee_agent_id}`
      : item.assignee_user_id
        ? `user:${item.assignee_user_id}`
        : ''
    const tagsMatch = (left: string[], right: string[]) =>
      left.length === right.length && left.every((tag, index) => tag === right[index])
    if (!sameTask || title === (previous?.title ?? '')) setTitle(item.title ?? '')
    if (!sameTask || description === normalizeTaskDescription(previous?.description ?? '')) {
      setDescription(normalizeTaskDescription(item.description ?? ''))
    }
    if (!sameTask || status === previous?.status) setStatus(item.status ?? 'inbox')
    if (!sameTask || priority === previous?.priority) setPriority(item.priority ?? 'none')
    if (!sameTask || parentId === (previous?.parent_id ?? '')) setParentId(item.parent_id ?? '')
    if (!sameTask || dueDate === (previous?.due_at?.slice(0, 10) ?? '')) {
      setDueDate(item.due_at?.slice(0, 10) ?? '')
    }
    if (!sameTask || assigneeTarget === previousAssigneeTarget) {
      setAssigneeTarget(nextAssigneeTarget)
    }
    if (!sameTask || tagsMatch(tags, previous?.tags ?? [])) setTags(item.tags ?? [])
    syncedItemRef.current = item
  }, [item, title, description, status, priority, parentId, dueDate, assigneeTarget, tags])
  // Tag autocomplete candidates: the project registry plus tags already used
  // by any item in the project.
  const tagSuggestions = Array.from(
    new Set([
      ...(createProps?.project.tags ?? editProps?.project?.tags ?? []),
      ...allItems.flatMap(candidate => candidate.tags ?? []),
    ])
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const [pendingFiles, setPendingFiles] = useState<File[]>(() =>
    draftKey ? (draftAttachmentStore.get(draftKey) ?? []) : []
  )

  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [selectedDelivery, setSelectedDelivery] = useState<DeliveryDetail | null>(null)
  const [tasks, setTasks] = useState<
    Array<{ id: number; device_id: string; task_id: string; task_title: string | null }>
  >([])
  const [attachments, setAttachments] = useState<CloudLoopItemAttachment[]>([])
  const [collaborators, setCollaborators] = useState<CloudLoopItemCollaborator[]>([])
  const [projectMembers, setProjectMembers] = useState<CloudProjectMember[]>([])
  const [projectAgents, setProjectAgents] = useState<ProjectChatAgent[]>([])
  const [addingCollaborator, setAddingCollaborator] = useState(false)
  const [selectedCollaboratorId, setSelectedCollaboratorId] = useState<number | null>(null)
  const [collaboratorBusy, setCollaboratorBusy] = useState(false)
  const [collaboratorError, setCollaboratorError] = useState<string | null>(null)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [expandedRailSections, setExpandedRailSections] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [fullScreen, setFullScreen] = useState(false)
  const detailScrollRef = useRef<HTMLDivElement>(null)

  const editItemId = item?.id ?? null
  const editProjectId = item?.cloud_project_id ?? null
  const createProjectId = createProps?.project.id ?? null
  const visibleAttachments = useMemo(() => {
    const merged = new Map<string, AttachmentRow>()
    markdownAttachmentRows(description).forEach(attachment => merged.set(attachment.id, attachment))
    attachments.forEach(attachment => merged.set(attachment.id, attachment))
    return Array.from(merged.values())
  }, [attachments, description])

  useEffect(() => {
    const node = detailScrollRef.current
    if (!node) return
    node.scrollTop = 0
  }, [editItemId, isCreate])

  // Edit mode loads everything tied to the item id.
  useEffect(() => {
    if (editItemId == null || editProjectId == null) return
    void Promise.all([
      api.listDeliveries(editItemId),
      api.listTaskBindings(editItemId),
      api.listLoopItemAttachments(editItemId),
      api.listLoopItemCollaborators(editItemId),
      api.listCloudProjectMembers(editProjectId),
      props.projectChatAgentApi?.list(String(editProjectId)) ?? Promise.resolve([]),
    ]).then(
      ([
        deliveryResponse,
        taskResponse,
        attachmentResponse,
        collaboratorResponse,
        memberResponse,
        agentResponse,
      ]) => {
        setDeliveries(deliveryResponse.items)
        setTasks(taskResponse)
        setAttachments(attachmentResponse)
        setCollaborators(collaboratorResponse)
        setProjectMembers(memberResponse)
        setProjectAgents(agentResponse.filter(agent => agent.status === 'active'))
      }
    )
  }, [api, editItemId, editProjectId, props.projectChatAgentApi])

  // Create mode only needs the member list for the assignee select.
  useEffect(() => {
    if (createProjectId == null) return
    void Promise.all([
      api.listCloudProjectMembers(createProjectId),
      props.projectChatAgentApi?.list(String(createProjectId)) ?? Promise.resolve([]),
    ]).then(([members, agents]) => {
      setProjectMembers(members)
      setProjectAgents(agents.filter(agent => agent.status === 'active'))
    })
  }, [api, createProjectId, props.projectChatAgentApi])

  // Persist the text draft on every edit; a fully cleared form removes it.
  useEffect(() => {
    if (!draftKey) return
    if (!title && !description && priority === 'none' && !parentId && !dueDate && !tags.length) {
      localStorage.removeItem(draftKey)
      return
    }
    const snapshot: TodoDraft = { title, markdown: description, priority, parentId, dueDate, tags }
    localStorage.setItem(draftKey, JSON.stringify(snapshot))
  }, [draftKey, title, description, priority, parentId, dueDate, tags])

  useEffect(() => {
    if (!draftKey) return
    if (pendingFiles.length > 0) draftAttachmentStore.set(draftKey, pendingFiles)
    else draftAttachmentStore.delete(draftKey)
  }, [draftKey, pendingFiles])

  const availableCollaborators = projectMembers.filter(
    member => !collaborators.some(collaborator => collaborator.user_id === member.user_id)
  )
  const excludedParentIds = item ? descendantIds(allItems, item.id) : new Set<string>()
  if (item) excludedParentIds.add(item.id)
  const parentOptions = allItems.filter(candidate => !excludedParentIds.has(candidate.id))
  const childItems = item ? allItems.filter(candidate => candidate.parent_id === item.id) : []
  const itemTags = item?.tags ?? []
  const tagsDirty =
    tags.length !== itemTags.length || tags.some((tag, index) => tag !== itemTags[index])
  const dirty = item
    ? title.trim() !== item.title ||
      description !== normalizedItemDescription ||
      status !== item.status ||
      priority !== item.priority ||
      parentId !== (item.parent_id ?? '') ||
      assigneeTarget !==
        (item.assignee_agent_id
          ? `agent:${item.assignee_agent_id}`
          : item.assignee_user_id
            ? `user:${item.assignee_user_id}`
            : '') ||
      dueDate !== (item.due_at?.slice(0, 10) ?? '') ||
      tagsDirty
    : false
  const hasDraftContent = Boolean(
    title ||
    description ||
    priority !== 'none' ||
    dueDate ||
    tags.length > 0 ||
    pendingFiles.length > 0
  )
  const pendingAttachmentRows: AttachmentRow[] = pendingFiles.map((file, index) => ({
    id: `pending-${index}`,
    display_name: file.name,
    size_bytes: file.size,
  }))
  const childRailExpanded = Boolean(expandedRailSections.children)
  const executionRailExpanded = Boolean(expandedRailSections.executions)
  const deliveryRailExpanded = Boolean(expandedRailSections.deliveries)
  const visibleRailChildren = childRailExpanded ? childItems : childItems.slice(0, 2)
  const visibleRailTasks = executionRailExpanded ? tasks : tasks.slice(0, 2)
  const visibleRailDeliveries = deliveryRailExpanded ? deliveries : deliveries.slice(0, 2)
  const toggleRailSection = (section: 'children' | 'executions' | 'deliveries') => {
    setExpandedRailSections(current => ({ ...current, [section]: !current[section] }))
  }
  const statusLabel = statusOptions.find(option => option.id === status)?.name ?? '未设置'
  const parentItem = allItems.find(candidate => candidate.id === parentId)
  const assignee = projectMembers.find(member => assigneeTarget === `user:${member.user_id}`)
  const assigneeAgent = projectAgents.find(agent => assigneeTarget === `agent:${agent.id}`)
  const canAssign = project
    ? project.access_role === 'Owner' || project.access_role === 'Maintainer'
    : false
  const creator =
    item?.created_by_user_name ||
    (item && item.created_by_user_id === editProps?.project?.current_user_id
      ? editProps.project.current_user_name
      : item
        ? memberNameById(projectMembers, item.created_by_user_id)
        : null)

  async function submitCreate() {
    if (props.mode !== 'create' || !title.trim() || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const creatorName =
        props.project.current_user_name ||
        memberNameById(projectMembers, props.project.current_user_id ?? null)
      let created = await api.createLoopItem(props.project.id, {
        title: title.trim(),
        description,
        priority,
        status,
        tags,
        ...(parentId ? { parent_id: parentId } : {}),
        ...(dueDate ? { due_at: dueDate } : {}),
        ...(creatorName ? { creator_name: creatorName } : {}),
      })
      // createLoopItem does not accept an assignee, so assign right after;
      // this records the who-assigned-to-whom chain and the queue state.
      if (assigneeTarget) {
        if (supportsAssignApi(api)) {
          created = await api.assignLoopItem(props.project.id, created.id, {
            version: created.version,
            assigneeType: assigneeTarget.startsWith('user:') ? 'user' : 'agent',
            assigneeId: assigneeTarget.startsWith('user:')
              ? Number(assigneeTarget.slice(5))
              : assigneeTarget.slice(6),
          })
        } else {
          created = await api.updateLoopItem(created.id, {
            version: created.version,
            assignee_user_id: assigneeTarget.startsWith('user:')
              ? Number(assigneeTarget.slice(5))
              : null,
            assignee_agent_id: assigneeTarget.startsWith('agent:') ? assigneeTarget.slice(6) : null,
          })
        }
      }
      const uploaded = await uploadAttachments(created.id, pendingFiles)
      if (uploaded.markdown) {
        created = await api.updateLoopItem(created.id, {
          version: created.version,
          description: appendAttachmentMarkdown(description, uploaded.markdown),
        })
      }
      if (draftKey) {
        localStorage.removeItem(draftKey)
        draftAttachmentStore.delete(draftKey)
      }
      props.onCreated(created)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : '创建任务失败')
    } finally {
      setSaving(false)
    }
  }

  async function saveDetails() {
    if (props.mode !== 'edit' || !dirty || !title.trim() || saving) return
    const current = props.item
    setSaving(true)
    setSaveError(null)
    try {
      let updated = await api.updateLoopItem(current.id, {
        version: current.version,
        title: title.trim(),
        description,
        status,
        priority,
        parent_id: parentId || null,
        due_at: dueDate || null,
        tags,
      })
      const currentAssigneeTarget = current.assignee_agent_id
        ? `agent:${current.assignee_agent_id}`
        : current.assignee_user_id
          ? `user:${current.assignee_user_id}`
          : ''
      if (assigneeTarget !== currentAssigneeTarget) {
        if (project && supportsAssignApi(api)) {
          updated = await api.assignLoopItem(project.id, current.id, {
            version: updated.version,
            assigneeType: assigneeTarget.startsWith('user:') ? 'user' : 'agent',
            assigneeId: assigneeTarget.startsWith('user:')
              ? Number(assigneeTarget.slice(5))
              : assigneeTarget.slice(6),
          })
        } else {
          updated = await api.updateLoopItem(current.id, {
            version: updated.version,
            assignee_user_id: assigneeTarget.startsWith('user:')
              ? Number(assigneeTarget.slice(5))
              : null,
            assignee_agent_id: assigneeTarget.startsWith('agent:') ? assigneeTarget.slice(6) : null,
          })
        }
      }
      props.onUpdated(updated)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : '保存任务失败')
    } finally {
      setSaving(false)
    }
  }

  async function addCollaborator() {
    if (!editItemId || !selectedCollaboratorId || collaboratorBusy) return
    setCollaboratorBusy(true)
    setCollaboratorError(null)
    try {
      const collaborator = await api.addLoopItemCollaborator(editItemId, selectedCollaboratorId)
      setCollaborators(current => [...current, collaborator])
      setSelectedCollaboratorId(null)
      setAddingCollaborator(false)
    } catch (cause) {
      setCollaboratorError(cause instanceof Error ? cause.message : '添加参与者失败')
    } finally {
      setCollaboratorBusy(false)
    }
  }

  async function removeCollaborator(collaborator: CloudLoopItemCollaborator) {
    if (!editItemId || collaboratorBusy) return
    setCollaboratorBusy(true)
    setCollaboratorError(null)
    try {
      await api.removeLoopItemCollaborator(editItemId, collaborator.user_id)
      setCollaborators(current => current.filter(entry => entry.id !== collaborator.id))
    } catch (cause) {
      setCollaboratorError(cause instanceof Error ? cause.message : '移除参与者失败')
    } finally {
      setCollaboratorBusy(false)
    }
  }

  async function stageFiles(files: FileList | null) {
    if (!files?.length) return
    setPendingFiles(current => [...current, ...Array.from(files)])
  }

  async function removePendingFile(row: AttachmentRow) {
    setPendingFiles(current => current.filter((_, index) => `pending-${index}` !== row.id))
  }

  async function addAttachments(files: FileList | null) {
    if (!editItemId || !files?.length || attachmentBusy) return
    setAttachmentBusy(true)
    setAttachmentError(null)
    try {
      const result = await uploadAttachments(editItemId, Array.from(files))
      setAttachments(current => [...result.attachments.reverse(), ...current])
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '附件上传失败')
    } finally {
      setAttachmentBusy(false)
    }
  }

  async function uploadAttachments(itemId: string, files: File[]) {
    const uploaded = await Promise.all(
      files.map(async file => {
        const attachment = await api.addLoopItemAttachment(itemId, file)
        return { attachment, markdown: attachment.markdown }
      })
    )
    return {
      attachments: uploaded.map(entry => entry.attachment),
      markdown: uploaded.map(entry => entry.markdown).join('\n'),
    }
  }

  function pasteAttachments(files: File[]) {
    if (isCreate) {
      setPendingFiles(current => [...current, ...files])
      return
    }
    if (!editItemId || attachmentBusy) return
    setAttachmentBusy(true)
    setAttachmentError(null)
    void uploadAttachments(editItemId, files)
      .then(result => {
        setAttachments(current => [...result.attachments.reverse(), ...current])
        setDescription(current => appendAttachmentMarkdown(current, result.markdown))
      })
      .catch(cause => {
        setAttachmentError(cause instanceof Error ? cause.message : '附件上传失败')
      })
      .finally(() => setAttachmentBusy(false))
  }

  async function openAttachment(attachment: AttachmentRow) {
    await api.downloadLoopItemAttachment(attachment.id, attachment.display_name)
  }

  async function removeAttachment(attachment: AttachmentRow) {
    setAttachmentBusy(true)
    setAttachmentError(null)
    try {
      await api.deleteLoopItemAttachment(attachment.id)
      setAttachments(current => current.filter(entry => entry.id !== attachment.id))
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '附件删除失败')
    } finally {
      setAttachmentBusy(false)
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (isCreate) void submitCreate()
      else void saveDetails()
    }
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    if (isCreate) void stageFiles(event.dataTransfer.files)
    else void addAttachments(event.dataTransfer.files)
  }

  function commitTagDraft() {
    const tag = tagDraft.trim().replace(/,/g, '')
    if (tag) {
      setTags(current => (current.includes(tag) ? current : [...current, tag]))
    }
    setTagDraft('')
  }

  if (selectedDelivery && item) {
    return (
      <aside className="fixed inset-y-0 right-0 z-modal flex w-full min-w-0 flex-col border-l border-border bg-background shadow-xl md:w-[calc(100%-248px)]">
        <header className="flex h-12 items-center border-b border-border px-4">
          <button
            type="button"
            onClick={() => setSelectedDelivery(null)}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-hover"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 返回
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="h-7 w-7 rounded-lg hover:bg-hover">
            <X className="mx-auto h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <p className="font-mono text-xs text-text-muted">{item.id} · 已交付</p>
          <h2 className="mt-2 text-heading-md font-semibold">{item.title}</h2>
          <article className="mt-6 whitespace-pre-wrap rounded-lg bg-muted/40 p-4 text-sm leading-6 text-text-primary">
            {selectedDelivery.markdown || '无交付说明'}
          </article>
          <h3 className="mt-6 text-xs font-semibold text-text-secondary">附件</h3>
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {selectedDelivery.assets.map(asset => (
              <div key={asset.id} className="flex h-10 items-center gap-2 px-3 text-sm">
                <File className="h-4 w-4 text-text-muted" />
                <span className="min-w-0 flex-1 truncate">{asset.relative_path}</span>
                <span className="text-text-muted">{asset.size_bytes} B</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    )
  }

  // The Xiaohongshu-style split: task content on the left, the comment
  // activity rail on the right. Edit mode with a project always gets this
  // layout so the task detail shape matches the design even before chat
  // connectivity is available.
  const activityView =
    item && editProps?.project && props.projectChatClient ? (
      <TaskActivityView
        key={`${item.id}:${item.assignee_agent_id ?? 'unassigned'}`}
        client={props.projectChatClient}
        project={editProps.project}
        task={item}
        currentUserId={props.currentUserId}
        onTaskUpdated={editProps.onUpdated}
        linear
      />
    ) : null
  const twoColumn = item !== null && editProps?.project !== undefined

  // Property controls, shared by the single-column chip row and the
  // two-column Xiaohongshu-style rail cells. The overlay select/input keeps
  // every cell editable in place regardless of where it is rendered.
  const statusSelect = (
    <select
      data-testid={isCreate ? 'cloud-todo-create-status' : 'cloud-todo-detail-status'}
      aria-label="状态"
      value={status}
      onChange={event => setStatus(event.target.value as CloudLoopItem['status'])}
      className={overlayControlClass}
    >
      {status === '' ? <option value="">未设置</option> : null}
      {statusOptions.map(option => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  )
  const prioritySelect = (
    <select
      data-testid={isCreate ? 'cloud-todo-create-priority' : 'cloud-todo-detail-priority'}
      aria-label="优先级"
      value={priority}
      onChange={event => setPriority(event.target.value as CloudLoopItem['priority'])}
      className={overlayControlClass}
    >
      <option value="none">无</option>
      <option value="low">低</option>
      <option value="medium">普通</option>
      <option value="high">高</option>
      <option value="urgent">紧急</option>
    </select>
  )
  const assigneeSelect = (
    <select
      data-testid={isCreate ? 'cloud-todo-create-assignee' : 'cloud-todo-detail-assignee'}
      aria-label="负责人"
      value={assigneeTarget}
      onChange={event => setAssigneeTarget(event.target.value)}
      disabled={!canAssign}
      className={overlayControlClass}
    >
      <option value="">添加负责人</option>
      <optgroup label="成员">
        {projectMembers.map(member => (
          <option key={member.user_id} value={`user:${member.user_id}`}>
            {member.user_name}
          </option>
        ))}
      </optgroup>
      {projectAgents.length ? (
        <optgroup label="机器人">
          {projectAgents.map(agent => (
            <option key={agent.id} value={`agent:${agent.id}`}>
              {agent.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  )
  const parentSelect = (
    <select
      data-testid={isCreate ? 'cloud-todo-create-parent' : 'cloud-todo-detail-parent'}
      aria-label="父任务"
      value={parentId}
      onChange={event => setParentId(event.target.value)}
      className={overlayControlClass}
    >
      <option value="">{isCreate ? '顶层任务' : '无父任务'}</option>
      {parentOptions.map(candidate => (
        <option key={candidate.id} value={candidate.id}>
          {candidate.id} · {candidate.title}
        </option>
      ))}
    </select>
  )
  const dueInput = (
    <input
      data-testid={isCreate ? 'cloud-todo-create-due-date' : 'cloud-todo-detail-due-date'}
      aria-label="截止时间"
      type="date"
      value={dueDate}
      onChange={event => setDueDate(event.target.value)}
      className={overlayControlClass}
    />
  )
  const statusValue = (
    <>
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', columnDotClasses[status] ?? 'bg-zinc-400')}
      />
      {statusLabel}
    </>
  )
  const priorityValue = (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-px text-xs font-medium',
        priorityBadgeClasses[priority]
      )}
    >
      {priority === 'none' ? '普通' : priority}
    </span>
  )
  const priorityRailLabels: Record<CloudLoopItem['priority'], string> = {
    none: '普通',
    low: 'P3 低',
    medium: 'P2 中',
    high: 'P1 高',
    urgent: 'P0 紧急',
  }
  const railAssigneeName = assigneeAgent?.name ?? assignee?.user_name ?? null
  const iterationText =
    item && editProps?.project
      ? (sourceCellText(item.source_cells, ['iteration', 'sprint', '迭代']) ??
        tagByPattern(tags, /^(sprint|迭代)[\s:_-]*/i) ??
        null)
      : null
  const requirementText =
    item && editProps?.project
      ? (sourceCellText(item.source_cells, ['requirement', '需求', 'req']) ??
        tagByPattern(tags, /^(req|需求)[\s:_-]*/i) ??
        item.source_record_id ??
        null)
      : null
  const collaboratorPreview = collaborators.slice(0, 2)
  const railDueDate = formatRailDueDate(item?.due_at, dueDate)
  const statusChip = (
    <span className={propChipClass}>
      <Circle className="h-3.5 w-3.5 text-text-muted" />
      <span className="text-text-muted">状态</span>
      {statusValue}
      <ChevronDown className="h-3 w-3 text-text-muted" />
      {statusSelect}
    </span>
  )
  const priorityChip = (
    <span className={propChipClass}>
      <Flag className="h-3.5 w-3.5 text-text-muted" />
      <span className="text-text-muted">优先级</span>
      {priorityValue}
      <ChevronDown className="h-3 w-3 text-text-muted" />
      {prioritySelect}
    </span>
  )
  // Single-column layout: all props stay as one wrapping chip row.
  const propChips = (
    <>
      {statusChip}
      {priorityChip}
      <span className={cn(propChipClass, !assignee && !assigneeAgent && 'text-text-muted')}>
        {assigneeAgent ? (
          <Bot className="h-3.5 w-3.5 text-violet-600" />
        ) : (
          <CircleUserRound className="h-3.5 w-3.5 text-text-muted" />
        )}
        <span className="text-text-muted">负责人</span>
        {assigneeAgent?.name ?? assignee?.user_name ?? '添加'}
        <ChevronDown className="h-3 w-3 text-text-muted" />
        {assigneeSelect}
      </span>
      {item && (
        <span
          data-testid="cloud-todo-detail-creator"
          className={cn(propChipClass, 'text-text-muted')}
        >
          <CircleUserRound className="h-3.5 w-3.5 text-text-muted" />
          <span className="text-text-muted">创建人</span>
          <span className="text-text-primary">
            {creator ?? (item.created_by_user_id > 0 ? `#${item.created_by_user_id}` : '—')}
          </span>
        </span>
      )}
      <span className={propChipClass}>
        <ListTodo className="h-3.5 w-3.5 text-text-muted" />
        <span className="text-text-muted">父任务</span>
        <span className="max-w-40 truncate">
          {parentItem
            ? `${parentItem.id} · ${parentItem.title}`
            : isCreate
              ? '顶层任务'
              : '无父任务'}
        </span>
        <ChevronDown className="h-3 w-3 text-text-muted" />
        {parentSelect}
      </span>
      <span className={cn(propChipClass, !dueDate && 'text-text-muted')}>
        <Calendar className="h-3.5 w-3.5 text-text-muted" />
        <span className="text-text-muted">截止时间</span>
        {dueDate ? dueDate.slice(5) : '添加日期'}
        {dueInput}
      </span>
    </>
  )
  // Two-column layout: the right rail shows flat label/value cells. 状态 and
  // 优先级 stay editable through the chips under the title, so their rail
  // cells are read-only summaries.
  const railProps = (
    <>
      <RailProp label="负责人" control={assigneeSelect}>
        {railAssigneeName ? (
          <>
            <AvatarMark name={railAssigneeName} />
            <span className="truncate">{railAssigneeName}</span>
          </>
        ) : (
          <span>添加</span>
        )}
      </RailProp>
      {item?.assignment_history?.length ? (
        <div
          data-testid="cloud-todo-assignment-chain"
          className="border-t border-border/60 px-3 py-2 text-xs text-text-muted"
        >
          <p className="mb-1 font-medium">指派链</p>
          {item.assignment_history.map((entry, index) => {
            const byName = memberNameById(projectMembers, entry.by_user_id)
            const toName =
              entry.to_type === 'agent'
                ? (entry.to_name ?? '机器人')
                : (entry.to_name ?? memberNameById(projectMembers, Number(entry.to_id)))
            return (
              <div key={`${entry.at}-${index}`} className="flex items-center gap-1.5 py-0.5">
                <span className="truncate">{byName ?? `#${entry.by_user_id}`}</span>
                <ArrowRight className="h-3 w-3 shrink-0" />
                <span className="truncate">{toName ?? '未指派'}</span>
                <span className="ml-auto shrink-0 text-xs">
                  {new Date(entry.at).toLocaleString()}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
      <RailProp label="截止日期" control={dueInput}>
        <span className={cn(railDueDate && 'text-red-500')}>{railDueDate ?? '添加日期'}</span>
      </RailProp>
      <RailProp label="优先级" control={prioritySelect}>
        <span className="flex items-center gap-1.5">
          <Flag className="h-4 w-4 fill-text-primary text-text-primary" />
          {priorityRailLabels[priority]}
        </span>
      </RailProp>
      <RailProp label="迭代">
        <span className={cn(!iterationText && 'text-text-muted')}>
          {iterationText?.replace(/^(sprint|迭代)[\s:_-]*/i, '') || '未设置'}
        </span>
      </RailProp>
      <RailProp label="参与者" clickable={false} valueClassName="overflow-visible">
        <span className="flex min-w-0 items-center">
          {collaboratorPreview.map((collaborator, index) => (
            <span
              key={collaborator.id}
              title={collaborator.user_name}
              className={cn(index > 0 && '-ml-2')}
            >
              <AvatarMark name={collaborator.user_name} index={index + 1} size="sm" />
            </span>
          ))}
          {collaborators.length > collaboratorPreview.length ? (
            <span className="ml-2">+{collaborators.length - collaboratorPreview.length}</span>
          ) : null}
          <button
            type="button"
            data-testid="cloud-todo-add-collaborator"
            aria-label="添加参与者"
            onClick={() => {
              setAddingCollaborator(current => !current)
              setCollaboratorError(null)
            }}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-text-muted transition hover:bg-muted hover:text-text-primary',
              collaboratorPreview.length > 0 && '-ml-2'
            )}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {collaborators.length === 0 ? <span className="ml-2 text-text-muted">暂无</span> : null}
        </span>
      </RailProp>
      {addingCollaborator ? (
        <div className="col-span-full flex items-center gap-2 px-2 pb-1">
          <select
            data-testid="cloud-todo-collaborator-select"
            value={selectedCollaboratorId ?? ''}
            onChange={event => setSelectedCollaboratorId(Number(event.target.value) || null)}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-text-muted"
          >
            <option value="">选择项目空间成员</option>
            {availableCollaborators.map(member => (
              <option key={member.user_id} value={member.user_id}>
                {member.user_name}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="cloud-todo-confirm-collaborator"
            disabled={!selectedCollaboratorId || collaboratorBusy}
            onClick={() => void addCollaborator()}
            className="h-8 shrink-0 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          >
            添加
          </button>
        </div>
      ) : null}
      {collaboratorError ? (
        <p className="col-span-full px-2 text-xs text-destructive">{collaboratorError}</p>
      ) : null}
      <RailProp label="关联需求">
        <span className={cn(requirementText ? 'text-blue-600' : 'text-text-muted')}>
          {requirementText || '未设置'}
          {requirementText ? ' ↗' : ''}
        </span>
      </RailProp>
    </>
  )
  const completedChildCount = childItems.filter(child => child.status === 'completed').length

  return (
    <div
      className={cn(
        'fixed z-modal flex items-start justify-center bg-black/35 backdrop-blur-sm',
        fullScreen
          ? 'inset-0 p-3'
          : twoColumn
            ? 'inset-x-0 bottom-0 top-[38px] p-3'
            : 'inset-0 px-6 pb-6 pt-[6vh]'
      )}
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <section
        data-testid={isCreate ? 'cloud-todo-create-panel' : 'cloud-todo-detail'}
        className={cn(
          'flex flex-col overflow-hidden rounded-2xl bg-background shadow-2xl',
          fullScreen
            ? 'h-full w-full'
            : cn(
                'max-w-[calc(100vw-48px)]',
                twoColumn
                  ? 'h-full w-full max-w-none'
                  : cn('max-h-[88vh]', isAITableEdit ? 'w-[1080px]' : 'w-[760px]')
              )
        )}
        onKeyDown={handleKeyDown}
        onDragOver={event => event.preventDefault()}
        onDrop={handleDrop}
      >
        <span className="sr-only">{isCreate ? '新建任务' : '任务详情'}</span>
        <header
          className={cn(
            'flex shrink-0 items-center',
            twoColumn ? 'h-12 border-b border-border px-4' : 'px-4 pt-3'
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
            <Folder className="h-3.5 w-3.5" />
            <span className="truncate">
              {item
                ? `${editProps?.project?.name ?? '项目空间'} / ${item.id}`
                : `${createProps?.project.name} · ${createProps?.initialParent ? '新建子任务' : '新建任务'}`}
            </span>
          </span>
          {item && (
            <button
              type="button"
              aria-label="复制任务编号"
              title="复制任务编号"
              onClick={() => void navigator.clipboard?.writeText(item.id)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition hover:bg-muted hover:text-text-primary"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="flex-1" />
          {twoColumn && !isCreate ? (
            <>
              <button
                type="button"
                data-testid="cloud-todo-start-task"
                onClick={() => editProps?.onStartConversation()}
                className="mr-2 h-8 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition hover:bg-muted"
              >
                开始对话
              </button>
              {dirty || saving ? (
                <button
                  type="button"
                  data-testid="cloud-todo-save"
                  disabled={!title.trim() || saving}
                  onClick={() => void saveDetails()}
                  className="mr-2 h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            data-testid={isCreate ? 'cloud-todo-create-fullscreen' : 'cloud-todo-detail-fullscreen'}
            onClick={() => setFullScreen(current => !current)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
            aria-label={fullScreen ? '退出全屏' : '全屏显示'}
          >
            {fullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            data-testid={isCreate ? 'cloud-todo-modal-close' : 'cloud-todo-detail-close'}
            onClick={onClose}
            className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
            aria-label={isCreate ? '关闭' : '关闭任务详情'}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div
          className={cn(
            'min-h-0 flex-1',
            twoColumn
              ? 'grid grid-cols-1 overflow-y-auto bg-background md:grid-cols-[minmax(0,1fr)_320px] md:overflow-visible'
              : 'overflow-y-auto'
          )}
        >
          <div
            ref={twoColumn ? detailScrollRef : undefined}
            className={cn('pb-6 pt-2.5', twoColumn ? 'task-detail-left md:min-h-0' : 'px-14')}
          >
            <div className={cn(twoColumn && 'task-detail-left-inner')}>
              {twoColumn && item ? (
                <div className="task-detail-id-row">
                  <span>{item.id}</span>
                  <span>·</span>
                  <span>创建于 {item.created_at.slice(5, 10)}</span>
                </div>
              ) : null}
              <textarea
                data-testid={isCreate ? 'cloud-todo-title' : 'cloud-todo-detail-title'}
                aria-label="任务标题"
                autoFocus={isCreate}
                value={title}
                onChange={event => setTitle(event.target.value)}
                rows={1}
                maxLength={255}
                placeholder="目标或事项标题"
                className={cn(
                  'block w-full resize-none overflow-hidden border-0 bg-transparent font-bold tracking-tight text-text-primary outline-none placeholder:text-text-muted',
                  twoColumn ? 'task-detail-title' : 'py-1.5 text-heading-lg'
                )}
              />

              <div
                className={cn(
                  'flex flex-wrap items-center gap-2',
                  twoColumn ? 'task-detail-pill-row' : 'mt-3'
                )}
              >
                {twoColumn ? (
                  <>
                    {statusChip}
                    {priorityChip}
                    <span className="task-detail-pill">
                      <Plus className="h-3.5 w-3.5" />
                      <input
                        data-testid={
                          isCreate ? 'cloud-todo-create-tag-input' : 'cloud-todo-detail-tag-input'
                        }
                        value={tagDraft}
                        onChange={event => setTagDraft(event.target.value)}
                        onBlur={commitTagDraft}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ',') {
                            event.preventDefault()
                            commitTagDraft()
                          }
                        }}
                        placeholder="添加标签"
                      />
                    </span>
                    {tags.map(tag => (
                      <span
                        key={tag}
                        data-testid={`${isCreate ? 'cloud-todo-create-tag' : 'cloud-todo-detail-tag'}-tag-${tag}`}
                        className="task-detail-pill"
                      >
                        # {tag}
                        <button
                          type="button"
                          aria-label={`移除标签 ${tag}`}
                          data-testid={`${isCreate ? 'cloud-todo-create-tag' : 'cloud-todo-detail-tag'}-tag-remove-${tag}`}
                          onClick={() =>
                            setTags(current => current.filter(candidate => candidate !== tag))
                          }
                          className="flex h-4 w-4 items-center justify-center rounded-full text-text-muted transition hover:bg-muted hover:text-text-primary"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </>
                ) : (
                  propChips
                )}
              </div>

              {!twoColumn ? (
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="flex shrink-0 select-none items-center gap-1.5 text-xs text-text-muted">
                    <Tag className="h-3.5 w-3.5" />
                    标签
                  </span>
                  <TagEditor
                    testIdPrefix={isCreate ? 'cloud-todo-create-tag' : 'cloud-todo-detail-tag'}
                    tags={tags}
                    onChange={setTags}
                    suggestions={tagSuggestions}
                  />
                </div>
              ) : null}

              {twoColumn ? (
                <div className="task-detail-meta-line">
                  <span className="task-detail-meta-item">
                    <CircleUserRound className="h-3.5 w-3.5" />
                    负责人
                    <span className="text-text-primary">
                      {assigneeAgent?.name ?? assignee?.user_name ?? '未指派'}
                    </span>
                  </span>
                  <span className="task-detail-meta-item">
                    <Calendar className="h-3.5 w-3.5" />
                    截止
                    <span className="text-text-primary">
                      {dueDate ? dueDate.slice(5) : '未设置'}
                    </span>
                  </span>
                  {assigneeAgent ? (
                    <span className="task-detail-meta-item">
                      <Bot className="h-3.5 w-3.5 text-violet-600" />
                      协作 Agent
                      <span className="text-text-primary">{assigneeAgent.name}</span>
                    </span>
                  ) : null}
                </div>
              ) : null}

              {!isAITableEdit ? (
                <div className={cn(twoColumn ? 'mt-0' : 'mt-3 min-h-[240px]')}>
                  {twoColumn ? <h3 className="task-detail-section-label">描述</h3> : null}
                  <div
                    className={cn(
                      twoColumn && 'task-detail-desc',
                      twoColumn && !descriptionExpanded && 'is-collapsed'
                    )}
                  >
                    <TaskDescriptionEditor
                      value={description}
                      onChange={setDescription}
                      onPasteFiles={pasteAttachments}
                    />
                  </div>
                  {twoColumn ? (
                    <button
                      type="button"
                      onClick={() => setDescriptionExpanded(current => !current)}
                      className="task-detail-desc-toggle"
                    >
                      {descriptionExpanded ? '收起' : '展开描述'}
                    </button>
                  ) : null}
                  <p className={cn('mt-2.5 text-xs text-text-muted', twoColumn && 'hidden')}>
                    支持 Markdown，可拖拽文件到编辑器添加附件
                  </p>
                </div>
              ) : null}
              {saveError && <p className="mt-2 text-xs text-destructive">{saveError}</p>}

              {twoColumn && item
                ? (activityView ?? (
                    <section
                      data-testid="cloud-todo-detail-activity-rail-empty"
                      className="task-detail-comments"
                    >
                      <header className="task-detail-comments-head">
                        <span className="font-semibold text-text-primary">评论 / 动态</span>
                      </header>
                      <div className="task-detail-comments-list text-sm text-text-muted">
                        评论服务当前不可用
                      </div>
                    </section>
                  ))
                : null}

              {isAITableEdit && item && editProps?.project && props.aitableApi ? (
                <AITableTaskFields api={props.aitableApi} project={editProps.project} item={item} />
              ) : null}

              {twoColumn ? <div className="sr-only">{parentSelect}</div> : null}

              {!twoColumn ? (
                <div className="mt-5">
                  <TodoAttachmentSection
                    attachments={isCreate ? pendingAttachmentRows : visibleAttachments}
                    busy={attachmentBusy}
                    error={attachmentError}
                    editable
                    onAdd={isCreate ? stageFiles : addAttachments}
                    onOpen={isCreate ? undefined : openAttachment}
                    onRemove={isCreate ? removePendingFile : removeAttachment}
                  />
                </div>
              ) : null}

              {item && (
                <>
                  {!twoColumn ? (
                    <section className="mt-7" data-testid="cloud-todo-children">
                      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-muted">
                        <h3 className="text-sm font-medium text-text-muted">子任务</h3>
                        <span className="ml-2 text-xs font-normal text-text-muted">
                          {twoColumn && childItems.length > 0
                            ? `${completedChildCount}/${childItems.length}`
                            : childItems.length}
                        </span>
                        <button
                          type="button"
                          data-testid="cloud-todo-detail-add-child"
                          onClick={() => editProps?.onAddChild()}
                          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition hover:bg-muted hover:text-text-primary"
                        >
                          <Plus className="h-3 w-3" /> 新建子任务
                        </button>
                      </div>
                      {twoColumn && childItems.length > 0 ? (
                        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-text-primary transition-all"
                            style={{
                              width: `${(completedChildCount / childItems.length) * 100}%`,
                            }}
                          />
                        </div>
                      ) : null}
                      {childItems.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-sm text-text-muted">
                          暂无子任务
                        </p>
                      ) : (
                        <div>
                          {childItems.map(child => (
                            <div
                              key={child.id}
                              className="mb-2 flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted"
                            >
                              <span
                                className={cn(
                                  'h-1.5 w-1.5 shrink-0 rounded-full',
                                  columnDotClasses[child.status]
                                )}
                              />
                              <span className="shrink-0 font-mono text-xs text-text-muted">
                                {child.id}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{child.title}</span>
                              <span className="shrink-0 text-xs text-text-muted">
                                {columns.find(column => column.status === child.status)?.label}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  ) : null}
                  {!twoColumn ? (
                    <section className="mt-7" data-testid="cloud-todo-collaborators">
                      <div className="flex h-8 items-center">
                        <h3 className="text-sm font-semibold">参与者</h3>
                        <span className="ml-2 text-xs font-normal text-text-muted">
                          {collaborators.length}
                        </span>
                        <button
                          type="button"
                          data-testid="cloud-todo-add-collaborator"
                          onClick={() => {
                            setAddingCollaborator(current => !current)
                            setCollaboratorError(null)
                          }}
                          className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-muted transition hover:text-text-primary"
                        >
                          <Plus className="h-3 w-3" />
                          添加参与者
                        </button>
                      </div>
                      {addingCollaborator && (
                        <div className="mt-2 flex items-center gap-2">
                          <select
                            data-testid="cloud-todo-collaborator-select"
                            value={selectedCollaboratorId ?? ''}
                            onChange={event =>
                              setSelectedCollaboratorId(Number(event.target.value) || null)
                            }
                            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-text-muted"
                          >
                            <option value="">选择项目空间成员</option>
                            {availableCollaborators.map(member => (
                              <option key={member.user_id} value={member.user_id}>
                                {member.user_name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            data-testid="cloud-todo-confirm-collaborator"
                            disabled={!selectedCollaboratorId || collaboratorBusy}
                            onClick={() => void addCollaborator()}
                            className="h-9 shrink-0 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
                          >
                            添加
                          </button>
                        </div>
                      )}
                      {collaborators.length === 0 ? (
                        <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                          暂无参与者
                        </p>
                      ) : (
                        <div className="mt-1">
                          {collaborators.map(collaborator => (
                            <div
                              key={collaborator.id}
                              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted/60"
                            >
                              <span
                                className={cn(
                                  'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background',
                                  memberAvatarClasses[0]
                                )}
                              >
                                {collaborator.user_name.slice(0, 1).toUpperCase()}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {collaborator.user_name}
                              </span>
                              {collaborator.source !== 'manual' && (
                                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
                                  自动加入
                                </span>
                              )}
                              <button
                                type="button"
                                aria-label={`移除参与者 ${collaborator.user_name}`}
                                disabled={collaboratorBusy}
                                onClick={() => void removeCollaborator(collaborator)}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition hover:bg-background hover:text-text-primary disabled:opacity-40"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {collaboratorError && (
                        <p className="mt-2 text-xs text-destructive">{collaboratorError}</p>
                      )}
                    </section>
                  ) : null}
                  {!twoColumn ? (
                    <>
                      <section className="mt-7">
                        <h3 className="flex h-8 items-center text-sm font-semibold">本地执行</h3>
                        {tasks.length === 0 ? (
                          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                            尚未关联本地任务
                          </p>
                        ) : (
                          <div className="mt-1">
                            {tasks.map(task => (
                              <div
                                key={task.id}
                                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors hover:bg-muted/60"
                              >
                                <Link2 className="h-4 w-4 shrink-0 text-text-muted" />
                                <span
                                  className="min-w-0 flex-1 truncate"
                                  title={task.task_title || task.task_id}
                                >
                                  {task.task_title || task.task_id}
                                </span>
                                <span className="shrink-0 text-text-muted">{task.device_id}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                      <section className="mt-7">
                        <h3 className="flex h-8 items-center text-sm font-semibold">交付</h3>
                        <div className="mt-1 space-y-1">
                          {deliveries.map(delivery => (
                            <button
                              key={delivery.id}
                              type="button"
                              onClick={() =>
                                void api.getDelivery(delivery.id).then(setSelectedDelivery)
                              }
                              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-xs transition-colors hover:bg-muted/60"
                            >
                              <FileText className="h-4 w-4 shrink-0 text-text-muted" />
                              <span>{delivery.assets.length} 个附件</span>
                              <span className="ml-auto shrink-0 text-text-muted">
                                {delivery.delivered_at?.slice(0, 10)}
                              </span>
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                            </button>
                          ))}
                        </div>
                      </section>
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
          {twoColumn ? (
            <aside
              data-testid="cloud-todo-detail-activity-rail"
              className="task-detail-slim-rail flex min-h-0 flex-col border-t border-border bg-muted/40 md:border-l md:border-t-0"
            >
              <div className="shrink-0 border-b border-border bg-background px-3 py-2.5">
                <div className="grid grid-cols-1 gap-0.5">{railProps}</div>
              </div>
              {item ? (
                <div className="task-detail-rail-sections">
                  <section className="task-detail-rail-section" data-testid="cloud-todo-children">
                    <div className="task-detail-section-label">
                      <h3>
                        <ListTodo className="icon" />
                        子任务
                      </h3>
                      <span className="count">
                        {childItems.length > 0
                          ? `${completedChildCount}/${childItems.length}`
                          : childItems.length}
                      </span>
                      <button
                        type="button"
                        data-testid="cloud-todo-detail-add-child"
                        onClick={() => editProps?.onAddChild()}
                        className="add"
                      >
                        ＋ 添加
                      </button>
                    </div>
                    {childItems.length > 0 ? (
                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${(completedChildCount / childItems.length) * 100}%`,
                          }}
                        />
                      </div>
                    ) : null}
                    {childItems.length === 0 ? (
                      <p className="task-detail-rail-empty">暂无子任务</p>
                    ) : (
                      <>
                        <div
                          className={cn(
                            'task-detail-rail-subtasks',
                            childRailExpanded && 'expanded-scroll'
                          )}
                        >
                          {visibleRailChildren.map(child => (
                            <div key={child.id} className="subtask">
                              <span
                                className={cn(
                                  'checkbox',
                                  child.status === 'completed' && 'is-done'
                                )}
                              >
                                {child.status === 'completed' ? '✓' : null}
                              </span>
                              <span className="subtask-title">{child.title}</span>
                              <span className="who">
                                {columns.find(column => column.status === child.status)?.label}
                              </span>
                            </div>
                          ))}
                        </div>
                        {childItems.length > 2 && (
                          <button
                            type="button"
                            className="task-detail-rail-more"
                            onClick={() => toggleRailSection('children')}
                          >
                            {childRailExpanded ? '收起' : `查看全部 ${childItems.length} 个`}
                          </button>
                        )}
                      </>
                    )}
                  </section>
                  <TodoAttachmentSection
                    attachments={visibleAttachments}
                    busy={attachmentBusy}
                    error={attachmentError}
                    editable
                    compactRail
                    onAdd={addAttachments}
                    onOpen={openAttachment}
                    onRemove={removeAttachment}
                  />
                  <section className="task-detail-rail-section">
                    <div className="task-detail-section-label">
                      <h3>
                        <Link2 className="icon" />
                        执行记录
                      </h3>
                      <span className="count">{tasks.length}</span>
                    </div>
                    {tasks.length === 0 ? (
                      <p className="task-detail-rail-empty">尚未关联本地任务</p>
                    ) : (
                      <>
                        <div
                          className={cn(
                            'task-detail-rail-executions',
                            executionRailExpanded && 'expanded-scroll'
                          )}
                        >
                          {visibleRailTasks.map(task => (
                            <div key={task.id} className="task-detail-rail-execution">
                              <span className="task-detail-rail-icon">
                                <Link2 className="icon" />
                              </span>
                              <span className="task-detail-rail-content">
                                <span
                                  className="task-detail-rail-name"
                                  title={task.task_title || task.task_id}
                                >
                                  {task.task_title || task.task_id}
                                </span>
                                <span className="task-detail-rail-detail">
                                  <span>{task.device_id}</span>
                                  <span>已关联</span>
                                </span>
                              </span>
                              <span className="task-detail-rail-badges">
                                <span className="task-detail-mini-badge human">人类</span>
                                <span className="task-detail-mini-badge">手动</span>
                              </span>
                            </div>
                          ))}
                        </div>
                        {tasks.length > 2 && (
                          <button
                            type="button"
                            className="task-detail-rail-more"
                            onClick={() => toggleRailSection('executions')}
                          >
                            {executionRailExpanded ? '收起' : `查看全部 ${tasks.length} 个`}
                          </button>
                        )}
                      </>
                    )}
                  </section>
                  <section className="task-detail-rail-section">
                    <div className="task-detail-section-label">
                      <h3>
                        <FileText className="icon" />
                        交付
                      </h3>
                      <span className="count">{deliveries.length}</span>
                    </div>
                    {deliveries.length === 0 ? (
                      <p className="task-detail-rail-empty">暂无交付</p>
                    ) : (
                      <>
                        <div
                          className={cn(
                            'task-detail-rail-deliveries',
                            deliveryRailExpanded && 'expanded-scroll'
                          )}
                        >
                          {visibleRailDeliveries.map(delivery => (
                            <button
                              key={delivery.id}
                              type="button"
                              onClick={() =>
                                void api.getDelivery(delivery.id).then(setSelectedDelivery)
                              }
                              className="task-detail-rail-delivery w-full text-left"
                            >
                              <span className="task-detail-rail-icon">
                                <FileText className="icon" />
                              </span>
                              <span className="task-detail-rail-name">
                                {delivery.assets.length > 0
                                  ? `${delivery.assets.length} 个附件`
                                  : '交付结果'}
                              </span>
                              <span className="task-detail-rail-meta">
                                {delivery.delivered_at?.slice(0, 10)}
                              </span>
                            </button>
                          ))}
                        </div>
                        {deliveries.length > 2 && (
                          <button
                            type="button"
                            className="task-detail-rail-more"
                            onClick={() => toggleRailSection('deliveries')}
                          >
                            {deliveryRailExpanded ? '收起' : `查看全部 ${deliveries.length} 个`}
                          </button>
                        )}
                      </>
                    )}
                  </section>
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>

        {!twoColumn ? (
          <footer className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
            <span className="text-xs text-text-muted">
              {isCreate
                ? `ESC 关闭 · ⌘↵ 创建${hasDraftContent ? ' · 草稿已保存' : ''}`
                : 'ESC 关闭 · ⌘↵ 保存'}
            </span>
            <span className="flex-1" />
            {isCreate ? (
              <>
                <button
                  type="button"
                  data-testid="cloud-todo-create-confirm"
                  disabled={!title.trim() || saving}
                  onClick={() => void submitCreate()}
                  className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? '正在创建…' : '创建任务'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="cloud-todo-start-task"
                  onClick={() => editProps?.onStartConversation()}
                  className="h-8 rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-text-primary transition hover:bg-muted"
                >
                  开始对话
                </button>
                {dirty && (
                  <button
                    type="button"
                    data-testid="cloud-todo-save"
                    disabled={!title.trim() || saving}
                    onClick={() => void saveDetails()}
                    className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? '正在保存…' : '保存'}
                  </button>
                )}
              </>
            )}
          </footer>
        ) : null}
      </section>
    </div>
  )
}
