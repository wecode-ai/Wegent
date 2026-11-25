import { TabsList, TabsRoot, TabsTab } from '../controls/Tabs'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
import { useId, useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import { Bot, Check, CircleUserRound, Search, Users, UserRound } from 'lucide-react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { PersonalIssuesApi } from './personalIssuesApi'
import { usePersonalIssueTranslation } from './personalIssueMessages'
import { isImeComposingEvent } from '@wegent/chat-core/ime'

import {
  participantLabel,
  participantNeedsIdentifier,
  type IssueParticipant,
} from './issueParticipants'

export function IssueParticipantPicker({
  api,
  collaborationApi,
  colleaguesOnly = false,
  selected,
  onChange,
  assigneeKey,
  onAssign,
  ownerId,
  disabled,
  userId,
}: {
  api: PersonalIssuesApi
  collaborationApi?: SharedWorkspaceApi
  colleaguesOnly?: boolean
  selected: IssueParticipant[]
  onChange(people: IssueParticipant[]): void
  assigneeKey: string
  onAssign(person: IssueParticipant | null): void
  ownerId: number
  disabled: boolean
  userId: number
}) {
  const t = usePersonalIssueTranslation()
  const pickerId = useId()
  const [tab, setTab] = useState<IssueParticipant['kind']>('human')
  const [query, setQuery] = useState('')
  const searchQuery = query.trim()
  const directoryQuery = tab === 'human' ? searchQuery : ''
  const [revision, setRevision] = useState(0)
  const requestKey = JSON.stringify([tab, directoryQuery, revision])
  const resource = useMemo(
    () =>
      createAsyncResource<IssueParticipant[]>(
        requestKey,
        async (signal): Promise<IssueParticipant[]> => {
          await Promise.resolve()
          signal.throwIfAborted()
          if (tab === 'human') {
            if (!directoryQuery) return []
            const page = await api.searchUsers(directoryQuery)
            return page.users.map(user => ({
              key: `human:${user.id}`,
              kind: 'human',
              id: user.id,
              name: user.user_name,
            }))
          }
          if (!collaborationApi) return []
          if (tab === 'agent') {
            const resources = await collaborationApi.resources?.list()
            return (resources?.agents ?? [])
              .filter(
                agent =>
                  agent.location !== 'local' &&
                  agent.owner_type === 'user' &&
                  Number(agent.owner_id) === userId
              )
              .map(agent => ({
                key: `agent:${agent.id}`,
                kind: 'agent' as const,
                id: Number(agent.id),
                name: agent.name,
              }))
              .filter(agent => Number.isSafeInteger(agent.id) && agent.id > 0)
          }
          const spaces = (await collaborationApi.workspaces?.list()) ?? []
          const groups = await Promise.all(
            spaces
              .filter(space => space.location === 'cloud')
              .map(space => collaborationApi.workspaces!.listCollaborationGroups(space.id))
          )
          return [
            ...new Map(
              groups.flat().map(group => [
                group.id,
                {
                  key: `group:${group.id}`,
                  kind: 'group' as const,
                  id: Number(group.id),
                  name: group.name,
                },
              ])
            ).values(),
          ]
        },
        { delayMs: tab === 'human' ? 200 : 0, refreshOnSubscribe: true }
      ),
    [api, collaborationApi, directoryQuery, tab, userId, requestKey]
  )
  const response = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const results = response.data ?? []
  const error =
    response.status === 'error'
      ? response.error instanceof Error
        ? response.error.message
        : String(response.error)
      : ''
  const busy = !response.settled
  const icon = (kind: IssueParticipant['kind']) =>
    kind === 'agent' ? Bot : kind === 'group' ? Users : UserRound
  const candidates = results.filter(
    person =>
      participantLabel(person, results)
        .toLocaleLowerCase()
        .includes(searchQuery.toLocaleLowerCase()) && person.key !== `human:${userId}`
  )
  const unselected = candidates.filter(person => !selected.some(item => item.key === person.key))
  const known = [...selected, ...results]
  const candidateWithIdentity = (person: IssueParticipant) =>
    participantNeedsIdentifier(person, known, userId)
      ? { ...person, needsIdentifier: true }
      : person
  const personRow = (person: IssueParticipant, checked: boolean) => {
    const owner = person.key === `human:${ownerId}`
    const responsible = person.key === assigneeKey
    const label = participantLabel(person, known, { id: userId, name: t('personalHome.me') })
    const identified = participantNeedsIdentifier(person, known, userId)
    const Icon = icon(person.kind)
    return (
      <li key={person.key} className="flex min-w-0 items-center rounded-md hover:bg-muted/50">
        <ControlButton
          variant="unstyled"
          type="button"
          disabled={disabled || owner}
          aria-pressed={checked}
          data-testid={
            owner && ownerId === userId
              ? 'issue-participant-self'
              : checked
                ? `issue-participant-remove-${person.key}`
                : person.kind === 'human'
                  ? `independent-issue-invite-${person.id}`
                  : `issue-participant-invite-${person.key}`
          }
          aria-label={
            checked && !owner ? t('independentIssues.removePerson', { name: label }) : label
          }
          onClick={() =>
            onChange(
              checked
                ? selected.filter(item => item.key !== person.key)
                : [...selected, candidateWithIdentity(person)]
            )
          }
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm md:min-h-8"
        >
          <Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{identified ? person.name : label}</span>
          {identified && <span className="shrink-0 text-text-secondary"> · #{person.id}</span>}
          {checked && <Check className="size-4 shrink-0" aria-hidden="true" />}
        </ControlButton>
        {checked && (
          <ControlButton
            variant="unstyled"
            type="button"
            disabled={disabled}
            aria-pressed={responsible}
            aria-label={t(responsible ? 'taskIssueShare.assignee' : 'taskIssueShare.assignPerson', {
              name: label,
            })}
            title={t(responsible ? 'taskIssueShare.assignee' : 'taskIssueShare.assignPerson', {
              name: label,
            })}
            data-testid={`issue-participant-assignee-${person.key}`}
            onClick={() => onAssign(responsible ? null : person)}
            className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-md text-text-muted hover:bg-muted aria-pressed:text-text-primary md:min-h-8 md:min-w-8"
          >
            <CircleUserRound
              className={`size-4 ${responsible ? 'rounded-full bg-text-primary text-background' : ''}`}
              aria-hidden="true"
            />
          </ControlButton>
        )}
      </li>
    )
  }
  const statusMessage = error
    ? ''
    : busy
      ? t('issue_creation.participants_loading')
      : candidates.length
        ? t('issue_creation.participant_results', { count: candidates.length })
        : tab === 'human' && !searchQuery
          ? ''
          : t('issue_creation.no_participants')
  return (
    <section
      data-testid="issue-participants"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"
      aria-label={t('independentIssues.participants')}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        {!colleaguesOnly && (
          <TabsRoot
            value={tab}
            onValueChange={kind => {
              if (kind !== 'human' && kind !== 'agent' && kind !== 'group') return
              setTab(kind)
              setQuery('')
            }}
          >
            <TabsList appearance="surface" aria-label={t('issue_creation.participant_type')}>
              {(['human', 'agent', 'group'] as const).map(kind => (
                <TabsTab
                  key={kind}
                  value={kind}
                  appearance="surface"
                  disabled={disabled}
                  id={`${pickerId}-${kind}-tab`}
                  data-testid={`issue-participant-tab-${kind}`}
                  className="min-h-11 rounded-md px-3 text-sm aria-selected:bg-muted md:min-h-8"
                >
                  {t(`issue_creation.participant_${kind}`)}
                </TabsTab>
              ))}
            </TabsList>
          </TabsRoot>
        )}
        <label className="issue-participant-search flex min-w-0 items-center gap-2 rounded-md border border-border px-2 keyboard:focus-within:border-focus keyboard:focus-within:ring-1 keyboard:focus-within:ring-focus">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <ControlInput
            appearance="plain"
            disabled={disabled}
            value={query}
            data-testid="independent-issue-search-people"
            aria-label={t('issue_creation.search_participants')}
            aria-describedby={`${pickerId}-status`}
            placeholder={t('issue_creation.search_participants')}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (isImeComposingEvent(event)) {
                event.stopPropagation()
                return
              }
              if (event.key === 'Enter') event.preventDefault()
            }}
            className="min-h-11 min-w-0 flex-1 bg-transparent text-base placeholder:text-text-secondary md:min-h-8"
          />
        </label>
        {selected.length > 0 && <ul>{selected.map(person => personRow(person, true))}</ul>}
        <div
          id={`${pickerId}-panel`}
          role={colleaguesOnly ? undefined : 'tabpanel'}
          aria-labelledby={colleaguesOnly ? undefined : `${pickerId}-${tab}-tab`}
          className="max-h-48 overflow-y-auto"
        >
          {error && (
            <div role="alert" className="text-sm text-destructive">
              {t('issue_creation.participants_load_failed')}
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="issue-participant-retry"
                onClick={() => setRevision(v => v + 1)}
                className="ml-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md underline md:min-h-8"
              >
                {t('independentIssues.retry')}
              </ControlButton>
            </div>
          )}
          <p
            id={`${pickerId}-status`}
            data-testid="issue-participant-results-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={
              statusMessage && (busy || (!error && !candidates.length))
                ? 'py-2 text-sm text-text-secondary'
                : 'sr-only'
            }
          >
            {statusMessage}
          </p>
          {!error && !busy && unselected.length > 1 && (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="issue-participants-select-results"
              disabled={disabled}
              onClick={() => onChange([...selected, ...unselected.map(candidateWithIdentity)])}
              className="min-h-11 rounded-md px-2 text-sm text-text-secondary hover:bg-muted md:min-h-8"
            >
              {t('taskIssueShare.selectParticipants', { count: unselected.length })}
            </ControlButton>
          )}
          {!error && !busy && <ul>{unselected.map(person => personRow(person, false))}</ul>}
        </div>
      </div>
    </section>
  )
}
