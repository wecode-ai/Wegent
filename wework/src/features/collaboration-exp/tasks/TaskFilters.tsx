import { useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { IssueDetailSearchableSelect } from '@wegent/collaboration'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceProjectScope } from '../model/types'

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
  onChange(value: TaskFilterValue): void
}

export function TaskFilters({ value, projects, statuses, onChange }: Props) {
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
  return (
    <div ref={controls} className="space-y-2 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <select
          data-testid="collaboration-exp-filter-relevance"
          aria-label={t('tasks.relevance')}
          value={value.relevance}
          onChange={event =>
            onChange({ ...value, relevance: event.target.value as TaskFilterValue['relevance'] })
          }
          className="min-h-11 min-w-0 max-w-full rounded-md bg-background px-2 text-sm md:min-h-8"
        >
          <option value="related">{t('tasks.related')}</option>
          <option value="all">{t('tasks.allVisible')}</option>
        </select>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto h-11 w-11 md:h-8 md:w-8"
          data-testid="collaboration-exp-search-toggle"
          aria-label={t('tasks.search')}
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen(!searchOpen)
            if (!searchOpen) requestAnimationFrame(() => searchInput.current?.focus())
          }}
        >
          <Search aria-hidden="true" />
        </Button>
        <IssueDetailSearchableSelect
          value={value.status}
          options={[{ value: '', label: t('tasks.allStatuses') }, ...statuses]}
          testId="collaboration-exp-filter-status"
          accessibleLabel={t('tasks.status')}
          searchPlaceholder={t('tasks.findStatus')}
          emptyLabel={t('tasks.noMatches')}
          className="min-h-11 max-w-full px-2 text-sm md:min-h-8"
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
          className="min-h-11 max-w-full px-2 text-sm md:min-h-8"
          onChange={projectKey => onChange({ ...value, projectKey })}
        />
      </div>
      {searchOpen && (
        <input
          ref={searchInput}
          type="search"
          value={value.search}
          data-testid="collaboration-exp-task-search"
          aria-label={t('tasks.search')}
          placeholder={t('tasks.search')}
          className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-base md:min-h-8"
          onChange={event => onChange({ ...value, search: event.target.value })}
        />
      )}
      {(selectedStatus || selectedProject) && (
        <div className="flex flex-wrap gap-1" data-testid="collaboration-exp-filter-chips">
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
                className="h-auto min-h-11 max-w-full gap-1 px-2 py-1 md:min-h-8"
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
  )
}
