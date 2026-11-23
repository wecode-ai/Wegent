import { Button as ControlButton } from '../markdown/Button'
import { TextField as ControlInput } from '../controls/TextField'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { selectionTriggerClasses } from '../controls/recipes'
import { Popover, PopoverTrigger, PopoverContent } from '../controls/Popover'
import { Bot, Plus, Search, UserRound, UsersRound } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  CollaborationParticipantsTabs,
  type ParticipantTab,
} from '../project-manage/ProjectCollaborationParticipants'
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
  const [previousOpen, setPreviousOpen] = useState(open)
  if (previousOpen !== open) {
    setPreviousOpen(open)
    if (!open) {
      setQuery('')
      setActiveTab('members')
    }
  }
  const resource = useMemo(
    () =>
      query.trim() && searchUsers
        ? createAsyncResource(
            query,
            async () => {
              try {
                return {
                  users: await searchUsers(query.trim()),
                  failed: false,
                }
              } catch {
                return { users: [] as CollaborationUser[], failed: true }
              }
            },
            { delayMs: 180, refreshOnSubscribe: true }
          )
        : null,
    [query, searchUsers]
  )
  const snapshot = useSyncExternalStore(
    open && activeTab === 'members' && resource ? resource.subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const response = snapshot.data
  const current = response !== undefined
  const loading = Boolean(query.trim() && searchUsers && !snapshot.settled)
  const failed = current && response.failed
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
  const focusSearch = useCallback((input: HTMLInputElement | null) => {
    input?.focus({ preventScroll: true })
  }, [])
  const modalContainer = trigger?.closest<HTMLElement>(
    '[role="dialog"][aria-modal="true"], dialog[open]'
  )
  // Resolve the owning portal before a pre-opened picker can bind its search field.
  return (
    <Popover
      open={open && trigger !== null}
      onOpenChange={(next, detail) => {
        onOpenChange(next)
        if (!next && detail.reason === 'escape-key' && !trigger?.closest('[hidden], [inert]'))
          trigger?.focus({ preventScroll: true })
      }}
    >
      <PopoverTrigger
        render={
          <button
            ref={setTrigger}
            type="button"
            className={selectionTriggerClasses('property', 'dense')}
            data-testid="collaboration-project-create-add-collaborator"
            aria-expanded={open}
          />
        }
      >
        <Plus aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
        <span>{labels.addCollaborator}</span>
      </PopoverTrigger>
      <PopoverContent
        {...theme}
        container={modalContainer}
        anchor={trigger?.closest<HTMLElement>('[data-participant-field]') ?? trigger}
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={`${theme.className ?? ''} collaboration-project-create-collaborator-menu`}
        data-testid="collaboration-project-create-collaborator-menu"
        aria-label={labels.addCollaborator}
        finalFocus="none"
      >
        <div className="collaboration-project-collaborator-picker">
          <label className="collaboration-project-collaborator-search">
            <Search aria-hidden="true" />
            <ControlInput
              ref={focusSearch}
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
            className="collaboration-project-collaborator-tabs"
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
                {loading && <p aria-hidden="true">{labels.searchingPeople}</p>}
                {failed && <p role="alert">{labels.peopleSearchFailed}</p>}
                {users.map(user => (
                  <ControlButton
                    variant="unstyled"
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
                  </ControlButton>
                ))}
                {!users.length && !loading && !failed && empty(labels.noAvailablePeople)}
              </>
            }
            agentsContent={
              <>
                {availableAgents.map(agent => (
                  <ControlButton
                    variant="unstyled"
                    key={agent.id}
                    type="button"
                    data-testid={`collaboration-project-create-agent-${agent.id}`}
                    onClick={() => onSelectAgent(agent.id)}
                  >
                    <Bot aria-hidden="true" />
                    <span>
                      <strong>{agent.name}</strong>
                    </span>
                  </ControlButton>
                ))}
                {!availableAgents.length && empty(labels.noAvailableAgents)}
              </>
            }
            groupsContent={
              <>
                {availableGroups.map(group => (
                  <ControlButton
                    variant="unstyled"
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
                  </ControlButton>
                ))}
                {!availableGroups.length && empty(labels.noAvailableGroups)}
                {groupAction}
              </>
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
