import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface ExperimentalBadgeProps {
  className?: string
  testId?: string
}

export function ExperimentalBadge({ className, testId }: ExperimentalBadgeProps) {
  const { t } = useTranslation('common')

  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-xs font-medium leading-none text-primary',
        className
      )}
    >
      {t('workbench.experimental_badge', '实验性')}
    </span>
  )
}
