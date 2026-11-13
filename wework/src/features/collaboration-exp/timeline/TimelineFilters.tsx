import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export type TimelineFilter = 'all' | 'attachments' | 'conclusions'

export function TimelineFilters({
  value,
  onChange,
}: {
  value: TimelineFilter
  onChange(value: TimelineFilter): void
}) {
  const { t } = useTranslation('collaborationExp')
  return (
    <div
      className="flex shrink-0 flex-wrap gap-1 px-4 py-2"
      role="group"
      aria-label={t('timeline.filters')}
    >
      {(['all', 'attachments', 'conclusions'] as const).map(filter => (
        <Button
          key={filter}
          variant={value === filter ? 'secondary' : 'ghost'}
          aria-pressed={value === filter}
          className="min-h-11 md:min-h-8"
          data-testid={`collaboration-exp-timeline-filter-${filter}`}
          onClick={() => onChange(filter)}
        >
          {t(`timeline.${filter}`)}
        </Button>
      ))}
    </div>
  )
}
