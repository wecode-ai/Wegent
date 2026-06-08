import {
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectTask, ProjectWithTasks, Task, User } from '@/types/api'

const PROJECT_TASK_LIMIT = 4

interface MobileDrawerProps {
  open: boolean
  user: User | null
  projects: ProjectWithTasks[]
  recentTasks: Task[]
  runningTaskIds?: Set<number>
  currentProjectId?: number
  currentTaskId?: number
  activeItem?: 'chat' | 'plugins' | 'automation'
  onClose: () => void
  onNewChat?: () => void
  onStartStandaloneChat?: () => void
  onOpenSettings?: () => void
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number, projectId?: number) => void
}

function formatRelativeTime(value?: string) {
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

export function MobileDrawer({
  open,
  user,
  projects,
  recentTasks,
  runningTaskIds = new Set(),
  currentProjectId,
  currentTaskId,
  onClose,
  onNewChat,
  onStartStandaloneChat,
  onOpenSettings,
  onSelectProject,
  onOpenTask,
}: MobileDrawerProps) {
  const { t } = useTranslation('common')
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(
    () => new Set(),
  )
  const [expandedTaskProjectIds, setExpandedTaskProjectIds] = useState<Set<number>>(
    () => new Set(),
  )
  const standaloneRecentTasks = useMemo(
    () => sortTasksByTime(recentTasks).filter(task => !task.project_id),
    [recentTasks],
  )

  if (!open) return null

  const closeAfter = (action?: () => void) => {
    action?.()
    onClose()
  }

  const toggleProject = (projectId: number) => {
    setExpandedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
    onSelectProject(projectId)
  }

  const toggleProjectTaskLimit = (projectId: number) => {
    setExpandedTaskProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  return (
    <div
      className="fixed inset-0 z-critical isolate flex h-dvh flex-col overflow-hidden px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(22px,env(safe-area-inset-top))] text-[rgb(var(--color-sidebar-text-primary))] backdrop-blur-3xl backdrop-saturate-150"
      style={{ backgroundColor: 'rgb(var(--color-mobile-drawer))' }}
    >
      <header className="flex shrink-0 items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-normal">{t('workbench.brand', 'Wework')}</h1>
        <div className="flex items-center gap-2 rounded-full bg-[rgb(var(--color-sidebar-hover))] px-3 py-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-contrast">
            {user?.user_name?.slice(0, 2).toUpperCase() || t('workbench.user_fallback', '我')}
          </div>
          <button
            type="button"
            data-testid="close-mobile-drawer-button"
            onClick={onClose}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-active))]"
            aria-label={t('workbench.close_menu', '关闭菜单')}
          >
            <X className="h-6 w-6" />
          </button>
        </div>
      </header>

      <div className="relative mt-7 shrink-0">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[rgb(var(--color-sidebar-text-secondary))]" />
        <input
          data-testid="mobile-search-input"
          type="search"
          placeholder={t('workbench.search', '搜索')}
          className="h-12 w-full rounded-2xl border border-border/60 bg-surface/85 pl-12 pr-4 text-base font-medium leading-5 text-text-primary outline-none placeholder:text-[rgb(var(--color-sidebar-text-muted))] focus:bg-surface"
        />
      </div>

      <div className="mt-7 min-h-0 flex-1 overflow-y-auto pr-1" data-testid="mobile-drawer-scroll">
        <section>
          <h2 className="mb-3 px-1 text-sm font-semibold text-[rgb(var(--color-sidebar-text-muted))]">
            {t('workbench.projects', '项目')}
          </h2>
          <div className="space-y-1">
            {projects.map(project => {
              const sortedTasks = sortProjectTasks(project.tasks)
              const showAllTasks = expandedTaskProjectIds.has(project.id)
              const tasks = showAllTasks
                ? sortedTasks
                : sortedTasks.slice(0, PROJECT_TASK_LIMIT)
              const hasMoreTasks = sortedTasks.length > PROJECT_TASK_LIMIT
              const selected = currentProjectId === project.id
              const expanded = expandedProjectIds.has(project.id)
              const ExpandIcon = expanded ? ChevronDown : ChevronRight

              return (
                <div key={project.id}>
                  <button
                    type="button"
                    data-testid="mobile-project-item-button"
                    onClick={() => toggleProject(project.id)}
                    aria-expanded={expanded}
                    className={[
                      'flex h-11 min-w-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium',
                      selected
                        ? 'bg-[rgb(var(--color-sidebar-active))] text-[rgb(var(--color-sidebar-text-primary))]'
                        : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
                    ].join(' ')}
                  >
                    <ProjectFolderIcon
                      project={project}
                      className="h-5 w-5 shrink-0 text-[rgb(var(--color-sidebar-text-secondary))]"
                    />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <ExpandIcon
                      data-testid={`mobile-project-collapse-icon-${project.id}`}
                      className="h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))]"
                    />
                  </button>
                  {expanded && tasks.length > 0 && (
                    <div className="ml-8 mt-1 space-y-1">
                      {tasks.map(task => {
                        const running = runningTaskIds.has(task.task_id)
                        return (
                          <button
                            key={task.task_id}
                            type="button"
                            data-testid="mobile-project-task-button"
                            onClick={() => {
                              onOpenTask(task.task_id, project.id)
                              onClose()
                            }}
                            className={[
                              'flex h-11 min-w-[44px] w-full items-center rounded-lg px-2 text-left text-[13px]',
                              currentTaskId === task.task_id
                                ? 'bg-[rgb(var(--color-sidebar-active))] text-[rgb(var(--color-sidebar-text-primary))]'
                                : 'text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
                            ].join(' ')}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {getProjectTaskTitle(task)}
                            </span>
                            {running ? (
                              <Loader2 className="ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                            ) : (
                              <span className="ml-2 shrink-0 text-xs text-[rgb(var(--color-sidebar-text-muted))]">
                                {formatRelativeTime(getProjectTaskTime(task))}
                              </span>
                            )}
                          </button>
                        )
                      })}
                      {hasMoreTasks && (
                        <button
                          type="button"
                          data-testid={`mobile-project-task-limit-toggle-${project.id}`}
                          onClick={() => toggleProjectTaskLimit(project.id)}
                          className="flex h-11 min-w-[44px] w-full items-center rounded-lg px-2 text-left text-[13px] font-medium text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
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
            })}
          </div>
        </section>

        <section className="mt-7 pb-24">
          <div className="mb-3 flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-[rgb(var(--color-sidebar-text-muted))]">
              {t('workbench.history', '对话')}
            </h2>
          </div>
          <div className="space-y-1">
            {standaloneRecentTasks.map(task => {
              const running = runningTaskIds.has(task.id)
              return (
                <button
                  key={task.id}
                  type="button"
                  data-testid="mobile-recent-task-button"
                  onClick={() => {
                    onOpenTask(task.id, task.project_id)
                    onClose()
                  }}
                  className={[
                    'flex h-11 min-w-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm',
                    currentTaskId === task.id && !currentProjectId
                      ? 'bg-[rgb(var(--color-sidebar-active))] text-[rgb(var(--color-sidebar-text-primary))]'
                      : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
                  ].join(' ')}
                >
                  {running ? (
                    <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Clock className="h-5 w-5 shrink-0 text-[rgb(var(--color-sidebar-text-secondary))]" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <span className="shrink-0 text-sm text-[rgb(var(--color-sidebar-text-muted))]">
                    {formatRelativeTime(task.updated_at || task.created_at)}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      </div>

      <footer className="mt-3 shrink-0 border-t border-border/60 pt-3">
        <button
          type="button"
          data-testid="mobile-settings-button"
          onClick={() => closeAfter(onOpenSettings)}
          className="flex h-11 min-w-[44px] items-center gap-3 rounded-xl px-3 text-sm font-medium text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
        >
          <Settings className="h-5 w-5 text-[rgb(var(--color-sidebar-text-secondary))]" />
          {t('workbench.settings', '设置')}
        </button>
      </footer>
      <button
        type="button"
        data-testid="mobile-new-chat-button"
        onClick={() => closeAfter(onNewChat ?? onStartStandaloneChat)}
        className="absolute bottom-[max(28px,env(safe-area-inset-bottom))] right-5 z-10 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-contrast shadow-[0_14px_36px_rgba(20,184,166,0.24)] hover:opacity-90"
        aria-label={t('workbench.new_chat', '新对话')}
      >
        <Plus className="h-7 w-7" />
      </button>
    </div>
  )
}
