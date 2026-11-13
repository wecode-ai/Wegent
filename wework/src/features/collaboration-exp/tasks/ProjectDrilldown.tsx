import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceProjectScope } from '../model/types'

export type ProjectDrilldownView = 'overview' | 'plan' | 'settings'

export function ProjectDrilldown({
  view,
  onViewChange,
  canConfigure = true,
  children,
}: {
  project: ExperienceProjectScope
  view: ProjectDrilldownView
  onViewChange(view: ProjectDrilldownView): void
  onBack(): void
  children: ReactNode
  canConfigure?: boolean
}) {
  const { t } = useTranslation('collaborationExp')
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-testid="collaboration-exp-project"
    >
      <nav
        aria-label={t('tasks.projectViews')}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2"
      >
        {(['overview', 'plan', 'settings'] as const)
          .filter(option => option !== 'settings' || canConfigure)
          .map(option => (
            <Button
              key={option}
              variant={view === option ? 'secondary' : 'ghost'}
              className="min-h-11 md:min-h-8"
              data-testid={`collaboration-exp-project-${option}`}
              aria-current={view === option ? 'page' : undefined}
              onClick={() => onViewChange(option)}
            >
              {t(`tasks.${option}`)}
            </Button>
          ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  )
}
