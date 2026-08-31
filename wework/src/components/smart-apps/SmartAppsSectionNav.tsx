import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'

type SmartAppsSection = 'marketplace' | 'owned'

interface SmartAppsSectionNavProps {
  active: SmartAppsSection
  onNavigate?: (path: string) => void
}

const sections: Array<{
  id: SmartAppsSection
  path: string
  testId: string
}> = [
  {
    id: 'marketplace',
    path: '/sites?app_type=smart_app',
    testId: 'smart-apps-section-marketplace',
  },
  {
    id: 'owned',
    path: '/sites?app_type=smart_app&view=owned',
    testId: 'smart-apps-section-owned',
  },
]

export function SmartAppsSectionNav({ active, onNavigate = navigateTo }: SmartAppsSectionNavProps) {
  const { t } = useTranslation('common')

  return (
    <nav
      data-testid="smart-apps-section-nav"
      aria-label={t('workbench.smart_apps_sections', '智能工作台导航')}
      className="flex h-11 w-full rounded-lg border border-border/50 bg-surface/60 p-0.5 md:h-9 md:w-[168px]"
    >
      {sections.map(section => {
        const selected = section.id === active
        const label =
          section.id === 'marketplace'
            ? t('workbench.smart_apps_marketplace', '市场')
            : t('workbench.smart_apps_owned', '我的')
        return (
          <button
            key={section.id}
            type="button"
            data-testid={section.testId}
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'flex h-full flex-1 items-center justify-center rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30',
              selected
                ? 'bg-background font-medium text-text-primary shadow-sm'
                : 'text-text-secondary hover:bg-background/60 hover:text-text-primary'
            )}
            onClick={() => {
              if (selected) return
              onNavigate(section.path)
            }}
          >
            {label}
          </button>
        )
      })}
    </nav>
  )
}
