import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  ArrowLeft,
  Calendar,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleUserRound,
  Copy,
  Download,
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
import type { AITableApi } from '@/api/aitable'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { cn } from '@/lib/utils'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'
import { TagEditor } from './TagEditor'
import { normalizeTaskDescription } from './taskDescription'
import { AITableTaskFields } from './AITableTaskFields'
import {
  columnDotClasses,
  columns,
  memberAvatarClasses,
  memberNameById,
  priorityBadgeClasses,
} from './todoShared'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

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

const propChipClass =
  'relative inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-2.5 text-xs text-text-primary transition hover:bg-muted'
const overlayControlClass = 'absolute inset-0 h-full w-full cursor-pointer opacity-0'

function TodoAttachmentSection({
  attachments,
  busy,
  error,
  editable,
  onAdd,
  onOpen,
  onRemove,
}: {
  attachments: AttachmentRow[]
  busy: boolean
  error: string | null
  editable: boolean
  onAdd: (files: FileList | null) => Promise<void>
  onOpen?: (attachment: AttachmentRow) => Promise<void>
  onRemove: (attachment: AttachmentRow) => Promise<void>
}) {
  return (
    <section>
      <span className="flex select-none items-center gap-2 text-sm text-text-muted">
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
        <div className="mt-2 flex flex-col gap-1">
          {attachments.map(attachment => (
            <div
              key={attachment.id}
              className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition hover:bg-muted"
            >
              <File className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate text-sm">{attachment.display_name}</span>
              <span className="shrink-0 text-xs text-text-muted">
                {formatAttachmentSize(attachment.size_bytes)}
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
        <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-4 text-sm text-text-muted transition hover:bg-muted hover:text-text-secondary">
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
  onStart: () => void
}

export type TodoEditorProps = {
  api: DeliveryApi
  aitableApi?: AITableApi
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
  const [assigneeId, setAssigneeId] = useState(
    item?.assignee_user_id ? String(item.assignee_user_id) : ''
  )
  const [tags, setTags] = useState<string[]>(item?.tags ?? draft?.tags ?? [])
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
  const [addingCollaborator, setAddingCollaborator] = useState(false)
  const [selectedCollaboratorId, setSelectedCollaboratorId] = useState<number | null>(null)
  const [collaboratorBusy, setCollaboratorBusy] = useState(false)
  const [collaboratorError, setCollaboratorError] = useState<string | null>(null)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [fullScreen, setFullScreen] = useState(false)

  const editItemId = item?.id ?? null
  const editProjectId = item?.cloud_project_id ?? null
  const createProjectId = createProps?.project.id ?? null

  // Edit mode loads everything tied to the item id.
  useEffect(() => {
    if (editItemId == null || editProjectId == null) return
    void Promise.all([
      api.listDeliveries(editItemId),
      api.listTaskBindings(editItemId),
      api.listLoopItemAttachments(editItemId),
      api.listLoopItemCollaborators(editItemId),
      api.listCloudProjectMembers(editProjectId),
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
  }, [api, editItemId, editProjectId])

  // Create mode only needs the member list for the assignee select.
  useEffect(() => {
    if (createProjectId == null) return
    void api.listCloudProjectMembers(createProjectId).then(setProjectMembers)
  }, [api, createProjectId])

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
      assigneeId !== (item.assignee_user_id ? String(item.assignee_user_id) : '') ||
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
  const statusLabel = columns.find(column => column.status === status)?.label ?? ''
  const parentItem = allItems.find(candidate => candidate.id === parentId)
  const assignee = projectMembers.find(member => String(member.user_id) === assigneeId)
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
      // createLoopItem does not accept an assignee, so apply it right after.
      if (assigneeId) {
        created = await api.updateLoopItem(created.id, {
          version: created.version,
          assignee_user_id: Number(assigneeId),
        })
      }
      // Upload staged attachments after creation; a single failure must not
      // block the rest or the panel completion.
      await Promise.allSettled(
        pendingFiles.map(file => api.addLoopItemAttachment(created.id, file))
      )
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
      props.onUpdated(
        await api.updateLoopItem(current.id, {
          version: current.version,
          title: title.trim(),
          description,
          status,
          priority,
          parent_id: parentId || null,
          assignee_user_id: assigneeId ? Number(assigneeId) : null,
          due_at: dueDate || null,
          tags,
        })
      )
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
      const uploaded = await Promise.all(
        Array.from(files).map(file => api.addLoopItemAttachment(editItemId, file))
      )
      setAttachments(current => [...uploaded.reverse(), ...current])
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '附件上传失败')
    } finally {
      setAttachmentBusy(false)
    }
  }

  async function openAttachment(attachment: AttachmentRow) {
    const access = await api.accessLoopItemAttachment(attachment.id)
    window.open(access.url, '_blank', 'noopener,noreferrer')
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

  return (
    <div
      className={cn(
        'fixed inset-0 z-modal flex items-start justify-center bg-black/35 backdrop-blur-sm',
        fullScreen ? 'p-3' : 'px-6 pb-6 pt-[6vh]'
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
                'max-h-[88vh] max-w-[calc(100vw-48px)]',
                isAITableEdit ? 'w-[1080px]' : 'w-[760px]'
              )
        )}
        onKeyDown={handleKeyDown}
        onDragOver={event => event.preventDefault()}
        onDrop={handleDrop}
      >
        <span className="sr-only">{isCreate ? '新建任务' : '任务详情'}</span>
        <header className="flex shrink-0 items-center px-4 pt-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
            <Folder className="h-3.5 w-3.5" />
            {item
              ? item.id
              : `${createProps?.project.name} · ${createProps?.initialParent ? '新建子任务' : '新建任务'}`}
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

        <div className="min-h-0 flex-1 overflow-y-auto px-14 pb-6 pt-2.5">
          <textarea
            data-testid={isCreate ? 'cloud-todo-title' : 'cloud-todo-detail-title'}
            aria-label="任务标题"
            autoFocus={isCreate}
            value={title}
            onChange={event => setTitle(event.target.value)}
            rows={1}
            maxLength={255}
            placeholder="目标或事项标题"
            className="block w-full resize-none overflow-hidden border-0 bg-transparent py-1.5 text-heading-lg font-bold tracking-tight text-text-primary outline-none placeholder:text-text-muted"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={propChipClass}>
              <Circle className="h-3.5 w-3.5 text-text-muted" />
              <span className="text-text-muted">状态</span>
              <span className={cn('h-2 w-2 rounded-full', columnDotClasses[status])} />
              {statusLabel}
              <ChevronDown className="h-3 w-3 text-text-muted" />
              <select
                data-testid={isCreate ? 'cloud-todo-create-status' : 'cloud-todo-detail-status'}
                aria-label="状态"
                value={status}
                onChange={event => setStatus(event.target.value as CloudLoopItem['status'])}
                className={overlayControlClass}
              >
                {columns.map(column => (
                  <option key={column.status} value={column.status}>
                    {column.label}
                  </option>
                ))}
              </select>
            </span>
            <span className={propChipClass}>
              <Flag className="h-3.5 w-3.5 text-text-muted" />
              <span className="text-text-muted">优先级</span>
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-1.5 py-px text-xs font-medium',
                  priorityBadgeClasses[priority]
                )}
              >
                {priority === 'none' ? '普通' : priority}
              </span>
              <ChevronDown className="h-3 w-3 text-text-muted" />
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
            </span>
            <span className={cn(propChipClass, !assignee && 'text-text-muted')}>
              <CircleUserRound className="h-3.5 w-3.5 text-text-muted" />
              <span className="text-text-muted">负责人</span>
              {assignee?.user_name ?? '添加'}
              <ChevronDown className="h-3 w-3 text-text-muted" />
              <select
                data-testid={isCreate ? 'cloud-todo-create-assignee' : 'cloud-todo-detail-assignee'}
                aria-label="负责人"
                value={assigneeId}
                onChange={event => setAssigneeId(event.target.value)}
                className={overlayControlClass}
              >
                <option value="">添加负责人</option>
                {projectMembers.map(member => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.user_name}
                  </option>
                ))}
              </select>
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
            </span>
            <span className={cn(propChipClass, !dueDate && 'text-text-muted')}>
              <Calendar className="h-3.5 w-3.5 text-text-muted" />
              <span className="text-text-muted">截止时间</span>
              {dueDate ? dueDate.slice(5) : '添加日期'}
              <input
                data-testid={isCreate ? 'cloud-todo-create-due-date' : 'cloud-todo-detail-due-date'}
                aria-label="截止时间"
                type="date"
                value={dueDate}
                onChange={event => setDueDate(event.target.value)}
                className={overlayControlClass}
              />
            </span>
          </div>

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

          {!isAITableEdit ? (
            <div className="mt-3 min-h-[240px]">
              <TaskDescriptionEditor value={description} onChange={setDescription} />
              <p className="mt-2.5 text-xs text-text-muted">
                支持 Markdown，可拖拽文件到编辑器添加附件
              </p>
            </div>
          ) : null}
          {saveError && <p className="mt-2 text-xs text-destructive">{saveError}</p>}

          {isAITableEdit && item && editProps?.project && props.aitableApi ? (
            <AITableTaskFields api={props.aitableApi} project={editProps.project} item={item} />
          ) : null}

          <div className="mt-5">
            <TodoAttachmentSection
              attachments={isCreate ? pendingAttachmentRows : attachments}
              busy={attachmentBusy}
              error={attachmentError}
              editable
              onAdd={isCreate ? stageFiles : addAttachments}
              onOpen={isCreate ? undefined : openAttachment}
              onRemove={isCreate ? removePendingFile : removeAttachment}
            />
          </div>

          {item && (
            <>
              <section className="mt-7" data-testid="cloud-todo-children">
                <div className="flex h-8 items-center">
                  <h3 className="text-sm font-semibold">子任务</h3>
                  <span className="ml-2 text-xs font-normal text-text-muted">
                    {childItems.length}
                  </span>
                  <button
                    type="button"
                    data-testid="cloud-todo-detail-add-child"
                    onClick={() => editProps?.onAddChild()}
                    className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-muted transition hover:text-text-primary"
                  >
                    <Plus className="h-3 w-3" /> 新建子任务
                  </button>
                </div>
                {childItems.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                    暂无子任务
                  </p>
                ) : (
                  <div className="mt-1">
                    {childItems.map(child => (
                      <div
                        key={child.id}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted/60"
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
                        <span className="min-w-0 flex-1 truncate">{collaborator.user_name}</span>
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
                      onClick={() => void api.getDelivery(delivery.id).then(setSelectedDelivery)}
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
          )}
        </div>

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
                onClick={onClose}
                className="h-8 rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-text-primary transition hover:bg-muted"
              >
                取消
              </button>
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
                onClick={() => editProps?.onStart()}
                className="h-8 rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-text-primary transition hover:bg-muted"
              >
                {item?.status === 'completed' ? '开启后续任务' : '开启本地任务'}
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
      </section>
    </div>
  )
}
