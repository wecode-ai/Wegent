import {
  Archive,
  ChevronDown,
  ChevronRight,
  Edit3,
  Folder,
  FolderGit2,
  FolderPlus,
  Loader2,
  MessageSquarePlus,
  Plus,
  Search,
  Settings,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type {
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeviceInfo,
  GitBranch,
  GitRepoInfo,
  ProjectTask,
  ProjectWithTasks,
  Task,
  TaskDetail,
  TaskListResponse,
  User as UserProfile,
} from '@/types/api'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'
import { DesktopSearchDialog } from './DesktopSearchDialog'
import { DesktopWindowControls } from './DesktopWindowControls'
import {
  DesktopTopBar,
  MAC_NATIVE_TOP_BAR_ACTION_INSET,
} from './DesktopTopBar'
import { useResizableSidebar } from './useResizableSidebar'

interface DesktopSidebarProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  recentTasks: Task[]
  runningTaskIds: Set<number>
  currentProjectId?: number
  currentTaskId?: number
  preferredDeviceId?: string | null
  activeItem?: 'chat' | 'plugins' | 'automation'
  onCollapse: () => void
  onNewChat: () => void
  onStartStandaloneChat: () => void
  onSelectProject: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onSearchTasks?: (query: string) => Promise<TaskListResponse>
  onSearchTaskDetail?: (taskId: number) => Promise<TaskDetail>
  onRememberExecutionDevice?: (deviceId: string) => void
  onOpenPlugins: () => void
  onRefreshDevices?: () => Promise<void>
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject: (
    data: CreateGitWorkspaceProjectRequest,
  ) => Promise<ProjectWithTasks>
  onListGitRepositories: () => Promise<GitRepoInfo[]>
  onListGitBranches: (repo: GitRepoInfo) => Promise<GitBranch[]>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onArchiveAllChats: () => Promise<void>
  onArchiveAllProjectChats: () => Promise<void>
  onArchiveProjectChats: (projectId: number) => Promise<void>
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (taskId: number, title: string) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenSettings: () => void
  onLogout: () => void
}

type ProjectCreateMode = 'scratch' | 'existing' | 'git'

function SidebarButton({
  icon: Icon,
  label,
  testId,
  selected,
  onClick,
}: {
  icon: typeof Plus
  label: string
  testId: string
  selected?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={[
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium leading-[18px]',
        selected
          ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
          : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 text-[rgb(var(--color-sidebar-text-secondary))]" />
      <span>{label}</span>
    </button>
  )
}

const INITIAL_PROJECT_CHAT_COUNT = 5

function handleSidebarRowKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onOpen: () => void,
) {
  if (event.key !== 'Enter' && event.key !== ' ') return

  event.preventDefault()
  onOpen()
}

function SidebarSectionHeader({
  title,
  expanded,
  toggleTestId,
  iconTestId,
  onToggle,
  children,
}: {
  title: string
  expanded: boolean
  toggleTestId: string
  iconTestId: string
  onToggle: () => void
  children: ReactNode
}) {
  const ToggleIcon = expanded ? ChevronDown : ChevronRight
  const iconVisibilityClass = 'opacity-0 group-hover/section:opacity-100'

  return (
    <div className="group/section mb-2 flex h-7 items-center justify-between px-2.5">
      <button
        type="button"
        data-testid={toggleTestId}
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left"
      >
        <span className="truncate text-[13px] font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]">
          {title}
        </span>
        <ToggleIcon
          data-testid={iconTestId}
          className={`h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))] transition-opacity ${iconVisibilityClass}`}
        />
      </button>
      <div className="flex items-center opacity-0 transition-opacity group-hover/section:opacity-100 focus-within:opacity-100">
        {children}
      </div>
    </div>
  )
}

function formatRelativeSidebarTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const elapsedMs = Math.max(0, Date.now() - date.getTime())
  const minutes = Math.floor(elapsedMs / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  return `${Math.floor(days / 7)}w`
}

function getProjectTaskTitle(task: ProjectTask) {
  return task.task_title || task.title || `Task #${task.task_id}`
}

function getProjectTaskTime(task: ProjectTask) {
  return task.updated_at || task.created_at
}

function sortProjectTasks(tasks: ProjectTask[] = []) {
  return [...tasks].sort((left, right) => {
    const leftTime = new Date(getProjectTaskTime(left) || 0).getTime()
    const rightTime = new Date(getProjectTaskTime(right) || 0).getTime()
    return rightTime - leftTime
  })
}

function sortTasksByTime(tasks: Task[] = []) {
  return [...tasks].sort((left, right) => {
    const leftTime = new Date(left.updated_at || left.created_at || 0).getTime()
    const rightTime = new Date(right.updated_at || right.created_at || 0).getTime()
    return rightTime - leftTime
  })
}

function ProjectTaskRow({
  task,
  selected,
  running,
  onOpenTask,
  projectId,
  onArchiveTask,
  onRenameTask,
}: {
  task: ProjectTask
  selected: boolean
  running: boolean
  onOpenTask: (taskId: number, projectId?: number) => void
  projectId: number
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (task: ProjectTask) => void
}) {
  const { t } = useTranslation('common')
  const title = getProjectTaskTitle(task)
  const handleOpen = () => onOpenTask(task.task_id, projectId)

  return (
    <div
      data-testid={`project-chat-row-${task.task_id}`}
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(event) => handleSidebarRowKeyDown(event, handleOpen)}
      className={[
        'group/task flex h-8 cursor-default items-center rounded-md pl-10 pr-0.5 text-[13px] leading-[18px]',
        selected
          ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
          : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
      ].join(' ')}
    >
      <span
        data-testid="project-chat-button"
        className="min-w-0 flex-1 truncate"
      >
        {title}
      </span>
      <div className="relative ml-2 flex h-7 w-8 shrink-0 items-center justify-end">
        {running ? (
          <Loader2
            data-testid={`project-chat-spinner-${task.task_id}`}
            className="h-3.5 w-3.5 animate-spin text-primary"
          />
        ) : (
          <span
            data-testid={`project-chat-time-${task.task_id}`}
            className="text-xs text-[rgb(var(--color-sidebar-text-muted))] transition-opacity group-hover/task:opacity-0 focus-within:opacity-0"
          >
            {formatRelativeSidebarTime(getProjectTaskTime(task))}
          </span>
        )}
        <div
          data-testid={`project-chat-actions-${task.task_id}`}
          className="absolute inset-0 opacity-0 transition-opacity group-hover/task:opacity-100 focus-within:opacity-100"
        >
          <ActionMenu
            ariaLabel={t('workbench.chat_actions', '会话操作')}
            testId={`project-chat-menu-${task.task_id}`}
            variant="vertical"
            items={[
              {
                label: t('workbench.archive_chat', '归档会话'),
                icon: Archive,
                testId: `archive-chat-${task.task_id}`,
                onSelect: () => onArchiveTask(task.task_id),
              },
              {
                label: t('workbench.rename_chat', '重命名会话'),
                icon: Edit3,
                testId: `rename-chat-${task.task_id}`,
                onSelect: () => onRenameTask(task),
              },
            ]}
          />
        </div>
      </div>
    </div>
  )
}

function ProjectItem({
  project,
  expanded,
  showAllTasks,
  activeTaskId,
  runningTaskIds,
  onToggleProject,
  onToggleTaskLimit,
  onStartNewProjectChat,
  onArchiveProjectChats,
  onRemoveProject,
  onRenameProject,
  onOpenTask,
  onArchiveTask,
  onRenameTask,
}: {
  project: ProjectWithTasks
  expanded: boolean
  showAllTasks: boolean
  activeTaskId?: number
  runningTaskIds: Set<number>
  onToggleProject: (projectId: number) => void
  onToggleTaskLimit: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onArchiveProjectChats: (projectId: number) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onRenameProject: (project: ProjectWithTasks) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (task: ProjectTask) => void
}) {
  const { t } = useTranslation('common')
  const tasks = useMemo(() => sortProjectTasks(project.tasks), [project.tasks])
  const hasMoreTasks = tasks.length > INITIAL_PROJECT_CHAT_COUNT
  const visibleTasks = showAllTasks ? tasks : tasks.slice(0, INITIAL_PROJECT_CHAT_COUNT)
  const projectRunning = tasks.some(task => runningTaskIds.has(task.task_id))

  return (
    <div data-testid="project-item" className="space-y-0.5">
      <div
        data-testid={`project-row-${project.id}`}
        className="group/project flex h-8 items-center gap-1 rounded-md pl-2.5 pr-1 text-[13px] leading-[18px] text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
      >
        <button
          type="button"
          data-testid="project-item-button"
          onClick={() => onToggleProject(project.id)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <ProjectFolderIcon
            project={project}
            className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-secondary))]"
          />
          <span className="truncate">{project.name}</span>
        </button>
        {!expanded && projectRunning && (
          <Loader2
            data-testid={`project-spinner-${project.id}`}
            className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
          />
        )}
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100">
          <ActionMenu
            ariaLabel={t('workbench.project_actions', '项目操作')}
            testId={`project-menu-${project.id}`}
            items={[
              {
                label: t('workbench.rename_project', '重命名项目'),
                icon: Edit3,
                testId: `rename-project-${project.id}`,
                onSelect: () => onRenameProject(project),
              },
              {
                label: t('workbench.archive_chats', '归档会话'),
                icon: Archive,
                testId: `archive-project-chats-${project.id}`,
                onSelect: () => onArchiveProjectChats(project.id),
              },
              {
                label: t('workbench.remove_project', '移除'),
                icon: X,
                testId: `remove-project-${project.id}`,
                danger: true,
                onSelect: () => onRemoveProject(project.id),
              },
            ]}
          />
          <button
            type="button"
            data-testid="project-new-conversation-button"
            onClick={event => {
              event.stopPropagation()
              onStartNewProjectChat(project.id)
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
            aria-label={t('workbench.new_project_chat', '新建项目对话')}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-0.5">
          {tasks.length === 0 ? (
            <div className="ml-10 rounded-md px-2 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]">
              {t('workbench.no_chats', '暂无会话')}
            </div>
          ) : (
            visibleTasks.map(task => (
              <ProjectTaskRow
                key={task.task_id}
                task={task}
                selected={activeTaskId === task.task_id}
                running={runningTaskIds.has(task.task_id)}
                onOpenTask={onOpenTask}
                projectId={project.id}
                onArchiveTask={onArchiveTask}
                onRenameTask={onRenameTask}
              />
            ))
          )}
          {hasMoreTasks && (
            <button
              type="button"
              data-testid={`project-task-limit-toggle-${project.id}`}
              onClick={() => onToggleTaskLimit(project.id)}
              className="ml-10 h-8 rounded-md px-2 text-left text-xs font-medium text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
            >
              {showAllTasks
                ? t('workbench.show_less', '收起')
                : t('workbench.show_more', '显示更多')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function RecentTaskRow({
  task,
  selected,
  running,
  onOpenTask,
  onArchiveTask,
  onRenameTask,
}: {
  task: Task
  selected: boolean
  running: boolean
  onOpenTask: (taskId: number, projectId?: number) => void
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (task: Task) => void
}) {
  const { t } = useTranslation('common')
  const handleOpen = () => onOpenTask(task.id, task.project_id ?? 0)

  return (
    <div
      data-testid={`history-task-row-${task.id}`}
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(event) => handleSidebarRowKeyDown(event, handleOpen)}
      className={[
        'group/task flex h-8 cursor-default items-center rounded-md pl-3 pr-0.5 text-[13px] leading-[18px]',
        selected
          ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
          : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
      ].join(' ')}
    >
      <span
        data-testid="history-task-button"
        className="min-w-0 flex-1 truncate"
      >
        {task.title}
      </span>
      <div className="relative ml-2 flex h-7 w-8 shrink-0 items-center justify-end">
        {running ? (
          <Loader2
            data-testid={`history-task-spinner-${task.id}`}
            className="h-3.5 w-3.5 animate-spin text-primary"
          />
        ) : (
          <span
            data-testid={`history-task-time-${task.id}`}
            className="text-xs text-[rgb(var(--color-sidebar-text-muted))] transition-opacity group-hover/task:opacity-0 focus-within:opacity-0"
          >
            {formatRelativeSidebarTime(task.updated_at || task.created_at)}
          </span>
        )}
        <div
          data-testid={`history-task-actions-${task.id}`}
          className="absolute inset-0 opacity-0 transition-opacity group-hover/task:opacity-100 focus-within:opacity-100"
        >
          <ActionMenu
            ariaLabel={t('workbench.chat_actions', '会话操作')}
            testId={`history-task-menu-${task.id}`}
            variant="vertical"
            items={[
              {
                label: t('workbench.archive_chat', '归档会话'),
                icon: Archive,
                testId: `archive-history-chat-${task.id}`,
                onSelect: () => onArchiveTask(task.id),
              },
              {
                label: t('workbench.rename_chat', '重命名会话'),
                icon: Edit3,
                testId: `rename-history-chat-${task.id}`,
                onSelect: () => onRenameTask(task),
              },
            ]}
          />
        </div>
      </div>
    </div>
  )
}

export function DesktopSidebar({
  user,
  projects,
  devices,
  recentTasks,
  runningTaskIds,
  currentProjectId,
  currentTaskId,
  preferredDeviceId,
  activeItem = 'chat',
  onCollapse,
  onNewChat,
  onStartStandaloneChat,
  onStartNewProjectChat,
  onOpenTask,
  onSearchTasks,
  onSearchTaskDetail,
  onRememberExecutionDevice,
  onOpenPlugins,
  onRefreshDevices,
  onCreateProject,
  onCreateGitWorkspaceProject,
  onListGitRepositories,
  onListGitBranches,
  onUpdateProjectName,
  onRemoveProject,
  onArchiveAllChats,
  onArchiveAllProjectChats,
  onArchiveProjectChats,
  onArchiveTask,
  onRenameTask,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenSettings,
  onLogout,
}: DesktopSidebarProps) {
  const { t } = useTranslation('common')
  const { sidebarWidth, handleResizeStart } = useResizableSidebar()
  const reserveMacWindowControls = isTauriRuntime()
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const [projectCreateMode, setProjectCreateMode] = useState<ProjectCreateMode | null>(null)
  const [renamingProject, setRenamingProject] = useState<ProjectWithTasks | null>(null)
  const [renamingTask, setRenamingTask] = useState<{ id: number; title: string } | null>(null)
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [chatsExpanded, setChatsExpanded] = useState(true)
  const [searchDialogOpen, setSearchDialogOpen] = useState(false)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(new Set())
  const [expandedTaskListIds, setExpandedTaskListIds] = useState<Set<number>>(new Set())
  const sortedRecentTasks = useMemo(
    () => sortTasksByTime(recentTasks).filter(task => !task.project_id),
    [recentTasks]
  )
  const currentProjectWithTask = useMemo(
    () =>
      currentTaskId
        ? projects.find(project =>
            project.tasks?.some(task => task.task_id === currentTaskId),
          )
        : undefined,
    [currentTaskId, projects],
  )
  const currentProjectTaskIndex = useMemo(() => {
    if (!currentProjectWithTask || !currentTaskId) return -1
    return sortProjectTasks(currentProjectWithTask.tasks).findIndex(
      task => task.task_id === currentTaskId,
    )
  }, [currentProjectWithTask, currentTaskId])

  const handleToggleProject = (projectId: number) => {
    setExpandedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  const handleToggleProjectTaskLimit = (projectId: number) => {
    setExpandedTaskListIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  const openProjectCreateDialog = (mode: ProjectCreateMode) => {
    setProjectCreateMode(mode)
    void onRefreshDevices?.().catch(() => undefined)
  }

  useEffect(() => {
    if (!settingsMenuOpen) {
      return
    }

    const handleOutsidePointer = (event: MouseEvent | PointerEvent) => {
      if (!settingsMenuRef.current?.contains(event.target as Node)) {
        setSettingsMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleOutsidePointer)
    document.addEventListener('mousedown', handleOutsidePointer)

    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      document.removeEventListener('mousedown', handleOutsidePointer)
    }
  }, [settingsMenuOpen])

  useEffect(() => {
    if (!currentTaskId) return

    const timer = window.setTimeout(() => {
      if (currentProjectWithTask) {
        setProjectsExpanded(true)
        setExpandedProjectIds(previous => {
          if (previous.has(currentProjectWithTask.id)) return previous
          return new Set([...previous, currentProjectWithTask.id])
        })
        if (currentProjectTaskIndex >= INITIAL_PROJECT_CHAT_COUNT) {
          setExpandedTaskListIds(previous => {
            if (previous.has(currentProjectWithTask.id)) return previous
            return new Set([...previous, currentProjectWithTask.id])
          })
        }
        return
      }

      if (sortedRecentTasks.some(task => task.id === currentTaskId)) {
        setChatsExpanded(true)
      }
    }, 0)

    return () => window.clearTimeout(timer)
  }, [
    currentProjectTaskIndex,
    currentProjectWithTask,
    currentTaskId,
    sortedRecentTasks,
  ])

  useEffect(() => {
    if (!currentTaskId) return

    const taskRow =
      document.querySelector(`[data-testid="project-chat-row-${currentTaskId}"]`) ??
      document.querySelector(`[data-testid="history-task-row-${currentTaskId}"]`)

    taskRow?.scrollIntoView({ block: 'nearest' })
  }, [
    chatsExpanded,
    currentTaskId,
    expandedProjectIds,
    expandedTaskListIds,
    projectsExpanded,
  ])

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-border/70 bg-[rgb(var(--color-sidebar))] px-1.5 pb-4 shadow-[inset_-1px_0_0_rgb(var(--color-border))] backdrop-blur-xl backdrop-saturate-150"
      style={{ width: sidebarWidth }}
    >
      <DesktopTopBar
        testId="desktop-sidebar-topbar"
        className={cn(
          '-mx-1.5 mb-2 w-[calc(100%+0.75rem)] bg-transparent pr-2',
          reserveMacWindowControls ? undefined : 'pl-2',
        )}
        style={
          reserveMacWindowControls
            ? { paddingLeft: MAC_NATIVE_TOP_BAR_ACTION_INSET }
            : undefined
        }
        left={(
          <DesktopWindowControls
            sidebarCollapsed={false}
            onToggleSidebar={onCollapse}
          />
        )}
      />

      <nav className="space-y-0.5">
        <SidebarButton
          icon={Plus}
          label={t('workbench.new_chat', '新对话')}
          testId="new-chat-button"
          onClick={onNewChat}
        />
        <SidebarButton
          icon={Search}
          label={t('workbench.search', '搜索')}
          testId="search-button"
          onClick={() => setSearchDialogOpen(true)}
        />
        <SidebarButton
          icon={Sparkles}
          label={t('workbench.plugins', '插件')}
          testId="plugins-button"
          selected={activeItem === 'plugins'}
          onClick={onOpenPlugins}
        />
      </nav>

      <div
        data-testid="sidebar-worklists-scroll"
        className="scrollbar-none mt-8 min-h-0 flex-1 overflow-y-auto"
      >
        <section>
          <SidebarSectionHeader
            title={t('workbench.projects', '项目')}
            expanded={projectsExpanded}
            toggleTestId="projects-section-toggle"
            iconTestId={
              projectsExpanded ? 'projects-section-chevron-down' : 'projects-section-chevron-right'
            }
            onToggle={() => setProjectsExpanded(expanded => !expanded)}
          >
            <ActionMenu
              ariaLabel={t('workbench.project_list_actions', '项目列表操作')}
              testId="projects-more-button"
              items={[
                {
                  label: t('workbench.archive_all_chats', '归档所有会话'),
                  icon: Archive,
                  testId: 'archive-all-chats-button',
                  onSelect: onArchiveAllProjectChats,
                },
              ]}
            />
            <ActionMenu
              ariaLabel={t('workbench.new_project', '新建项目')}
              testId="projects-create-button"
              icon={FolderPlus}
              items={[
                {
                  label: t('workbench.start_from_scratch', '新建空白项目'),
                  icon: FolderPlus,
                  testId: 'project-start-from-scratch-button',
                  onSelect: () => openProjectCreateDialog('scratch'),
                },
                {
                  label: t('workbench.using_existing_folder', '使用现有目录'),
                  icon: Folder,
                  testId: 'project-existing-folder-button',
                  onSelect: () => openProjectCreateDialog('existing'),
                },
                {
                  label: t('workbench.clone_from_git', '从 Git 克隆'),
                  icon: FolderGit2,
                  testId: 'project-clone-from-git-button',
                  onSelect: () => openProjectCreateDialog('git'),
                },
              ]}
            />
          </SidebarSectionHeader>
          {projectsExpanded && (
            <div className="space-y-1">
              {projects.map(project => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  expanded={expandedProjectIds.has(project.id)}
                  showAllTasks={expandedTaskListIds.has(project.id)}
                  activeTaskId={currentTaskId}
                  runningTaskIds={runningTaskIds}
                  onToggleProject={handleToggleProject}
                  onToggleTaskLimit={handleToggleProjectTaskLimit}
                  onStartNewProjectChat={onStartNewProjectChat}
                  onArchiveProjectChats={onArchiveProjectChats}
                  onRemoveProject={onRemoveProject}
                  onRenameProject={setRenamingProject}
                  onOpenTask={onOpenTask}
                  onArchiveTask={onArchiveTask}
                  onRenameTask={task =>
                  setRenamingTask({ id: task.task_id, title: getProjectTaskTitle(task) })
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section className="mt-8">
          <SidebarSectionHeader
            title={t('workbench.history', '对话')}
            expanded={chatsExpanded}
            toggleTestId="chats-section-toggle"
            iconTestId={
              chatsExpanded ? 'chats-section-chevron-down' : 'chats-section-chevron-right'
            }
            onToggle={() => setChatsExpanded(expanded => !expanded)}
          >
            <ActionMenu
              ariaLabel={t('workbench.chat_list_actions', '对话列表操作')}
              testId="chats-more-button"
              items={[
                {
                  label: t('workbench.archive_all_chats', '归档所有会话'),
                  icon: Archive,
                  testId: 'archive-standalone-chats-button',
                  onSelect: onArchiveAllChats,
                },
              ]}
            />
            <button
              type="button"
              data-testid="chats-new-conversation-button"
              onClick={onStartStandaloneChat}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
              aria-label={t('workbench.new_chat', '新对话')}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
          </SidebarSectionHeader>
          {chatsExpanded && (
            <div className="space-y-1 pb-2">
              {sortedRecentTasks.map(task => (
                <RecentTaskRow
                  key={task.id}
                  task={task}
                  selected={currentTaskId === task.id && currentProjectId === undefined}
                  running={runningTaskIds.has(task.id)}
                  onOpenTask={onOpenTask}
                  onArchiveTask={onArchiveTask}
                  onRenameTask={item => setRenamingTask({ id: item.id, title: item.title })}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <div ref={settingsMenuRef} className="mt-4 shrink-0">
        <button
          type="button"
          data-testid="settings-button"
          onClick={() => setSettingsMenuOpen(open => !open)}
          className="flex h-9 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium leading-[18px] text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
          aria-expanded={settingsMenuOpen}
        >
          <Settings className="h-4 w-4" />
          {t('workbench.settings', '设置')}
        </button>
        {settingsMenuOpen && (
          <DesktopSettingsMenu
            user={user}
            onOpenSettings={() => {
              setSettingsMenuOpen(false)
              onOpenSettings()
            }}
            onLogout={onLogout}
          />
        )}
      </div>

      <button
        type="button"
        data-testid="sidebar-resize-handle"
        onPointerDown={handleResizeStart}
        className="absolute right-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
        aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
      />

      <DesktopSearchDialog
        open={searchDialogOpen}
        projects={projects}
        recentTasks={recentTasks}
        onOpenChange={setSearchDialogOpen}
        onOpenTask={onOpenTask}
        onSearchTasks={onSearchTasks}
        onSearchTaskDetail={onSearchTaskDetail}
      />

      <ProjectCreateDialog
        open={projectCreateMode !== null}
        mode={projectCreateMode ?? 'scratch'}
        devices={devices}
        onClose={() => setProjectCreateMode(null)}
        onCreateProject={onCreateProject}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        preferredDeviceId={preferredDeviceId}
        onSelectDevicePreference={onRememberExecutionDevice}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onListGitRepositories={onListGitRepositories}
        onListGitBranches={onListGitBranches}
      />
      <TextInputDialog
        open={renamingProject !== null}
        title={t('workbench.rename_project', '重命名项目')}
        label={t('workbench.project_name', '项目名称')}
        initialValue={renamingProject?.name ?? ''}
        confirmLabel={t('workbench.save', '保存')}
        cancelLabel={t('workbench.cancel', '取消')}
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={() => setRenamingProject(null)}
        onSubmit={name =>
          renamingProject
            ? onUpdateProjectName(renamingProject.id, name)
            : Promise.resolve()
        }
      />
      <TextInputDialog
        open={renamingTask !== null}
        title={t('workbench.rename_chat', '重命名会话')}
        label={t('workbench.chat_name', '会话名称')}
        initialValue={renamingTask?.title ?? ''}
        confirmLabel={t('workbench.save', '保存')}
        cancelLabel={t('workbench.cancel', '取消')}
        inputTestId="rename-chat-input"
        confirmTestId="confirm-rename-chat-button"
        onClose={() => setRenamingTask(null)}
        onSubmit={title =>
          renamingTask ? onRenameTask(renamingTask.id, title) : Promise.resolve()
        }
      />
    </aside>
  )
}
