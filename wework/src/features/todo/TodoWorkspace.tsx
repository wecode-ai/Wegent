import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Grid2X2,
  LayoutDashboard,
  List,
  ListTodo,
  Plus,
  Settings2,
} from 'lucide-react'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { DesktopAppSwitcher } from '@/components/layout/DesktopAppSwitcher'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import { cn } from '@/lib/utils'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeTaskSummary,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import type { TodoCreateValues } from './TodoCreateDialog'
import { TodoDetailPanel, type TodoDetailItem, type TodoViewState } from './TodoDetailPanel'
import {
  ProjectSwitcherOverlay,
  TodoSearchOverlay,
  TodoSidebar,
  type TodoProject,
  type TodoProjectView,
} from './TodoNavigation'
import { TodoOverview } from './TodoOverview'
import { TodoMyWork } from './TodoMyWork'
import { TodoWorkItems } from './TodoWorkItems'
import { projectColor } from './todoProject'
import {
  countActiveTodoFilters,
  DEFAULT_TODO_DISPLAY,
  DEFAULT_TODO_FILTERS,
  type TodoDisplaySettings,
  type TodoFilters,
  type TodoLayout,
} from './todoViewSettings'
import { requestProjectCreateMode } from '@/components/layout/workbenchShellEvents'
import {
  createLocalWorkItemId,
  ensureTodoWorkDirectory,
  ensureTodoWorkspace,
  hydrateLocalWorkItems,
  loadLocalWorkItems,
  loadTodoWorkflow,
  saveLocalWorkItems,
  saveTodoWorkflow,
  type TodoWorkflowConfig,
  writeTodoWorkspaceFile,
  type LocalWorkItem,
} from './todoModel'
import { TodoWorkflowDialog } from './TodoWorkflowDialog'

type TodoState = TodoViewState

interface TodoWorkspaceProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  runtimeWork: RuntimeWorkListResponse | null
  currentProjectId?: number | null
  services?: WorkbenchServices
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onRunTodo?: (request: TodoRunRequest) => Promise<RuntimeTaskAddress | false>
}

export interface TodoRunRequest {
  project: ProjectWithTasks
  message: string
  goal?: string
  attachments: Attachment[]
  collaborationMode?: 'default' | 'plan'
}

type TodoItem = TodoDetailItem

const TODO_PROJECT_STORAGE_KEY = 'wework:todo:selected-project'
const TODO_VIEW_STORAGE_KEY = 'wework:todo:view'

function collectProjects(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null,
  localProjectName: string,
  localProjectDescription: string
): TodoProject[] {
  const entries = new Map<number, TodoProject>()
  projects.forEach(project => entries.set(project.id, { project, workspaces: [] }))
  runtimeWork?.projects.forEach(projectWork => {
    const projectId = runtimeProjectUiId(projectWork.project)
    entries.set(projectId, {
      project:
        projects.find(project => project.id === projectId) ?? runtimeProjectToProject(projectWork),
      workspaces: projectWork.deviceWorkspaces,
    })
  })
  if (entries.size === 0) {
    entries.set(-1, {
      project: {
        id: -1,
        name: localProjectName,
        description: localProjectDescription,
        client_origin: 'wework',
      },
      workspaces: [],
    })
  }
  return [...entries.values()]
}

function resolveTodoState(task: RuntimeTaskSummary): TodoState {
  const status = task.status?.trim().toLowerCase() ?? ''
  if (['review', 'confirm', 'approval', 'waiting', 'input'].some(value => status.includes(value))) {
    return 'review'
  }
  if (
    task.running ||
    task.optimistic ||
    ['running', 'started'].some(value => status.includes(value))
  ) {
    return 'started'
  }
  if (['queued', 'pending', 'backlog', 'created'].some(value => status.includes(value))) {
    return 'backlog'
  }
  return 'completed'
}

function deriveRootState(current: TodoState, children: LocalWorkItem[]): TodoState {
  if (current === 'completed' || children.length === 0) return current
  if (children.every(child => child.state === 'completed')) return 'review'
  if (children.some(child => ['started', 'review', 'completed'].includes(child.state))) {
    return 'started'
  }
  return current === 'inbox' ? 'backlog' : current
}

function buildTodoItems(project: TodoProject | null): TodoItem[] {
  if (!project) return []
  return project.workspaces
    .flatMap(workspace =>
      workspace.tasks.map(task => ({
        workspace,
        task,
      }))
    )
    .map(({ workspace, task }, index) => ({
      id: task.taskId,
      kind: 'runtime' as const,
      code: `WEG-${String(index + 1).padStart(2, '0')}`,
      title: task.title,
      state: resolveTodoState(task),
      runtime: task.runtime,
      priorityValue: 'normal' as const,
      assignee: task.runtime,
      assigneeType: 'ai' as const,
      workspace: workspace.label || workspace.deviceName || workspace.workspacePath,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      address: {
        deviceId: workspace.deviceId,
        taskId: task.taskId,
        workspacePath: task.workspacePath || workspace.workspacePath,
        runtimeHandle: task.runtimeHandle,
      },
      task,
    }))
}

function deriveTodoTitle(markdown: string): string {
  const firstLine = markdown
    .split('\n')
    .map(line => line.trim())
    .find(Boolean)
  if (!firstLine) return 'Untitled TODO'
  const title = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, '')
    .replace(/^>\s*/, '')
    .replace(/[*_`~]/g, '')
    .trim()
  return title.slice(0, 120) || 'Untitled TODO'
}

function loadSelectedProjectId(
  userId: number | undefined,
  projects: TodoProject[],
  fallback: number | null
): number | null {
  try {
    const value = window.localStorage.getItem(`${TODO_PROJECT_STORAGE_KEY}:${userId ?? 'local'}`)
    const projectId = value ? Number(value) : NaN
    if (projects.some(entry => entry.project.id === projectId)) return projectId
  } catch {
    // Keep the current Wework project when browser storage is unavailable.
  }
  return fallback
}

function loadTodoViewSettings(
  userId: number | undefined,
  projectId: number | null
): { layout: TodoLayout; display: TodoDisplaySettings } {
  if (projectId == null) return { layout: 'board', display: DEFAULT_TODO_DISPLAY }
  try {
    const raw = window.localStorage.getItem(
      `${TODO_VIEW_STORAGE_KEY}:${userId ?? 'local'}:${projectId}`
    )
    if (!raw) return { layout: 'board', display: DEFAULT_TODO_DISPLAY }
    const value = JSON.parse(raw) as {
      layout?: TodoLayout
      display?: Partial<TodoDisplaySettings>
    }
    return {
      layout: value.layout === 'list' ? 'list' : 'board',
      display: { ...DEFAULT_TODO_DISPLAY, ...value.display },
    }
  } catch {
    return { layout: 'board', display: DEFAULT_TODO_DISPLAY }
  }
}

export function TodoWorkspace({
  user,
  projects,
  runtimeWork,
  currentProjectId,
  services,
  onOpenRuntimeTask,
  onRunTodo,
}: TodoWorkspaceProps) {
  const { t } = useTranslation('common')
  const localProjectName = t('todo.local_project', '本地事项')
  const localProjectDescription = t('todo.local_project_description', '仅存储在这台设备上的事项')
  const projectEntries = useMemo(
    () => collectProjects(projects, runtimeWork, localProjectName, localProjectDescription),
    [localProjectDescription, localProjectName, projects, runtimeWork]
  )
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() =>
    loadSelectedProjectId(
      user?.id,
      projectEntries,
      currentProjectId ?? projectEntries[0]?.project.id ?? null
    )
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [projectView, setProjectView] = useState<TodoProjectView>('work-items')
  const [workScope, setWorkScope] = useState<'items' | 'mine'>('items')
  const [expandedProjectId, setExpandedProjectId] = useState<number | null>(selectedProjectId)
  const initialViewSettings = loadTodoViewSettings(user?.id, selectedProjectId)
  const [layout, setLayout] = useState<TodoLayout>(initialViewSettings.layout)
  const [filters, setFilters] = useState<TodoFilters>(DEFAULT_TODO_FILTERS)
  const [display, setDisplay] = useState<TodoDisplaySettings>(initialViewSettings.display)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [displayOpen, setDisplayOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [quickCreateRequest, setQuickCreateRequest] = useState<{
    state: TodoState
    token: number
  } | null>(null)
  const [workflowDialogOpen, setWorkflowDialogOpen] = useState(false)
  const [workItems, setWorkItems] = useState<LocalWorkItem[]>(() => loadLocalWorkItems(user?.id))
  const usesOverlayTitlebar = isTauriRuntime()
  const selectedProject =
    projectEntries.find(entry => entry.project.id === selectedProjectId) ??
    projectEntries[0] ??
    null
  const [workflowConfig, setWorkflowConfig] = useState<TodoWorkflowConfig>(() =>
    loadTodoWorkflow(selectedProjectId)
  )
  const runtimeItems = useMemo(() => {
    const linkedTaskIds = new Set(
      workItems.flatMap(item => item.runtimeRefs.map(ref => ref.taskId))
    )
    return buildTodoItems(selectedProject).filter(item => !linkedTaskIds.has(item.id))
  }, [selectedProject, workItems])
  const localItems = useMemo<TodoItem[]>(
    () =>
      workItems
        .filter(item => item.projectId === selectedProject?.project.id && !item.parentId)
        .map(item => {
          const children = workItems.filter(child => child.parentId === item.id)
          const derivedState = deriveRootState(item.state, children)
          const blockedChild = children.find(child => child.blocker)
          const currentChild =
            children.find(child => child.state === 'started') ??
            children.find(child => child.state !== 'completed')
          return {
            id: item.id,
            kind: 'draft',
            code: `TODO-${item.id.slice(-4).toUpperCase()}`,
            title: item.title,
            state: derivedState,
            runtime: item.assignee.type === 'human' ? t('todo.assignee_human', '员工') : 'TODO',
            workspace: selectedProject?.project.name ?? '',
            description: item.description,
            objective: item.objective,
            priority:
              item.priority === 'none'
                ? t('todo.priority_none_short', '无')
                : t(`todo.priority_${item.priority}`, item.priority),
            priorityValue: item.priority,
            assignee:
              item.assignee.name ||
              (item.assignee.type === 'human'
                ? t('todo.assignee_human', '员工')
                : item.assignee.type === 'ai'
                  ? t('todo.assignee_ai', 'AI 智能体')
                  : t('todo.assignee_unassigned_short', '未指定')),
            assigneeType: item.assignee.type,
            dueDate: item.dueDate,
            attachments: item.attachments,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            events: item.events,
            blocker: item.blocker || blockedChild?.blocker,
            nextAction: item.nextAction || currentChild?.nextAction,
            collaborators: item.collaborators,
            confirmer: item.confirmer?.name,
            workspaceItemId: item.id,
            address: item.runtimeRefs.at(-1),
            children: children.map(child => {
              const waitingFor = (child.workTypeSnapshot?.dependsOn ?? []).flatMap(key => {
                const dependency = children.find(candidate => candidate.workTypeKey === key)
                if (dependency?.state === 'completed') return []
                return [workflowConfig.workTypes.find(type => type.key === key)?.name ?? key]
              })
              return {
                id: child.id,
                parentId: child.parentId,
                kind: 'draft' as const,
                code: `TODO-${child.id.slice(-4).toUpperCase()}`,
                title: child.title,
                state: child.state,
                runtime: child.assignee.name || child.assignee.type,
                workspace: selectedProject?.project.name ?? '',
                description: child.description,
                objective: child.objective,
                priorityValue: child.priority,
                assignee: child.assignee.name,
                assigneeType: child.assignee.type,
                workTypeKey: child.workTypeKey,
                workTypeName: child.workTypeSnapshot?.name,
                blocker: child.blocker,
                nextAction: child.nextAction,
                workspaceItemId: item.id,
                createdAt: child.createdAt,
                updatedAt: child.updatedAt,
                waitingFor,
                events: child.events,
                address: child.runtimeRefs.at(-1),
              }
            }),
          }
        }),
    [
      workItems,
      selectedProject?.project.id,
      selectedProject?.project.name,
      t,
      workflowConfig.workTypes,
    ]
  )
  const items = useMemo(() => [...localItems, ...runtimeItems], [localItems, runtimeItems])
  const projectItemCounts = useMemo(
    () =>
      Object.fromEntries(
        projectEntries.map(entry => [
          entry.project.id,
          entry.workspaces.reduce((total, workspace) => total + workspace.tasks.length, 0) +
            workItems.filter(item => item.projectId === entry.project.id && !item.parentId).length,
        ])
      ),
    [workItems, projectEntries]
  )
  const selectedItem =
    items
      .flatMap(item => [item, ...(item.children ?? [])])
      .find(item => item.id === selectedItemId) ?? null
  const selectProject = (projectId: number) => {
    setSelectedProjectId(projectId)
    setExpandedProjectId(projectId)
    setSelectedItemId(null)
    setFilters(DEFAULT_TODO_FILTERS)
    setFiltersOpen(false)
    setDisplayOpen(false)
    const viewSettings = loadTodoViewSettings(user?.id, projectId)
    setLayout(viewSettings.layout)
    setDisplay(viewSettings.display)
    setWorkflowConfig(loadTodoWorkflow(projectId))
    try {
      window.localStorage.setItem(
        `${TODO_PROJECT_STORAGE_KEY}:${user?.id ?? 'local'}`,
        String(projectId)
      )
    } catch {
      // The selection remains available for the current session.
    }
  }

  useEffect(() => {
    void hydrateLocalWorkItems(user?.id).then(items => {
      if (items.length > 0) setWorkItems(items)
    })
  }, [user?.id])

  useEffect(() => saveLocalWorkItems(user?.id, workItems), [user?.id, workItems])

  useEffect(() => {
    if (selectedProjectId == null) return
    try {
      window.localStorage.setItem(
        `${TODO_VIEW_STORAGE_KEY}:${user?.id ?? 'local'}:${selectedProjectId}`,
        JSON.stringify({ layout, display })
      )
    } catch {
      // View preferences remain available for the current session.
    }
  }, [display, layout, selectedProjectId, user?.id])

  const createDraft = (values: TodoCreateValues, attachments: Attachment[]) => {
    const now = new Date().toISOString()
    const draft: LocalWorkItem = {
      id: createLocalWorkItemId(),
      projectId: values.projectId,
      state: values.state,
      title: deriveTodoTitle(values.markdown),
      description: values.markdown.trim(),
      objective: values.goal.trim(),
      priority: values.priority,
      assignee: { type: values.assignee },
      collaborators: [],
      blocker: '',
      nextAction: '',
      dueDate: values.dueDate,
      attachments,
      runtimeRefs: [],
      events: [
        { id: createLocalWorkItemId(), type: 'created', summary: '事项已创建', createdAt: now },
      ],
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    }
    const stages: LocalWorkItem[] = workflowConfig.workTypes.map((workType, index) => ({
      id: createLocalWorkItemId(),
      projectId: values.projectId,
      parentId: draft.id,
      title: `${draft.title} · ${workType.name}`,
      objective: draft.objective,
      description: '',
      state: 'backlog',
      workTypeKey: workType.key,
      workTypeSnapshot: workType,
      assignee: workType.defaultAssignee,
      collaborators: [],
      blocker: '',
      nextAction: '',
      priority: draft.priority,
      attachments: [],
      runtimeRefs: [],
      events: [
        {
          id: createLocalWorkItemId(),
          type: 'created',
          summary: '由项目流程自动创建',
          createdAt: now,
        },
      ],
      sortOrder: index,
      createdAt: now,
      updatedAt: now,
    }))
    setWorkItems(current => [draft, ...stages, ...current])
    void ensureTodoWorkspace(draft).then(() =>
      Promise.all(
        values.files.map(file =>
          writeTodoWorkspaceFile(
            draft.id,
            `context/${file.name.replaceAll('/', '_').replaceAll('\\', '_')}`,
            file
          )
        )
      )
    )
    stages.forEach(stage => {
      if (stage.workTypeKey) void ensureTodoWorkDirectory(draft.id, stage.workTypeKey)
    })
    selectProject(values.projectId)
    return draft
  }

  const quickCreate = (state: TodoState, title: string) => {
    createDraft(
      {
        projectId: selectedProject?.project.id ?? -1,
        state,
        goal: '',
        markdown: title,
        priority: 'none',
        assignee: 'unassigned',
        launchMode: 'manual',
        dueDate: '',
        files: [],
      },
      []
    )
  }

  const runDraft = async (item: TodoItem) => {
    const draft = workItems.find(entry => entry.id === item.id)
    if (!draft) return
    if (draft.parentId && draft.workTypeSnapshot?.dependsOn.length) {
      const siblings = workItems.filter(entry => entry.parentId === draft.parentId)
      const incomplete = draft.workTypeSnapshot.dependsOn.filter(
        key => !siblings.some(entry => entry.workTypeKey === key && entry.state === 'completed')
      )
      if (incomplete.length > 0) {
        throw new Error(t('todo.dependencies_incomplete', '前置阶段尚未完成'))
      }
    }
    const project = projectEntries.find(entry => entry.project.id === draft.projectId)?.project
    if (!project || !onRunTodo) throw new Error(t('todo.run_unavailable', '运行服务当前不可用'))
    if (draft.assignee.type === 'unassigned') {
      throw new Error(t('todo.executor_required', '请先选择员工或 AI 智能体作为执行者'))
    }
    if (draft.assignee.type === 'human') {
      setWorkItems(current =>
        current.map(entry =>
          entry.id === draft.id
            ? { ...entry, state: 'started', updatedAt: new Date().toISOString() }
            : entry
        )
      )
      setSelectedItemId(null)
      return
    }
    const address = await onRunTodo({
      project,
      message: draft.description,
      goal: draft.objective || undefined,
      attachments: draft.attachments,
      collaborationMode: draft.runtimeRefs.length === 0 ? 'plan' : 'default',
    })
    if (!address) throw new Error(t('todo.create_failed', 'TODO 创建失败'))
    setWorkItems(current =>
      current.map(entry =>
        entry.id === draft.id
          ? {
              ...entry,
              state: 'started',
              runtimeRefs: [...entry.runtimeRefs, address],
              events: [
                ...entry.events,
                {
                  id: createLocalWorkItemId(),
                  type: 'run-linked',
                  summary: '已关联 AI 执行会话',
                  createdAt: new Date().toISOString(),
                },
              ],
              updatedAt: new Date().toISOString(),
            }
          : entry
      )
    )
    setSelectedItemId(null)
  }

  const updateDraftAttachments = (draftId: string, attachments: Attachment[]) => {
    setWorkItems(current =>
      current.map(item =>
        item.id === draftId ? { ...item, attachments, updatedAt: new Date().toISOString() } : item
      )
    )
  }

  const deleteDraft = (draftId: string) => {
    setWorkItems(current =>
      current.filter(item => item.id !== draftId && item.parentId !== draftId)
    )
    setSelectedItemId(null)
  }

  const addChildWorkItem = (parentId: string, workTypeKey: string, workTypeName: string) => {
    const parent = workItems.find(item => item.id === parentId)
    if (!parent) return
    if (workItems.some(item => item.parentId === parentId && item.workTypeKey === workTypeKey))
      return
    const now = new Date().toISOString()
    const child: LocalWorkItem = {
      id: createLocalWorkItemId(),
      projectId: parent.projectId,
      parentId,
      title: `${parent.title} · ${workTypeName}`,
      objective: parent.objective,
      description: '',
      state: 'backlog',
      workTypeKey,
      workTypeSnapshot: workflowConfig.workTypes.find(type => type.key === workTypeKey) ?? {
        key: workTypeKey,
        name: workTypeName,
        dependsOn: [],
        defaultAssignee: { type: 'unassigned' },
      },
      assignee:
        workflowConfig.workTypes.find(type => type.key === workTypeKey)?.defaultAssignee ??
        ({ type: 'unassigned' } as const),
      collaborators: [],
      blocker: '',
      nextAction: '',
      priority: parent.priority,
      attachments: [],
      runtimeRefs: [],
      events: [
        { id: createLocalWorkItemId(), type: 'created', summary: '执行任务已创建', createdAt: now },
      ],
      sortOrder: workItems.filter(item => item.parentId === parentId).length,
      createdAt: now,
      updatedAt: now,
    }
    setWorkItems(current => [...current, child])
    void ensureTodoWorkDirectory(parentId, workTypeKey)
  }

  const applyWorkflowToItem = (parentId: string) => {
    workflowConfig.workTypes.forEach(workType => {
      addChildWorkItem(parentId, workType.key, workType.name)
    })
  }

  const openWeworkProjects = (createProject = false) => {
    navigateTo('/')
    if (createProject) {
      window.setTimeout(() => requestProjectCreateMode('scratch'), 0)
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        event.stopPropagation()
        setProjectMenuOpen(true)
        return
      }
      if (event.key === 'Escape') {
        setProjectMenuOpen(false)
        setSearchOpen(false)
        setDisplayOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  return (
    <div
      data-testid="todo-workspace"
      className="flex h-full w-full min-w-0 flex-1 overflow-hidden bg-white"
    >
      <TodoSidebar
        user={user}
        projects={projectEntries}
        projectItemCounts={projectItemCounts}
        selectedProjectId={selectedProject?.project.id ?? null}
        expandedProjectId={expandedProjectId}
        activeView={projectView}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed(value => !value)}
        onSelectProject={selectProject}
        onToggleProject={projectId =>
          setExpandedProjectId(current => (current === projectId ? null : projectId))
        }
        onSelectView={setProjectView}
        onCreate={() => setQuickCreateRequest({ state: 'inbox', token: Date.now() })}
        onSearch={() => setSearchOpen(true)}
        onAddProject={() => openWeworkProjects(true)}
        onOpenProjects={() => openWeworkProjects(false)}
        onConfigureWorkflow={() => setWorkflowDialogOpen(true)}
      />

      <main className="relative flex min-w-0 flex-1 flex-col bg-[#F7F8F9] dark:bg-background">
        <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
        <header
          data-testid="todo-main-header"
          className={cn(
            'relative z-10 flex h-[38px] shrink-0 items-center justify-between border-b border-[#E3E6E8] bg-white pr-[3px] dark:border-border dark:bg-background',
            sidebarCollapsed ? 'pl-0' : 'pl-3.5'
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {sidebarCollapsed && (
              <div
                data-testid="todo-main-header-left-controls"
                className={cn(
                  'flex h-full shrink-0 items-center gap-1 pr-2',
                  usesOverlayTitlebar && 'pl-[92px]'
                )}
              >
                <DesktopWindowControls
                  sidebarCollapsed
                  onToggleSidebar={() => setSidebarCollapsed(false)}
                  toggleTestId="todo-expand-sidebar"
                  className="gap-1"
                />
                <DesktopAppSwitcher
                  activeApp="todo"
                  onNavigate={app =>
                    navigateTo(app === 'wework' ? '/' : app === 'todo' ? '/todo' : '/apps')
                  }
                  testIds={{
                    wework: 'todo-collapsed-app-wework',
                    todo: 'todo-collapsed-app-current',
                    apps: 'todo-collapsed-app-apps',
                  }}
                />
              </div>
            )}
            <button
              type="button"
              data-testid="todo-project-switcher"
              aria-expanded={projectMenuOpen}
              onClick={() => {
                setSelectedItemId(null)
                setProjectMenuOpen(value => !value)
              }}
              className="flex h-8 max-w-[220px] items-center gap-2 rounded-md px-2 text-[13px] font-medium text-[#30353A] hover:bg-[#F1F2F4] dark:text-text-primary dark:hover:bg-muted"
            >
              <span
                className="h-[18px] w-[18px] shrink-0 rounded-[5px]"
                style={{
                  backgroundColor: selectedProject
                    ? projectColor(selectedProject.project, 0)
                    : '#A0A7AE',
                }}
              />
              <span className="truncate">
                {selectedProject?.project.name ?? t('todo.no_project', '未选择项目')}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#798189]" />
            </button>
            <ChevronRight className="h-3.5 w-3.5 text-[#A0A7AE]" />
            {projectView === 'overview' ? (
              <LayoutDashboard className="h-4 w-4 text-[#777F87]" />
            ) : (
              <ListTodo className="h-4 w-4 text-[#777F87]" />
            )}
            <span className="text-[13px] font-semibold text-[#30353A] dark:text-text-primary">
              {projectView === 'overview' ? t('todo.overview', '总览') : 'Work items'}
            </span>
            <span className="rounded-md bg-[#EEF0F2] px-2 py-1 font-mono text-[10px] text-[#707981] dark:bg-muted dark:text-text-muted">
              {items.length}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {projectView === 'work-items' && (
              <>
                <div className="flex h-8 items-center rounded-md bg-[#F1F2F4] p-[3px] dark:bg-muted">
                  <ViewButton
                    testId="todo-view-board"
                    label="Board"
                    active={layout === 'board'}
                    icon={Grid2X2}
                    onClick={() => setLayout('board')}
                  />
                  <ViewButton
                    testId="todo-view-list"
                    label="List"
                    active={layout === 'list'}
                    icon={List}
                    onClick={() => setLayout('list')}
                  />
                </div>
                <ToolbarButton
                  testId="todo-filter-button"
                  icon={Filter}
                  label={t('todo.filter', '筛选')}
                  active={filtersOpen || countActiveTodoFilters(filters) > 0}
                  badge={countActiveTodoFilters(filters)}
                  onClick={() => {
                    setDisplayOpen(false)
                    setFiltersOpen(value => !value)
                  }}
                />
                <ToolbarButton
                  testId="todo-display-button"
                  icon={Settings2}
                  label={t('todo.display', '显示')}
                  active={displayOpen}
                  onClick={() => setDisplayOpen(value => !value)}
                />
              </>
            )}
            <button
              type="button"
              data-testid="todo-create-button"
              onClick={() => setQuickCreateRequest({ state: 'inbox', token: Date.now() })}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[#14B8A6] px-3 text-[12px] font-semibold text-white hover:bg-[#0FA797]"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('todo.create_action', '新建 TODO')}
            </button>
          </div>
          {projectView === 'work-items' && (
            <div
              data-testid="todo-scope-switcher"
              className="absolute left-1/2 top-0 flex h-[38px] -translate-x-1/2 items-end gap-5"
            >
              <button
                type="button"
                data-testid="todo-scope-items"
                onClick={() => setWorkScope('items')}
                className={cn(
                  'h-8 border-b-2 px-1 text-[12px] font-medium',
                  workScope === 'items'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                )}
              >
                {t('todo.items_scope', '事项')}
              </button>
              <button
                type="button"
                data-testid="todo-scope-mine"
                onClick={() => setWorkScope('mine')}
                className={cn(
                  'h-8 border-b-2 px-1 text-[12px] font-medium',
                  workScope === 'mine'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                )}
              >
                {t('todo.my_work', '我的工作')}
              </button>
            </div>
          )}
        </header>

        {projectView === 'work-items' && workScope === 'items' ? (
          <TodoWorkItems
            items={items}
            layout={layout}
            filters={filters}
            display={display}
            filtersOpen={filtersOpen}
            displayOpen={displayOpen}
            onFiltersChange={setFilters}
            onDisplayChange={setDisplay}
            onCloseDisplay={() => setDisplayOpen(false)}
            onSelectItem={item => setSelectedItemId(item.id)}
            onCreate={quickCreate}
            createRequest={quickCreateRequest}
            onMoveItem={(itemId, state) =>
              setWorkItems(current =>
                current.map(item =>
                  item.id === itemId
                    ? { ...item, state, updatedAt: new Date().toISOString() }
                    : item
                )
              )
            }
          />
        ) : projectView === 'work-items' ? (
          <TodoMyWork items={items} onSelectItem={item => setSelectedItemId(item.id)} />
        ) : (
          <TodoOverview
            projectName={selectedProject?.project.name ?? t('todo.no_project', '未选择项目')}
            items={items}
            user={user}
            onOpenWorkItems={() => setProjectView('work-items')}
            onSelectItem={item => setSelectedItemId(item.id)}
          />
        )}

        {projectMenuOpen && (
          <ProjectSwitcherOverlay
            projects={projectEntries}
            selectedProjectId={selectedProject?.project.id ?? null}
            search={projectSearch}
            onSearchChange={setProjectSearch}
            onClose={() => setProjectMenuOpen(false)}
            onSelectProject={projectId => {
              selectProject(projectId)
              setProjectMenuOpen(false)
              setProjectSearch('')
            }}
            onViewAll={() => openWeworkProjects(false)}
          />
        )}
        {searchOpen && (
          <TodoSearchOverlay
            items={items}
            onClose={() => setSearchOpen(false)}
            onSelectItem={item => {
              setSelectedItemId(item.id)
              setSearchOpen(false)
            }}
          />
        )}
        {selectedItem && (selectedItem.kind === 'draft' || onOpenRuntimeTask) && (
          <TodoDetailPanel
            item={selectedItem}
            userName={user?.user_name}
            services={services}
            onClose={() => setSelectedItemId(null)}
            onOpenRuntimeTask={onOpenRuntimeTask}
            onRun={selectedItem.kind === 'draft' ? () => runDraft(selectedItem) : undefined}
            onDelete={
              selectedItem.kind === 'draft' ? () => deleteDraft(selectedItem.id) : undefined
            }
            onAttachmentsChange={
              selectedItem.kind === 'draft'
                ? attachments => updateDraftAttachments(selectedItem.id, attachments)
                : undefined
            }
            onAddChild={
              selectedItem.kind === 'draft' && !selectedItem.parentId
                ? (workTypeKey, workTypeName) =>
                    addChildWorkItem(selectedItem.id, workTypeKey, workTypeName)
                : undefined
            }
            workTypes={workflowConfig.workTypes}
            onApplyWorkflow={
              selectedItem.kind === 'draft' && !selectedItem.parentId
                ? () => applyWorkflowToItem(selectedItem.id)
                : undefined
            }
            onConfigureWorkflow={() => setWorkflowDialogOpen(true)}
            onSelectChild={child => setSelectedItemId(child.id)}
            onUpdateItem={
              selectedItem.kind === 'draft'
                ? patch =>
                    setWorkItems(current =>
                      current.map(item =>
                        item.id === selectedItem.id
                          ? {
                              ...item,
                              ...(patch.state &&
                              !(
                                patch.state === 'started' &&
                                selectedItem.waitingFor &&
                                selectedItem.waitingFor.length > 0
                              )
                                ? { state: patch.state }
                                : {}),
                              ...(patch.assigneeType
                                ? { assignee: { type: patch.assigneeType } }
                                : {}),
                              ...(patch.blocker !== undefined ? { blocker: patch.blocker } : {}),
                              ...(patch.nextAction !== undefined
                                ? { nextAction: patch.nextAction }
                                : {}),
                              events: [
                                ...item.events,
                                {
                                  id: createLocalWorkItemId(),
                                  type: 'updated' as const,
                                  summary: '事项信息已更新',
                                  createdAt: new Date().toISOString(),
                                },
                              ],
                              updatedAt: new Date().toISOString(),
                            }
                          : item
                      )
                    )
                : undefined
            }
            onConfirm={
              selectedItem.kind === 'draft' && !selectedItem.parentId
                ? () =>
                    setWorkItems(current =>
                      current.map(item =>
                        item.id === selectedItem.id
                          ? {
                              ...item,
                              state: 'completed',
                              events: [
                                ...item.events,
                                {
                                  id: createLocalWorkItemId(),
                                  type: 'confirmed' as const,
                                  summary: '事项已确认完成',
                                  createdAt: new Date().toISOString(),
                                },
                              ],
                              updatedAt: new Date().toISOString(),
                            }
                          : item
                      )
                    )
                : undefined
            }
          />
        )}
      </main>
      {workflowDialogOpen && selectedProject && (
        <TodoWorkflowDialog
          projectName={selectedProject.project.name}
          initialConfig={workflowConfig}
          onClose={() => setWorkflowDialogOpen(false)}
          onSave={config => {
            setWorkflowConfig(config)
            saveTodoWorkflow(selectedProject.project.id, config)
            setWorkflowDialogOpen(false)
          }}
        />
      )}
    </div>
  )
}

function ViewButton({
  testId,
  label,
  icon: Icon,
  active = false,
  onClick,
}: {
  testId: string
  label: string
  icon: typeof Grid2X2
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex h-[26px] w-7 items-center justify-center rounded-[5px] text-[#69727A]',
        active && 'bg-white text-[#30353A] shadow-sm dark:bg-background dark:text-text-primary'
      )}
      aria-label={label}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

function ToolbarButton({
  testId,
  icon: Icon,
  label,
  active = false,
  badge = 0,
  onClick,
}: {
  testId: string
  icon: typeof Filter
  label: string
  active?: boolean
  badge?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'relative flex h-8 items-center gap-1.5 rounded-md border border-[#DDE1E4] bg-white px-2.5 text-[11px] font-medium text-[#596169] hover:bg-[#F7F8F9] dark:border-border dark:bg-background dark:text-text-secondary dark:hover:bg-muted',
        active &&
          'border-[#A9DAD3] bg-[#EFF9F7] text-[#0F766E] dark:border-primary/30 dark:bg-primary/10 dark:text-primary'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {badge > 0 && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#14B8A6] px-1 font-mono text-[8px] font-bold text-white">
          {badge}
        </span>
      )}
    </button>
  )
}
