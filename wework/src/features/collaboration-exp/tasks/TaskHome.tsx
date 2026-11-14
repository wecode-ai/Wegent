import type { ReactNode } from 'react'
import { ArrowRight, Circle, Plus } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import weworkLogo from '../../../../resources/icons/icon.png'
import { selectExperienceTaskState, type ExperienceTaskRow } from '../model'
import { TaskRhythm } from './TaskRhythm'
import { useTaskDescription } from './taskPresentation'
import './TasksExperience.css'

export function TaskHome({
  rows,
  team,
  onSelect,
  onCreate,
}: {
  rows: readonly ExperienceTaskRow[]
  team?: ReactNode
  onSelect(row: ExperienceTaskRow): void
  onCreate?(): void
}) {
  const { t } = useTranslation('collaborationExp')
  const next = rows.find(row => selectExperienceTaskState(row) === 'waiting')
  const description = useTaskDescription(next)
  return (
    <main className="experience-task-home" data-testid="collaboration-exp-task-home">
      <div className="experience-task-home-hero">
        <div className="experience-task-home-copy">
          <span className="experience-task-home-symbol">
            <img src={weworkLogo} width={34} height={34} alt="" />
            <span>
              <strong>{t('tasks.home.console')}</strong>
              <small>{t('tasks.home.sync')}</small>
            </span>
          </span>
          <h1>{t('tasks.home.title')}</h1>
          <p>{t('tasks.home.description')}</p>
          {onCreate && (
            <button
              type="button"
              className="experience-task-create-primary"
              data-testid="collaboration-exp-task-home-create"
              onClick={onCreate}
            >
              <Plus size={16} aria-hidden="true" />
              {t('tasks.create')}
            </button>
          )}
        </div>
        <TaskRhythm rows={rows} onSelect={onSelect} />
      </div>
      {team}
      {next && (
        <section
          className="experience-task-home-next"
          data-testid="collaboration-exp-task-home-next"
        >
          <span>
            <Circle size={14} aria-hidden="true" />
            {t('tasks.home.next')}
          </span>
          <h2>{next.title}</h2>
          <p>{description}</p>
          <button
            type="button"
            className="experience-task-home-next-action"
            data-testid="collaboration-exp-task-home-next-open"
            onClick={() => onSelect(next)}
          >
            {t('tasks.home.viewProgress')}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </section>
      )}
    </main>
  )
}
