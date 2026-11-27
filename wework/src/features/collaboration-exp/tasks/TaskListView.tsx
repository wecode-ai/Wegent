import {
  formatRelativeSidebarTime,
  useSidebarRelativeTimeRefresh,
} from '@/components/layout/runtimeSidebarTime'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Check, Circle, LoaderCircle, MessageSquare } from 'lucide-react'
import { useCallback, useRef } from 'react'
import { selectExperienceTaskState } from '../model'
import type {
  ExperienceProjectData,
  ExperienceProjectScope,
  ExperienceTaskRow,
} from '../model/types'
import { ProjectList } from './ProjectList'
import { TaskFilters, type TaskFilterValue, type TaskListMode } from './TaskFilters'
import { useTaskDescription } from './taskPresentation'
import './TasksExperience.css'

interface Props {
  scrollOwner: string
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
  const mode = props.mode ?? 'tasks'
  const { relevance, search, status, projectKey } = props.filters
  const scrollKey = JSON.stringify([
    'experience-list-scroll',
    props.scrollOwner,
    mode,
    relevance,
    search,
    status,
    projectKey,
  ])
  const count = mode === 'tasks' ? props.rows.length : props.projects.length
  const restored = useRef<HTMLDivElement | null>(null)
  const attachScroller = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || restored.current === element || props.loading || !count) return
      const position = Number(sessionStorage.getItem(scrollKey)) || 0
      element.scrollTop = position
      restored.current = element
    },
    [scrollKey, count, props.loading]
  )
  const nowMs = useSidebarRelativeTimeRefresh(props.rows.length > 0)
  const groups = [...new Set(props.rows.map(row => row.status))]
  const visibleProjects = props.projects.filter(
    project => !props.filters.projectKey || project.key === props.filters.projectKey
  )
  return (
    <section className="experience-task-list" data-testid="collaboration-exp-tasks">
      <TaskFilters
        value={props.filters}
        projects={props.projects}
        statuses={props.statuses}
        mode={mode}
        onModeChange={props.onModeChange}
        onCreate={props.onCreate}
        onCreateProject={props.onCreateProject}
        onChange={props.onFiltersChange}
      />
      <div
        key={scrollKey}
        ref={attachScroller}
        className="experience-task-scroll"
        aria-busy={props.loading}
        onScroll={event => {
          const element = event.currentTarget
          if (restored.current === element && element.isConnected && !element.closest('[hidden]'))
            sessionStorage.setItem(scrollKey, String(element.scrollTop))
        }}
      >
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
          !(mode === 'projects' ? visibleProjects.length : props.rows.length) && (
            <p
              className="p-4 text-sm text-text-secondary"
              data-testid="collaboration-exp-tasks-empty"
            >
              {t('tasks.empty')}
            </p>
          )}
        {mode === 'projects' ? (
          <ProjectList
            nowMs={nowMs}
            projects={visibleProjects}
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
                    nowMs={nowMs}
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
  nowMs,
  row,
  selected,
  onSelect,
  onOpenProject,
}: {
  nowMs: number
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
      <ControlButton
        variant="unstyled"
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
      </ControlButton>
      <div className="experience-task-row-meta">
        <ControlButton
          variant="unstyled"
          type="button"
          className="experience-task-row-project"
          data-testid={`collaboration-exp-task-project-${row.id}`}
          onClick={() => onOpenProject(row.project)}
        >
          {row.project.name}
        </ControlButton>
        <span className="experience-task-row-signals">
          {row.conversations.state === 'ready' && row.conversations.items.length > 0 && (
            <span title={t('private.title')} className="experience-task-row-conversations">
              <MessageSquare size={13} aria-hidden="true" />
              {row.conversations.items.length}
            </span>
          )}
          <time dateTime={row.updatedAt} title={row.updatedAt}>
            {formatRelativeSidebarTime(row.updatedAt, nowMs)}
          </time>
        </span>
      </div>
    </article>
  )
}
