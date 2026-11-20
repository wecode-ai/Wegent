import type { PersonalIssuesApi } from '@/api/personalIssues'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { ParticipantField, ParticipantToken } from '@wegent/collaboration/controls'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { TabsList, TabsPanel, TabsRoot, TabsTab } from '@wegent/collaboration/controls/Tabs'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Bot, Plus, UserRound, Users } from 'lucide-react'
import { useId, useMemo, useState, useSyncExternalStore } from 'react'

import {
  participantLabel,
  participantNeedsIdentifier,
  type IssueParticipant,
} from './issueParticipants'

export function IssueParticipantPicker({
  api,
  collaborationApi,
  selected,
  onChange,
  disabled,
  userId,
}: {
  api: PersonalIssuesApi
  collaborationApi?: SharedWorkspaceApi
  selected: IssueParticipant[]
  onChange(people: IssueParticipant[]): void
  disabled: boolean
  userId: number
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
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
  const options =
    !busy && !error
      ? candidates.map(person => {
          const Icon = icon(person.kind)
          const label = participantLabel(person, results)
          return {
            value: person.key,
            label,
            searchText: person.name,
            testId:
              person.kind === 'human'
                ? `independent-issue-invite-${person.id}`
                : `issue-participant-invite-${person.key}`,
            icon: <Icon aria-hidden="true" className="h-4 w-4" />,
          }
        })
      : []
  return (
    <section
      data-testid="issue-participants"
      className="grid gap-2"
      aria-label={t('independentIssues.participants')}
    >
      <span className="text-sm text-text-secondary">{t('independentIssues.participants')}</span>
      <ParticipantField>
        {selected.map(person => {
          const Icon = icon(person.kind)
          const label = participantLabel(person, [...selected, ...results], {
            id: userId,
            name: t('personalHome.me'),
          })
          const identity = `${label} · ${t(`issue_creation.participant_${person.kind}`)}`
          const identified = participantNeedsIdentifier(person, [...selected, ...results], userId)
          return (
            <ParticipantToken
              key={person.key}
              title={identity}
              icon={<Icon aria-hidden="true" />}
              label={identified ? person.name : label}
              description={identified ? `· #${person.id}` : undefined}
              disabled={disabled}
              removeTestId={`issue-participant-remove-${person.key}`}
              removeLabel={t('independentIssues.removePerson', { name: identity })}
              onRemove={
                person.key === `human:${userId}`
                  ? undefined
                  : () => onChange(selected.filter(item => item.key !== person.key))
              }
            />
          )
        })}
        <TabsRoot
          className="min-w-0 max-w-full"
          value={tab}
          onValueChange={next => {
            if (next) {
              setTab(next)
              setQuery('')
            }
          }}
        >
          <SearchableSelect
            appearance="property"
            density="dense"
            header={
              <TabsList aria-label={t('issue_creation.participant_type')} className="mb-2">
                {(['human', 'agent', 'group'] as const).map(kind => (
                  <TabsTab
                    value={kind}
                    key={kind}
                    disabled={disabled}
                    data-testid={`issue-participant-tab-${kind}`}
                    className="min-w-0 flex-1 truncate px-2"
                  >
                    {t(`issue_creation.participant_${kind}`)}
                  </TabsTab>
                ))}
              </TabsList>
            }
            multiple
            value={selected.map(person => person.key)}
            options={options}
            disabled={disabled}
            filter={false}
            query={query}
            onSearchChange={setQuery}
            open={open}
            onOpenChange={setOpen}
            searchDescriptionId={`${pickerId}-status`}
            testId="issue-participant-add"
            menuTestId="issue-participant-picker"
            searchTestId="independent-issue-search-people"
            accessibleLabel={t('issue_creation.add_participants')}
            searchPlaceholder={t('issue_creation.search_participants')}
            emptyLabel={t('issue_creation.no_participants')}
            triggerContent={
              <>
                <Plus aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 truncate">{t('issue_creation.add_participants')}</span>
              </>
            }
            searchStatus={
              <>
                <p
                  id={`${pickerId}-status`}
                  data-testid="issue-participant-results-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className={
                    busy || (!error && !candidates.length)
                      ? 'px-2.5 py-3 text-sm text-text-secondary'
                      : 'sr-only'
                  }
                >
                  {statusMessage}
                </p>
                {error && (
                  <div
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2 text-sm text-destructive"
                  >
                    {t('issue_creation.participants_load_failed')}
                    <ControlButton
                      variant="outline"
                      size="sm"
                      type="button"
                      data-testid="issue-participant-retry"
                      onClick={() => setRevision(v => v + 1)}
                    >
                      {t('independentIssues.retry')}
                    </ControlButton>
                  </div>
                )}
              </>
            }
            renderOptions={list =>
              (['human', 'agent', 'group'] as const).map(kind => (
                <TabsPanel className="flex min-h-0 flex-col" key={kind} value={kind}>
                  {tab === kind ? list : null}
                </TabsPanel>
              ))
            }
            footer={
              <div className="flex justify-end">
                <ControlButton
                  variant="outline"
                  size="sm"
                  type="button"
                  data-testid="issue-participant-done"
                  onClick={() => setOpen(false)}
                >
                  {t('issue_creation.participant_done')}
                </ControlButton>
              </div>
            }
            onChange={next => {
              const candidateKeys = new Set(candidates.map(person => person.key))
              const retained = selected.filter(
                person => !candidateKeys.has(person.key) || next.includes(person.key)
              )
              const added = candidates
                .filter(
                  person =>
                    next.includes(person.key) &&
                    !selected.some(current => current.key === person.key)
                )
                .map(person =>
                  participantNeedsIdentifier(person, results, userId)
                    ? { ...person, needsIdentifier: true }
                    : person
                )
              onChange([...retained, ...added])
            }}
          />
        </TabsRoot>
      </ParticipantField>
    </section>
  )
}
