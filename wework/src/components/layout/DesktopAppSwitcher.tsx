import { Globe2, Grid3X3, ListTodo } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export type DesktopAppKey = 'wework' | 'todo' | 'apps'

interface DesktopAppSwitcherProps {
  activeApp: DesktopAppKey
  onNavigate: (app: DesktopAppKey) => void
  className?: string
  testIds?: Partial<Record<DesktopAppKey, string>>
}

const APP_BUTTON_CLASS =
  'group relative flex h-8 w-8 min-w-0 shrink-0 items-center justify-center rounded-lg px-0 text-center text-[13px] font-medium leading-none transition-colors'

const APP_TOOLTIP_CLASS =
  'pointer-events-none absolute left-1/2 top-[calc(100%+0.375rem)] z-popover -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-background px-2 py-1 text-xs font-medium leading-none text-text-primary opacity-0 shadow-[0_8px_20px_rgba(0,0,0,0.14)] transition-opacity group-hover:opacity-100'

export function DesktopAppSwitcher({
  activeApp,
  onNavigate,
  className,
  testIds,
}: DesktopAppSwitcherProps) {
  const { t } = useTranslation('common')
  const apps = [
    {
      key: 'wework' as const,
      label: t('workbench.app_wework', 'WeWork'),
      icon: Globe2,
    },
    {
      key: 'todo' as const,
      label: t('todo.navigation', 'TODO'),
      icon: ListTodo,
    },
    {
      key: 'apps' as const,
      label: t('workbench.apps', '应用'),
      icon: Grid3X3,
    },
  ]

  return (
    <nav
      data-testid="desktop-app-switcher"
      aria-label={t('workbench.app_navigation', '应用导航')}
      className={cn('flex shrink-0 items-center gap-1', className)}
    >
      {apps.map(app => {
        const Icon = app.icon
        const active = activeApp === app.key

        return (
          <button
            key={app.key}
            type="button"
            data-testid={testIds?.[app.key] ?? `chrome-tab-${app.key}`}
            onClick={() => onNavigate(app.key)}
            title={app.label}
            aria-label={app.label}
            aria-current={active ? 'page' : undefined}
            className={cn(
              APP_BUTTON_CLASS,
              active && app.key === 'todo'
                ? 'bg-[#DDE2E2] text-[#0F8F82]'
                : active
                  ? 'bg-black/[0.045] text-text-primary'
                  : 'text-text-secondary hover:bg-black/[0.04]'
            )}
          >
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0 stroke-[1.8]" />
            <span className="sr-only">{app.label}</span>
            <span className={APP_TOOLTIP_CLASS}>{app.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
