import type { CloudProject } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { SearchableSelect } from '@wegent/collaboration'
import { ChevronDown } from 'lucide-react'

export function IssueProjectSelect({
  projects,
  value,
  disabled,
  className,
  placeholder,
  onChange,
}: {
  projects: CloudProject[]
  value: string
  disabled?: boolean
  className?: string
  placeholder?: string
  onChange(value: string): void
}) {
  const { t } = useTranslation('common')
  const empty = placeholder ?? t('issue_creation.independent_option')
  const selected = projects.find(project => String(project.id) === value)
  return (
    <SearchableSelect
      modal
      testId="independent-issue-project"
      accessibleLabel={t('issue_creation.project_label')}
      density="compact"
      className={className}
      disabled={disabled}
      value={value}
      searchPlaceholder={t('todo.search_projects')}
      emptyLabel={t('todo.no_project_results')}
      triggerContent={
        <>
          <span className="min-w-0 flex-1">
            {selected ? (
              <>
                <span data-testid="issue-project-selected-name" className="block truncate">
                  {selected.name}
                </span>
                {selected.project_key && (
                  <span
                    data-testid="issue-project-selected-key"
                    className="block break-all text-xs text-text-secondary"
                  >
                    {selected.project_key}
                  </span>
                )}
              </>
            ) : (
              empty
            )}
          </span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
        </>
      }
      options={[
        { value: '', label: empty },
        ...projects.map(project => ({
          value: String(project.id),
          label: project.name,
          description: project.project_key,
          group: project.workspace_context?.name,
          searchText: [project.workspace_context?.name, project.public_id]
            .filter(Boolean)
            .join(' '),
        })),
      ]}
      onChange={onChange}
    />
  )
}
