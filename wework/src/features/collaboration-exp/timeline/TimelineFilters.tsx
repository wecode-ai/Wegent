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
    <div className="experience-timeline-tools">
      <h2 className="text-base font-semibold">{t('timeline.progress')}</h2>
      <div role="group" aria-label={t('timeline.filters')}>
        {(['all', 'attachments', 'conclusions'] as const).map(filter => (
          <Button
            key={filter}
            variant="ghost"
            aria-pressed={value === filter}
            data-testid={`collaboration-exp-timeline-filter-${filter}`}
            onClick={() => onChange(filter)}
          >
            {t(`timeline.${filter === 'attachments' ? 'hasAttachments' : filter}`)}
          </Button>
        ))}
      </div>
    </div>
  )
}
