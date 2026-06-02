import {
  Archive,
  ChevronLeft,
  Clock,
  Edit3,
  Folder,
  FolderPlus,
  Loader2,
  MessageSquarePlus,
  Plus,
  Search,
  Settings,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CreateProjectRequest,
  DeviceInfo,
  ProjectTask,
  ProjectWithTasks,
  Task,
  User as UserProfile,
} from '@/types/api'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'
import { useResizableSidebar } from './useResizableSidebar'

interface DesktopSidebarProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  recentTasks: Task[]
  runningTaskIds: Set<number>
  currentProjectId?: number
  currentTaskId?: number
  activeItem?: 'chat' | 'plugins' | 'automation'
  onCollapse: () => void
  onNewChat: () => void
  onStartStandaloneChat: () => void
  onSelectProject: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onOpenPlugins: () => void
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
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
  onOpenSettings: () => void
  onLogout: () => void
}

type ProjectCreateMode = 'scratch' | 'existing'

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
        'flex h-8 w-full items-center gap-3 rounded-md px-3 text-left text-[13px] font-medium leading-[18px]',
        selected ? 'bg-[#cfd1d4] text-[#222]' : 'text-[#333] hover:bg-white/70',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 text-[#555]" />
      <span>{label}</span>
    </button>
  )
}

const INITIAL_PROJECT_CHAT_COUNT = 5

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
  return (
    <div
      data-testid={`project-chat-row-${task.task_id}`}
      className={[
        'group/task ml-5 flex h-8 items-center rounded-md pl-3 pr-1 text-[13px] leading-[18px]',
        selected ? 'bg-white text-text-primary' : 'text-text-secondary hover:bg-white/70',
      ].join(' ')}
    >
      <button
        type="button"
        data-testid="project-chat-button"
        onClick={() => onOpenTask(task.task_id, projectId)}
        className="min-w-0 flex-1 truncate text-left"
      >
        {title}
      </button>
      <div className="relative ml-2 flex h-7 w-7 shrink-0 items-center justify-center">
        {running ? (
          <Loader2
            data-testid={`project-chat-spinner-${task.task_id}`}
            className="h-3.5 w-3.5 animate-spin text-primary"
          />
        ) : (
          <span
            data-testid={`project-chat-time-${task.task_id}`}
            className="text-xs text-[#8a8a8a] transition-opacity group-hover/task:opacity-0 focus-within:opacity-0"
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
        className="group/project flex h-8 items-center gap-1 rounded-md pl-3 pr-1 text-[13px] leading-[18px] text-text-secondary hover:bg-white/70"
      >
        <button
          type="button"
          data-testid="project-item-button"
          onClick={() => onToggleProject(project.id)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Folder className="h-4 w-4 shrink-0" />
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
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#606368] hover:bg-white/80 hover:text-[#2d2d2d]"
            aria-label={t('workbench.new_project_chat', '新建项目对话')}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-0.5">
          {tasks.length === 0 ? (
            <div className="ml-5 rounded-md px-3 py-1.5 text-xs text-[#8a8a8a]">
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
              className="ml-5 h-8 rounded-md px-3 text-left text-xs font-medium text-[#606368] hover:bg-white/70 hover:text-[#2d2d2d]"
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
  return (
    <div
      data-testid={`history-task-row-${task.id}`}
      className={[
        'group/task flex h-8 items-center gap-2 rounded-md pl-3 pr-1 text-[13px] leading-[18px]',
        selected ? 'bg-white text-text-primary' : 'text-text-secondary hover:bg-white/70',
      ].join(' ')}
    >
      <Clock className="h-4 w-4 shrink-0" />
      <button
        type="button"
        data-testid="history-task-button"
        onClick={() => onOpenTask(task.id, task.project_id)}
        className="min-w-0 flex-1 truncate text-left"
      >
        {task.title}
      </button>
      <div className="relative flex h-7 w-7 shrink-0 items-center justify-center">
        {running ? (
          <Loader2
            data-testid={`history-task-spinner-${task.id}`}
            className="h-3.5 w-3.5 animate-spin text-primary"
          />
        ) : (
          <span
            data-testid={`history-task-time-${task.id}`}
            className="text-xs text-[#8a8a8a] transition-opacity group-hover/task:opacity-0 focus-within:opacity-0"
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
  activeItem = 'chat',
  onCollapse,
  onNewChat,
  onStartStandaloneChat,
  onSelectProject,
  onStartNewProjectChat,
  onOpenTask,
  onOpenPlugins,
  onCreateProject,
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
  onOpenSettings,
  onLogout,
}: DesktopSidebarProps) {
  const { t } = useTranslation('common')
  const { sidebarWidth, handleResizeStart } = useResizableSidebar()
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const [projectCreateMode, setProjectCreateMode] = useState<ProjectCreateMode | null>(null)
  const [renamingProject, setRenamingProject] = useState<ProjectWithTasks | null>(null)
  const [renamingTask, setRenamingTask] = useState<{ id: number; title: string } | null>(null)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(new Set())
  const [expandedTaskListIds, setExpandedTaskListIds] = useState<Set<number>>(new Set())
  const sortedRecentTasks = useMemo(
    () => sortTasksByTime(recentTasks).filter(task => !task.project_id),
    [recentTasks]
  )

  const handleToggleProject = (projectId: number) => {
    const shouldExpand = !expandedProjectIds.has(projectId)
    setExpandedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
    if (shouldExpand) {
      onSelectProject(projectId)
    }
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

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-white/45 bg-[#e5e5e7]/70 px-4 py-4 shadow-[inset_-1px_0_0_rgba(255,255,255,0.28)] backdrop-blur-xl backdrop-saturate-150"
      style={{ width: sidebarWidth }}
    >
      <div className="-mt-3 mb-1 flex justify-end">
        <button
          type="button"
          data-testid="collapse-sidebar-button"
          onClick={onCollapse}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[#555] hover:bg-white/70"
          aria-label={t('workbench.collapse_sidebar', '收起侧边栏')}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

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
          onClick={() => {}}
        />
        <SidebarButton
          icon={Sparkles}
          label={t('workbench.plugins', '插件')}
          testId="plugins-button"
          selected={activeItem === 'plugins'}
          onClick={onOpenPlugins}
        />
        <SidebarButton
          icon={Workflow}
          label={t('workbench.automation', '自动化')}
          testId="automation-button"
          selected={activeItem === 'automation'}
          onClick={() => {}}
        />
      </nav>

      <div
        data-testid="sidebar-worklists-scroll"
        className="scrollbar-none mt-8 min-h-0 flex-1 overflow-y-auto"
      >
        <section>
          <div className="group/projects mb-3 flex h-8 items-center justify-between px-3">
            <h2 className="text-[13px] font-semibold leading-[18px] text-[#8a8a8a]">
              {t('workbench.projects', '项目')}
            </h2>
            <div className="flex items-center opacity-0 transition-opacity group-hover/projects:opacity-100 focus-within:opacity-100">
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
                    label: t('workbench.start_from_scratch', '从头开始'),
                    icon: FolderPlus,
                    testId: 'project-start-from-scratch-button',
                    onSelect: () => setProjectCreateMode('scratch'),
                  },
                  {
                    label: t('workbench.using_existing_folder', '使用现有目录'),
                    icon: Folder,
                    testId: 'project-existing-folder-button',
                    onSelect: () => setProjectCreateMode('existing'),
                  },
                ]}
              />
            </div>
          </div>
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
        </section>

        <section className="mt-8">
          <div className="group/chats mb-3 flex h-8 items-center justify-between px-3">
            <h2 className="text-[13px] font-semibold leading-[18px] text-[#8a8a8a]">
              {t('workbench.history', '对话')}
            </h2>
            <div className="flex items-center opacity-0 transition-opacity group-hover/chats:opacity-100 focus-within:opacity-100">
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
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#606368] hover:bg-white/80 hover:text-[#2d2d2d]"
                aria-label={t('workbench.new_chat', '新对话')}
              >
                <MessageSquarePlus className="h-4 w-4" />
              </button>
            </div>
          </div>
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
        </section>
      </div>

      <div ref={settingsMenuRef} className="mt-4 shrink-0">
        <button
          type="button"
          data-testid="settings-button"
          onClick={() => setSettingsMenuOpen(open => !open)}
          className="flex h-9 shrink-0 items-center gap-3 rounded-md px-3 text-[13px] font-medium leading-[18px] text-[#333] hover:bg-white/70"
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

      <ProjectCreateDialog
        open={projectCreateMode !== null}
        mode={projectCreateMode ?? 'scratch'}
        devices={devices}
        onClose={() => setProjectCreateMode(null)}
        onCreateProject={onCreateProject}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
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
