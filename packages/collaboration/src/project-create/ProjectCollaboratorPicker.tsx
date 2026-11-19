import { Bot, Plus, UserRound, UsersRound } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { SearchableSelect, type SearchableSelectOption } from '../controls/SearchableSelect'
import {
  CollaborationParticipantsTabs,
  type ParticipantTab,
} from '../project-manage/ProjectCollaborationParticipants'
import { runActiveMemberSearch } from '../project-manage/memberSearch'
import type { CollaborationUser } from '../types'
import type { ProjectCreateLabels, ProjectCreateResourceSetup } from './types'

export function ProjectCollaboratorPicker({
  labels,
  open,
  onOpenChange,
  people,
  excludedIds,
  agents,
  groups,
  searchUsers,
  onSelectPerson,
  onSelectAgent,
  onSelectGroup,
  groupAction,
}: {
  labels: ProjectCreateLabels
  open: boolean
  onOpenChange(open: boolean): void
  people: CollaborationUser[]
  excludedIds: number[]
  agents: ProjectCreateResourceSetup['agents']
  groups: ProjectCreateResourceSetup['groups']
  searchUsers?: ProjectCreateResourceSetup['searchUsers']
  onSelectPerson(user: CollaborationUser): void
  onSelectAgent(id: string): void
  onSelectGroup(id: string): void
  groupAction?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ParticipantTab>('members')
  const [response, setResponse] = useState<{
    query: string
    searchUsers: typeof searchUsers
    users: CollaborationUser[]
    failed: boolean
  } | null>(null)
  const current = response?.query === query && response.searchUsers === searchUsers
  const loading = Boolean(query.trim() && searchUsers && !current)
  const failed = current && response.failed
  useEffect(() => {
    if (!open) {
      setQuery('')
      setResponse(null)
      setActiveTab('members')
      return
    }
    if (activeTab !== 'members' || !query.trim() || !searchUsers) return
    let active = true
    const timer = window.setTimeout(() => {
      void runActiveMemberSearch({
        query: query.trim(),
        existingUserIds: new Set<number>(),
        search: async value => ({ users: await searchUsers(value) }),
        userId: user => user.id,
        isActive: () => active,
        onResults: users => setResponse({ query, searchUsers, users, failed: false }),
        onError: () => setResponse({ query, searchUsers, users: [], failed: true }),
      })
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [open, activeTab, query, searchUsers])
  const matches = (...values: (string | null | undefined)[]) =>
    values.some(value => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const users = [
    ...people.filter(user => matches(user.user_name, user.email)),
    ...(current ? response.users : []),
  ].filter(
    (user, index, all) =>
      !excludedIds.includes(user.id) &&
      all.findIndex(candidate => candidate.id === user.id) === index
  )
  const availableAgents = agents.filter(agent => matches(agent.name))
  const availableGroups = groups.filter(group => matches(group.name, group.description))
  const peopleSearchStatus =
    !open || activeTab !== 'members' || !query.trim() || failed
      ? ''
      : loading
        ? labels.searchingPeople
        : users.length
          ? `${labels.availablePeople}: ${users.length}`
          : labels.noMatchingCollaborators
  const options: SearchableSelectOption[] =
    activeTab === 'members'
      ? users.map(user => ({
          value: `user:${user.id}`,
          label: user.user_name,
          description: user.email ?? undefined,
          testId: `collaboration-project-create-member-${user.id}`,
          icon: <UserRound aria-hidden="true" className="h-4 w-4" />,
        }))
      : activeTab === 'agents'
        ? availableAgents.map(agent => ({
            value: `agent:${agent.id}`,
            label: agent.name,
            testId: `collaboration-project-create-agent-${agent.id}`,
            icon: <Bot aria-hidden="true" className="h-4 w-4" />,
          }))
        : availableGroups.map(group => ({
            value: `group:${group.id}`,
            label: group.name,
            description: labels.importGroupDescription,
            testId: `collaboration-project-create-group-${group.id}`,
            icon: <UsersRound aria-hidden="true" className="h-4 w-4" />,
          }))
  return (
    <SearchableSelect
      value=""
      options={options}
      filter={false}
      query={query}
      onSearchChange={setQuery}
      open={open}
      onOpenChange={onOpenChange}
      testId="collaboration-project-create-add-collaborator"
      menuTestId="collaboration-project-create-collaborator-menu"
      searchTestId="collaboration-project-create-people-search"
      accessibleLabel={labels.addCollaborator}
      searchPlaceholder={labels.searchCollaborators}
      emptyLabel={labels.noMatchingCollaborators}
      triggerContent={
        <>
          <Plus aria-hidden="true" className="h-4 w-4" />
          <span>{labels.addCollaborator}</span>
        </>
      }
      footer={activeTab === 'groups' ? groupAction : undefined}
      searchStatus={
        <>
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="collaboration-project-create-people-search-status"
          >
            {peopleSearchStatus}
          </p>
          {activeTab === 'members' && loading && <p aria-hidden="true">{labels.searchingPeople}</p>}
          {activeTab === 'members' && failed && <p role="alert">{labels.peopleSearchFailed}</p>}
          {!options.length && !loading && !failed && (
            <p className="px-3 py-4 text-sm text-text-secondary">
              {query.trim()
                ? labels.noMatchingCollaborators
                : activeTab === 'members'
                  ? labels.noAvailablePeople
                  : activeTab === 'agents'
                    ? labels.noAvailableAgents
                    : labels.noAvailableGroups}
            </p>
          )}
          {!options.length && !loading && !failed && (
            <p className="px-3 pb-4 text-xs text-text-secondary">
              {activeTab === 'members' && !query.trim() && searchUsers
                ? labels.searchPeopleHint
                : labels.collaboratorsOptionalHint}
            </p>
          )}
        </>
      }
      renderOptions={list => (
        <CollaborationParticipantsTabs
          ariaLabel={labels.collaborators}
          initialTab="members"
          onTabChange={setActiveTab}
          tabOrder={['members', 'agents', 'groups']}
          testIdPrefix="collaboration-project-create-collaborator"
          membersLabel={labels.availablePeople}
          agentsLabel={labels.availableAgents}
          groupsLabel={labels.availableGroups}
          membersContent={list}
          agentsContent={list}
          groupsContent={list}
        />
      )}
      onChange={value => {
        const separator = value.indexOf(':')
        const kind = value.slice(0, separator)
        const id = value.slice(separator + 1)
        if (kind === 'user') {
          const user = users.find(user => String(user.id) === id)
          if (user) onSelectPerson(user)
        } else if (kind === 'agent') onSelectAgent(id)
        else if (kind === 'group') onSelectGroup(id)
      }}
    />
  )
}
