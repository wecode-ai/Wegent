import { Code2, Folder, Image, MoreHorizontal, Pencil, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectWithTasks, Task, User } from '@/types/api'

interface MobileDrawerProps {
  open: boolean
  user: User | null
  projects: ProjectWithTasks[]
  recentTasks: Task[]
  onClose: () => void
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number, projectId?: number) => void
}

export function MobileDrawer({
  open,
  user,
  projects,
  recentTasks,
  onClose,
  onSelectProject,
  onOpenTask,
}: MobileDrawerProps) {
  const { t } = useTranslation('common')

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-base px-6 pb-6 pt-[max(28px,env(safe-area-inset-top))]">
      <div className="mb-10 flex items-center justify-between">
        <h1 className="text-3xl font-semibold">{t('workbench.brand', 'Wework')}</h1>
        <div className="flex items-center gap-3 rounded-full bg-surface px-4 py-3">
          <Search className="h-7 w-7" />
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#9b59b6] text-sm font-medium text-white">
            {user?.user_name?.slice(0, 2).toUpperCase() || t('workbench.user_fallback', '我')}
          </div>
          <button
            type="button"
            data-testid="close-mobile-drawer-button"
            onClick={onClose}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full"
            aria-label={t('workbench.close_menu', '关闭菜单')}
          >
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>

      <nav className="space-y-8 text-2xl font-semibold">
        <button
          className="flex h-12 min-w-[44px] items-center gap-6"
          type="button"
          data-testid="mobile-projects-nav-button"
        >
          <Folder className="h-8 w-8" />
          {t('workbench.projects', '项目')}
        </button>
        <button
          className="flex h-12 min-w-[44px] items-center gap-6"
          type="button"
          data-testid="mobile-images-nav-button"
        >
          <Image className="h-8 w-8" />
          {t('workbench.images', '图片')}
        </button>
        <button
          className="flex h-12 min-w-[44px] items-center gap-6"
          type="button"
          data-testid="mobile-code-nav-button"
        >
          <Code2 className="h-8 w-8" />
          {t('workbench.code', '编码')}
        </button>
        <button
          className="flex h-12 min-w-[44px] items-center gap-6"
          type="button"
          data-testid="mobile-more-nav-button"
        >
          <MoreHorizontal className="h-8 w-8" />
          {t('workbench.more', '更多')}
        </button>
      </nav>

      <section className="mt-12">
        <h2 className="mb-6 text-xl font-semibold">{t('workbench.recent', '最近')}</h2>
        <div className="space-y-5">
          {projects.map(project => (
            <button
              key={`project-${project.id}`}
              type="button"
              data-testid="mobile-project-item-button"
              className="block min-h-[44px] w-full truncate text-left text-xl"
              onClick={() => {
                onSelectProject(project.id)
                onClose()
              }}
            >
              {project.name}
            </button>
          ))}
          {recentTasks.map(task => (
            <button
              key={`task-${task.id}`}
              type="button"
              data-testid="mobile-recent-task-button"
              className="block min-h-[44px] w-full truncate text-left text-xl"
              onClick={() => {
                onOpenTask(task.id, task.project_id)
                onClose()
              }}
            >
              {task.title}
            </button>
          ))}
        </div>
      </section>

      <button
        type="button"
        data-testid="mobile-chat-button"
        className="fixed bottom-[max(24px,env(safe-area-inset-bottom))] right-6 flex h-16 min-w-[44px] items-center gap-3 rounded-full bg-[#242424] px-7 text-xl font-semibold text-white shadow-[0_12px_36px_rgba(0,0,0,0.25)]"
      >
        <Pencil className="h-7 w-7" />
        {t('workbench.chat', '聊天')}
      </button>
    </div>
  )
}
