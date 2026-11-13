import type { ReactNode } from 'react'
import { ListTodo, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export interface ExperienceNavigationProps {
  activeView: 'assistant' | 'tasks'
  onViewChange: (view: 'assistant' | 'tasks') => void
  projectNavigation?: ReactNode
  footer?: ReactNode
}

export function ExperienceNavigation({
  activeView,
  onViewChange,
  projectNavigation,
  footer,
}: ExperienceNavigationProps) {
  const { t } = useTranslation('collaborationExp')
  const items = [
    { id: 'assistant', icon: Sparkles, label: t('shell.assistant') },
    { id: 'tasks', icon: ListTodo, label: t('shell.tasks') },
  ] as const

  return (
    <nav className="experience-navigation" aria-label={t('shell.navigation')}>
      <div className="experience-navigation-primary">
        {items.map(({ id, icon: Icon, label }) => (
          <Button
            key={id}
            type="button"
            variant="ghost"
            className="experience-navigation-item"
            aria-current={activeView === id ? 'page' : undefined}
            data-testid={`collaboration-exp-navigation-${id}`}
            onClick={() => onViewChange(id)}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="min-w-0 truncate">{label}</span>
          </Button>
        ))}
      </div>
      {projectNavigation ? (
        <div className="experience-navigation-projects">
          <div className="px-2 text-xs text-text-muted">{t('shell.projects')}</div>
          {projectNavigation}
        </div>
      ) : null}
      {footer ? <div className="experience-navigation-footer">{footer}</div> : null}
    </nav>
  )
}
