import { useRef, useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import { IssueDetailSearchableSelect } from '@wegent/collaboration'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceProjectScope } from '../model/types'
import { TaskViewSwitcher } from './TaskViewSwitcher'

export type TaskListMode = 'tasks' | 'projects'

export interface TaskFilterValue {
  relevance: 'related' | 'all'
  search: string
  status: string
  projectKey: string
}

interface Props {
  value: TaskFilterValue
  projects: readonly ExperienceProjectScope[]
  statuses: readonly { value: string; label: string }[]
  mode?: TaskListMode
  onModeChange?(mode: TaskListMode): void
  onCreate?(): void
  onCreateProject?(): void
  onChange(value: TaskFilterValue): void
}

export function TaskFilters({
  value,
  projects,
  statuses,
  mode = 'tasks',
  onModeChange,
  onCreate,
  onCreateProject,
  onChange,
}: Props) {
  const { t } = useTranslation('collaborationExp')
  const [searchOpen, setSearchOpen] = useState(Boolean(value.search))
  const controls = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const clear = (field: 'status' | 'projectKey') => {
    onChange({ ...value, [field]: '' })
    controls.current
      ?.querySelector<HTMLElement>(`[data-testid="collaboration-exp-filter-${field}"]`)
      ?.focus()
  }
  const selectedProject = projects.find(project => project.key === value.projectKey)
  const selectedStatus = statuses.find(status => status.value === value.status)
  const filtersVisible = searchOpen || Boolean(selectedStatus || selectedProject)
  const create = mode === 'projects' ? onCreateProject : onCreate
  return (
    <div ref={controls} className="experience-task-controls">
      <header className="experience-task-toolbar" data-testid="collaboration-exp-pane-header-tasks">
        <div className="experience-task-view-switch">
          <TaskViewSwitcher mode={mode} onChange={onModeChange} />
        </div>
        <button
          type="button"
          className="experience-task-icon-button"
          data-testid="collaboration-exp-search-toggle"
          aria-label={t('tasks.search')}
          aria-expanded={searchOpen}
          data-active={searchOpen || undefined}
          onClick={() => {
            setSearchOpen(!searchOpen)
            if (!searchOpen) requestAnimationFrame(() => searchInput.current?.focus())
          }}
        >
          <Search aria-hidden="true" />
        </button>
        {create && (
          <button
            type="button"
            className="experience-task-icon-button"
            data-testid="collaboration-exp-task-create"
            aria-label={t(mode === 'projects' ? 'tasks.projectHome.create' : 'tasks.create')}
            onClick={create}
          >
            <Plus aria-hidden="true" />
          </button>
        )}
      </header>
      {filtersVisible && (
        <div className="experience-task-filter-panel">
          {searchOpen && (
            <input
              ref={searchInput}
              type="search"
              value={value.search}
              data-testid="collaboration-exp-task-search"
              aria-label={t('tasks.search')}
              placeholder={t('tasks.search')}
              className="experience-task-search"
              onChange={event => onChange({ ...value, search: event.target.value })}
            />
          )}
          <select
            data-testid="collaboration-exp-filter-relevance"
            aria-label={t('tasks.relevance')}
            value={value.relevance}
            onChange={event =>
              onChange({ ...value, relevance: event.target.value as TaskFilterValue['relevance'] })
            }
            className="experience-task-relevance"
          >
            <option value="related">{t('tasks.related')}</option>
            <option value="all">{t('tasks.allVisible')}</option>
          </select>
          <IssueDetailSearchableSelect
            value={value.status}
            options={[{ value: '', label: t('tasks.allStatuses') }, ...statuses]}
            testId="collaboration-exp-filter-status"
            accessibleLabel={t('tasks.status')}
            searchPlaceholder={t('tasks.findStatus')}
            emptyLabel={t('tasks.noMatches')}
            className="experience-task-filter-select"
            onChange={status => onChange({ ...value, status })}
          />
          <IssueDetailSearchableSelect
            value={value.projectKey}
            options={[
              { value: '', label: t('tasks.allProjects') },
              ...projects.map(project => ({ value: project.key, label: project.name })),
            ]}
            testId="collaboration-exp-filter-projectKey"
            accessibleLabel={t('tasks.project')}
            searchPlaceholder={t('tasks.findProject')}
            emptyLabel={t('tasks.noMatches')}
            className="experience-task-filter-select"
            onChange={projectKey => onChange({ ...value, projectKey })}
          />
          {(selectedStatus || selectedProject) && (
            <div
              className="experience-task-filter-chips"
              data-testid="collaboration-exp-filter-chips"
            >
              {(
                [
                  ['status', selectedStatus?.label],
                  ['projectKey', selectedProject?.name],
                ] as const
              ).map(([field, label]) =>
                label ? (
                  <Button
                    key={field}
                    type="button"
                    variant="secondary"
                    className="h-auto min-h-8 max-w-full gap-1 px-2 py-1"
                    data-testid={`collaboration-exp-clear-${field}`}
                    aria-label={t('tasks.clearFilter', { name: label })}
                    onClick={() => clear(field)}
                  >
                    <span className="truncate">{label}</span>
                    <X aria-hidden="true" />
                  </Button>
                ) : null
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
