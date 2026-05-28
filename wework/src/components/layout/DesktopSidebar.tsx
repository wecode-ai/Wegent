import {
  ChevronLeft,
  Clock,
  Folder,
  Plus,
  Search,
  Settings,
  Sparkles,
  Workflow,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectWithTasks, Task, User as UserProfile } from '@/types/api'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'
import { useResizableSidebar } from './useResizableSidebar'

interface DesktopSidebarProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  recentTasks: Task[]
  currentProjectId?: number
  onCollapse: () => void
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number) => void
  onOpenSettings: () => void
  onLogout: () => void
}

function SidebarButton({
  icon: Icon,
  label,
  testId,
}: {
  icon: typeof Plus
  label: string
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="flex h-8 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-[#333] hover:bg-white/70"
    >
      <Icon className="h-4 w-4 text-[#555]" />
      <span>{label}</span>
    </button>
  )
}

function ProjectItem({
  project,
  selected,
  onClick,
}: {
  project: ProjectWithTasks
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid="project-item-button"
      onClick={onClick}
      className={[
        'flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm',
        selected ? 'bg-white text-text-primary' : 'text-text-secondary hover:bg-white/70',
      ].join(' ')}
    >
      <Folder className="h-4 w-4 shrink-0" />
      <span className="truncate">{project.name}</span>
    </button>
  )
}

function TaskItem({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="history-task-button"
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-text-secondary hover:bg-white/70"
    >
      <Clock className="h-4 w-4 shrink-0" />
      <span className="truncate">{task.title}</span>
    </button>
  )
}

export function DesktopSidebar({
  user,
  projects,
  recentTasks,
  currentProjectId,
  onCollapse,
  onSelectProject,
  onOpenTask,
  onOpenSettings,
  onLogout,
}: DesktopSidebarProps) {
  const { t } = useTranslation('common')
  const { sidebarWidth, handleResizeStart } = useResizableSidebar()
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)

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
        />
        <SidebarButton
          icon={Search}
          label={t('workbench.search', '搜索')}
          testId="search-button"
        />
        <SidebarButton
          icon={Sparkles}
          label={t('workbench.plugins', '插件')}
          testId="plugins-button"
        />
        <SidebarButton
          icon={Workflow}
          label={t('workbench.automation', '自动化')}
          testId="automation-button"
        />
      </nav>

      <section className="mt-8 min-h-0">
        <h2 className="mb-3 px-3 text-sm font-semibold text-[#8a8a8a]">
          {t('workbench.projects', '项目')}
        </h2>
        <div className="space-y-1">
          {projects.map(project => (
            <ProjectItem
              key={project.id}
              project={project}
              selected={currentProjectId === project.id}
              onClick={() => onSelectProject(project.id)}
            />
          ))}
        </div>
      </section>

      <section className="mt-8 min-h-0 flex-1 overflow-hidden">
        <h2 className="mb-3 px-3 text-sm font-semibold text-[#8a8a8a]">
          {t('workbench.history', '对话')}
        </h2>
        <div className="space-y-1 overflow-auto">
          {recentTasks.map(task => (
            <TaskItem key={task.id} task={task} onClick={() => onOpenTask(task.id)} />
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
    </aside>
  )
}
