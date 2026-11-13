import { ArrowUpRight, CirclePlay } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { selectExperienceWorkSnapshot, type ExperienceTaskRow } from '../model'

export function TaskRhythm({
  rows,
  onSelect,
}: {
  rows: readonly ExperienceTaskRow[]
  onSelect(row: ExperienceTaskRow): void
}) {
  const { t } = useTranslation('collaborationExp')
  const snapshot = selectExperienceWorkSnapshot({ roles: [], work: [], rows })
  const current = snapshot.current?.taskRow
  return (
    <section
      aria-label={t('tasks.rhythm.title')}
      data-testid="collaboration-exp-task-rhythm"
      className="space-y-3 px-4 pb-3 pt-4"
    >
      <dl className="grid grid-cols-3 gap-3">
        {(['waiting', 'running', 'completed'] as const).map(status => (
          <div key={status} className="min-w-0">
            <dt className="break-words text-sm text-text-secondary">
              {t(`tasks.rhythm.${status}`)}
            </dt>
            <dd
              className="heading-small mt-1 tabular-nums"
              data-testid={`collaboration-exp-task-rhythm-${status}`}
            >
              {snapshot.counts[status]}
            </dd>
          </div>
        ))}
      </dl>
      {current && (
        <button
          type="button"
          data-testid="collaboration-exp-task-rhythm-current"
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted keyboard:focus-visible:outline keyboard:focus-visible:outline-2 keyboard:focus-visible:outline-focus"
          onClick={() => onSelect(current)}
        >
          <CirclePlay aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-text-muted">{t('tasks.rhythm.current')}</span>
            <span className="block truncate text-sm font-medium">{current.title}</span>
          </span>
          <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
        </button>
      )}
    </section>
  )
}
