import { useEffect, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CircleUserRound,
  Cloud,
  Copy,
  Download,
  File,
  FileText,
  Folder,
  Link2,
  ListTodo,
  Maximize2,
  MoreHorizontal,
  MoveRight,
  Network,
  PanelRight,
  Paperclip,
  Plus,
  Search,
  SignalHigh,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import type {
  CloudLoopItem,
  CloudLoopItemAttachment,
  CloudLoopItemCollaborator,
  CloudMyWorkItem,
  CloudProject,
  CloudProjectMember,
  Delivery,
  DeliveryDetail,
} from '@/api/deliveries'
import { ApiError } from '@/api/http'
import { DesktopAppSwitcher } from '@/components/layout/DesktopAppSwitcher'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeTaskAddress,
  User as UserProfile,
} from '@/types/api'
import { CloudTodoModal as Modal } from './CloudTodoModal'
import { CloudProjectSettingsDialog } from './CloudProjectSettingsDialog'
import { CloudFilesView } from './CloudFilesView'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'
import { normalizeTaskDescription } from './taskDescription'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>
type ProjectView = 'board' | 'files'
type RootView = 'projects' | 'my-work'

interface CloudTaskRunRequest {
  project: ProjectWithTasks
  message: string
  goal?: string
  attachments: Attachment[]
  collaborationMode?: 'default' | 'plan'
  deliveryId?: string
  cloudProjectId?: string
}

interface CloudTodoWorkspaceProps {
  user: UserProfile
  localProjects: ProjectWithTasks[]
  services: WorkbenchServices
  onRunTodo?: (request: CloudTaskRunRequest) => Promise<RuntimeTaskAddress | false>
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
}

const columns: Array<{ status: CloudLoopItem['status']; label: string }> = [
  { status: 'inbox', label: '收集箱' },
  { status: 'pending', label: '待开始' },
  { status: 'in_progress', label: '进行中' },
  { status: 'in_review', label: '待确认' },
  { status: 'completed', label: '已完成' },
]

function boardStatusFromDropId(id: string | number | undefined): CloudLoopItem['status'] | null {
  if (typeof id !== 'string' || !id.startsWith('todo-column:')) return null
  const status = id.slice('todo-column:'.length) as CloudLoopItem['status']
  return columns.some(column => column.status === status) ? status : null
}

function TodoCardContent({ item }: { item: CloudLoopItem }) {
  return (
    <>
      <span className="font-mono text-xs text-text-muted">{item.id}</span>
      <span className="mt-2 block text-sm font-medium leading-5">{item.title}</span>
      <span className="mt-4 flex items-center text-xs text-text-muted">
        <ListTodo className="mr-1.5 h-3.5 w-3.5" />
        {item.priority === 'none' ? '普通' : item.priority}
        <span className="ml-auto">{item.updated_at.slice(5, 10)}</span>
      </span>
    </>
  )
}

function DraggableTodoCard({
  item,
  childCount,
  onClick,
  onAddChild,
  onOpenChildren,
}: {
  item: CloudLoopItem
  childCount: number
  onClick: () => void
  onAddChild: () => void
  onOpenChildren: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.id,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'w-full touch-none overflow-hidden rounded-md border border-border bg-background text-left shadow-sm transition-[opacity,border-color,box-shadow] hover:border-text-muted',
        isDragging && 'opacity-25 shadow-none'
      )}
    >
      <button
        type="button"
        data-testid={`cloud-todo-card-${item.id}`}
        onClick={onClick}
        className="w-full p-3 text-left"
        {...listeners}
        {...attributes}
      >
        <TodoCardContent item={item} />
      </button>
      <div className="flex h-8 items-center border-t border-border">
        {childCount > 0 && (
          <button
            type="button"
            data-testid={`cloud-todo-open-children-${item.id}`}
            onClick={onOpenChildren}
            className="flex h-full min-w-0 flex-1 items-center px-3 text-xs text-text-secondary hover:bg-hover"
          >
            <ListTodo className="mr-1.5 h-3.5 w-3.5" />
            {childCount} 个子任务
            <ChevronRight className="ml-auto h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          data-testid={`cloud-todo-card-add-child-${item.id}`}
          onClick={onAddChild}
          className={cn(
            'flex h-full items-center gap-1 px-3 text-xs text-text-secondary hover:bg-hover',
            childCount > 0 && 'border-l border-border'
          )}
        >
          <Plus className="h-3.5 w-3.5" /> 子任务
        </button>
      </div>
    </div>
  )
}

function TodoColumnDropzone({
  status,
  children,
}: {
  status: CloudLoopItem['status']
  children: React.ReactNode
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `todo-column:${status}` })
  return (
    <div
      ref={setNodeRef}
      data-testid={`cloud-todo-column-dropzone-${status}`}
      className={cn(
        'min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain rounded-md bg-muted/30 px-2 pt-2 transition-colors',
        isOver && 'bg-hover ring-1 ring-inset ring-focus/50'
      )}
    >
      {children}
    </div>
  )
}

function descendantIds(items: CloudLoopItem[], itemId: string): Set<string> {
  const result = new Set<string>()
  const pending = [itemId]
  while (pending.length > 0) {
    const parentId = pending.pop()!
    for (const item of items) {
      if (item.parent_id !== parentId || result.has(item.id)) continue
      result.add(item.id)
      pending.push(item.id)
    }
  }
  return result
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

function ProjectDialog({
  api,
  onClose,
  onCreated,
}: {
  api: DeliveryApi
  onClose: () => void
  onCreated: (project: CloudProject) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      onCreated(
        await api.createCloudProject({
          name: name.trim(),
          description: description.trim(),
        })
      )
    } catch (cause) {
      setError(cloudProjectRequestError(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="新建项目空间" onClose={onClose}>
      <div className="space-y-4 p-5">
        <label className="block space-y-1.5 text-xs font-medium text-text-secondary">
          项目名称
          <input
            data-testid="cloud-project-name"
            value={name}
            onChange={event => setName(event.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-focus"
            placeholder="例如：Wegent V4"
          />
        </label>
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-text-muted">
          项目标识将在创建时自动生成。
        </p>
        <label className="block space-y-1.5 text-xs font-medium text-text-secondary">
          项目说明
          <textarea
            value={description}
            onChange={event => setDescription(event.target.value)}
            className="h-24 w-full resize-none rounded-md border border-border bg-background p-3 text-sm text-text-primary outline-none focus:border-focus"
          />
        </label>
        <p className="text-xs text-text-muted">
          项目空间包含共享任务、文件与交付；成员可以关联各自不同的本地工作区。
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <footer className="flex h-14 items-center justify-end gap-2 border-t border-border px-5">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-md px-3 text-sm hover:bg-hover"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="cloud-project-create-confirm"
          disabled={!name.trim() || saving}
          onClick={() => void submit()}
          className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
        >
          {saving ? '正在创建…' : '创建项目'}
        </button>
      </footer>
    </Modal>
  )
}

function TodoDialog({
  api,
  project,
  parent,
  initialStatus,
  allItems,
  onClose,
  onCreated,
}: {
  api: DeliveryApi
  project: CloudProject
  parent?: CloudLoopItem | null
  initialStatus: CloudLoopItem['status']
  allItems: CloudLoopItem[]
  onClose: () => void
  onCreated: (item: CloudLoopItem) => void
}) {
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [priority, setPriority] = useState<CloudLoopItem['priority']>('none')
  const [status, setStatus] = useState<CloudLoopItem['status']>(initialStatus)
  const [parentId, setParentId] = useState(parent?.id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!title.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      onCreated(
        await api.createLoopItem(project.id, {
          title: title.trim(),
          description: markdown,
          priority,
          status,
          ...(parentId ? { parent_id: parentId } : {}),
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建任务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={parent ? '新建子任务' : '新建任务'} onClose={onClose}>
      <div className="space-y-4 p-5">
        <label className="flex items-center gap-3 text-xs text-text-secondary">
          父任务
          <select
            data-testid="cloud-todo-create-parent"
            value={parentId}
            onChange={event => setParentId(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2"
          >
            <option value="">顶层任务</option>
            {allItems.map(candidate => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.id} · {candidate.title}
              </option>
            ))}
          </select>
        </label>
        <input
          data-testid="cloud-todo-title"
          value={title}
          onChange={event => setTitle(event.target.value)}
          className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-focus"
          placeholder="目标或事项标题"
        />
        <div className="overflow-hidden rounded-md border border-border">
          <div className="flex h-8 items-center gap-3 border-b border-border bg-muted/40 px-3 text-xs text-text-muted">
            <span className="font-semibold">B</span>
            <span className="italic">I</span>
            <span>Markdown</span>
          </div>
          <textarea
            data-testid="cloud-todo-markdown"
            value={markdown}
            onChange={event => setMarkdown(event.target.value)}
            className="h-56 w-full resize-none bg-background p-3 text-sm leading-6 text-text-primary outline-none"
            placeholder="写下背景、要求或直接完成的文档内容…"
          />
        </div>
        <label className="flex items-center gap-3 text-xs text-text-secondary">
          状态
          <select
            data-testid="cloud-todo-create-status"
            value={status}
            onChange={event => setStatus(event.target.value as CloudLoopItem['status'])}
            className="h-8 rounded-md border border-border bg-background px-2"
          >
            {columns.map(column => (
              <option key={column.status} value={column.status}>
                {column.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-3 text-xs text-text-secondary">
          优先级
          <select
            value={priority}
            onChange={event => setPriority(event.target.value as CloudLoopItem['priority'])}
            className="h-8 rounded-md border border-border bg-background px-2"
          >
            <option value="none">无</option>
            <option value="low">低</option>
            <option value="medium">普通</option>
            <option value="high">高</option>
            <option value="urgent">紧急</option>
          </select>
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <footer className="flex h-14 items-center justify-end gap-2 border-t border-border px-5">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-md px-3 text-sm hover:bg-hover"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="cloud-todo-create-confirm"
          disabled={!title.trim() || saving}
          onClick={() => void submit()}
          className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
        >
          {saving ? '正在创建…' : '创建任务'}
        </button>
      </footer>
    </Modal>
  )
}

function StartTaskDialog({
  item,
  projects,
  onClose,
  onStart,
}: {
  item: CloudLoopItem
  projects: ProjectWithTasks[]
  onClose: () => void
  onStart: (project: ProjectWithTasks, message: string) => Promise<void>
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? 0)
  const [message, setMessage] = useState(item.description || item.title)
  const [starting, setStarting] = useState(false)
  const selected = projects.find(project => project.id === projectId)

  return (
    <Modal title="开启本地任务" onClose={onClose}>
      <div className="space-y-4 p-5">
        <div className="rounded-md bg-muted/50 px-3 py-3">
          <p className="font-mono text-xs text-text-muted">{item.id}</p>
          <p className="mt-1 text-sm font-medium text-text-primary">{item.title}</p>
        </div>
        <label className="block space-y-1.5 text-xs font-medium text-text-secondary">
          本地项目
          <select
            data-testid="cloud-todo-local-project"
            value={projectId}
            onChange={event => setProjectId(Number(event.target.value))}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            {projects.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5 text-xs font-medium text-text-secondary">
          启动指令
          <textarea
            value={message}
            onChange={event => setMessage(event.target.value)}
            className="h-32 w-full resize-none rounded-md border border-border bg-background p-3 text-sm outline-none focus:border-focus"
          />
        </label>
        <p className="text-xs text-text-muted">
          新任务会获得当前项目空间上下文，可读取共享目录、任务和历史交付，但不会自动上传本地会话。
        </p>
      </div>
      <footer className="flex h-14 items-center justify-end gap-2 border-t border-border px-5">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-md px-3 text-sm hover:bg-hover"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="cloud-todo-start-confirm"
          disabled={!selected || !message.trim() || starting}
          onClick={() => {
            if (!selected) return
            setStarting(true)
            void onStart(selected, message).finally(() => setStarting(false))
          }}
          className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
        >
          {starting ? '正在开启…' : '开启任务'}
        </button>
      </footer>
    </Modal>
  )
}

function TodoAttachmentSection({
  attachments,
  busy,
  error,
  editable,
  onAdd,
  onOpen,
  onRemove,
}: {
  attachments: CloudLoopItemAttachment[]
  busy: boolean
  error: string | null
  editable: boolean
  onAdd: (files: FileList | null) => Promise<void>
  onOpen: (attachment: CloudLoopItemAttachment) => Promise<void>
  onRemove: (attachment: CloudLoopItemAttachment) => Promise<void>
}) {
  return (
    <section className="space-y-2">
      <div className="flex h-8 items-center">
        <h3 className="text-xs font-semibold text-text-secondary">附件</h3>
        <span className="ml-2 text-xs text-text-muted">{attachments.length}</span>
        <span className="flex-1" />
        {editable && (
          <label className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-hover">
            <Paperclip className="h-3.5 w-3.5" />
            {busy ? '上传中…' : '添加附件'}
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
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {attachments.length === 0 ? (
          <p className="px-3 py-3 text-xs text-text-muted">暂无附件</p>
        ) : (
          attachments.map(attachment => (
            <div key={attachment.id} className="flex h-10 items-center gap-2 px-3 text-sm">
              <File className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate">{attachment.display_name}</span>
              <span className="text-xs text-text-muted">{attachment.size_bytes} B</span>
              <button
                type="button"
                data-testid={`cloud-todo-attachment-download-${attachment.id}`}
                onClick={() => void onOpen(attachment)}
                className="h-7 w-7 rounded-md text-text-muted hover:bg-hover hover:text-text-primary"
                aria-label={`下载 ${attachment.display_name}`}
              >
                <Download className="mx-auto h-3.5 w-3.5" />
              </button>
              {editable && (
                <button
                  type="button"
                  data-testid={`cloud-todo-attachment-delete-${attachment.id}`}
                  disabled={busy}
                  onClick={() => void onRemove(attachment)}
                  className="h-7 w-7 rounded-md text-text-muted hover:bg-hover hover:text-destructive disabled:opacity-50"
                  aria-label={`删除 ${attachment.display_name}`}
                >
                  <Trash2 className="mx-auto h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function TodoDetail({
  api,
  item,
  allItems,
  onClose,
  onAddChild,
  onStart,
  onUpdated,
}: {
  api: DeliveryApi
  item: CloudLoopItem
  allItems: CloudLoopItem[]
  onClose: () => void
  onAddChild: () => void
  onStart: () => void
  onUpdated: (item: CloudLoopItem) => void
}) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [selectedDelivery, setSelectedDelivery] = useState<DeliveryDetail | null>(null)
  const [tasks, setTasks] = useState<
    Array<{ id: number; device_id: string; task_id: string; task_title: string | null }>
  >([])
  const [attachments, setAttachments] = useState<CloudLoopItemAttachment[]>([])
  const [collaborators, setCollaborators] = useState<CloudLoopItemCollaborator[]>([])
  const [projectMembers, setProjectMembers] = useState<CloudProjectMember[]>([])
  const [addingCollaborator, setAddingCollaborator] = useState(false)
  const [selectedCollaboratorId, setSelectedCollaboratorId] = useState<number | null>(null)
  const [collaboratorBusy, setCollaboratorBusy] = useState(false)
  const [collaboratorError, setCollaboratorError] = useState<string | null>(null)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [title, setTitle] = useState(item.title)
  const normalizedItemDescription = normalizeTaskDescription(item.description)
  const [description, setDescription] = useState(normalizedItemDescription)
  const [status, setStatus] = useState(item.status)
  const [priority, setPriority] = useState(item.priority)
  const [parentId, setParentId] = useState(item.parent_id ?? '')
  const [assigneeId, setAssigneeId] = useState(
    item.assignee_user_id ? String(item.assignee_user_id) : ''
  )
  const [dueDate, setDueDate] = useState(item.due_at?.slice(0, 10) ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    void Promise.all([
      api.listDeliveries(item.id),
      api.listTaskBindings(item.id),
      api.listLoopItemAttachments(item.id),
      api.listLoopItemCollaborators(item.id),
      api.listCloudProjectMembers(item.cloud_project_id),
    ]).then(
      ([
        deliveryResponse,
        taskResponse,
        attachmentResponse,
        collaboratorResponse,
        memberResponse,
      ]) => {
        setDeliveries(deliveryResponse.items)
        setTasks(taskResponse)
        setAttachments(attachmentResponse)
        setCollaborators(collaboratorResponse)
        setProjectMembers(memberResponse)
      }
    )
  }, [api, item.cloud_project_id, item.id])

  const availableCollaborators = projectMembers.filter(
    member => !collaborators.some(collaborator => collaborator.user_id === member.user_id)
  )
  const excludedParentIds = descendantIds(allItems, item.id)
  excludedParentIds.add(item.id)
  const parentOptions = allItems.filter(candidate => !excludedParentIds.has(candidate.id))
  const childItems = allItems.filter(candidate => candidate.parent_id === item.id)
  const dirty =
    title.trim() !== item.title ||
    description !== normalizedItemDescription ||
    status !== item.status ||
    priority !== item.priority ||
    parentId !== (item.parent_id ?? '') ||
    assigneeId !== (item.assignee_user_id ? String(item.assignee_user_id) : '') ||
    dueDate !== (item.due_at?.slice(0, 10) ?? '')

  async function saveDetails() {
    if (!dirty || !title.trim() || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      onUpdated(
        await api.updateLoopItem(item.id, {
          version: item.version,
          title: title.trim(),
          description,
          status,
          priority,
          parent_id: parentId || null,
          assignee_user_id: assigneeId ? Number(assigneeId) : null,
          due_at: dueDate || null,
        })
      )
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : '保存任务失败')
    } finally {
      setSaving(false)
    }
  }
  async function addCollaborator() {
    if (!selectedCollaboratorId || collaboratorBusy) return
    setCollaboratorBusy(true)
    setCollaboratorError(null)
    try {
      const collaborator = await api.addLoopItemCollaborator(item.id, selectedCollaboratorId)
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
    if (collaboratorBusy) return
    setCollaboratorBusy(true)
    setCollaboratorError(null)
    try {
      await api.removeLoopItemCollaborator(item.id, collaborator.user_id)
      setCollaborators(current => current.filter(entry => entry.id !== collaborator.id))
    } catch (cause) {
      setCollaboratorError(cause instanceof Error ? cause.message : '移除参与者失败')
    } finally {
      setCollaboratorBusy(false)
    }
  }

  async function addAttachments(files: FileList | null) {
    if (!files?.length || attachmentBusy) return
    setAttachmentBusy(true)
    setAttachmentError(null)
    try {
      const uploaded = await Promise.all(
        Array.from(files).map(file => api.addLoopItemAttachment(item.id, file))
      )
      setAttachments(current => [...uploaded.reverse(), ...current])
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '附件上传失败')
    } finally {
      setAttachmentBusy(false)
    }
  }

  async function openAttachment(attachment: CloudLoopItemAttachment) {
    const access = await api.accessLoopItemAttachment(attachment.id)
    window.open(access.url, '_blank', 'noopener,noreferrer')
  }

  async function removeAttachment(attachment: CloudLoopItemAttachment) {
    setAttachmentBusy(true)
    setAttachmentError(null)
    try {
      await api.deleteLoopItemAttachment(attachment.id)
      setAttachments(current => current.filter(item => item.id !== attachment.id))
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '附件删除失败')
    } finally {
      setAttachmentBusy(false)
    }
  }

  if (selectedDelivery) {
    return (
      <aside className="fixed inset-y-0 right-0 z-modal flex w-full min-w-0 flex-col border-l border-border bg-background shadow-xl md:w-[calc(100%-248px)]">
        <header className="flex h-12 items-center border-b border-border px-4">
          <button
            type="button"
            onClick={() => setSelectedDelivery(null)}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-hover"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 返回
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="h-7 w-7 rounded-md hover:bg-hover">
            <X className="mx-auto h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <p className="font-mono text-xs text-text-muted">{item.id} · 已交付</p>
          <h2 className="heading-md mt-2">{item.title}</h2>
          <article className="mt-6 whitespace-pre-wrap rounded-md bg-muted/40 p-4 text-sm leading-6 text-text-primary">
            {selectedDelivery.markdown || '无交付说明'}
          </article>
          <h3 className="mt-6 text-xs font-semibold text-text-secondary">附件</h3>
          <div className="mt-2 divide-y divide-border rounded-md border border-border">
            {selectedDelivery.assets.map(asset => (
              <div key={asset.id} className="flex h-10 items-center gap-2 px-3 text-sm">
                <File className="h-4 w-4 text-text-muted" />
                <span className="min-w-0 flex-1 truncate">{asset.relative_path}</span>
                <span className="text-xs text-text-muted">{asset.size_bytes} B</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside
      data-testid="cloud-todo-detail"
      className={cn(
        'fixed inset-y-0 right-0 z-modal flex w-full min-w-0 flex-col overflow-hidden border-l border-border bg-background shadow-xl',
        fullScreen ? 'md:w-full' : 'md:w-[calc(100%-248px)]'
      )}
    >
      <span className="sr-only">任务详情</span>
      <header className="flex h-16 shrink-0 items-center px-6">
        <div className="flex items-center gap-4 text-text-muted">
          <button
            type="button"
            data-testid="cloud-todo-detail-close"
            aria-label="关闭任务详情"
            title="关闭任务详情"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-hover hover:text-text-primary"
          >
            <MoveRight className="mx-auto h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="全屏显示"
            title="全屏显示"
            onClick={() => setFullScreen(current => !current)}
            className="h-8 w-8 rounded-md hover:bg-hover hover:text-text-primary"
          >
            <Maximize2 className="mx-auto h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="切换详情布局"
            title="切换详情布局"
            className="h-8 w-8 rounded-md hover:bg-hover hover:text-text-primary"
          >
            <PanelRight className="mx-auto h-4 w-4" />
          </button>
        </div>
        <span className="flex-1" />
        {dirty && (
          <button
            type="button"
            data-testid="cloud-todo-save"
            disabled={!title.trim() || saving}
            onClick={() => void saveDetails()}
            className="mr-2 h-8 rounded-md bg-text-primary px-4 text-sm font-medium text-background disabled:opacity-50"
          >
            {saving ? '正在保存…' : '保存'}
          </button>
        )}
        <button
          type="button"
          aria-label="复制任务编号"
          title="复制任务编号"
          onClick={() => void navigator.clipboard?.writeText(item.id)}
          className="h-8 w-8 rounded-md text-text-muted hover:bg-hover hover:text-text-primary"
        >
          <Copy className="mx-auto h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="更多操作"
          title="更多操作"
          className="ml-2 h-8 w-8 rounded-md border border-border text-text-muted hover:bg-hover hover:text-text-primary"
        >
          <MoreHorizontal className="mx-auto h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-[1240px] px-10 pb-16 pt-12 xl:px-16">
          <p className="font-mono text-sm text-text-muted">{item.id}</p>
          <textarea
            data-testid="cloud-todo-detail-title"
            aria-label="任务标题"
            value={title}
            onChange={event => setTitle(event.target.value)}
            rows={1}
            maxLength={255}
            className="heading-lg mt-5 block w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-text-primary outline-none placeholder:text-text-muted"
          />

          <div className="mt-6 grid grid-cols-2 md:grid-cols-5">
            <label className="group relative flex min-w-0 items-center gap-2 border-b border-border px-3 py-3 text-sm text-text-secondary md:border-b-0 md:border-r">
              <CircleDot className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="sr-only">状态</span>
              <select
                data-testid="cloud-todo-detail-status"
                aria-label="状态"
                value={status}
                onChange={event => setStatus(event.target.value as CloudLoopItem['status'])}
                className="h-8 min-w-0 flex-1 appearance-none bg-transparent pr-4 outline-none"
              >
                {columns.map(column => (
                  <option key={column.status} value={column.status}>
                    {column.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </label>
            <label className="group relative flex min-w-0 items-center gap-2 border-b border-border px-3 py-3 text-sm text-text-secondary md:border-b-0 md:border-r">
              <SignalHigh
                className={cn(
                  'h-4 w-4 shrink-0',
                  priority === 'urgent' || priority === 'high' ? 'text-warning' : 'text-text-muted'
                )}
              />
              <span className="sr-only">优先级</span>
              <select
                data-testid="cloud-todo-detail-priority"
                aria-label="优先级"
                value={priority}
                onChange={event => setPriority(event.target.value as CloudLoopItem['priority'])}
                className="h-8 min-w-0 flex-1 appearance-none bg-transparent pr-4 outline-none"
              >
                <option value="none">无优先级</option>
                <option value="low">低</option>
                <option value="medium">普通</option>
                <option value="high">高</option>
                <option value="urgent">紧急</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </label>
            <label className="group relative flex min-w-0 items-center gap-2 border-b border-border px-3 py-3 text-sm text-text-secondary md:border-b-0 md:border-r">
              <Users className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="sr-only">负责人</span>
              <select
                data-testid="cloud-todo-detail-assignee"
                aria-label="负责人"
                value={assigneeId}
                onChange={event => setAssigneeId(event.target.value)}
                className="h-8 min-w-0 flex-1 appearance-none bg-transparent pr-4 outline-none"
              >
                <option value="">添加负责人</option>
                {projectMembers.map(member => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.user_name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </label>
            <label className="flex min-w-0 items-center gap-2 px-3 py-3 text-sm text-text-secondary md:border-r">
              <CalendarDays className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="sr-only">截止时间</span>
              <input
                data-testid="cloud-todo-detail-due-date"
                aria-label="截止时间"
                type="date"
                value={dueDate}
                onChange={event => setDueDate(event.target.value)}
                className="h-8 min-w-0 flex-1 bg-transparent outline-none"
              />
            </label>
            <label className="group relative col-span-2 flex min-w-0 items-center gap-2 px-3 py-3 text-sm text-text-secondary md:col-span-1">
              <Network className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="sr-only">父任务</span>
              <select
                data-testid="cloud-todo-detail-parent"
                aria-label="父任务"
                value={parentId}
                onChange={event => setParentId(event.target.value)}
                className="h-8 min-w-0 flex-1 appearance-none bg-transparent pr-4 outline-none"
              >
                <option value="">无父任务</option>
                {parentOptions.map(candidate => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id} · {candidate.title}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </label>
          </div>

          <div className="mt-8 min-h-48">
            <TaskDescriptionEditor value={description} onChange={setDescription} />
          </div>
          {saveError && <p className="mt-2 text-xs text-destructive">{saveError}</p>}

          <section className="mt-8 border-t border-border pt-6" data-testid="cloud-todo-children">
            <div className="flex h-8 items-center">
              <h3 className="text-sm font-medium text-text-secondary">
                子任务 <span className="font-normal text-text-muted">{childItems.length}</span>
              </h3>
              <button
                type="button"
                data-testid="cloud-todo-detail-add-child"
                onClick={onAddChild}
                className="ml-auto flex h-8 items-center gap-1 rounded-md px-2 text-sm text-text-secondary hover:bg-hover"
              >
                <Plus className="h-3.5 w-3.5" /> 新建子任务
              </button>
            </div>
            {childItems.length === 0 ? (
              <p className="py-4 text-sm text-text-muted">暂无子任务</p>
            ) : (
              <div className="mt-2 divide-y divide-border border-y border-border">
                {childItems.map(child => (
                  <div key={child.id} className="flex min-h-11 items-center gap-3 py-2 text-sm">
                    <CircleDot className="h-4 w-4 shrink-0 text-text-muted" />
                    <span className="font-mono text-xs text-text-muted">{child.id}</span>
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    <span className="text-xs text-text-muted">
                      {columns.find(column => column.status === child.status)?.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section
            className="mt-8 border-t border-border pt-6"
            data-testid="cloud-todo-collaborators"
          >
            <div className="flex h-7 items-center">
              <h3 className="text-xs font-semibold text-text-secondary">
                参与者 <span className="font-normal text-text-muted">{collaborators.length}</span>
              </h3>
              <button
                type="button"
                data-testid="cloud-todo-add-collaborator"
                onClick={() => {
                  setAddingCollaborator(current => !current)
                  setCollaboratorError(null)
                }}
                className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-hover"
              >
                <Plus className="h-3.5 w-3.5" />
                添加参与者
              </button>
            </div>
            {addingCollaborator && (
              <div className="mt-2 flex items-center gap-2 rounded-md border border-border p-2">
                <select
                  data-testid="cloud-todo-collaborator-select"
                  value={selectedCollaboratorId ?? ''}
                  onChange={event => setSelectedCollaboratorId(Number(event.target.value) || null)}
                  className="h-8 min-w-0 flex-1 rounded-md bg-muted/50 px-2 text-sm outline-none focus:ring-1 focus:ring-focus"
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
                  className="h-8 rounded-md bg-text-primary px-3 text-xs font-medium text-background disabled:opacity-40"
                >
                  添加
                </button>
              </div>
            )}
            <div className="mt-2 divide-y divide-border rounded-md border border-border">
              {collaborators.length === 0 ? (
                <p className="px-3 py-3 text-xs text-text-muted">暂无参与者</p>
              ) : (
                collaborators.map(collaborator => (
                  <div key={collaborator.id} className="flex h-10 items-center gap-2 px-3 text-sm">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium text-text-secondary">
                      {collaborator.user_name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{collaborator.user_name}</span>
                    {collaborator.source !== 'manual' && (
                      <span className="text-xs text-text-muted">自动加入</span>
                    )}
                    <button
                      type="button"
                      aria-label={`移除参与者 ${collaborator.user_name}`}
                      disabled={collaboratorBusy}
                      onClick={() => void removeCollaborator(collaborator)}
                      className="h-7 w-7 rounded-md text-text-muted hover:bg-hover hover:text-text-primary disabled:opacity-40"
                    >
                      <X className="mx-auto h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
            {collaboratorError && <p className="mt-2 text-xs text-danger">{collaboratorError}</p>}
          </section>
          <div className="mt-8 border-t border-border pt-6">
            <TodoAttachmentSection
              attachments={attachments}
              busy={attachmentBusy}
              error={attachmentError}
              editable
              onAdd={addAttachments}
              onOpen={openAttachment}
              onRemove={removeAttachment}
            />
          </div>
          <h3 className="mt-8 border-t border-border pt-6 text-sm font-medium text-text-secondary">
            本地执行
          </h3>
          <div className="mt-2 space-y-2">
            {tasks.length === 0 ? (
              <p className="rounded-md bg-muted/40 px-3 py-3 text-xs text-text-muted">
                尚未关联本地任务
              </p>
            ) : (
              tasks.map(task => (
                <div
                  key={task.id}
                  className="flex h-10 items-center rounded-md bg-muted/40 px-3 text-xs"
                >
                  <Link2 className="mr-2 h-4 w-4 text-text-muted" />
                  <span className="truncate" title={task.task_title || task.task_id}>
                    {task.task_title || task.task_id}
                  </span>
                  <span className="ml-auto text-text-muted">{task.device_id}</span>
                </div>
              ))
            )}
          </div>
          <h3 className="mt-8 border-t border-border pt-6 text-sm font-medium text-text-secondary">
            交付
          </h3>
          <div className="mt-2 space-y-2">
            {deliveries.map(delivery => (
              <button
                key={delivery.id}
                type="button"
                onClick={() => void api.getDelivery(delivery.id).then(setSelectedDelivery)}
                className="flex h-11 w-full items-center rounded-md border border-border px-3 text-left text-xs hover:bg-hover"
              >
                <FileText className="mr-2 h-4 w-4 text-text-muted" />
                <span>{delivery.assets.length} 个附件</span>
                <span className="ml-auto text-text-muted">
                  {delivery.delivered_at?.slice(0, 10)}
                </span>
                <ChevronRight className="ml-2 h-3.5 w-3.5 text-text-muted" />
              </button>
            ))}
          </div>
        </main>
      </div>
      <footer className="flex h-16 shrink-0 items-center justify-end gap-2 border-t border-border px-6">
        <button
          type="button"
          data-testid="cloud-todo-start-task"
          onClick={onStart}
          className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background"
        >
          {item.status === 'completed' ? '开启后续任务' : '开启本地任务'}
        </button>
      </footer>
    </aside>
  )
}

export function CloudTodoWorkspace({
  user,
  localProjects,
  services,
  onRunTodo,
  onOpenRuntimeTask,
}: CloudTodoWorkspaceProps) {
  const api = services.deliveryApi!
  const [projects, setProjects] = useState<CloudProject[]>([])
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>({})
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [items, setItems] = useState<CloudLoopItem[]>([])
  const [myWork, setMyWork] = useState<CloudMyWorkItem[]>([])
  const [rootView, setRootView] = useState<RootView>('projects')
  const [projectView, setProjectView] = useState<ProjectView>('board')
  const [selectedItem, setSelectedItem] = useState<CloudLoopItem | null>(null)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createTodoOpen, setCreateTodoOpen] = useState(false)
  const [createTodoParent, setCreateTodoParent] = useState<CloudLoopItem | null>(null)
  const [createTodoStatus, setCreateTodoStatus] = useState<CloudLoopItem['status']>('inbox')
  const [boardParentId, setBoardParentId] = useState<string | null>(null)
  const [startItem, setStartItem] = useState<CloudLoopItem | null>(null)
  const [activeDragItemId, setActiveDragItemId] = useState<string | null>(null)
  const boardSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null
  const boardParent = items.find(item => item.id === boardParentId) ?? null
  const boardBreadcrumb: CloudLoopItem[] = []
  let breadcrumbItem = boardParent
  const breadcrumbIds = new Set<string>()
  while (breadcrumbItem && !breadcrumbIds.has(breadcrumbItem.id)) {
    boardBreadcrumb.unshift(breadcrumbItem)
    breadcrumbIds.add(breadcrumbItem.id)
    breadcrumbItem = items.find(candidate => candidate.id === breadcrumbItem?.parent_id) ?? null
  }

  function selectProject(projectId: string | null) {
    setSelectedProjectId(projectId)
    setBoardParentId(null)
  }

  function openTodoCreation(
    parent: CloudLoopItem | null,
    status: CloudLoopItem['status'] = 'inbox'
  ) {
    setCreateTodoParent(parent)
    setCreateTodoStatus(status)
    setCreateTodoOpen(true)
  }

  useEffect(() => {
    let active = true
    void api
      .listCloudProjects()
      .then(async response => {
        const counts = await Promise.all(
          response.items.map(
            async project =>
              [project.id, (await api.listLoopItems(project.id)).items.length] as const
          )
        )
        if (!active) return
        setProjects(response.items)
        setProjectCounts(Object.fromEntries(counts))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api])
  useEffect(() => {
    if (!selectedProjectId) return
    let active = true
    const refreshItems = () => {
      void api.listLoopItems(selectedProjectId).then(response => {
        if (!active) return
        setItems(response.items)
        setSelectedItem(current =>
          current ? (response.items.find(item => item.id === current.id) ?? null) : null
        )
      })
    }
    refreshItems()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshItems()
    }, 15_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [api, selectedProjectId])
  useEffect(() => {
    if (rootView === 'my-work') void api.listMyWork().then(response => setMyWork(response.items))
  }, [api, rootView])

  async function startTask(project: ProjectWithTasks, item: CloudLoopItem, message: string) {
    if (!onRunTodo) return
    const address = await onRunTodo({
      project,
      message,
      goal: item.title,
      attachments: [] as Attachment[],
      collaborationMode: 'default',
      cloudProjectId: item.cloud_project_id,
    })
    if (!address) return
    await api.bindTask(item.id, address, item.title)
    if (item.status === 'completed') {
      const reopened = await api.updateLoopItem(item.id, {
        version: item.version,
        status: 'in_progress',
      })
      setItems(current => current.map(entry => (entry.id === reopened.id ? reopened : entry)))
    }
    setStartItem(null)
    setSelectedItem(null)
    await onOpenRuntimeTask?.(address)
  }

  async function moveItem(
    itemId: string,
    status: CloudLoopItem['status'],
    beforeItemId: string | null = null
  ) {
    const item = items.find(candidate => candidate.id === itemId)
    if (!item || item.status === status) return
    const previousItems = items
    const nextItem = { ...item, status }
    const remainingItems = items.filter(candidate => candidate.id !== itemId)
    const beforeIndex = beforeItemId
      ? remainingItems.findIndex(candidate => candidate.id === beforeItemId)
      : -1
    const insertIndex = beforeIndex >= 0 ? beforeIndex : remainingItems.length
    const nextItems = [...remainingItems]
    nextItems.splice(insertIndex, 0, nextItem)
    setItems(nextItems)
    setBoardError(null)
    try {
      const updated = await api.updateLoopItem(item.id, {
        version: item.version,
        status,
      })
      setItems(current =>
        current.map(candidate => (candidate.id === updated.id ? updated : candidate))
      )
      setSelectedItem(current => (current?.id === updated.id ? updated : current))
    } catch (cause) {
      setItems(previousItems)
      setBoardError(cause instanceof Error ? cause.message : '移动任务失败')
    }
  }

  function finishBoardDrop(event: DragEndEvent) {
    setActiveDragItemId(null)
    const status = boardStatusFromDropId(event.over?.id)
    if (status) void moveItem(String(event.active.id), status)
  }

  return (
    <div
      className="absolute inset-0 z-content flex min-h-0 w-full overflow-hidden bg-background text-text-primary"
      data-testid="cloud-todo-workspace"
    >
      <aside
        className={cn(
          'relative shrink-0 overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200',
          sidebarCollapsed ? 'w-0 border-r-0' : 'w-[248px]'
        )}
      >
        <div className="flex h-full w-[248px] flex-col">
          <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
          <div
            data-testid="cloud-todo-sidebar-chrome-controls"
            className="relative z-10 ml-[92px] flex h-[38px] shrink-0 items-center gap-1"
          >
            <DesktopWindowControls
              sidebarCollapsed={false}
              onToggleSidebar={() => setSidebarCollapsed(true)}
              className="gap-1"
              toggleTestId="cloud-todo-collapse-sidebar"
            />
            <DesktopAppSwitcher
              activeApp="todo"
              onNavigate={app =>
                navigateTo(
                  app === 'wework'
                    ? '/'
                    : app === 'todo'
                      ? '/todo'
                      : app === 'wegent'
                        ? '/app/wegent'
                        : '/apps'
                )
              }
              testIds={{
                wework: 'cloud-todo-app-wework',
                todo: 'cloud-todo-app-current',
                apps: 'cloud-todo-app-apps',
                wegent: 'cloud-todo-app-wegent',
              }}
            />
          </div>
          <nav className="space-y-1 px-2">
            <button
              type="button"
              onClick={() => {
                setRootView('projects')
                selectProject(null)
                setSelectedItem(null)
              }}
              className={cn(
                'flex h-8 w-full items-center gap-3 rounded-md px-3 text-sm',
                rootView === 'projects'
                  ? 'bg-selected font-medium'
                  : 'text-text-secondary hover:bg-hover'
              )}
            >
              <Cloud className="h-4 w-4" /> 项目空间
            </button>
            <button
              type="button"
              data-testid="cloud-my-work"
              onClick={() => setRootView('my-work')}
              className={cn(
                'flex h-8 w-full items-center gap-3 rounded-md px-3 text-sm',
                rootView === 'my-work'
                  ? 'bg-selected font-medium'
                  : 'text-text-secondary hover:bg-hover'
              )}
            >
              <CircleUserRound className="h-4 w-4" /> 我的工作
            </button>
            <button
              type="button"
              data-testid="cloud-search-toggle"
              onClick={() => setSearchOpen(current => !current)}
              className="flex h-8 w-full items-center gap-3 rounded-md px-3 text-sm text-text-secondary hover:bg-hover"
            >
              <Search className="h-4 w-4" /> 搜索
            </button>
          </nav>
          {searchOpen && (
            <div className="px-2 pt-2">
              <input
                autoFocus
                data-testid="cloud-search-input"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder="搜索项目空间或任务"
                className="h-8 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-focus"
              />
            </div>
          )}
          <div className="mt-8 flex items-center px-5 text-xs font-semibold text-text-muted">
            项目空间
            <button
              type="button"
              data-testid="cloud-project-add"
              onClick={() => setCreateProjectOpen(true)}
              className="ml-auto h-6 w-6 rounded hover:bg-hover"
            >
              <Plus className="mx-auto h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2">
            {projects
              .filter(project =>
                `${project.name} ${project.project_key} ${project.description}`
                  .toLowerCase()
                  .includes(searchQuery.trim().toLowerCase())
              )
              .map(project => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => {
                    selectProject(project.id)
                    setRootView('projects')
                    setProjectView('board')
                    setSelectedItem(null)
                  }}
                  className={cn(
                    'flex h-8 w-full items-center gap-3 rounded-md px-3 text-sm',
                    rootView === 'projects' && selectedProjectId === project.id
                      ? 'bg-selected font-medium'
                      : 'text-text-secondary hover:bg-hover'
                  )}
                >
                  <Folder className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                  {projectCounts[project.id] ? (
                    <span className="text-xs text-text-muted">{projectCounts[project.id]}</span>
                  ) : null}
                </button>
              ))}
          </div>
          <div className="flex h-14 items-center border-t border-border px-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
              <CircleUserRound className="h-4 w-4" />
            </span>
            <span className="ml-3 min-w-0">
              <span className="block truncate text-xs font-medium">{user.user_name}</span>
              <span className="block truncate text-xs text-text-muted">{user.email}</span>
            </span>
          </div>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {!selectedProject && (
          <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
        )}
        {sidebarCollapsed && (
          <div
            data-testid="cloud-todo-collapsed-chrome-controls"
            className="absolute left-[92px] top-0 z-20 flex h-[38px] items-center gap-1"
          >
            <DesktopWindowControls
              sidebarCollapsed
              onToggleSidebar={() => setSidebarCollapsed(false)}
              className="gap-1"
              toggleTestId="cloud-todo-expand-sidebar"
            />
            <DesktopAppSwitcher
              activeApp="todo"
              onNavigate={app =>
                navigateTo(
                  app === 'wework'
                    ? '/'
                    : app === 'todo'
                      ? '/todo'
                      : app === 'wegent'
                        ? '/app/wegent'
                        : '/apps'
                )
              }
              testIds={{
                wework: 'cloud-todo-collapsed-app-wework',
                todo: 'cloud-todo-collapsed-app-current',
                apps: 'cloud-todo-collapsed-app-apps',
                wegent: 'cloud-todo-collapsed-app-wegent',
              }}
            />
          </div>
        )}
        {rootView === 'my-work' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-7">
            <h1 className="heading-lg">我的工作</h1>
            <p className="mt-1 text-xs text-text-muted">
              跨项目空间查看需要你处理的任务和本地执行。
            </p>
            <div className="mt-8 grid grid-cols-2 gap-4">
              {[
                [
                  '需要我处理',
                  myWork.filter(item => !item.has_active_task && item.status !== 'completed'),
                ],
                [
                  '正在执行',
                  myWork.filter(item => item.has_active_task && item.status === 'in_progress'),
                ],
                ['等待确认', myWork.filter(item => item.status === 'in_review')],
                ['已完成', myWork.filter(item => item.status === 'completed')],
              ].map(([label, group]) => (
                <section key={label as string} className="min-h-56 rounded-md border border-border">
                  <header className="border-b border-border px-4 py-3">
                    <h2 className="text-sm font-semibold">{label as string}</h2>
                  </header>
                  <div className="space-y-2 p-3">
                    {(group as CloudMyWorkItem[]).map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          selectProject(item.cloud_project_id)
                          setRootView('projects')
                          setSelectedItem(item)
                        }}
                        className="flex h-12 w-full items-center rounded-md bg-muted/40 px-3 text-left hover:bg-hover"
                      >
                        <span className="font-mono text-xs text-text-muted">{item.id}</span>
                        <span className="ml-3 min-w-0 flex-1 truncate text-sm">{item.title}</span>
                        <span className="text-xs text-text-muted">{item.project_name}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <p className="mt-6 text-xs text-text-muted">
              这里只汇总与你相关的项目任务；未关联任务的普通本地会话不会出现。
            </p>
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            正在加载项目空间…
          </div>
        ) : !selectedProject && projects.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center">
            <Cloud className="h-8 w-8 text-text-muted" />
            <h1 className="heading-md mt-4">创建第一个项目空间</h1>
            <p className="mt-2 text-sm text-text-muted">
              共享任务、文件与交付，让成员和 AI 在不同本地工作区协作。
            </p>
            <button
              type="button"
              onClick={() => setCreateProjectOpen(true)}
              className="mt-5 h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background"
            >
              新建项目空间
            </button>
          </div>
        ) : !selectedProject ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-7">
            <div className="flex items-start">
              <div>
                <h1 className="heading-lg">项目空间</h1>
                <p className="mt-1 text-xs text-text-muted">
                  多人和 AI 在各自本地工作区协作，共享任务、文件与交付。
                </p>
              </div>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setCreateProjectOpen(true)}
                className="flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background"
              >
                <Plus className="h-3.5 w-3.5" /> 新建项目空间
              </button>
            </div>
            <div className="mt-8 overflow-hidden rounded-md border border-border">
              <div className="grid h-9 grid-cols-[minmax(0,1fr)_100px_120px_100px] items-center border-b border-border bg-muted/30 px-4 text-xs text-text-muted">
                <span>项目</span>
                <span>任务</span>
                <span>更新时间</span>
                <span>成员</span>
              </div>
              {projects
                .filter(project =>
                  `${project.name} ${project.project_key} ${project.description}`
                    .toLowerCase()
                    .includes(searchQuery.trim().toLowerCase())
                )
                .map(project => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => selectProject(project.id)}
                    className="grid h-16 w-full grid-cols-[minmax(0,1fr)_100px_120px_100px] items-center border-b border-border px-4 text-left last:border-b-0 hover:bg-hover"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Folder className="h-4 w-4 text-text-muted" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{project.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-text-muted">
                          {project.description || `${project.project_key} 项目空间`}
                        </span>
                      </span>
                    </span>
                    <span className="text-xs text-text-secondary">
                      {projectCounts[project.id] ?? '—'}
                    </span>
                    <span className="text-xs text-text-muted">
                      {project.updated_at.slice(0, 10)}
                    </span>
                    <span className="flex items-center text-xs text-text-muted">
                      <CircleUserRound className="mr-1.5 h-3.5 w-3.5" />
                      成员
                    </span>
                  </button>
                ))}
            </div>
            <p className="mt-6 text-xs text-text-muted">
              项目空间只包含共享协作数据；本地目录、Git 与未关联会话仍留在成员设备上。
            </p>
          </div>
        ) : (
          <>
            <header
              data-testid="cloud-project-header"
              className={cn(
                'relative z-10 flex h-[38px] shrink-0 items-center border-b border-border/40 bg-background pr-6',
                sidebarCollapsed ? 'pl-[240px]' : 'pl-6'
              )}
            >
              <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />
              <Folder className="relative z-10 h-4 w-4 text-text-muted" />
              <span className="relative z-10 ml-2 text-sm font-semibold">
                {selectedProject.name}
              </span>
              <nav className="relative z-10 ml-8 flex h-full items-center gap-5">
                <button
                  type="button"
                  data-testid="cloud-project-board-view"
                  onClick={() => setProjectView('board')}
                  className={cn(
                    'h-full border-b-2 px-1 text-xs',
                    projectView === 'board'
                      ? 'border-text-primary font-semibold'
                      : 'border-transparent text-text-muted'
                  )}
                >
                  事项
                </button>
                <button
                  type="button"
                  onClick={() => setProjectView('files')}
                  className={cn(
                    'h-full border-b-2 px-1 text-xs',
                    projectView === 'files'
                      ? 'border-text-primary font-semibold'
                      : 'border-transparent text-text-muted'
                  )}
                >
                  文件
                </button>
              </nav>
              <span className="flex-1" />
              <button
                type="button"
                data-testid="cloud-project-settings"
                onClick={() => setProjectSettingsOpen(true)}
                className="relative z-10 h-8 w-8 rounded-md hover:bg-hover"
                aria-label="项目成员"
              >
                <MoreHorizontal className="mx-auto h-4 w-4" />
              </button>
              {projectView !== 'files' && (
                <button
                  type="button"
                  data-testid="cloud-todo-add"
                  onClick={() => openTodoCreation(projectView === 'board' ? boardParent : null)}
                  className="relative z-10 ml-2 flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background"
                >
                  <Plus className="h-3.5 w-3.5" /> 新建任务
                </button>
              )}
            </header>
            {projectView === 'files' ? (
              <CloudFilesView api={api} project={selectedProject} />
            ) : (
              <div className="min-h-0 flex-1 overflow-x-auto p-6">
                <nav
                  data-testid="cloud-todo-board-breadcrumb"
                  className="mb-3 flex h-8 min-w-[1050px] items-center gap-1 text-xs"
                  aria-label="任务层级"
                >
                  <button
                    type="button"
                    onClick={() => setBoardParentId(null)}
                    className={cn(
                      'rounded-md px-2 py-1 hover:bg-hover',
                      !boardParent && 'font-medium text-text-primary'
                    )}
                  >
                    顶层任务
                  </button>
                  {boardBreadcrumb.map(parent => (
                    <span key={parent.id} className="flex min-w-0 items-center gap-1">
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                      <button
                        type="button"
                        data-testid={`cloud-todo-board-breadcrumb-${parent.id}`}
                        onClick={() => setBoardParentId(parent.id)}
                        className={cn(
                          'max-w-48 truncate rounded-md px-2 py-1 hover:bg-hover',
                          parent.id === boardParentId && 'font-medium text-text-primary'
                        )}
                      >
                        {parent.title}
                      </button>
                    </span>
                  ))}
                  {boardParent && (
                    <span className="ml-2 text-text-muted">仅显示当前层的直接子任务</span>
                  )}
                </nav>
                {boardError && (
                  <p className="mb-3 text-xs text-destructive" role="alert">
                    {boardError}
                  </p>
                )}
                <DndContext
                  sensors={boardSensors}
                  onDragStart={event => setActiveDragItemId(String(event.active.id))}
                  onDragCancel={() => setActiveDragItemId(null)}
                  onDragEnd={finishBoardDrop}
                >
                  <div className="flex h-[calc(100%_-_44px)] min-w-[1050px] gap-3">
                    {columns.map(column => {
                      const normalizedSearch = searchQuery.trim().toLowerCase()
                      const columnItems = items.filter(
                        item =>
                          item.parent_id === boardParentId &&
                          item.status === column.status &&
                          (!normalizedSearch ||
                            `${item.id} ${item.title} ${item.description}`
                              .toLowerCase()
                              .includes(normalizedSearch))
                      )
                      return (
                        <section
                          key={column.status}
                          data-testid={`cloud-todo-column-${column.status}`}
                          className="flex min-w-0 flex-1 flex-col"
                        >
                          <header className="flex h-9 items-center justify-between px-2 text-xs font-semibold">
                            <span className="flex min-w-0 items-center">
                              <span className="mr-2 h-2 w-2 rounded-full bg-text-muted" />
                              {column.label}
                              <span className="ml-2 font-normal text-text-muted">
                                {columnItems.length}
                              </span>
                            </span>
                            <button
                              type="button"
                              data-testid={`cloud-todo-column-add-${column.status}`}
                              onClick={() => openTodoCreation(boardParent, column.status)}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
                              aria-label={`在${column.label}中新建任务`}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </header>
                          <TodoColumnDropzone status={column.status}>
                            {columnItems.map(item => (
                              <DraggableTodoCard
                                key={item.id}
                                item={item}
                                childCount={
                                  items.filter(child => child.parent_id === item.id).length
                                }
                                onClick={() => setSelectedItem(item)}
                                onAddChild={() => openTodoCreation(item)}
                                onOpenChildren={() => setBoardParentId(item.id)}
                              />
                            ))}
                            <button
                              type="button"
                              data-testid={`cloud-todo-column-bottom-add-${column.status}`}
                              onClick={() => openTodoCreation(boardParent, column.status)}
                              className="sticky bottom-0 z-10 flex h-9 w-full items-center gap-2 rounded-md bg-muted px-2 text-sm text-text-secondary hover:bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
                              aria-label={`在${column.label}中新建工作项`}
                            >
                              <Plus className="h-4 w-4" />
                              新建工作项
                            </button>
                          </TodoColumnDropzone>
                        </section>
                      )
                    })}
                  </div>
                  <DragOverlay dropAnimation={null}>
                    {activeDragItemId ? (
                      <div className="w-[210px] rotate-1 rounded-md border border-border bg-background p-3 text-left shadow-lg">
                        <TodoCardContent item={items.find(item => item.id === activeDragItemId)!} />
                      </div>
                    ) : null}
                  </DragOverlay>
                </DndContext>
              </div>
            )}
          </>
        )}
      </main>

      {selectedItem && (
        <TodoDetail
          key={`${selectedItem.id}:${selectedItem.version}`}
          api={api}
          item={selectedItem}
          allItems={items}
          onClose={() => setSelectedItem(null)}
          onAddChild={() => openTodoCreation(selectedItem)}
          onStart={() => setStartItem(selectedItem)}
          onUpdated={updated => {
            setItems(current => current.map(item => (item.id === updated.id ? updated : item)))
            setSelectedItem(updated)
          }}
        />
      )}
      {createProjectOpen && (
        <ProjectDialog
          api={api}
          onClose={() => setCreateProjectOpen(false)}
          onCreated={project => {
            setProjects(current => [project, ...current])
            selectProject(project.id)
            setCreateProjectOpen(false)
          }}
        />
      )}
      {createTodoOpen && selectedProject && (
        <TodoDialog
          api={api}
          project={selectedProject}
          parent={createTodoParent}
          initialStatus={createTodoStatus}
          allItems={items}
          onClose={() => {
            setCreateTodoOpen(false)
            setCreateTodoParent(null)
          }}
          onCreated={item => {
            setItems(current => [...current, item])
            setProjectCounts(current => ({
              ...current,
              [item.cloud_project_id]: (current[item.cloud_project_id] ?? 0) + 1,
            }))
            setCreateTodoOpen(false)
            setCreateTodoParent(null)
          }}
        />
      )}
      {startItem && (
        <StartTaskDialog
          item={startItem}
          projects={localProjects}
          onClose={() => setStartItem(null)}
          onStart={(project, message) => startTask(project, startItem, message)}
        />
      )}
      {projectSettingsOpen && selectedProject && (
        <CloudProjectSettingsDialog
          api={api}
          project={selectedProject}
          onClose={() => setProjectSettingsOpen(false)}
        />
      )}
    </div>
  )
}
