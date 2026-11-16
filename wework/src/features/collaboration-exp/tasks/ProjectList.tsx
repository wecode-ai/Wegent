import { Circle, LoaderCircle } from 'lucide-react'
import { formatRelativeSidebarTime } from '@/components/layout/runtimeSidebarTime'
import { useTranslation } from '@/hooks/useTranslation'
import {
  projectScopeOf,
  selectExperienceTaskState,
  type ExperienceProjectData,
  type ExperienceProjectScope,
  type ExperienceTaskRow,
} from '../model'
import './ProjectExperience.css'

export interface ProjectPresentationProps {
  projects: readonly ExperienceProjectScope[]
  rows: readonly ExperienceTaskRow[]
  projectData?: readonly ExperienceProjectData[]
  onOpenProject(project: ExperienceProjectScope): void
}

export function ProjectList({
  projects,
  rows,
  projectData,
  onOpenProject,
}: ProjectPresentationProps) {
  const { t } = useTranslation('collaborationExp')
  const summaries = projects.map(project => {
    const visible = rows.filter(row => row.project.key === project.key)
    return {
      project,
      source: projectData?.find(item => projectScopeOf(item.project).key === project.key)?.project,
      count: visible.length,
      waiting: visible.filter(row => selectExperienceTaskState(row) === 'waiting').length,
      running: visible.some(row => selectExperienceTaskState(row) === 'running'),
    }
  })
  return (
    <>
      {[true, false].map(attention => {
        const group = summaries.filter(item => Boolean(item.waiting) === attention)
        if (!group.length) return null
        return (
          <section key={String(attention)}>
            <h2 className="experience-task-group-title">
              <span>{t(attention ? 'tasks.projectAttention' : 'tasks.projectOther')}</span>
              <span>{group.length}</span>
            </h2>
            {group.map(({ project, source, count, waiting, running }) => {
              const Icon = running && !waiting ? LoaderCircle : Circle
              return (
                <button
                  key={project.key}
                  type="button"
                  className="experience-project-list-row"
                  data-testid={`collaboration-exp-task-project-scope-${project.id}`}
                  onClick={() => onOpenProject(project)}
                >
                  <span className="experience-project-list-title">
                    <strong>{project.name}</strong>
                    {source && (
                      <time dateTime={source.updated_at}>
                        {formatRelativeSidebarTime(source.updated_at)}
                      </time>
                    )}
                  </span>
                  <span className="experience-project-list-description">
                    {source?.description || t('tasks.noProjectDescription')}
                  </span>
                  <span className="experience-project-list-meta">
                    <span>
                      {t('tasks.projectTaskCount', { count })}
                      {waiting > 0 && <> · {t('tasks.projectWaitingCount', { count: waiting })}</>}
                    </span>
                    <Icon
                      size={14}
                      aria-hidden="true"
                      data-state={waiting ? 'waiting' : running ? 'running' : 'idle'}
                      className={
                        running && !waiting ? 'animate-spin motion-reduce:animate-none' : undefined
                      }
                    />
                  </span>
                </button>
              )
            })}
          </section>
        )
      })}
    </>
  )
}
