import { Cloud } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'

interface GitProjectCreateSectionProps {
  closeMenu: () => void
  context: {
    onCreateProjectMode?: (mode: string) => void
  }
}

export default function GitProjectCreateSection({
  closeMenu,
  context,
}: GitProjectCreateSectionProps) {
  const { t } = useTranslation('common')
  if (!context.onCreateProjectMode) return null

  return (
    <div>
      <button
        type="button"
        data-testid="add-remote-project-option"
        onClick={() => {
          context.onCreateProjectMode?.('git')
          closeMenu()
        }}
        className="flex h-8 w-full items-center gap-3 rounded-lg px-4 text-left text-sm font-medium leading-[18px] text-text-secondary hover:bg-muted"
      >
        <Cloud className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1">{t('workbench.add_remote_project', '添加远程项目')}</span>
      </button>
    </div>
  )
}
