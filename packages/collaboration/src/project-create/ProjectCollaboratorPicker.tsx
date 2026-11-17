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
  agentsError,
  groupsError,
  searchUsers,
  directoryLoading = false,
  directoryError,
  onRetryDirectory,
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
  agentsError?: string | null
  groupsError?: string | null
  searchUsers?: ProjectCreateResourceSetup['searchUsers']
  directoryLoading?: boolean
  directoryError?: string | null
  onRetryDirectory?(): void
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
    error?: string
    attempt: number
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const current =
    response?.query === query &&
    response.searchUsers === searchUsers &&
    response.attempt === attempt
  const loading = Boolean(query.trim() && searchUsers && !current)
  const error = directoryError || (current ? response.error : undefined)
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
        onResults: users => setResponse({ query, searchUsers, users, attempt }),
        onError: cause =>
          setResponse({
            query,
            searchUsers,
            users: [],
            attempt,
            error:
              cause instanceof Error && cause.message
                ? `${labels.peopleSearchFailed} ${cause.message}`
                : labels.peopleSearchFailed,
          }),
      })
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [open, activeTab, query, searchUsers, attempt, labels.peopleSearchFailed])
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
    !open || activeTab !== 'members' || error
      ? ''
      : loading || directoryLoading
        ? labels.searchingPeople
        : !query.trim()
          ? ''
          : users.length
            ? `${labels.availablePeople}: ${users.length}`
            : labels.noMatchingCollaborators
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
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const modalContainer = trigger?.closest<HTMLElement>(
    '[role="dialog"][aria-modal="true"], dialog[open]'
  )
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          ref={setTrigger}
          type="button"
          className="collaboration-project-create-collaborator-trigger"
          data-testid="collaboration-project-create-add-collaborator"
          aria-expanded={open}
        >
          <Plus aria-hidden="true" />
          <span>{labels.addCollaborator}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal container={modalContainer}>
        <Popover.Content
          {...theme}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionBoundary={trigger?.closest('.collaboration-project-create-body')}
          collisionPadding={8}
          className={`${theme.className ?? ''} collaboration-project-create-collaborator-menu`}
          data-testid="collaboration-project-create-collaborator-menu"
          aria-label={labels.addCollaborator}
          onCloseAutoFocus={event => {
            if (trigger?.closest('[hidden], [inert]')) event.preventDefault()
          }}
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
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
              data-testid="collaboration-project-create-people-search-status"
            >
              {peopleSearchStatus}
            </p>
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
                  {(loading || directoryLoading) && (
                    <p aria-hidden="true">{labels.searchingPeople}</p>
                  )}
                  {error && <p role="alert">{directoryError || labels.peopleSearchFailed}</p>}
                  {!directoryError && error && error !== labels.peopleSearchFailed && (
                    <p>{error}</p>
                  )}
                  {error && (directoryError ? onRetryDirectory : searchUsers) ? (
                    <button
                      type="button"
                      data-testid="collaboration-project-create-member-search-retry"
                      onClick={() => {
                        if (directoryError) onRetryDirectory?.()
                        else setAttempt(value => value + 1)
                      }}
                    >
                      {labels.retry}
                    </button>
                  ) : null}
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
                  {!users.length &&
                    !loading &&
                    !directoryLoading &&
                    !error &&
                    empty(labels.noAvailablePeople)}
                </>
              }
              agentsContent={
                <>
                  {agentsError && <p role="alert">{agentsError}</p>}
                  {agentsError && onRetryDirectory && (
                    <button
                      type="button"
                      data-testid="collaboration-project-create-agents-retry"
                      onClick={onRetryDirectory}
                    >
                      {labels.retry}
                    </button>
                  )}
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
                  {!availableAgents.length && !agentsError && empty(labels.noAvailableAgents)}
                </>
              }
              groupsContent={
                <>
                  {groupsError && <p role="alert">{groupsError}</p>}
                  {groupsError && onRetryDirectory && (
                    <button
                      type="button"
                      data-testid="collaboration-project-create-groups-retry"
                      onClick={onRetryDirectory}
                    >
                      {labels.retry}
                    </button>
                  )}
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
                  {!availableGroups.length && !groupsError && empty(labels.noAvailableGroups)}
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
