import * as Popover from '@radix-ui/react-popover'
import { Bot, Plus, Search, UserRound, UsersRound } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  CollaborationParticipantsTabs,
  type ParticipantTab,
} from '../project-manage/ProjectCollaborationParticipants'
import { runActiveMemberSearch } from '../project-manage/memberSearch'
import { useCollaborationPortalTheme } from '../theme'
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
  const theme = useCollaborationPortalTheme()
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
  const empty = (message: string) => (
    <div className="collaboration-project-create-collaborator-empty">
      <p>{query.trim() ? labels.noMatchingCollaborators : message}</p>
      <p>
        {activeTab === 'members' && !query.trim() && searchUsers
          ? labels.searchPeopleHint
          : labels.collaboratorsOptionalHint}
      </p>
    </div>
  )
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="collaboration-project-create-collaborator-trigger"
          data-testid="collaboration-project-create-add-collaborator"
          aria-expanded={open}
        >
          <Plus aria-hidden="true" />
          <span>{labels.addCollaborator}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...theme}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={`${theme.className ?? ''} collaboration-project-create-collaborator-menu`}
          data-testid="collaboration-project-create-collaborator-menu"
        >
          <div className="collaboration-project-collaborator-picker">
            <label className="collaboration-project-collaborator-search">
              <Search aria-hidden="true" />
              <input
                data-testid="collaboration-project-create-people-search"
                value={query}
                aria-label={labels.searchCollaborators}
                placeholder={labels.searchCollaborators}
                onChange={event => setQuery(event.target.value)}
              />
            </label>
            <CollaborationParticipantsTabs
              ariaLabel={labels.collaborators}
              initialTab="members"
              onTabChange={setActiveTab}
              tabOrder={['members', 'agents', 'groups']}
              testIdPrefix="collaboration-project-create-collaborator"
              membersLabel={labels.availablePeople}
              agentsLabel={labels.availableAgents}
              groupsLabel={labels.availableGroups}
              membersContent={
                <>
                  {loading && <p role="status">{labels.searchingPeople}</p>}
                  {failed && <p role="alert">{labels.peopleSearchFailed}</p>}
                  {users.map(user => (
                    <button
                      key={user.id}
                      type="button"
                      data-testid={`collaboration-project-create-member-${user.id}`}
                      onClick={() => onSelectPerson(user)}
                    >
                      <UserRound aria-hidden="true" />
                      <span>
                        <strong>{user.user_name}</strong>
                        {user.email && <small>{user.email}</small>}
                      </span>
                    </button>
                  ))}
                  {!users.length && !loading && !failed && empty(labels.noAvailablePeople)}
                </>
              }
              agentsContent={
                <>
                  {availableAgents.map(agent => (
                    <button
                      key={agent.id}
                      type="button"
                      data-testid={`collaboration-project-create-agent-${agent.id}`}
                      onClick={() => onSelectAgent(agent.id)}
                    >
                      <Bot aria-hidden="true" />
                      <span>
                        <strong>{agent.name}</strong>
                      </span>
                    </button>
                  ))}
                  {!availableAgents.length && empty(labels.noAvailableAgents)}
                </>
              }
              groupsContent={
                <>
                  {availableGroups.map(group => (
                    <button
                      key={group.id}
                      type="button"
                      data-testid={`collaboration-project-create-group-${group.id}`}
                      onClick={() => onSelectGroup(group.id)}
                    >
                      <UsersRound aria-hidden="true" />
                      <span>
                        <strong>{group.name}</strong>
                        <small>{labels.importGroupDescription}</small>
                      </span>
                    </button>
                  ))}
                  {!availableGroups.length && empty(labels.noAvailableGroups)}
                  {groupAction}
                </>
              }
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
