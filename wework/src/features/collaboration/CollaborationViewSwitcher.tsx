import { FolderKanban, MessagesSquare } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function CollaborationViewSwitcher({
  value,
  onChange,
}: {
  value: 'groups' | 'projects'
  onChange(value: 'groups' | 'projects'): void
}) {
  const { t } = useTranslation('collaboration')
  return (
    <nav className="flex shrink-0 gap-1 p-2" aria-label={t('views')}>
      {(['groups', 'projects'] as const).map(view => {
        const Icon = view === 'groups' ? MessagesSquare : FolderKanban
        return (
          <button
            key={view}
            type="button"
            data-testid={`collaboration-view-${view}`}
            aria-current={value === view ? 'page' : undefined}
            className={`flex h-7 flex-1 items-center justify-center gap-2 rounded-md px-2 text-sm hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus ${value === view ? 'bg-hover text-text-primary' : 'text-text-muted'}`}
            onClick={() => onChange(view)}
          >
            <Icon className="h-4 w-4" />
            {t(view)}
          </button>
        )
      })}
    </nav>
  )
}
