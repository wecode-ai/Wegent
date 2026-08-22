import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'

type SmartAppsSection = 'marketplace' | 'owned'

interface SmartAppsSectionNavProps {
  active: SmartAppsSection
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

export function SmartAppsSectionNav({ active }: SmartAppsSectionNavProps) {
  const { t } = useTranslation('common')

  return (
    <nav
      data-testid="smart-apps-section-nav"
      aria-label={t('workbench.smart_apps_sections', '智能工作台导航')}
      className="flex gap-5 border-b border-border/40"
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
              '-mb-px min-h-11 border-b-2 px-1 text-sm transition-colors sm:min-h-9',
              selected
                ? 'border-text-primary font-medium text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )}
            onClick={() => {
              if (!selected) navigateTo(section.path)
            }}
          >
            {label}
          </button>
        )
      })}
    </nav>
  )
}
