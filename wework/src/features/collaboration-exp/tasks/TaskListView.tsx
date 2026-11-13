import { Circle, Check, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { ExperienceProjectScope, ExperienceTaskRow } from '../model/types'
import { TaskFilters, type TaskFilterValue } from './TaskFilters'

interface Props {
  rows: readonly ExperienceTaskRow[]
  projects: readonly ExperienceProjectScope[]
  statuses: readonly { value: string; label: string }[]
  filters: TaskFilterValue
  selectedKey?: string | null
  loading: boolean
  error?: string | null
  hasMore?: boolean
  onFiltersChange(value: TaskFilterValue): void
  onSelect(row: ExperienceTaskRow): void
  onOpenProject(project: ExperienceProjectScope): void
  onRetry(): void
  onLoadMore?(): void
}

export function TaskListView(props: Props) {
  const { t } = useTranslation('collaborationExp')
  const groups = [...new Set(props.rows.map(row => row.status))]
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" data-testid="collaboration-exp-tasks">
      <TaskFilters
        value={props.filters}
        projects={props.projects}
        statuses={props.statuses}
        onChange={props.onFiltersChange}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" aria-busy={props.loading}>
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
        {!props.loading && !props.error && !props.rows.length && (
          <p
            className="p-4 text-sm text-text-secondary"
            data-testid="collaboration-exp-tasks-empty"
          >
            {t('tasks.empty')}
          </p>
        )}
        {groups.map(status => {
          const rows = props.rows.filter(row => row.status === status)
          return (
            <section key={status} data-testid={`collaboration-exp-task-group-${status}`}>
              <h2 className="flex items-center justify-between px-4 pb-2 pt-5 text-sm text-text-secondary">
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
        })}
        {props.hasMore && props.onLoadMore && (
          <Button
            variant="ghost"
            disabled={props.loading}
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
  const Icon =
    row.status === 'completed' ? Check : row.executionState === 'running' ? LoaderCircle : Circle
  return (
    <article
      className={selected ? 'bg-muted' : 'hover:bg-muted/50'}
      data-testid={`collaboration-exp-task-row-${row.id}`}
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-start gap-3 px-4 pb-2 pt-3 text-left keyboard:focus-visible:outline keyboard:focus-visible:outline-2 keyboard:focus-visible:outline-focus"
        data-testid={`collaboration-exp-task-${row.id}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(row)}
      >
        <div className="min-w-0 flex-1">
          <span className="block break-words font-medium">{row.title}</span>
          {row.waitingFor.length > 0 && (
            <span className="mt-1 block break-words text-sm text-text-secondary">
              {t('tasks.waitingFor', {
                names: row.waitingFor.map(person => person.name).join('、'),
              })}
            </span>
          )}
          {row.assignee && (
            <span className="mt-1 block text-sm text-text-secondary">
              {row.assignee.name ?? t('tasks.unnamedUser', { id: row.assignee.id })}
            </span>
          )}
        </div>
        <Icon
          aria-hidden="true"
          className={`mt-1 h-4 w-4 shrink-0 text-text-muted ${row.executionState === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />
      </button>
      <button
        type="button"
        className="min-h-11 max-w-full truncate px-4 pb-3 text-left text-sm text-text-secondary hover:underline md:min-h-8"
        data-testid={`collaboration-exp-task-project-${row.id}`}
        onClick={() => onOpenProject(row.project)}
      >
        {row.project.name}
      </button>
    </article>
  )
}
