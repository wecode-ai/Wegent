import { useTranslation } from 'react-i18next'

interface SidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

export function Sidebar({ isOpen = true, onClose }: SidebarProps) {
  const { t } = useTranslation('common')

  return (
    <>
      {isOpen && onClose && (
        <div
          className="fixed inset-0 bg-black/20 z-20 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={[
          'fixed top-0 left-0 h-full w-60 bg-surface border-r border-border z-30',
          'transition-transform duration-300 ease-in-out',
          'lg:relative lg:translate-x-0 lg:z-auto',
          isOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        <div className="flex flex-col h-full p-4 pt-16 lg:pt-4">
          <nav className="flex-1">
            <a
              href="/"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-text-primary hover:bg-muted"
            >
              {t('navigation.home')}
            </a>
          </nav>
        </div>
      </aside>
    </>
  )
}
