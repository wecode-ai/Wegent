import { useEffect, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import {
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Cloud,
  Folder,
  ListTodo,
  Plus,
  Search,
  Tag,
} from 'lucide-react'
import type {
  CloudLoopItem,
  CloudMyWorkItem,
  CloudProject,
  CloudProjectMember,
} from '@/api/deliveries'
import { ApiError } from '@/api/http'
import { DesktopAppSwitcher, type DesktopAppKey } from '@/components/layout/DesktopAppSwitcher'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { DesktopWindowsTitlebar } from '@/components/layout/DesktopWindowsTitlebar'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { navigateTo } from '@/lib/navigation'
import { getPlatform } from '@/lib/platform'
import { cn } from '@/lib/utils'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeTaskAddress,
  User as UserProfile,
} from '@/types/api'
import { CloudTodoModal as Modal } from './CloudTodoModal'
import { CloudMyWorkView } from './CloudMyWorkView'
import { CloudProjectManageView } from './CloudProjectManageView'
import { CloudFilesView } from './CloudFilesView'
import { TodoEditor } from './TodoEditor'
import {
  columnDotClasses,
  columns,
  memberAvatarClasses,
  priorityBadgeClasses,
  reorderLaneItems,
} from './todoShared'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>
type ProjectView = 'board' | 'files' | 'manage'
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

function navigateToApp(app: DesktopAppKey) {
  navigateTo(
    app === 'wework' ? '/' : app === 'todo' ? '/todo' : app === 'wegent' ? '/app/wegent' : '/apps'
  )
}

const columnEmptyHints: Record<CloudLoopItem['status'], string> = {
  inbox: '新建或拖拽任务到这里收集',
  pending: '拖拽任务到这里等待开始',
  in_progress: '拖拽任务到这里开始处理',
  in_review: '等待确认的任务会显示在这里',
  completed: '已完成的任务会归档在这里',
}

const sidebarProjectDotClasses = [
  'bg-indigo-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-violet-500',
]

function boardStatusFromDropId(id: string | number | undefined): CloudLoopItem['status'] | null {
  if (typeof id !== 'string' || !id.startsWith('todo-column:')) return null
  const status = id.slice('todo-column:'.length) as CloudLoopItem['status']
  return columns.some(column => column.status === status) ? status : null
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

function TodoCardContent({ item }: { item: CloudLoopItem }) {
  const tags = item.tags ?? []
  return (
    <>
      <span className="font-mono text-xs text-text-muted">{item.id}</span>
      <span className="mt-1 block text-base font-medium leading-5">{item.title}</span>
      <span className="mt-2.5 flex items-center gap-1">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            priorityBadgeClasses[item.priority]
          )}
        >
          {item.priority === 'none' ? '普通' : item.priority}
        </span>
        {tags.slice(0, 3).map(tag => (
          <span
            key={tag}
            className="inline-flex max-w-24 items-center truncate rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary"
          >
            {tag}
          </span>
        ))}
        {tags.length > 3 && <span className="text-xs text-text-muted">+{tags.length - 3}</span>}
        <span className="ml-auto text-xs text-text-muted">{item.updated_at.slice(5, 10)}</span>
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
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({
    id: item.id,
  })
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `todo-card:${item.id}` })
  return (
    <div
      ref={node => {
        setDragRef(node)
        setDropRef(node)
      }}
      data-testid={`cloud-todo-card-drop-${item.id}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'group w-full touch-none overflow-hidden rounded-xl border border-border bg-background text-left shadow-sm transition hover:-translate-y-px hover:shadow-md',
        isDragging && 'opacity-25 shadow-none',
        isOver && !isDragging && 'border-focus ring-1 ring-focus/50'
      )}
    >
      <button
        type="button"
        data-testid={`cloud-todo-card-${item.id}`}
        onClick={onClick}
        className="w-full px-3 pt-3 text-left"
        {...listeners}
        {...attributes}
      >
        <TodoCardContent item={item} />
      </button>
      <div className="mx-3 mt-2.5 flex items-center border-t border-border py-2">
        {childCount > 0 ? (
          <button
            type="button"
            data-testid={`cloud-todo-open-children-${item.id}`}
            onClick={onOpenChildren}
            className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary transition hover:text-text-primary"
          >
            <ListTodo className="h-3.5 w-3.5" />
            {childCount} 个子任务
            <ChevronRight className="h-3 w-3" />
          </button>
        ) : (
          <span className="min-w-0 text-xs text-text-muted">暂无子任务</span>
        )}
        <button
          type="button"
          data-testid={`cloud-todo-card-add-child-${item.id}`}
          onClick={onAddChild}
          className={cn(
            'ml-auto flex items-center gap-1 text-xs text-text-muted opacity-0 transition hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100'
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
        'min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain px-2 pb-2 pt-2 transition-colors',
        isOver && 'rounded-xl bg-muted ring-1 ring-inset ring-focus/50'
      )}
    >
      {children}
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
        <p className="rounded-lg bg-muted px-3 py-2.5 text-xs text-text-muted">
          项目空间包含共享任务、文件与交付；成员可以关联各自不同的本地工作区。
        </p>
        <label className="block text-xs font-medium text-text-secondary">
          项目名称
          <input
            data-testid="cloud-project-name"
            value={name}
            onChange={event => setName(event.target.value)}
            className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal text-text-primary outline-none focus:border-text-muted"
            placeholder="例如：Wegent V4"
          />
          <span className="mt-1.5 block text-xs font-normal text-text-muted">
            项目标识将在创建时自动生成。
          </span>
        </label>
        <label className="block text-xs font-medium text-text-secondary">
          项目说明
          <textarea
            value={description}
            onChange={event => setDescription(event.target.value)}
            className="mt-1.5 h-20 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm font-normal text-text-primary outline-none focus:border-text-muted"
          />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
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
          disabled={!name.trim() || saving}
          onClick={() => void submit()}
          className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? '正在创建…' : '创建项目'}
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
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-muted px-3 py-2.5">
          <span className="shrink-0 font-mono text-xs text-text-muted">{item.id}</span>
          <span className="min-w-0 truncate text-sm font-medium text-text-primary">
            {item.title}
          </span>
        </div>
        <label className="block text-xs font-medium text-text-secondary">
          本地项目
          <select
            data-testid="cloud-todo-local-project"
            value={projectId}
            onChange={event => setProjectId(Number(event.target.value))}
            className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm font-normal outline-none focus:border-text-muted"
          >
            {projects.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium text-text-secondary">
          启动指令
          <textarea
            value={message}
            onChange={event => setMessage(event.target.value)}
            className="mt-1.5 h-24 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm font-normal outline-none focus:border-text-muted"
          />
        </label>
        <p className="text-xs text-text-muted">
          新任务会获得当前项目空间上下文，可读取共享目录、任务和历史交付，但不会自动上传本地会话。
        </p>
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
          data-testid="cloud-todo-start-confirm"
          disabled={!selected || !message.trim() || starting}
          onClick={() => {
            if (!selected) return
            setStarting(true)
            void onStart(selected, message).finally(() => setStarting(false))
          }}
          className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {starting ? '正在开启…' : '开启任务'}
        </button>
      </footer>
    </Modal>
  )
}

export function CloudTodoWorkspace({
  localProjects,
  services,
  onRunTodo,
  onOpenRuntimeTask,
}: CloudTodoWorkspaceProps) {
  const api = services.deliveryApi!
  const [projects, setProjects] = useState<CloudProject[]>([])
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>({})
  const [projectMembers, setProjectMembers] = useState<Record<string, CloudProjectMember[]>>({})
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [items, setItems] = useState<CloudLoopItem[]>([])
  const [myWork, setMyWork] = useState<CloudMyWorkItem[]>([])
  const [rootView, setRootView] = useState<RootView>('projects')
  const [projectView, setProjectView] = useState<ProjectView>('board')
  const [selectedItem, setSelectedItem] = useState<CloudLoopItem | null>(null)
  // Items of the detail drawer's project when it differs from the board project,
  // so the drawer can stay open without switching the board view.
  const [detailItems, setDetailItems] = useState<CloudLoopItem[]>([])
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
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const platform = getPlatform()
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null
  // Source for the detail drawer / creation dialog when the selected todo lives
  // in a project other than the one shown on the board.
  const detailAllItems =
    selectedItem && selectedItem.cloud_project_id !== selectedProjectId ? detailItems : items
  const createTodoProject = createTodoParent
    ? (projects.find(project => project.id === createTodoParent.cloud_project_id) ?? null)
    : selectedProject
  const boardParent = items.find(item => item.id === boardParentId) ?? null
  const boardLayerCount = items.filter(item => item.parent_id === boardParentId).length
  // Distinct tags across the project (registry plus item usage), used by the
  // board tag filter.
  const availableTags = Array.from(
    new Set([...(selectedProject?.tags ?? []), ...items.flatMap(item => item.tags ?? [])])
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'))
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
    setTagFilter(null)
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
        const details = await Promise.all(
          response.items.map(async project => {
            const [loopItems, members] = await Promise.all([
              api.listLoopItems(project.id),
              api.listCloudProjectMembers(project.id),
            ])
            return [project.id, loopItems.items.length, members] as const
          })
        )
        if (!active) return
        setProjects(response.items)
        setProjectCounts(Object.fromEntries(details.map(([id, count]) => [id, count])))
        setProjectMembers(Object.fromEntries(details.map(([id, , members]) => [id, members])))
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
        // Only sync the open drawer when it belongs to this project; a drawer
        // opened from another view (e.g. my work) must not be closed here.
        setSelectedItem(current =>
          current && current.cloud_project_id === selectedProjectId
            ? (response.items.find(item => item.id === current.id) ?? null)
            : current
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
  // Load the drawer project's items when the drawer shows a todo from a project
  // other than the one on the board, so subtasks and parent options stay correct.
  useEffect(() => {
    if (!selectedItem || selectedItem.cloud_project_id === selectedProjectId) return
    let active = true
    void api.listLoopItems(selectedItem.cloud_project_id).then(response => {
      if (active) setDetailItems(response.items)
    })
    return () => {
      active = false
    }
  }, [api, selectedItem, selectedProjectId])

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
    const reordered = reorderLaneItems(items, itemId, status, beforeItemId)
    if (!item || !reordered) return
    const previousItems = items
    setItems(reordered.items)
    setBoardError(null)
    try {
      if (item.status !== status) {
        const updated = await api.updateLoopItem(item.id, {
          version: item.version,
          status,
        })
        setItems(current =>
          current.map(candidate => (candidate.id === updated.id ? updated : candidate))
        )
        setSelectedItem(current => (current?.id === updated.id ? updated : current))
      }
      await api.reorderLoopItems(item.cloud_project_id, {
        parent_id: item.parent_id,
        status,
        item_ids: reordered.laneIds,
      })
    } catch (cause) {
      setItems(previousItems)
      setBoardError(cause instanceof Error ? cause.message : '移动任务失败')
    }
  }

  function finishBoardDrop(event: DragEndEvent) {
    setActiveDragItemId(null)
    const activeId = String(event.active.id)
    const beforeCardId = boardCardIdFromDropId(event.over?.id)
    if (beforeCardId) {
      if (beforeCardId === activeId) return
      const target = items.find(candidate => candidate.id === beforeCardId)
      if (target) void moveItem(activeId, target.status, beforeCardId)
      return
    }
    const status = boardStatusFromDropId(event.over?.id)
    if (status) void moveItem(activeId, status)
  }

  return (
    <div
      className="absolute inset-0 z-content flex min-h-0 w-full flex-col overflow-hidden bg-background text-text-primary"
      data-testid="cloud-todo-workspace"
    >
      <DesktopWindowsTitlebar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        activeApp="todo"
        onNavigate={navigateToApp}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            'relative shrink-0 overflow-hidden border-r border-border bg-background transition-[width] duration-200',
            sidebarCollapsed ? 'w-0 border-r-0' : 'w-[248px]'
          )}
        >
          <div className="flex h-full w-[248px] flex-col">
            {platform !== 'win' && (
              <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
            )}
            {platform !== 'win' && (
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
                  onNavigate={navigateToApp}
                  testIds={{
                    wework: 'cloud-todo-app-wework',
                    todo: 'cloud-todo-app-current',
                    apps: 'cloud-todo-app-apps',
                    wegent: 'cloud-todo-app-wegent',
                  }}
                />
              </div>
            )}
            <nav className="space-y-1 px-2">
              <button
                type="button"
                onClick={() => {
                  setRootView('projects')
                  selectProject(null)
                  setSelectedItem(null)
                }}
                className={cn(
                  'flex h-8 w-full items-center gap-3 rounded-lg px-3 text-sm',
                  rootView === 'projects'
                    ? 'bg-muted font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-muted/60'
                )}
              >
                <Cloud className="h-4 w-4" /> 项目空间
              </button>
              <button
                type="button"
                data-testid="cloud-my-work"
                onClick={() => setRootView('my-work')}
                className={cn(
                  'flex h-8 w-full items-center gap-3 rounded-lg px-3 text-sm',
                  rootView === 'my-work'
                    ? 'bg-muted font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-muted/60'
                )}
              >
                <CircleUserRound className="h-4 w-4" /> 我的工作
              </button>
              <button
                type="button"
                data-testid="cloud-search-toggle"
                onClick={() => setSearchOpen(current => !current)}
                className="flex h-8 w-full items-center gap-3 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted/60"
              >
                <Search className="h-4 w-4" /> 搜索
                <span className="ml-auto rounded-md border border-border bg-background px-1.5 text-xs leading-5 text-text-muted">
                  ⌘K
                </span>
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
                  className="h-8 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-text-muted"
                />
              </div>
            )}
            <div className="mt-6 flex items-center px-5 text-xs font-medium text-text-muted">
              项目空间
              <button
                type="button"
                data-testid="cloud-project-add"
                onClick={() => setCreateProjectOpen(true)}
                className="ml-auto h-6 w-6 rounded-md hover:bg-muted"
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
                .map((project, index) => (
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
                      'flex h-8 w-full items-center gap-3 rounded-lg px-3 text-sm',
                      rootView === 'projects' && selectedProjectId === project.id
                        ? 'bg-muted font-medium text-text-primary'
                        : 'text-text-secondary hover:bg-muted/60'
                    )}
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        sidebarProjectDotClasses[index % sidebarProjectDotClasses.length]
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                    {projectCounts[project.id] ? (
                      <span className="text-xs text-text-muted">{projectCounts[project.id]}</span>
                    ) : null}
                  </button>
                ))}
            </div>
          </div>
        </aside>

        <main className="relative flex min-w-0 flex-1 flex-col">
          {!selectedProject && platform !== 'win' && (
            <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
          )}
          {sidebarCollapsed && platform !== 'win' && (
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
                onNavigate={navigateToApp}
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
            <CloudMyWorkView
              items={myWork}
              // Open the detail drawer in place instead of jumping to the board.
              onSelectItem={item => setSelectedItem(item)}
            />
          ) : loading ? (
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
            <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
              <div className="mx-auto max-w-[880px]">
                <div className="flex items-start">
                  <div>
                    <h1 className="text-heading-md font-semibold">项目空间</h1>
                    <p className="mt-1 text-sm text-text-muted">
                      多人和 AI 在各自本地工作区协作，共享任务、文件与交付。
                    </p>
                  </div>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setCreateProjectOpen(true)}
                    className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90"
                  >
                    <Plus className="h-3.5 w-3.5" /> 新建项目空间
                  </button>
                </div>
                <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
                  <div className="grid h-10 grid-cols-[minmax(0,1fr)_80px_120px_170px] items-center bg-muted/30 px-4 text-xs text-text-muted">
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
                    .map((project, index) => (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => selectProject(project.id)}
                        className="grid h-12 w-full grid-cols-[minmax(0,1fr)_80px_120px_170px] items-center border-t border-border px-4 text-left transition-colors hover:bg-muted/60"
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              sidebarProjectDotClasses[index % sidebarProjectDotClasses.length]
                            )}
                          />
                          <span className="truncate text-sm font-medium">{project.name}</span>
                        </span>
                        <span className="text-xs text-text-muted">
                          {projectCounts[project.id] ?? '—'}
                        </span>
                        <span className="text-xs text-text-muted">
                          {project.updated_at.slice(5, 10)}
                        </span>
                        <span className="flex items-center">
                          {(projectMembers[project.id] ?? [])
                            .slice(0, 3)
                            .map((member, memberIndex) => (
                              <span
                                key={member.user_id}
                                className={cn(
                                  'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background ring-2 ring-background',
                                  memberAvatarClasses[memberIndex % memberAvatarClasses.length],
                                  memberIndex > 0 && '-ml-1.5'
                                )}
                              >
                                {member.user_name.slice(0, 1).toUpperCase()}
                              </span>
                            ))}
                          <span className="ml-2 text-xs text-text-muted">
                            {projectMembers[project.id]
                              ? `${projectMembers[project.id].length} 人`
                              : '—'}
                          </span>
                        </span>
                      </button>
                    ))}
                </div>
                <p className="mt-5 text-xs text-text-muted">
                  项目空间只包含共享协作数据；本地目录、Git 与未关联会话仍留在成员设备上。
                </p>
              </div>
            </div>
          ) : (
            <>
              <header
                data-testid="cloud-project-header"
                className={cn(
                  'relative z-10 flex h-[52px] shrink-0 items-center border-b border-border bg-background pr-6',
                  sidebarCollapsed ? 'pl-[240px]' : 'pl-6'
                )}
              >
                {platform !== 'win' && (
                  <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />
                )}
                <Folder className="relative z-10 h-4 w-4 text-text-muted" />
                <span className="relative z-10 ml-2 text-base font-semibold">
                  {selectedProject.name}
                </span>
                <nav className="relative z-10 ml-8 flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
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
                    事项
                  </button>
                  <button
                    type="button"
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
                </nav>
                <span className="flex-1" />
                {projectView === 'board' && (
                  <>
                    {availableTags.length > 0 && (
                      <span className="relative z-10 ml-2 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-2.5 text-xs transition hover:bg-muted">
                        <Tag className="h-3.5 w-3.5 text-text-muted" />
                        <span className={tagFilter ? 'text-text-primary' : 'text-text-muted'}>
                          {tagFilter ?? '全部标签'}
                        </span>
                        <ChevronDown className="h-3 w-3 text-text-muted" />
                        <select
                          data-testid="cloud-todo-tag-filter"
                          aria-label="标签筛选"
                          value={tagFilter ?? ''}
                          onChange={event => setTagFilter(event.target.value || null)}
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        >
                          <option value="">全部标签</option>
                          {availableTags.map(tag => (
                            <option key={tag} value={tag}>
                              {tag}
                            </option>
                          ))}
                        </select>
                      </span>
                    )}
                    <button
                      type="button"
                      data-testid="cloud-todo-add"
                      onClick={() => openTodoCreation(projectView === 'board' ? boardParent : null)}
                      className="relative z-10 ml-2 flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition hover:opacity-90"
                    >
                      <Plus className="h-3.5 w-3.5" /> 新建任务
                    </button>
                  </>
                )}
              </header>
              {projectView === 'files' ? (
                <CloudFilesView api={api} project={selectedProject} />
              ) : projectView === 'manage' ? (
                <CloudProjectManageView
                  api={api}
                  project={selectedProject}
                  onProjectUpdated={updated =>
                    setProjects(current =>
                      current.map(project => (project.id === updated.id ? updated : project))
                    )
                  }
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col pb-6 pt-4">
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
                        <h1 className="text-heading-sm font-semibold">顶层任务</h1>
                        <span className="text-xs text-text-muted">{boardLayerCount} 个任务</span>
                      </div>
                    )}
                  </nav>
                  {boardError && (
                    <p className="mx-6 mb-2 text-xs text-destructive" role="alert">
                      {boardError}
                    </p>
                  )}
                  <div className="min-h-0 flex-1 overflow-x-auto">
                    <DndContext
                      sensors={boardSensors}
                      collisionDetection={boardCollisionDetection}
                      onDragStart={event => setActiveDragItemId(String(event.active.id))}
                      onDragCancel={() => setActiveDragItemId(null)}
                      onDragEnd={finishBoardDrop}
                    >
                      <div className="flex h-full min-h-0 items-start gap-3.5 px-6">
                        {columns.map(column => {
                          const normalizedSearch = searchQuery.trim().toLowerCase()
                          const columnItems = items.filter(
                            item =>
                              item.parent_id === boardParentId &&
                              item.status === column.status &&
                              (!tagFilter || (item.tags ?? []).includes(tagFilter)) &&
                              (!normalizedSearch ||
                                `${item.id} ${item.title} ${item.description}`
                                  .toLowerCase()
                                  .includes(normalizedSearch))
                          )
                          return (
                            <section
                              key={column.status}
                              data-testid={`cloud-todo-column-${column.status}`}
                              className="group flex max-h-full w-[292px] shrink-0 flex-col rounded-2xl bg-muted p-0.5"
                            >
                              <header className="flex items-center justify-between px-2.5 pb-2 pt-1.5">
                                <span className="flex min-w-0 items-center">
                                  <span
                                    className={cn(
                                      'mr-2 h-2 w-2 rounded-full',
                                      columnDotClasses[column.status]
                                    )}
                                  />
                                  <span className="text-sm font-semibold">{column.label}</span>
                                  <span className="ml-2 text-xs text-text-muted">
                                    {columnItems.length}
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  data-testid={`cloud-todo-column-add-${column.status}`}
                                  onClick={() => openTodoCreation(boardParent, column.status)}
                                  className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 group-hover:opacity-100"
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
                                {columnItems.length === 0 && columnEmptyHints[column.status] && (
                                  <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
                                    {columnEmptyHints[column.status]}
                                  </div>
                                )}
                              </TodoColumnDropzone>
                              <div className="shrink-0 px-2 pb-2">
                                <button
                                  type="button"
                                  data-testid={`cloud-todo-column-bottom-add-${column.status}`}
                                  onClick={() => openTodoCreation(boardParent, column.status)}
                                  className="flex h-9 w-full items-center gap-2 rounded-xl border border-dashed border-transparent bg-muted px-2.5 text-sm text-text-muted hover:border-border hover:bg-background hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
                                  aria-label={`在${column.label}中新建任务`}
                                >
                                  <Plus className="h-4 w-4" />
                                  新建任务
                                </button>
                              </div>
                            </section>
                          )
                        })}
                      </div>
                      <DragOverlay dropAnimation={null}>
                        {activeDragItemId ? (
                          <div className="w-[272px] rotate-1 rounded-xl border border-border bg-background p-3 text-left shadow-lg">
                            <TodoCardContent
                              item={items.find(item => item.id === activeDragItemId)!}
                            />
                          </div>
                        ) : null}
                      </DragOverlay>
                    </DndContext>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {selectedItem && (
        <TodoEditor
          key={`${selectedItem.id}:${selectedItem.version}`}
          mode="edit"
          api={api}
          item={selectedItem}
          project={projects.find(project => project.id === selectedItem.cloud_project_id)}
          allItems={detailAllItems}
          onClose={() => setSelectedItem(null)}
          onAddChild={() => openTodoCreation(selectedItem)}
          onStart={() => setStartItem(selectedItem)}
          onUpdated={updated => {
            setItems(current => current.map(item => (item.id === updated.id ? updated : item)))
            setDetailItems(current =>
              current.map(item => (item.id === updated.id ? updated : item))
            )
            setMyWork(current =>
              current.map(entry => (entry.id === updated.id ? { ...entry, ...updated } : entry))
            )
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
            void api
              .listCloudProjectMembers(project.id)
              .then(members =>
                setProjectMembers(current => ({ ...current, [project.id]: members }))
              )
            selectProject(project.id)
            setCreateProjectOpen(false)
          }}
        />
      )}
      {createTodoOpen && createTodoProject && (
        <TodoEditor
          mode="create"
          api={api}
          project={createTodoProject}
          initialParent={createTodoParent}
          initialStatus={createTodoStatus}
          allItems={createTodoParent ? detailAllItems : items}
          onClose={() => {
            setCreateTodoOpen(false)
            setCreateTodoParent(null)
          }}
          onCreated={item => {
            if (item.cloud_project_id === selectedProjectId) {
              setItems(current => [...current, item])
            } else {
              setDetailItems(current => [...current, item])
            }
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
    </div>
  )
}
