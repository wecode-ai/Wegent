import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'

export interface ExperienceHeaderProps {
  title: ReactNode
  actions?: ReactNode
  onBack?: () => void
  backLabel?: string
  testId?: string
}

export function ExperienceHeader({
  title,
  actions,
  onBack,
  backLabel,
  testId = 'collaboration-exp-header',
}: ExperienceHeaderProps) {
  const { t } = useTranslation('collaborationExp')
  const label = backLabel ?? t('shell.back')

  return (
    <header className="experience-header" data-testid={testId}>
      {onBack ? (
        <Tooltip label={label}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="experience-header-back"
            aria-label={label}
            data-testid={`${testId}-back`}
            onClick={onBack}
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Button>
        </Tooltip>
      ) : null}
      <div className="experience-header-title text-base font-medium">{title}</div>
      {actions ? <div className="experience-header-actions">{actions}</div> : null}
    </header>
  )
}
