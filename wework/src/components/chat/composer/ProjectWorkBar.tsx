import { ChevronDown, FolderPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function ProjectWorkBar() {
  const { t } = useTranslation('common')

  return (
    <div className="flex min-h-12 items-center px-5">
      <button
        type="button"
        data-testid="project-work-button"
        className="flex h-10 min-w-10 items-center gap-2 rounded-full px-1 text-sm font-medium text-text-secondary hover:bg-muted"
        aria-label={t('workbench.enter_project_work', '进入项目工作')}
      >
        <FolderPlus className="h-[18px] w-[18px]" />
        <span>{t('workbench.enter_project_work', '进入项目工作')}</span>
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  )
}
