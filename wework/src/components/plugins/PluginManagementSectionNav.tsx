import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'

type PluginManagementSection = 'plugins' | 'harness'

interface PluginManagementSectionNavProps {
  active: PluginManagementSection
}

const sections: Array<{
  id: PluginManagementSection
  path: string
  testId: string
}> = [
  {
    id: 'plugins',
    path: '/plugins/manage',
    testId: 'plugin-management-section-plugins',
  },
  {
    id: 'harness',
    path: '/plugins/manage/harness',
    testId: 'plugin-management-section-harness',
  },
]

export function PluginManagementSectionNav({ active }: PluginManagementSectionNavProps) {
  const { t } = useTranslation('common')

  return (
    <nav
      data-testid="plugin-management-section-nav"
      aria-label={t('workbench.plugins_management_sections', '插件管理分区')}
      className="flex gap-5 border-b border-border/40"
    >
      {sections.map(section => {
        const selected = section.id === active
        const label =
          section.id === 'plugins'
            ? t('workbench.plugins_section_plugins', '插件')
            : t('workbench.harness_apps_title', 'Harness 能力')
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
