import { ArrowRight, Plus } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { selectExperienceTaskState } from '../model'
import type { ProjectPresentationProps } from './ProjectList'
import './ProjectExperience.css'

export function ProjectHome({
  projects,
  rows,
  onOpenProject,
  onCreate,
}: ProjectPresentationProps & { onCreate?(): void }) {
  const { t } = useTranslation('collaborationExp')
  const highlights = projects.flatMap(project => {
    const waiting = rows.find(
      row => row.project.key === project.key && selectExperienceTaskState(row) === 'waiting'
    )
    return waiting ? [{ project, waiting }] : []
  })
  return (
    <main className="experience-project-home" data-testid="collaboration-exp-project-home">
      <p className="experience-project-home-eyebrow">{t('tasks.projectHome.eyebrow')}</p>
      <div className="experience-project-home-heading">
        <h1>{t('tasks.projectHome.title')}</h1>
        {onCreate && (
          <button
            type="button"
            data-testid="collaboration-exp-project-home-create"
            onClick={onCreate}
          >
            <Plus size={16} aria-hidden="true" />
            {t('tasks.projectHome.create')}
          </button>
        )}
      </div>
      <p className="experience-project-home-intro">{t('tasks.projectHome.description')}</p>
      <div className="experience-project-home-summary">
        <span>
          <b>{projects.length}</b>
          {t('tasks.projectHome.count')}
        </span>
        <span>
          <b>{highlights.length}</b>
          {t('tasks.projectHome.attention')}
        </span>
      </div>
      <section className="experience-project-home-highlights">
        <h2>{t('tasks.projectHome.highlights')}</h2>
        {highlights.length ? (
          highlights.map(({ project, waiting }) => (
            <button
              key={project.key}
              type="button"
              data-testid={`collaboration-exp-project-highlight-${project.id}`}
              onClick={() => onOpenProject(project)}
            >
              <span>
                <strong>{project.name}</strong>
                <small>{waiting.title}</small>
              </span>
              <ArrowRight aria-hidden="true" />
            </button>
          ))
        ) : (
          <p className="text-sm text-text-muted">{t('tasks.projectHome.empty')}</p>
        )}
      </section>
    </main>
  )
}
