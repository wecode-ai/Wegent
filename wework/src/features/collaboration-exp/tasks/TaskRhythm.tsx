import { ArrowRight, Circle, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { selectExperienceWorkSnapshot, type ExperienceTaskRow } from '../model'
import { useTaskDescription } from './taskPresentation'
import './TasksExperience.css'

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
  const description = useTaskDescription(current)
  const Icon = current ? LoaderCircle : Circle
  return (
    <aside
      aria-label={t('tasks.rhythm.title')}
      data-testid="collaboration-exp-task-rhythm"
      data-live={Boolean(current)}
      className="experience-task-home-pulse"
    >
      <div className="experience-task-home-pulse-head">
        <Icon
          size={14}
          aria-hidden="true"
          className={current ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
        <span>
          <strong>{t(current ? 'tasks.home.progress' : 'tasks.home.idle')}</strong>
          <small>{t('tasks.home.attention', { count: rows.length })}</small>
        </span>
      </div>
      {current ? (
        <button
          type="button"
          data-testid="collaboration-exp-task-rhythm-current"
          className="experience-task-home-live-work"
          onClick={() => onSelect(current)}
        >
          <span>{t('tasks.rhythm.current')}</span>
          <strong>{current.title}</strong>
          <small>{description}</small>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      ) : (
        <p>{t('tasks.home.emptyRhythm')}</p>
      )}
      <dl className="experience-task-home-metrics">
        {(['waiting', 'running', 'completed'] as const).map(status => (
          <div key={status} data-tone={status}>
            <dd data-testid={`collaboration-exp-task-rhythm-${status}`}>
              {snapshot.counts[status]}
            </dd>
            <dt>{t(`tasks.rhythm.${status}`)}</dt>
          </div>
        ))}
      </dl>
    </aside>
  )
}
