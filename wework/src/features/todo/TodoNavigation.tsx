import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  LayoutDashboard,
  ListTodo,
  Plus,
  Search,
  UserRound,
} from 'lucide-react'
import { DesktopAppSwitcher } from '@/components/layout/DesktopAppSwitcher'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import type { ProjectWithTasks, RuntimeDeviceWorkspace, User as UserProfile } from '@/types/api'
import type { TodoDetailItem } from './TodoDetailPanel'
import { projectColor } from './todoProject'

export type TodoProjectView = 'overview' | 'work-items'

export interface TodoProject {
  project: ProjectWithTasks
  workspaces: RuntimeDeviceWorkspace[]
}

type TodoItem = TodoDetailItem

export function ProjectSwitcherOverlay({
  projects,
  selectedProjectId,
  search,
  onSearchChange,
  onClose,
  onSelectProject,
  onViewAll,
}: {
  projects: TodoProject[]
  selectedProjectId: number | null
  search: string
  onSearchChange: (value: string) => void
  onClose: () => void
  onSelectProject: (projectId: number) => void
  onViewAll: () => void
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
          onClick={onViewAll}
          className="flex h-[34px] shrink-0 items-center gap-2 rounded-md px-2 text-[11px] font-semibold text-[#596169] hover:bg-[#F2F4F5] dark:text-text-secondary dark:hover:bg-muted"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t('todo.view_all_projects', '查看全部项目')}
        </button>
      </section>
    </div>
  )
}

export function TodoSearchOverlay({
  items,
  onClose,
  onSelectItem,
}: {
  items: TodoItem[]
  onClose: () => void
  onSelectItem: (item: TodoItem) => void
}) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const results = items.filter(item =>
    [item.code, item.title, item.description, item.objective, item.workspace]
      .filter(Boolean)
      .some(value => value!.toLowerCase().includes(normalizedQuery))
  )
  return (
    <div
      data-testid="todo-search-overlay"
      className="absolute inset-0 z-40 flex items-start justify-center bg-[#11182733] pt-[72px]"
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <section
        data-testid="todo-search-dialog"
        className="flex max-h-[520px] w-[560px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-xl border border-[#D7DBDE] bg-white shadow-[0_18px_42px_rgba(17,24,39,0.24)] dark:border-border dark:bg-background"
        onMouseDown={event => event.stopPropagation()}
      >
        <label className="relative flex h-14 shrink-0 items-center border-b border-[#E2E5E7] px-4 dark:border-border">
          <Search className="h-4 w-4 shrink-0 text-[#717A82]" />
          <input
            autoFocus
            data-testid="todo-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('todo.search_todos', '搜索标题、编号或任务内容…')}
            className="min-w-0 flex-1 bg-transparent px-3 text-[13px] text-[#30363C] outline-none placeholder:text-[#9AA1A8] dark:text-text-primary"
          />
          <button
            type="button"
            data-testid="todo-search-close"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#717A82] hover:bg-[#F2F4F5] dark:hover:bg-muted"
            aria-label={t('workbench.close', '关闭')}
          >
            <span className="font-mono text-[10px]">ESC</span>
          </button>
        </label>
        <div className="min-h-0 overflow-y-auto p-2">
          {results.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-[11px] text-[#929AA1]">
              {t('todo.no_matching_items', '暂无符合条件的 TODO')}
            </div>
          ) : (
            results.map(item => (
              <button
                key={item.id}
                type="button"
                data-testid={`todo-search-result-${item.id}`}
                onClick={() => onSelectItem(item)}
                className="flex h-14 w-full items-center justify-between rounded-lg px-3 text-left hover:bg-[#F3F5F6] dark:hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-semibold text-[#30363C] dark:text-text-primary">
                    {item.title}
                  </span>
                  <span className="mt-1 block truncate text-[9px] text-[#858E96]">
                    {item.code} · {item.workspace}
                  </span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#9AA1A8]" />
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

export function TodoSidebar({
  user,
  projects,
  projectItemCounts,
  selectedProjectId,
  expandedProjectId,
  activeView,
  collapsed,
  onToggleCollapsed,
  onSelectProject,
  onToggleProject,
  onSelectView,
  onCreate,
  onSearch,
  onAddProject,
  onOpenProjects,
}: {
  user: UserProfile | null
  projects: TodoProject[]
  projectItemCounts: Record<number, number>
  selectedProjectId: number | null
  expandedProjectId: number | null
  activeView: TodoProjectView
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelectProject: (projectId: number) => void
  onToggleProject: (projectId: number) => void
  onSelectView: (view: TodoProjectView) => void
  onCreate: () => void
  onSearch: () => void
  onAddProject: () => void
  onOpenProjects: () => void
}) {
  const { t } = useTranslation('common')
  const [projectActionsOpen, setProjectActionsOpen] = useState(false)
  const selectedProject =
    projects.find(entry => entry.project.id === selectedProjectId) ?? projects[0] ?? null
  const otherProjects = projects.filter(entry => entry.project.id !== selectedProject?.project.id)
  const selectedExpanded = expandedProjectId === selectedProject?.project.id
  const projectItemCount = (entry: TodoProject) =>
    projectItemCounts[entry.project.id] ??
    entry.workspaces.reduce((total, workspace) => total + workspace.tasks.length, 0)

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
            onClick={onSearch}
          />
        </nav>

        <div className="absolute inset-x-2 bottom-14 top-[146px] overflow-y-auto">
          <div className="flex h-8 items-center justify-between px-2 text-[11px] font-semibold text-[#939BA3]">
            <span>{t('workbench.projects', '项目')}</span>
            <button
              type="button"
              data-testid="todo-sidebar-add-project"
              onClick={onAddProject}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-[#E7E9EB] dark:hover:bg-muted"
              aria-label={t('todo.add_project', '添加项目')}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {selectedProject && (
            <section className="relative">
              <div className="flex h-9 items-center rounded-md bg-[#E5E7E9] pr-1 dark:bg-muted">
                <button
                  type="button"
                  data-testid={`todo-sidebar-project-${selectedProject.project.id}`}
                  aria-expanded={selectedExpanded}
                  onClick={() => onToggleProject(selectedProject.project.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left"
                >
                  {selectedExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#68717A]" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#68717A]" />
                  )}
                  <span
                    className="h-5 w-5 shrink-0 rounded-[5px]"
                    style={{ backgroundColor: projectColor(selectedProject.project, 0) }}
                  />
                  <span className="truncate text-[12px] font-semibold text-[#30353A] dark:text-text-primary">
                    {selectedProject.project.name}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid={`todo-sidebar-project-more-${selectedProject.project.id}`}
                  aria-expanded={projectActionsOpen}
                  onClick={() => setProjectActionsOpen(value => !value)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[#D9DCDE] dark:hover:bg-background"
                  aria-label={t('todo.project_actions', '项目操作')}
                >
                  <Ellipsis className="h-3.5 w-3.5 text-[#757E86]" />
                </button>
              </div>
              {projectActionsOpen && (
                <div
                  data-testid="todo-sidebar-project-menu"
                  className="absolute right-0 top-10 z-30 w-44 rounded-md border border-[#D8DCE0] bg-white p-1 shadow-lg dark:border-border dark:bg-background"
                >
                  <button
                    type="button"
                    data-testid="todo-sidebar-open-in-wework"
                    onClick={onOpenProjects}
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-[10px] text-[#4F575F] hover:bg-[#F2F4F5] dark:text-text-secondary dark:hover:bg-muted"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t('todo.open_in_wework', '在 Wework 中打开')}
                  </button>
                  <button
                    type="button"
                    data-testid="todo-sidebar-menu-add-project"
                    onClick={onAddProject}
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-[10px] text-[#4F575F] hover:bg-[#F2F4F5] dark:text-text-secondary dark:hover:bg-muted"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('todo.add_project', '添加项目')}
                  </button>
                </div>
              )}
              {selectedExpanded && (
                <>
                  <ProjectNav
                    testId="todo-sidebar-overview"
                    icon={LayoutDashboard}
                    label={t('todo.overview', '总览')}
                    active={activeView === 'overview'}
                    onClick={() => onSelectView('overview')}
                  />
                  <ProjectNav
                    testId="todo-sidebar-work-items"
                    icon={ListTodo}
                    label="Work items"
                    count={projectItemCount(selectedProject)}
                    active={activeView === 'work-items'}
                    onClick={() => onSelectView('work-items')}
                  />
                </>
              )}
            </section>
          )}

          {otherProjects.length > 0 && (
            <section className="mt-0.5">
              {otherProjects.map((entry, index) => (
                <button
                  key={entry.project.id}
                  type="button"
                  data-testid={`todo-sidebar-project-${entry.project.id}`}
                  aria-expanded={false}
                  onClick={() => onSelectProject(entry.project.id)}
                  className="flex h-9 w-full items-center justify-between rounded-md px-2 text-left hover:bg-[#E7E9EB] dark:hover:bg-muted"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#899198]" />
                    <span
                      className="h-5 w-5 shrink-0 rounded-[5px]"
                      style={{ backgroundColor: projectColor(entry.project, index + 1) }}
                    />
                    <span className="truncate text-[12px] text-[#555D65] dark:text-text-secondary">
                      {entry.project.name}
                    </span>
                  </span>
                  <span className="font-mono text-[10px] text-[#9AA1A8]">
                    {projectItemCount(entry)}
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
  testId,
  icon: Icon,
  label,
  count,
  active = false,
  onClick,
}: {
  testId: string
  icon: typeof ListTodo
  label: string
  count?: number
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center justify-between rounded-md pl-9 pr-3 text-[11px] text-[#58616A] hover:bg-[#E7E9EB] dark:text-text-secondary dark:hover:bg-muted',
        active && 'bg-[#E8F8F5] font-semibold text-[#0F766E] dark:bg-primary/10 dark:text-primary'
      )}
    >
      <span className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      {count != null && (
        <span
          className={cn(
            'flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-[9px] text-[#818A92]',
            active && 'bg-[#D6EEEA] text-[#14786F] dark:bg-primary/15 dark:text-primary'
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}
