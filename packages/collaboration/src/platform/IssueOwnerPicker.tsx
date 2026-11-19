import { AtSign, Bot, UserRound, UsersRound } from 'lucide-react'
import type { ControlDensity } from '../controls/recipes'
import { SearchableSelect } from '../controls/SearchableSelect'
import type { CollaborationTranslate } from '../i18n'
import type { IssueHomeOwnerOption } from './issueHomeOwners'

export function IssueOwnerPicker({
  owners,
  value,
  onChange,
  disabled,
  translate,
  showLabel = false,
  density,
}: {
  owners: IssueHomeOwnerOption[]
  value: string | null
  onChange(id: string | null): void
  disabled: boolean
  translate: CollaborationTranslate
  showLabel?: boolean
  density?: ControlDensity
}) {
  const owner = owners.find(candidate => candidate.id === value)
  const label = translate('issue_creation.owner', 'Assignee')
  const options = [
    {
      value: '',
      label: translate('issue_creation.unassigned', 'Unassigned'),
      testId: 'collaboration-issue-owner-none',
      icon: <UserRound aria-hidden="true" className="h-4 w-4" />,
    },
    ...owners.map(member => {
      const Icon =
        member.owner.kind === 'agent' ? Bot : member.owner.kind === 'group' ? UsersRound : UserRound
      return {
        value: member.id,
        label: member.title,
        group: translate(`issue_creation.${member.owner.kind}`),
        searchText: member.owner.id,
        testId: `collaboration-issue-owner-${member.owner.kind === 'user' ? member.owner.id : member.id}`,
        icon: <Icon aria-hidden="true" className="h-4 w-4" />,
      }
    }),
  ]
  return (
    <SearchableSelect
      density={density}
      appearance="composer"
      value={value ?? ''}
      options={options}
      onChange={next => onChange(next || null)}
      testId="collaboration-issue-owner"
      accessibleLabel={owner ? `${label}: ${owner.title}` : label}
      disabled={disabled}
      searchPlaceholder={translate('issue_creation.search_members', 'Search members')}
      emptyLabel={translate('todo.no_matching_members', 'No matching members')}
      triggerContent={
        <>
          {showLabel ? (
            <UserRound aria-hidden="true" className="h-4 w-4 shrink-0" />
          ) : (
            <AtSign aria-hidden="true" className="h-4 w-4 shrink-0" />
          )}
          {owner && <span className="max-w-32 truncate">{owner.title}</span>}
          {!owner && showLabel && <span>{label}</span>}
        </>
      }
    />
  )
}
