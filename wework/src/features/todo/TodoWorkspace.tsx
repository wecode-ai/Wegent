import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Ellipsis,
  Filter,
  FolderOpen,
  Grid2X2,
  Grid3X3,
  LayoutDashboard,
  List,
  ListChecks,
  ListTodo,
  Plus,
  Search,
  Settings2,
  Signal,
  SlidersHorizontal,
  UserRound,
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
  RuntimeDeviceWorkspace,
  RuntimeTaskSummary,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import { TodoCreateDialog, type TodoCreateValues } from './TodoCreateDialog'
import { TodoDetailPanel, type TodoDetailItem, type TodoViewState } from './TodoDetailPanel'

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

interface TodoProject {
  project: ProjectWithTasks
  workspaces: RuntimeDeviceWorkspace[]
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
  attachments: Attachment[]
  createdAt: string
  updatedAt: string
}

const PROJECT_COLORS = ['#14B8A6', '#6B8AF7', '#D6A34A', '#9B6BE8', '#E879A7']
const TODO_PROJECT_STORAGE_KEY = 'wework:todo:selected-project'
const TODO_DRAFTS_STORAGE_KEY = 'wework:todo:drafts'

const STATE_META: Record<TodoState, { labelKey: string; fallback: string; color: string }> = {
  backlog: { labelKey: 'todo.state_backlog', fallback: '待处理', color: '#858E97' },
  started: { labelKey: 'todo.state_started', fallback: '进行中', color: '#F59E0B' },
  review: { labelKey: 'todo.state_review', fallback: '待确认', color: '#8B5CF6' },
  completed: { labelKey: 'todo.state_completed', fallback: '已完成', color: '#10B981' },
}

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

function projectColor(project: ProjectWithTasks, index: number): string {
  return project.color || PROJECT_COLORS[index % PROJECT_COLORS.length]
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
  const [stateFilter, setStateFilter] = useState<TodoState | 'all'>('all')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [createDialogState, setCreateDialogState] = useState<TodoState | null>(null)
  const [drafts, setDrafts] = useState<TodoDraft[]>(() => loadTodoDrafts(user?.id))
  const usesOverlayTitlebar = isTauriRuntime()
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
          assignee:
            draft.assignee === 'human'
              ? t('todo.assignee_human', '员工')
              : draft.assignee === 'ai'
                ? t('todo.assignee_ai', 'AI 智能体')
                : t('todo.assignee_unassigned_short', '未指定'),
          attachments: draft.attachments,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
        })),
    [drafts, selectedProject?.project.id, selectedProject?.project.name, t]
  )
  const items = useMemo(() => [...draftItems, ...runtimeItems], [draftItems, runtimeItems])
  const visibleItems =
    stateFilter === 'all' ? items : items.filter(item => item.state === stateFilter)
  const selectedItem = items.find(item => item.id === selectedItemId) ?? null
  const selectProject = (projectId: number) => {
    setSelectedProjectId(projectId)
    setSelectedItemId(null)
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        event.stopPropagation()
        setProjectMenuOpen(true)
        return
      }
      if (event.key === 'Escape') setProjectMenuOpen(false)
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
        projects={projectEntries.map(entry => entry.project)}
        selectedProjectId={selectedProject?.project.id ?? null}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed(value => !value)}
        onSelectProject={selectProject}
        onCreate={() => setCreateDialogState('backlog')}
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
            <ListTodo className="h-4 w-4 text-[#777F87]" />
            <span className="text-[13px] font-semibold text-[#30353A] dark:text-text-primary">
              Work items
            </span>
            <span className="rounded-md bg-[#EEF0F2] px-2 py-1 font-mono text-[10px] text-[#707981] dark:bg-muted dark:text-text-muted">
              {items.length}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <div className="flex h-8 items-center rounded-md bg-[#F1F2F4] p-[3px] dark:bg-muted">
              <ViewButton testId="todo-view-board" label="Board" active icon={Grid2X2} />
              <ViewButton testId="todo-view-list" label="List" icon={List} />
              <ViewButton testId="todo-view-grid" label="Grid" icon={Grid3X3} />
            </div>
            <ToolbarButton
              testId="todo-filter-button"
              icon={Filter}
              label={t('todo.filter', '筛选')}
            />
            <ToolbarButton
              testId="todo-display-button"
              icon={Settings2}
              label={t('todo.display', '显示')}
            />
            <ToolbarButton
              testId="todo-analytics-button"
              icon={BarChart3}
              label={t('todo.analytics', '分析')}
            />
            <button
              type="button"
              data-testid="todo-create-button"
              onClick={() => setCreateDialogState('backlog')}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[#14B8A6] px-3 text-[12px] font-semibold text-white hover:bg-[#0FA797]"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('todo.create_action', '新建 TODO')}
            </button>
          </div>
        </header>

        <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-[#E8EAEC] bg-white px-3.5 dark:border-border dark:bg-background">
          <div className="flex items-center gap-1.5">
            <label className="relative">
              <SlidersHorizontal className="pointer-events-none absolute left-2 top-[7px] h-3 w-3 text-[#747D85]" />
              <select
                data-testid="todo-state-filter"
                value={stateFilter}
                onChange={event => setStateFilter(event.target.value as TodoState | 'all')}
                className="h-[26px] appearance-none rounded-[5px] border border-[#E1E4E7] bg-[#F7F8F9] py-0 pl-6 pr-7 text-[10px] text-[#5E666E] outline-none dark:border-border dark:bg-muted dark:text-text-secondary"
              >
                <option value="all">{t('todo.all_work_items', '全部工作项')}</option>
                {(Object.keys(STATE_META) as TodoState[]).map(state => (
                  <option key={state} value={state}>
                    {t(STATE_META[state].labelKey, STATE_META[state].fallback)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-[7px] h-3 w-3 text-[#747D85]" />
            </label>
            <FilterChip
              testId="todo-assignee-filter"
              label={t('todo.assignee_all', '负责人：全部')}
            />
            <FilterChip
              testId="todo-priority-filter"
              label={t('todo.priority_all', '优先级：全部')}
            />
          </div>
          <span className="text-[10px] text-[#7C848C]">
            {t('todo.grouping_hint', '按状态分组 · 手动排序')}
          </span>
        </div>

        <div
          data-testid="todo-board-scroll"
          className="min-h-0 flex-1 overflow-auto bg-[#F7F8F9] p-3 dark:bg-background"
        >
          <div
            data-testid="todo-board-grid"
            className="grid min-h-full min-w-[960px] grid-cols-4 gap-2.5"
          >
            {(Object.keys(STATE_META) as TodoState[]).map(state => (
              <TodoColumn
                key={state}
                state={state}
                items={visibleItems.filter(item => item.state === state)}
                onSelectItem={item => setSelectedItemId(item.id)}
                onCreate={() => setCreateDialogState(state)}
              />
            ))}
          </div>
        </div>

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

function ProjectSwitcherOverlay({
  projects,
  selectedProjectId,
  search,
  onSearchChange,
  onClose,
  onSelectProject,
}: {
  projects: TodoProject[]
  selectedProjectId: number | null
  search: string
  onSearchChange: (value: string) => void
  onClose: () => void
  onSelectProject: (projectId: number) => void
}) {
  const { t } = useTranslation('common')
  const query = search.trim().toLowerCase()
  const filteredProjects = projects.filter(entry =>
    entry.project.name.toLowerCase().includes(query)
  )

  return (
    <div
      data-testid="todo-project-switcher-overlay"
      className="absolute inset-x-0 bottom-0 top-[52px] z-20 bg-[#1118271A]"
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <section
        data-testid="todo-project-switcher-menu"
        className="absolute left-3 top-[-6px] flex h-[350px] w-[314px] flex-col gap-2 rounded-lg border border-[#D7DBDE] bg-white p-3 shadow-[0_10px_26px_rgba(17,24,39,0.20)] dark:border-border dark:bg-background"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between">
          <span className="text-[13px] font-semibold text-[#30353A] dark:text-text-primary">
            {t('todo.switch_project', '切换项目')}
          </span>
          <span className="font-mono text-[10px] text-[#8A9299]">⌘ K</span>
        </div>
        <label className="relative block shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[#818A92]" />
          <input
            autoFocus
            data-testid="todo-project-search-input"
            value={search}
            onChange={event => onSearchChange(event.target.value)}
            placeholder={t('todo.search_projects', '搜索项目…')}
            className="h-[34px] w-full rounded-md border border-[#E0E3E6] bg-[#F7F8F9] pl-8 pr-2 text-[11px] text-[#343A40] outline-none placeholder:text-[#9AA1A8] focus:border-[#9FDCD5] dark:border-border dark:bg-muted dark:text-text-primary"
          />
        </label>
        <span className="shrink-0 text-[10px] font-semibold text-[#969EA5]">
          {t('todo.recent_projects', '最近项目')}
        </span>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filteredProjects.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[11px] text-[#929AA1]">
              {t('todo.no_project_results', '没有匹配的项目')}
            </div>
          ) : (
            filteredProjects.map((entry, index) => {
              const selected = entry.project.id === selectedProjectId
              const count = entry.workspaces.reduce(
                (total, workspace) => total + workspace.tasks.length,
                0
              )
              return (
                <button
                  key={entry.project.id}
                  type="button"
                  data-testid={`todo-project-menu-item-${entry.project.id}`}
                  onClick={() => onSelectProject(entry.project.id)}
                  className={cn(
                    'flex h-[42px] w-full items-center justify-between rounded-md px-2.5 text-left hover:bg-[#F2F4F5] dark:hover:bg-muted',
                    selected && 'bg-[#E8F8F5] dark:bg-primary/10'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-[10px] font-bold text-white"
                      style={{ backgroundColor: projectColor(entry.project, index) }}
                    >
                      {entry.project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-semibold text-[#343A40] dark:text-text-primary">
                        {entry.project.name}
                      </span>
                      <span className="block text-[9px] text-[#929AA1]">
                        {t('todo.work_item_count', {
                          defaultValue: '{{count}} 个工作项',
                          count,
                        })}
                      </span>
                    </span>
                  </span>
                  {selected ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[#0F8F82]" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#A0A7AE]" />
                  )}
                </button>
              )
            })
          )}
        </div>
        <div className="h-px shrink-0 bg-[#E6E8EA] dark:bg-border" />
        <button
          type="button"
          data-testid="todo-view-all-projects"
          className="flex h-[34px] shrink-0 items-center gap-2 rounded-md px-2 text-[11px] font-semibold text-[#596169] hover:bg-[#F2F4F5] dark:text-text-secondary dark:hover:bg-muted"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t('todo.view_all_projects', '查看全部项目')}
        </button>
      </section>
    </div>
  )
}

function TodoSidebar({
  user,
  projects,
  selectedProjectId,
  collapsed,
  onToggleCollapsed,
  onSelectProject,
  onCreate,
}: {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  selectedProjectId: number | null
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelectProject: (projectId: number) => void
  onCreate: () => void
}) {
  const { t } = useTranslation('common')
  const selectedProject =
    projects.find(project => project.id === selectedProjectId) ?? projects[0] ?? null
  const otherProjects = projects.filter(project => project.id !== selectedProject?.id)

  return (
    <aside
      data-testid="todo-sidebar"
      className={cn(
        'relative shrink-0 overflow-hidden border-r border-[#E1E4E7] bg-[#F2F3F4] transition-[width] duration-200 dark:border-border dark:bg-surface',
        collapsed ? 'w-0' : 'w-[252px]'
      )}
    >
      <div className="relative h-full w-[252px]">
        <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
        <div
          data-testid="todo-sidebar-chrome-controls"
          className="absolute left-[92px] top-0 z-10 flex h-[38px] items-center gap-1"
        >
          <DesktopWindowControls
            sidebarCollapsed={false}
            onToggleSidebar={onToggleCollapsed}
            className="gap-1"
          />
          <DesktopAppSwitcher
            activeApp="todo"
            onNavigate={app =>
              navigateTo(app === 'wework' ? '/' : app === 'todo' ? '/todo' : '/apps')
            }
            testIds={{
              wework: 'todo-app-wework',
              todo: 'todo-app-current',
              apps: 'todo-app-apps',
            }}
          />
        </div>

        <nav className="absolute inset-x-2 top-[44px] space-y-0.5">
          <SidebarAction
            testId="todo-sidebar-create"
            icon={Plus}
            label={t('todo.create_action', '新建 TODO')}
            onClick={onCreate}
          />
          <SidebarAction
            testId="todo-sidebar-search"
            icon={Search}
            label={t('workbench.search', '搜索')}
          />
        </nav>

        <div className="absolute inset-x-2 bottom-14 top-[146px] overflow-y-auto">
          <div className="flex h-8 items-center justify-between px-2 text-[11px] font-semibold text-[#939BA3]">
            <span>{t('workbench.projects', '项目')}</span>
            <Plus className="h-3.5 w-3.5" />
          </div>
          {selectedProject && (
            <section>
              <div className="flex h-9 items-center justify-between rounded-md bg-[#E5E7E9] px-2 dark:bg-muted">
                <div className="flex min-w-0 items-center gap-2">
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#68717A]" />
                  <span
                    className="h-[18px] w-[18px] shrink-0 rounded-[5px]"
                    style={{ backgroundColor: projectColor(selectedProject, 0) }}
                  />
                  <span className="truncate text-[12px] font-semibold text-[#30353A] dark:text-text-primary">
                    {selectedProject.name}
                  </span>
                </div>
                <Ellipsis className="h-3.5 w-3.5 text-[#757E86]" />
              </div>
              <ProjectNav icon={LayoutDashboard} label={t('todo.overview', '总览')} />
              <ProjectNav icon={ListTodo} label="Work items" active />
              <ProjectNav icon={CircleDot} label="Cycles" />
              <ProjectNav icon={Boxes} label="Modules" />
            </section>
          )}

          {otherProjects.length > 0 && (
            <section className="mt-5">
              <div className="mb-1 px-2 text-[11px] font-semibold text-[#939BA3]">
                {t('todo.other_projects', '其他项目')}
              </div>
              {otherProjects.map((project, index) => (
                <button
                  key={project.id}
                  type="button"
                  data-testid={`todo-sidebar-project-${project.id}`}
                  onClick={() => onSelectProject(project.id)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-[#E7E9EB] dark:hover:bg-muted"
                >
                  <span
                    className="h-[18px] w-[18px] shrink-0 rounded-[5px]"
                    style={{ backgroundColor: projectColor(project, index + 1) }}
                  />
                  <span className="truncate text-[12px] text-[#555D65] dark:text-text-secondary">
                    {project.name}
                  </span>
                </button>
              ))}
            </section>
          )}
        </div>

        <div className="absolute inset-x-2 bottom-1 flex h-12 items-center gap-2.5 px-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#C9D9FA] text-[#2F6FE4]">
            <UserRound className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-semibold text-[#272B30] dark:text-text-primary">
              {user?.user_name || 'local'}
            </span>
            <span className="block truncate text-[10px] text-[#737B83]">
              {user?.email || 'local@wework.local'}
            </span>
          </span>
        </div>
      </div>
    </aside>
  )
}

function TodoColumn({
  state,
  items,
  onSelectItem,
  onCreate,
}: {
  state: TodoState
  items: TodoItem[]
  onSelectItem: (item: TodoItem) => void
  onCreate: () => void
}) {
  const { t } = useTranslation('common')
  const meta = STATE_META[state]
  return (
    <section data-testid={`todo-column-${state}`} className="min-w-0">
      <header className="flex h-[34px] items-center justify-between px-1.5">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: meta.color }} />
          <span className="text-[12px] font-semibold text-[#30363C] dark:text-text-primary">
            {t(meta.labelKey, meta.fallback)}
          </span>
          <span className="font-mono text-[10px] text-[#7A838B]">{items.length}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[#808890]">
          <button
            type="button"
            data-testid={`todo-column-add-${state}`}
            onClick={onCreate}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-[#EAECED]"
            aria-label={t('todo.create_action', '新建 TODO')}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid={`todo-column-more-${state}`}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-[#EAECED]"
            aria-label={t('workbench.more', '更多')}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      <div className="space-y-2.5">
        {items.map(item => (
          <TodoCard key={item.id} item={item} onClick={() => onSelectItem(item)} />
        ))}
        <button
          type="button"
          data-testid={`todo-column-bottom-add-${state}`}
          onClick={onCreate}
          className="flex h-[34px] w-full items-center gap-2 rounded-md px-2 text-[11px] text-[#7B848C] hover:bg-[#ECEEEF] hover:text-[#4E565E]"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('todo.add_work_item', '添加工作项')}
        </button>
      </div>
    </section>
  )
}

function TodoCard({ item, onClick }: { item: TodoItem; onClick: () => void }) {
  const labelColor = item.runtime.toLowerCase().includes('codex') ? '#14B8A6' : '#9B6BE8'
  const initials = item.assignee?.includes('员工') ? 'HY' : 'AI'
  return (
    <button
      type="button"
      data-testid={`todo-card-${item.id}`}
      onClick={onClick}
      className="flex h-[172px] w-full flex-col gap-2.5 rounded-lg border border-[#DDE1E4] bg-white p-3 text-left shadow-[0_1px_3px_rgba(17,24,39,0.06)] transition-colors hover:border-[#BFC6CB] dark:border-border dark:bg-surface"
    >
      <span className="font-mono text-[10px] font-semibold text-[#858D95]">{item.code}</span>
      <span className="line-clamp-2 min-h-[36px] text-[13px] font-semibold leading-[1.35] text-[#262B30] dark:text-text-primary">
        {item.title}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="flex h-[22px] items-center gap-1 rounded-[5px] border border-[#E2E5E7] bg-[#F7F8F9] px-1.5 text-[9px] font-semibold text-[#626A72] dark:border-border dark:bg-muted dark:text-text-secondary">
          <Signal className="h-3 w-3" />
          {item.priority || (item.state === 'started' ? '高' : '普通')}
        </span>
        <span className="flex h-[22px] min-w-0 items-center gap-1 rounded-[5px] border border-[#E2E5E7] bg-[#F7F8F9] px-1.5 text-[9px] font-semibold text-[#626A72] dark:border-border dark:bg-muted dark:text-text-secondary">
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ backgroundColor: labelColor }}
          />
          <span className="truncate">{item.runtime}</span>
        </span>
      </span>
      <span className="mt-auto flex w-full items-center justify-between">
        <span className="flex min-w-0 items-center gap-1 text-[9px] text-[#727B83]">
          <CircleDot className="h-3 w-3 shrink-0" />
          <span className="max-w-[120px] truncate">{item.workspace}</span>
          <ListChecks className="ml-1 h-3 w-3 shrink-0" />
          <span>{formatShortDate(item.updatedAt)}</span>
        </span>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white bg-[#DDF8F2] text-[9px] font-bold text-[#0F766E]">
          {initials}
        </span>
      </span>
    </button>
  )
}

function SidebarAction({
  testId,
  icon: Icon,
  label,
  onClick,
}: {
  testId: string
  icon: typeof Plus
  label: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-normal leading-[18px] text-[#30353A] hover:bg-[#E7E9EB] dark:text-text-primary dark:hover:bg-muted"
    >
      <Icon className="h-4 w-4 text-current" />
      <span>{label}</span>
    </button>
  )
}

function ProjectNav({
  icon: Icon,
  label,
  active = false,
}: {
  icon: typeof ListTodo
  label: string
  active?: boolean
}) {
  return (
    <div
      className={cn(
        'flex h-8 items-center gap-2 rounded-md pl-9 pr-3 text-[11px] text-[#58616A] dark:text-text-secondary',
        active && 'bg-[#E8F8F5] font-semibold text-[#0F766E] dark:bg-primary/10 dark:text-primary'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  )
}

function ViewButton({
  testId,
  label,
  icon: Icon,
  active = false,
}: {
  testId: string
  label: string
  icon: typeof Grid2X2
  active?: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
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
}: {
  testId: string
  icon: typeof Filter
  label: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="flex h-8 items-center gap-1.5 rounded-md border border-[#DDE1E4] bg-white px-2.5 text-[11px] font-medium text-[#596169] hover:bg-[#F7F8F9] dark:border-border dark:bg-background dark:text-text-secondary dark:hover:bg-muted"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

function FilterChip({ testId, label }: { testId: string; label: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="flex h-[26px] items-center gap-1 rounded-[5px] border border-[#E1E4E7] bg-[#F7F8F9] px-2 text-[10px] text-[#5E666E] dark:border-border dark:bg-muted dark:text-text-secondary"
    >
      {label}
      <ChevronDown className="h-3 w-3" />
    </button>
  )
}

function formatShortDate(value: string | number | null | undefined): string {
  if (value == null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(date)
}
