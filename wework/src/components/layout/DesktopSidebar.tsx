import {
  Archive,
  ChevronLeft,
  Clock,
  Edit3,
  Folder,
  FolderPlus,
  MessageSquarePlus,
  Plus,
  Search,
  Settings,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
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
  currentProjectId?: number
  activeItem?: 'chat' | 'plugins' | 'automation'
  onCollapse: () => void
  onNewChat: () => void
  onSelectProject: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onOpenPlugins: () => void
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onArchiveAllChats: () => Promise<void>
  onArchiveProjectChats: (projectId: number) => Promise<void>
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (taskId: number, title: string) => Promise<void>
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
        'flex h-8 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium',
        selected ? 'bg-[#cfd1d4] text-[#222]' : 'text-[#333] hover:bg-white/70',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 text-[#555]" />
      <span>{label}</span>
    </button>
  )
}

function formatSidebarTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
  onOpenTask,
  projectId,
  onArchiveTask,
  onRenameTask,
}: {
  task: ProjectTask
  onOpenTask: (taskId: number, projectId?: number) => void
  projectId: number
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (task: ProjectTask) => void
}) {
  const title = getProjectTaskTitle(task)
  return (
    <div className="group/task ml-5 flex h-8 items-center rounded-md pl-3 pr-1 text-sm text-text-secondary hover:bg-white/70">
      <button
        type="button"
        data-testid="project-chat-button"
        onClick={() => onOpenTask(task.task_id, projectId)}
        className="min-w-0 flex-1 truncate text-left"
      >
        {title}
      </button>
      <span className="ml-2 shrink-0 text-xs text-[#8a8a8a]">
        {formatSidebarTime(getProjectTaskTime(task))}
      </span>
      <div className="ml-1 opacity-0 transition-opacity group-hover/task:opacity-100 focus-within:opacity-100">
        <ActionMenu
          ariaLabel="会话操作"
          testId={`project-chat-menu-${task.task_id}`}
          variant="vertical"
          items={[
            {
              label: 'Archive chat',
              icon: Archive,
              testId: `archive-chat-${task.task_id}`,
              onSelect: () => onArchiveTask(task.task_id),
            },
            {
              label: 'Rename chat',
              icon: Edit3,
              testId: `rename-chat-${task.task_id}`,
              onSelect: () => onRenameTask(task),
            },
          ]}
        />
      </div>
    </div>
  )
}

function ProjectItem({
  project,
  selected,
  onSelectProject,
  onStartNewProjectChat,
  onArchiveProjectChats,
  onRemoveProject,
  onRenameProject,
  onOpenTask,
  onArchiveTask,
  onRenameTask,
}: {
  project: ProjectWithTasks
  selected: boolean
  onSelectProject: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onArchiveProjectChats: (projectId: number) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onRenameProject: (project: ProjectWithTasks) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (task: ProjectTask) => void
}) {
  const tasks = useMemo(() => sortProjectTasks(project.tasks), [project.tasks])

  return (
    <div data-testid="project-item" className="space-y-0.5">
      <div
        className={[
          'group/project flex h-9 items-center gap-1 rounded-md pl-3 pr-1 text-sm',
          selected ? 'bg-white text-text-primary' : 'text-text-secondary hover:bg-white/70',
        ].join(' ')}
      >
        <button
          type="button"
          data-testid="project-item-button"
          onClick={() => onSelectProject(project.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Folder className="h-4 w-4 shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100">
          <ActionMenu
            ariaLabel="项目操作"
            testId={`project-menu-${project.id}`}
            items={[
              {
                label: 'Rename project',
                icon: Edit3,
                testId: `rename-project-${project.id}`,
                onSelect: () => onRenameProject(project),
              },
              {
                label: 'Archive chats',
                icon: Archive,
                testId: `archive-project-chats-${project.id}`,
                onSelect: () => onArchiveProjectChats(project.id),
              },
              {
                label: 'Remove',
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
            aria-label="新建项目对话"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
      </div>
      {tasks.map(task => (
        <ProjectTaskRow
          key={task.task_id}
          task={task}
          onOpenTask={onOpenTask}
          projectId={project.id}
          onArchiveTask={onArchiveTask}
          onRenameTask={onRenameTask}
        />
      ))}
    </div>
  )
}

function RecentTaskRow({
  task,
  onOpenTask,
  onArchiveTask,
  onRenameTask,
}: {
  task: Task
  onOpenTask: (taskId: number, projectId?: number) => void
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (task: Task) => void
}) {
  return (
    <div className="group/task flex h-9 items-center gap-2 rounded-md pl-3 pr-1 text-sm text-text-secondary hover:bg-white/70">
      <Clock className="h-4 w-4 shrink-0" />
      <button
        type="button"
        data-testid="history-task-button"
        onClick={() => onOpenTask(task.id, task.project_id)}
        className="min-w-0 flex-1 truncate text-left"
      >
        {task.title}
      </button>
      <span className="shrink-0 text-xs text-[#8a8a8a]">
        {formatSidebarTime(task.updated_at || task.created_at)}
      </span>
      <div className="opacity-0 transition-opacity group-hover/task:opacity-100 focus-within:opacity-100">
        <ActionMenu
          ariaLabel="会话操作"
          testId={`history-task-menu-${task.id}`}
          variant="vertical"
          items={[
            {
              label: 'Archive chat',
              icon: Archive,
              testId: `archive-history-chat-${task.id}`,
              onSelect: () => onArchiveTask(task.id),
            },
            {
              label: 'Rename chat',
              icon: Edit3,
              testId: `rename-history-chat-${task.id}`,
              onSelect: () => onRenameTask(task),
            },
          ]}
        />
      </div>
    </div>
  )
}

export function DesktopSidebar({
  user,
  projects,
  devices,
  recentTasks,
  currentProjectId,
  activeItem = 'chat',
  onCollapse,
  onNewChat,
  onSelectProject,
  onStartNewProjectChat,
  onOpenTask,
  onOpenPlugins,
  onCreateProject,
  onUpdateProjectName,
  onRemoveProject,
  onArchiveAllChats,
  onArchiveProjectChats,
  onArchiveTask,
  onRenameTask,
  onListDeviceDirectories,
  onOpenSettings,
  onLogout,
}: DesktopSidebarProps) {
  const { t } = useTranslation('common')
  const { sidebarWidth, handleResizeStart } = useResizableSidebar()
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [projectCreateMode, setProjectCreateMode] = useState<ProjectCreateMode | null>(null)
  const [renamingProject, setRenamingProject] = useState<ProjectWithTasks | null>(null)
  const [renamingTask, setRenamingTask] = useState<{ id: number; title: string } | null>(null)
  const sortedRecentTasks = useMemo(() => sortTasksByTime(recentTasks), [recentTasks])

  return (
    <aside
      className="relative flex shrink-0 flex-col bg-[#d9dadd] px-4 py-4"
      style={{ width: sidebarWidth }}
    >
      <div className="mb-1 flex justify-end">
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

      <section className="mt-8 min-h-0">
        <div className="group/projects mb-3 flex h-8 items-center justify-between px-3">
          <h2 className="text-sm font-semibold text-[#8a8a8a]">
            {t('workbench.projects', '项目')}
          </h2>
          <div className="flex items-center opacity-0 transition-opacity group-hover/projects:opacity-100 focus-within:opacity-100">
            <ActionMenu
              ariaLabel="项目列表操作"
              testId="projects-more-button"
              items={[
                {
                  label: 'Archive all chats',
                  icon: Archive,
                  testId: 'archive-all-chats-button',
                  onSelect: onArchiveAllChats,
                },
              ]}
            />
            <ActionMenu
              ariaLabel="新建项目"
              testId="projects-create-button"
              icon={FolderPlus}
              items={[
                {
                  label: 'Start from scratch',
                  icon: FolderPlus,
                  testId: 'project-start-from-scratch-button',
                  onSelect: () => setProjectCreateMode('scratch'),
                },
                {
                  label: 'Using an existing folder',
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
              selected={currentProjectId === project.id}
              onSelectProject={onSelectProject}
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

      <section className="mt-8 min-h-0 flex-1 overflow-hidden">
        <h2 className="mb-3 px-3 text-sm font-semibold text-[#8a8a8a]">
          {t('workbench.history', '对话')}
        </h2>
        <div className="space-y-1 overflow-auto">
          {sortedRecentTasks.map(task => (
            <RecentTaskRow
              key={task.id}
              task={task}
              onOpenTask={onOpenTask}
              onArchiveTask={onArchiveTask}
              onRenameTask={item => setRenamingTask({ id: item.id, title: item.title })}
            />
          ))}
        </div>
      </section>

      <button
        type="button"
        data-testid="settings-button"
        onClick={() => setSettingsMenuOpen(open => !open)}
        className="mt-4 flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-[#333] hover:bg-white/70"
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
        onListDeviceDirectories={onListDeviceDirectories}
      />
      <TextInputDialog
        open={renamingProject !== null}
        title="Rename project"
        label="Project name"
        initialValue={renamingProject?.name ?? ''}
        confirmLabel="Save"
        cancelLabel="Cancel"
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
        title="Rename chat"
        label="Chat name"
        initialValue={renamingTask?.title ?? ''}
        confirmLabel="Save"
        cancelLabel="Cancel"
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
