import { Circle, Check, LoaderCircle, MessageSquare } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import {
  formatRelativeSidebarTime,
  useSidebarRelativeTimeRefresh,
} from '@/components/layout/runtimeSidebarTime'
import type {
  ExperienceProjectData,
  ExperienceProjectScope,
  ExperienceTaskRow,
} from '../model/types'
import { selectExperienceTaskState } from '../model'
import { TaskFilters, type TaskFilterValue, type TaskListMode } from './TaskFilters'
import { useTaskDescription } from './taskPresentation'
import { ProjectList } from './ProjectList'
import './TasksExperience.css'

interface Props {
  rows: readonly ExperienceTaskRow[]
  projects: readonly ExperienceProjectScope[]
  projectData?: readonly ExperienceProjectData[]
  statuses: readonly { value: string; label: string }[]
  filters: TaskFilterValue
  selectedKey?: string | null
  mode?: TaskListMode
  loading: boolean
  loadMoreReady: boolean
  error?: string | null
  hasMore?: boolean
  onModeChange?(mode: TaskListMode): void
  onCreate?(): void
  onCreateProject?(): void
  onFiltersChange(value: TaskFilterValue): void
  onSelect(row: ExperienceTaskRow): void
  onOpenProject(project: ExperienceProjectScope): void
  onRetry(): void
  onLoadMore?(): void
}

export function TaskListView(props: Props) {
  const { t } = useTranslation('collaborationExp')
  useSidebarRelativeTimeRefresh(props.rows.length > 0)
  const groups = [...new Set(props.rows.map(row => row.status))]
  return (
    <section className="experience-task-list" data-testid="collaboration-exp-tasks">
      <TaskFilters
        value={props.filters}
        projects={props.projects}
        statuses={props.statuses}
        mode={props.mode}
        onModeChange={props.onModeChange}
        onCreate={props.onCreate}
        onCreateProject={props.onCreateProject}
        onChange={props.onFiltersChange}
      />
      <div className="experience-task-scroll" aria-busy={props.loading}>
        {props.error && (
          <div role="alert" className="px-4 py-3 text-sm text-error">
            <p>{props.error}</p>
            <Button
              variant="ghost"
              data-testid="collaboration-exp-tasks-retry"
              onClick={props.onRetry}
            >
              {t('retry')}
            </Button>
          </div>
        )}
        {props.loading && !props.rows.length && (
          <p role="status" className="p-4">
            {t('loading')}
          </p>
        )}
        {!props.loading &&
          !props.error &&
          !(props.mode === 'projects' ? props.projects.length : props.rows.length) && (
            <p
              className="p-4 text-sm text-text-secondary"
              data-testid="collaboration-exp-tasks-empty"
            >
              {t('tasks.empty')}
            </p>
          )}
        {props.mode === 'projects' ? (
          <ProjectList
            projects={props.projects.filter(
              project => !props.filters.projectKey || project.key === props.filters.projectKey
            )}
            rows={props.rows}
            projectData={props.projectData}
            onOpenProject={props.onOpenProject}
          />
        ) : (
          groups.map(status => {
            const rows = props.rows.filter(row => row.status === status)
            return (
              <section key={status} data-testid={`collaboration-exp-task-group-${status}`}>
                <h2 className="experience-task-group-title">
                  <span>{rows[0].statusName}</span>
                  <span>{rows.length}</span>
                </h2>
                {rows.map(row => (
                  <TaskRow
                    key={row.key}
                    row={row}
                    selected={props.selectedKey === row.key}
                    onSelect={props.onSelect}
                    onOpenProject={props.onOpenProject}
                  />
                ))}
              </section>
            )
          })
        )}
        {props.hasMore && props.onLoadMore && (
          <Button
            variant="ghost"
            disabled={!props.loadMoreReady}
            data-testid="collaboration-exp-tasks-more"
            onClick={props.onLoadMore}
            className="m-3 min-h-11 md:min-h-8"
          >
            {t('tasks.loadMore')}
          </Button>
        )}
      </div>
    </section>
  )
}

function TaskRow({
  row,
  selected,
  onSelect,
  onOpenProject,
}: {
  row: ExperienceTaskRow
  selected: boolean
  onSelect(row: ExperienceTaskRow): void
  onOpenProject(project: ExperienceProjectScope): void
}) {
  const { t } = useTranslation('collaborationExp')
  const state = selectExperienceTaskState(row)
  const Icon = state === 'completed' ? Check : state === 'running' ? LoaderCircle : Circle
  const description = useTaskDescription(row)
  return (
    <article
      className="experience-task-row"
      data-selected={selected || undefined}
      data-testid={`collaboration-exp-task-row-${row.id}`}
    >
      <button
        type="button"
        className="experience-task-row-main"
        data-testid={`collaboration-exp-task-${row.id}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(row)}
      >
        <span className="experience-task-row-title">
          <strong>{row.title}</strong>
          <Icon
            aria-hidden="true"
            data-state={state}
            className={state === 'running' ? 'animate-spin motion-reduce:animate-none' : undefined}
          />
        </span>
        <span className="experience-task-row-description">{description}</span>
      </button>
      <div className="experience-task-row-meta">
        <button
          type="button"
          className="experience-task-row-project"
          data-testid={`collaboration-exp-task-project-${row.id}`}
          onClick={() => onOpenProject(row.project)}
        >
          {row.project.name}
        </button>
        <span className="experience-task-row-signals">
          {row.conversations.state === 'ready' && row.conversations.items.length > 0 && (
            <span title={t('private.title')} className="experience-task-row-conversations">
              <MessageSquare size={13} aria-hidden="true" />
              {row.conversations.items.length}
            </span>
          )}
          <time dateTime={row.updatedAt} title={row.updatedAt}>
            {formatRelativeSidebarTime(row.updatedAt)}
          </time>
        </span>
      </div>
    </article>
  )
}
