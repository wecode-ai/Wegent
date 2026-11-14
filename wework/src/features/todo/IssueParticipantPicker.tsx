import { useEffect, useRef, useState } from 'react'
import { Bot, Check, Plus, Search, Users, UserRound, X } from 'lucide-react'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { useTranslation } from '@/hooks/useTranslation'

import type { IssueParticipant } from './issueParticipants'

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
  const [tab, setTab] = useState<IssueParticipant['kind']>('human')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const requestKey = JSON.stringify([tab, query, revision])
  const [response, setResponse] = useState<{
    key: string
    api?: PersonalIssuesApi
    collaborationApi?: SharedWorkspaceApi
    userId?: number
    items: IssueParticipant[]
    error: string
  }>({ key: '', items: [], error: '' })
  const currentResponse =
    response.key === requestKey &&
    response.api === api &&
    response.collaborationApi === collaborationApi &&
    response.userId === userId
  const results = currentResponse ? response.items : []
  const error = currentResponse ? response.error : ''
  const busy = open && !currentResponse
  const generation = useRef(0)
  useEffect(() => {
    if (!open) return
    const current = ++generation.current
    const timer = setTimeout(
      () => {
        const load = async (): Promise<IssueParticipant[]> => {
          if (tab === 'human') {
            if (!query.trim()) return []
            const page = await api.searchUsers(query.trim())
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
        }
        void load().then(
          rows => {
            if (current === generation.current)
              setResponse({
                key: requestKey,
                api,
                collaborationApi,
                userId,
                items: rows,
                error: '',
              })
          },
          reason => {
            if (current === generation.current)
              setResponse({
                key: requestKey,
                api,
                collaborationApi,
                userId,
                items: [],
                error: reason instanceof Error ? reason.message : String(reason),
              })
          }
        )
      },
      tab === 'human' ? 200 : 0
    )
    return () => {
      clearTimeout(timer)
      generation.current = current + 1
    }
  }, [api, collaborationApi, open, query, revision, tab, userId, requestKey])
  const icon = (kind: IssueParticipant['kind']) =>
    kind === 'agent' ? Bot : kind === 'group' ? Users : UserRound
  const candidates = results.filter(
    person =>
      person.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
      person.key !== `human:${userId}`
  )
  return (
    <section className="grid gap-2" aria-label={t('independentIssues.participants')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm text-text-secondary">
          {t('independentIssues.participants')}
        </span>
        {selected.map(person => {
          const Icon = icon(person.kind)
          return (
            <span
              key={person.key}
              className="inline-flex items-center gap-1 rounded-md bg-muted pl-2 text-sm"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{person.name}</span>
              {person.key !== `human:${userId}` && (
                <button
                  type="button"
                  disabled={disabled}
                  data-testid={`issue-participant-remove-${person.key}`}
                  aria-label={t('independentIssues.removePerson', { name: person.name })}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-background md:min-h-7 md:min-w-7"
                  onClick={() => onChange(selected.filter(item => item.key !== person.key))}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          )
        })}
        <button
          type="button"
          data-testid="issue-participant-add"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted md:min-h-7"
        >
          <Plus className="h-4 w-4" />
          {t('issue_creation.add_participants')}
        </button>
      </div>
      {open && (
        <div
          className="grid gap-2 rounded-lg border border-border p-3"
          data-testid="issue-participant-picker"
        >
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
                data-testid={`issue-participant-tab-${kind}`}
                key={kind}
                onClick={() => {
                  setTab(kind)
                  setQuery('')
                }}
                className={`min-h-11 rounded-md px-3 text-sm md:min-h-8 ${kind === tab ? 'bg-muted font-medium' : 'text-text-secondary hover:bg-muted'}`}
              >
                {t(`issue_creation.participant_${kind}`)}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 rounded-md border border-border px-2">
            <Search className="h-4 w-4 text-text-muted" />
            <input
              autoFocus
              value={query}
              data-testid="independent-issue-search-people"
              aria-label={t('issue_creation.search_participants')}
              placeholder={t('issue_creation.search_participants')}
              onChange={event => setQuery(event.target.value)}
              className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none md:min-h-8"
            />
          </label>
          {error ? (
            <div role="alert" className="text-sm text-error">
              {error}
              <button
                type="button"
                data-testid="issue-participant-retry"
                onClick={() => setRevision(v => v + 1)}
                className="ml-2 underline"
              >
                {t('independentIssues.retry')}
              </button>
            </div>
          ) : busy ? (
            <p role="status" className="text-sm text-text-muted">
              {t('independentIssues.loading')}
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {candidates.map(person => {
                const checked = selected.some(item => item.key === person.key)
                const Icon = icon(person.kind)
                return (
                  <button
                    type="button"
                    key={person.key}
                    data-testid={
                      person.kind === 'human'
                        ? `independent-issue-invite-${person.id}`
                        : `issue-participant-invite-${person.key}`
                    }
                    aria-pressed={checked}
                    onClick={() =>
                      onChange(
                        checked
                          ? selected.filter(item => item.key !== person.key)
                          : [...selected, person]
                      )
                    }
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted md:min-h-8"
                  >
                    <Icon className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate">{person.name}</span>
                    {checked && <Check className="h-4 w-4" />}
                  </button>
                )
              })}
              {!candidates.length && (
                <p className="py-2 text-sm text-text-muted">
                  {t(
                    tab === 'human' && !query.trim()
                      ? 'issue_creation.search_people_hint'
                      : 'issue_creation.no_participants'
                  )}
                </p>
              )}
            </div>
          )}
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
        </div>
      )}
    </section>
  )
}
