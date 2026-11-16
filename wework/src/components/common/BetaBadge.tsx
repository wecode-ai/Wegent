import { useTranslation } from '@/hooks/useTranslation'

/** Shared feature-stage label for entry points available outside experimental settings. */
export function BetaBadge({ testId }: { testId: string }) {
  const { t } = useTranslation('common')
  return (
    <span
      data-testid={testId}
      className="inline-flex shrink-0 items-center rounded border border-border px-1 text-xs font-medium leading-4 text-text-secondary"
    >
      {t('beta')}
    </span>
  )
}
