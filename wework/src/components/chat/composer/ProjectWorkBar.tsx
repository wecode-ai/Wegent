import { ChevronDown, FolderPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function ProjectWorkBar() {
  const { t } = useTranslation('common')

  return (
    <div className="flex min-h-16 items-center px-6">
      <button
        type="button"
        data-testid="project-work-button"
        className="flex h-11 min-w-[44px] items-center gap-2 rounded-full px-1 text-sm font-medium text-text-secondary hover:bg-muted"
        aria-label={t('workbench.enter_project_work', '进入项目工作')}
      >
        <FolderPlus className="h-5 w-5" />
        <span>{t('workbench.enter_project_work', '进入项目工作')}</span>
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  )
}
