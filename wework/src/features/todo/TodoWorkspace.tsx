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
import { WindowFrameControls } from '@/components/layout/WindowFrameControls'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
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
import { TodoCreateDialog, type TodoCreateValues } from './TodoCreateDialog'
import { TodoDetailPanel, type TodoDetailItem, type TodoViewState } from './TodoDetailPanel'
import {
  ProjectSwitcherOverlay,
  TodoSearchOverlay,
  TodoSidebar,
  type TodoProject,
  type TodoProjectView,
} from './TodoNavigation'
import { TodoOverview } from './TodoOverview'
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

type TodoState = TodoViewState

interface TodoWorkspaceProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  runtimeWork: RuntimeWorkListResponse | null
  currentProjectId?: number | null
  services?: WorkbenchServices
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  modelName?: string | null
  onRunTodo?: (request: TodoRunRequest) => Promise<RuntimeTaskAddress | false>
}

export interface TodoRunRequest {
  project: ProjectWithTasks
  message: string
  goal?: string
  attachments: Attachment[]
}

type TodoItem = TodoDetailItem

interface TodoDraft {
  id: string
  projectId: number
  state: TodoState
  title: string
  markdown: string
  goal: string
  priority: TodoCreateValues['priority']
  assignee: TodoCreateValues['assignee']
  launchMode: TodoCreateValues['launchMode']
  dueDate?: string
  attachments: Attachment[]
  createdAt: string
  updatedAt: string
}

const TODO_PROJECT_STORAGE_KEY = 'wework:todo:selected-project'
const TODO_DRAFTS_STORAGE_KEY = 'wework:todo:drafts'
const TODO_VIEW_STORAGE_KEY = 'wework:todo:view'

function collectProjects(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null
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

function loadTodoDrafts(userId: number | undefined): TodoDraft[] {
  try {
    const raw = window.localStorage.getItem(`${TODO_DRAFTS_STORAGE_KEY}:${userId ?? 'local'}`)
    if (!raw) return []
    const value = JSON.parse(raw) as TodoDraft[]
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
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
  modelName,
  onRunTodo,
}: TodoWorkspaceProps) {
  const { t } = useTranslation('common')
  const projectEntries = useMemo(
    () => collectProjects(projects, runtimeWork),
    [projects, runtimeWork]
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
  const [createDialogState, setCreateDialogState] = useState<TodoState | null>(null)
  const [drafts, setDrafts] = useState<TodoDraft[]>(() => loadTodoDrafts(user?.id))
  const usesOverlayTitlebar = isTauriRuntime()
  const platform = getPlatform()
  const selectedProject =
    projectEntries.find(entry => entry.project.id === selectedProjectId) ??
    projectEntries[0] ??
    null
  const runtimeItems = useMemo(() => buildTodoItems(selectedProject), [selectedProject])
  const draftItems = useMemo<TodoItem[]>(
    () =>
      drafts
        .filter(draft => draft.projectId === selectedProject?.project.id)
        .map(draft => ({
          id: draft.id,
          kind: 'draft',
          code: `TODO-${draft.id.slice(-4).toUpperCase()}`,
          title: draft.title,
          state: draft.state,
          runtime: draft.assignee === 'human' ? t('todo.assignee_human', '员工') : 'TODO',
          workspace: selectedProject?.project.name ?? '',
          description: draft.markdown,
          objective: draft.goal,
          priority:
            draft.priority === 'none'
              ? t('todo.priority_none_short', '无')
              : t(`todo.priority_${draft.priority}`, draft.priority),
          priorityValue: draft.priority,
          assignee:
            draft.assignee === 'human'
              ? t('todo.assignee_human', '员工')
              : draft.assignee === 'ai'
                ? t('todo.assignee_ai', 'AI 智能体')
                : t('todo.assignee_unassigned_short', '未指定'),
          assigneeType: draft.assignee,
          dueDate: draft.dueDate,
          attachments: draft.attachments,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
        })),
    [drafts, selectedProject?.project.id, selectedProject?.project.name, t]
  )
  const items = useMemo(() => [...draftItems, ...runtimeItems], [draftItems, runtimeItems])
  const projectItemCounts = useMemo(
    () =>
      Object.fromEntries(
        projectEntries.map(entry => [
          entry.project.id,
          entry.workspaces.reduce((total, workspace) => total + workspace.tasks.length, 0) +
            drafts.filter(draft => draft.projectId === entry.project.id).length,
        ])
      ),
    [drafts, projectEntries]
  )
  const selectedItem = items.find(item => item.id === selectedItemId) ?? null
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
    try {
      window.localStorage.setItem(
        `${TODO_DRAFTS_STORAGE_KEY}:${user?.id ?? 'local'}`,
        JSON.stringify(drafts)
      )
    } catch {
      // Drafts remain available for the current session.
    }
  }, [drafts, user?.id])

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

  const uploadFiles = async (files: File[]): Promise<Attachment[]> => {
    if (files.length === 0) return []
    if (!services?.attachmentApi) {
      throw new Error(t('todo.attachments_unavailable', '附件服务当前不可用'))
    }
    return Promise.all(files.map(file => services.attachmentApi!.uploadAttachment(file)))
  }

  const createDraft = (values: TodoCreateValues, attachments: Attachment[]) => {
    const now = new Date().toISOString()
    const draft: TodoDraft = {
      id: `draft-${crypto.randomUUID()}`,
      projectId: values.projectId,
      state: values.state,
      title: deriveTodoTitle(values.markdown),
      markdown: values.markdown.trim(),
      goal: values.goal.trim(),
      priority: values.priority,
      assignee: values.assignee,
      launchMode: values.launchMode,
      dueDate: values.dueDate,
      attachments,
      createdAt: now,
      updatedAt: now,
    }
    setDrafts(current => [draft, ...current])
    selectProject(values.projectId)
    return draft
  }

  const submitTodo = async (values: TodoCreateValues, runImmediately: boolean) => {
    const project = projectEntries.find(entry => entry.project.id === values.projectId)?.project
    if (!project) throw new Error(t('todo.no_project', '未选择项目'))
    if (runImmediately && values.assignee === 'unassigned') {
      throw new Error(t('todo.executor_required', '请先选择员工或 AI 智能体作为执行者'))
    }
    const attachments = await uploadFiles(values.files)

    if (!runImmediately || values.assignee === 'human') {
      createDraft(
        {
          ...values,
          state: runImmediately && values.assignee === 'human' ? 'started' : values.state,
        },
        attachments
      )
      setCreateDialogState(null)
      return
    }
    if (!onRunTodo) throw new Error(t('todo.run_unavailable', '运行服务当前不可用'))
    const address = await onRunTodo({
      project,
      message: values.markdown.trim(),
      goal: values.goal.trim() || undefined,
      attachments,
    })
    if (!address) throw new Error(t('todo.create_failed', 'TODO 创建失败'))
    selectProject(values.projectId)
    setCreateDialogState(null)
  }

  const runDraft = async (item: TodoItem) => {
    const draft = drafts.find(entry => entry.id === item.id)
    if (!draft) return
    const project = projectEntries.find(entry => entry.project.id === draft.projectId)?.project
    if (!project || !onRunTodo) throw new Error(t('todo.run_unavailable', '运行服务当前不可用'))
    if (draft.assignee === 'unassigned') {
      throw new Error(t('todo.executor_required', '请先选择员工或 AI 智能体作为执行者'))
    }
    if (draft.assignee === 'human') {
      setDrafts(current =>
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
      message: draft.markdown,
      goal: draft.goal || undefined,
      attachments: draft.attachments,
    })
    if (!address) throw new Error(t('todo.create_failed', 'TODO 创建失败'))
    setDrafts(current => current.filter(entry => entry.id !== draft.id))
    setSelectedItemId(null)
  }

  const updateDraftAttachments = (draftId: string, attachments: Attachment[]) => {
    setDrafts(current =>
      current.map(draft =>
        draft.id === draftId
          ? { ...draft, attachments, updatedAt: new Date().toISOString() }
          : draft
      )
    )
  }

  const deleteDraft = (draftId: string) => {
    setDrafts(current => current.filter(draft => draft.id !== draftId))
    setSelectedItemId(null)
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
        onCreate={() => setCreateDialogState('backlog')}
        onSearch={() => setSearchOpen(true)}
        onAddProject={() => openWeworkProjects(true)}
        onOpenProjects={() => openWeworkProjects(false)}
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
                  usesOverlayTitlebar && platform === 'mac' && 'pl-[92px]'
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
                    wework: 'todo-collapsed-app-wework',
                    todo: 'todo-collapsed-app-current',
                    apps: 'todo-collapsed-app-apps',
                    wegent: 'todo-collapsed-app-wegent',
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
              className="flex h-8 max-w-[220px] items-center gap-2 rounded-md px-2 text-sm font-medium text-[#30353A] hover:bg-[#F1F2F4] dark:text-text-primary dark:hover:bg-muted"
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
            <span className="text-sm font-semibold text-[#30353A] dark:text-text-primary">
              {projectView === 'overview' ? t('todo.overview', '总览') : 'Work items'}
            </span>
            <span className="rounded-md bg-[#EEF0F2] px-2 py-1 font-mono text-xs text-[#707981] dark:bg-muted dark:text-text-muted">
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
              onClick={() => setCreateDialogState('backlog')}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[#14B8A6] px-3 text-xs font-semibold text-white hover:bg-[#0FA797]"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('todo.create_action', '新建 TODO')}
            </button>
            {platform === 'win' && (
              <div className="relative z-chrome h-8" data-tauri-drag-region={false}>
                <WindowFrameControls className="h-full" />
              </div>
            )}
          </div>
        </header>

        {projectView === 'work-items' ? (
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
            onCreate={state => setCreateDialogState(state)}
          />
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
          />
        )}
      </main>
      {createDialogState && selectedProject && (
        <TodoCreateDialog
          projects={projectEntries.map(entry => entry.project)}
          initialProjectId={selectedProject.project.id}
          initialState={createDialogState}
          modelName={modelName}
          onClose={() => setCreateDialogState(null)}
          onSubmit={submitTodo}
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
        'relative flex h-8 items-center gap-1.5 rounded-md border border-[#DDE1E4] bg-white px-2.5 text-xs font-medium text-[#596169] hover:bg-[#F7F8F9] dark:border-border dark:bg-background dark:text-text-secondary dark:hover:bg-muted',
        active &&
          'border-[#A9DAD3] bg-[#EFF9F7] text-[#0F766E] dark:border-primary/30 dark:bg-primary/10 dark:text-primary'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {badge > 0 && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#14B8A6] px-1 font-mono text-xs font-bold text-white">
          {badge}
        </span>
      )}
    </button>
  )
}
