import { useTranslation } from 'react-i18next'

interface HeaderProps {
  onMenuClick?: () => void
}

export function Header({ onMenuClick }: HeaderProps) {
  const { t } = useTranslation('common')

  return (
    <header className="flex items-center justify-between h-12 px-4 bg-background border-b border-border">
      <div className="flex items-center gap-3">
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="lg:hidden p-2 rounded-md text-text-muted hover:text-text-primary hover:bg-surface"
            aria-label={t('common.open_menu', 'Open menu')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <span className="text-lg font-semibold text-text-primary">WeWork</span>
      </div>
    </header>
  )
}
