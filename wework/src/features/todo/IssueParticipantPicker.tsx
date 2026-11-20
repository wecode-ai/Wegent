import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import * as Popover from '@radix-ui/react-popover'
import { Bot, Check, Plus, Search, Users, UserRound, X } from 'lucide-react'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { useTranslation } from '@/hooks/useTranslation'
import { useEscapeKey } from '@/hooks/useEscapeKey'
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
  disabled,
  userId,
}: {
  api: PersonalIssuesApi
  collaborationApi?: SharedWorkspaceApi
  colleaguesOnly?: boolean
  selected: IssueParticipant[]
  onChange(people: IssueParticipant[]): void
  disabled: boolean
  userId: number
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  useEscapeKey(() => setOpen(false), open, popoverRef)
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
    open ? resource.subscribe : subscribeIdleResource,
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
  const busy = open && !response.settled
  const icon = (kind: IssueParticipant['kind']) =>
    kind === 'agent' ? Bot : kind === 'group' ? Users : UserRound
  const candidates = results.filter(
    person =>
      participantLabel(person, results)
        .toLocaleLowerCase()
        .includes(searchQuery.toLocaleLowerCase()) && person.key !== `human:${userId}`
  )
  const statusMessage = error
    ? ''
    : busy
      ? t('issue_creation.participants_loading')
      : candidates.length
        ? t('issue_creation.participant_results', { count: candidates.length })
        : t(
            tab === 'human' && !searchQuery
              ? 'issue_creation.search_people_hint'
              : 'issue_creation.no_participants'
          )
  return (
    <Popover.Root modal open={open} onOpenChange={setOpen}>
      <section
        data-testid="issue-participants"
        className="grid gap-2"
        aria-label={t('independentIssues.participants')}
      >
        <div className="flex flex-wrap items-center gap-2">
          {!colleaguesOnly && (
            <span className="mr-1 text-sm text-text-secondary">
              {t('independentIssues.participants')}
            </span>
          )}
          {(colleaguesOnly
            ? selected.filter(person => person.key !== `human:${userId}`)
            : selected
          ).map(person => {
            const Icon = icon(person.kind)
            const label = participantLabel(person, [...selected, ...results], {
              id: userId,
              name: t('personalHome.me'),
            })
            const identity = `${label} · ${t(`issue_creation.participant_${person.kind}`)}`
            const identified = participantNeedsIdentifier(person, [...selected, ...results], userId)
            return (
              <span
                key={person.key}
                title={identity}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted pl-2 text-sm"
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{identified ? person.name : label}</span>
                {identified && (
                  <span className="shrink-0 text-text-secondary"> · #{person.id}</span>
                )}
                {person.key !== `human:${userId}` && (
                  <button
                    type="button"
                    disabled={disabled}
                    data-testid={`issue-participant-remove-${person.key}`}
                    aria-label={t('independentIssues.removePerson', { name: identity })}
                    className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md hover:bg-background md:min-h-7 md:min-w-7"
                    onClick={() => onChange(selected.filter(item => item.key !== person.key))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            )
          })}
          <Popover.Trigger asChild>
            <button
              type="button"
              data-testid="issue-participant-add"
              disabled={disabled}
              aria-expanded={open}
              className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted md:min-h-7"
            >
              <Plus className="h-4 w-4" />
              {t(
                colleaguesOnly ? 'taskIssueShare.addColleagues' : 'issue_creation.add_participants'
              )}
            </button>
          </Popover.Trigger>
        </div>
        <Popover.Portal>
          <Popover.Content
            ref={popoverRef}
            aria-label={t(
              colleaguesOnly ? 'taskIssueShare.addColleagues' : 'issue_creation.add_participants'
            )}
            align="start"
            sideOffset={6}
            collisionPadding={8}
            onOpenAutoFocus={event => {
              event.preventDefault()
              searchRef.current?.focus()
            }}
            onEscapeKeyDown={event => {
              event.preventDefault()
              event.stopPropagation()
              if (!isImeComposingEvent(event)) setOpen(false)
            }}
            className="z-system-popover grid max-h-[var(--radix-popover-content-available-height)] w-[min(374px,calc(100vw-16px))] gap-2 overflow-y-auto rounded-xl border border-border bg-popover p-3 text-text-primary shadow-lg"
            data-testid="issue-participant-picker"
          >
            {!colleaguesOnly && (
              <div
                role="tablist"
                aria-label={t('issue_creation.participant_type')}
                className="flex gap-1"
              >
                {(['human', 'agent', 'group'] as const).map(kind => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={kind === tab}
                    id={`${pickerId}-${kind}-tab`}
                    aria-controls={`${pickerId}-panel`}
                    tabIndex={kind === tab ? 0 : -1}
                    disabled={disabled}
                    data-testid={`issue-participant-tab-${kind}`}
                    key={kind}
                    onClick={() => {
                      setTab(kind)
                      setQuery('')
                    }}
                    onKeyDown={event => {
                      const kinds = ['human', 'agent', 'group'] as const
                      const index = kinds.indexOf(kind)
                      const next =
                        event.key === 'ArrowRight'
                          ? kinds[(index + 1) % kinds.length]
                          : event.key === 'ArrowLeft'
                            ? kinds[(index + kinds.length - 1) % kinds.length]
                            : event.key === 'Home'
                              ? kinds[0]
                              : event.key === 'End'
                                ? kinds[2]
                                : null
                      if (!next) return
                      event.preventDefault()
                      setTab(next)
                      setQuery('')
                      document.getElementById(`${pickerId}-${next}-tab`)?.focus()
                    }}
                    className={`min-h-11 rounded-md px-3 text-sm md:min-h-8 ${kind === tab ? 'bg-muted font-medium' : 'text-text-secondary hover:bg-muted'}`}
                  >
                    {t(`issue_creation.participant_${kind}`)}
                  </button>
                ))}
              </div>
            )}
            <label className="flex items-center gap-2 rounded-md border border-border px-2">
              <Search className="h-4 w-4 text-text-muted" />
              <input
                ref={searchRef}
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
                className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-text-secondary md:min-h-8"
              />
            </label>
            <div
              id={`${pickerId}-panel`}
              role={colleaguesOnly ? undefined : 'tabpanel'}
              aria-labelledby={colleaguesOnly ? undefined : `${pickerId}-${tab}-tab`}
              className="max-h-48 overflow-y-auto"
            >
              {error && (
                <div role="alert" className="text-sm text-destructive">
                  {t('issue_creation.participants_load_failed')}
                  <button
                    type="button"
                    data-testid="issue-participant-retry"
                    onClick={() => setRevision(v => v + 1)}
                    className="ml-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md underline md:min-h-8"
                  >
                    {t('independentIssues.retry')}
                  </button>
                </div>
              )}
              <p
                id={`${pickerId}-status`}
                data-testid="issue-participant-results-status"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className={
                  busy || (!error && !candidates.length)
                    ? 'py-2 text-sm text-text-secondary'
                    : 'sr-only'
                }
              >
                {statusMessage}
              </p>
              {!error &&
                !busy &&
                candidates.map(person => {
                  const checked = selected.some(item => item.key === person.key)
                  const Icon = icon(person.kind)
                  const label = participantLabel(person, results)
                  const identified = participantNeedsIdentifier(person, results, userId)
                  return (
                    <button
                      type="button"
                      disabled={disabled}
                      key={person.key}
                      data-testid={
                        person.kind === 'human'
                          ? `independent-issue-invite-${person.id}`
                          : `issue-participant-invite-${person.key}`
                      }
                      aria-pressed={checked}
                      title={label}
                      aria-label={`${label} · ${t(`issue_creation.participant_${person.kind}`)}`}
                      onClick={() =>
                        onChange(
                          checked
                            ? selected.filter(item => item.key !== person.key)
                            : [
                                ...selected,
                                identified ? { ...person, needsIdentifier: true } : person,
                              ]
                        )
                      }
                      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted md:min-h-8"
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{person.name}</span>
                      {identified && (
                        <span className="shrink-0 text-text-secondary"> · #{person.id}</span>
                      )}
                      {checked && <Check className="h-4 w-4" />}
                    </button>
                  )
                })}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="issue-participant-done"
                onClick={() => setOpen(false)}
                className="min-h-11 rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
              >
                {t('issue_creation.participant_done')}
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </section>
    </Popover.Root>
  )
}
