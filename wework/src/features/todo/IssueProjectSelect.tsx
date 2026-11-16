import { ChevronDown } from 'lucide-react'
import { IssueDetailSearchableSelect } from '@wegent/collaboration'
import type { CloudProject } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'

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
  className: string
  placeholder?: string
  onChange(value: string): void
}) {
  const { t } = useTranslation('common')
  const empty = placeholder ?? t('issue_creation.independent_option')
  const label = (project: CloudProject) =>
    [project.name, project.project_key].filter(Boolean).join(' · ')
  const selected = projects.find(project => String(project.id) === value)
  return (
    <IssueDetailSearchableSelect
      modal
      testId="independent-issue-project"
      accessibleLabel={t('issue_creation.project_label')}
      className={`${className} flex items-center gap-2 text-left`}
      disabled={disabled}
      value={value}
      searchPlaceholder={t('todo.search_projects')}
      emptyLabel={t('todo.no_project_results')}
      triggerContent={
        <>
          <span className="min-w-0 flex-1 truncate">
            {selected
              ? [selected.workspace_context?.name, label(selected)].filter(Boolean).join(' / ')
              : empty}
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
