import { isImeComposingEvent } from '@wegent/chat-core/ime'
import { useRef, useState } from 'react'
import { DialogForm } from '@/components/common/DialogForm'
import { useTranslation } from '@/hooks/useTranslation'
import {
  independentIssueInput,
  type IndependentIssue,
  type IndependentIssueInput,
  type PersonalIssuesApi,
} from '@/api/personalIssues'

const control =
  'min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base text-text-primary md:min-h-8'

export function IndependentIssueEditor({
  api,
  issue,
  userId,
  busy,
  onSave,
  onCancel,
}: {
  api: PersonalIssuesApi
  issue: IndependentIssue | null
  userId: number
  busy: boolean
  onSave(input: IndependentIssueInput): Promise<void>
  onCancel(): void
}) {
  const { t } = useTranslation('common')
  const [draft, setDraft] = useState<IndependentIssueInput>(() =>
    issue
      ? independentIssueInput(issue)
      : {
          title: '',
          description: '',
          status: 'pending',
          priority: 'medium',
          assignee_id: userId,
          participants: [],
          archived: false,
          due_at: null,
        }
  )
  const [people, setPeople] = useState<Record<string, string>>(issue?.people ?? {})
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Array<{ id: number; user_name: string }>>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const searchGeneration = useRef(0)
  const owner = issue?.creator_id ?? userId
  const mayInvite = owner === userId
  const name = (id: number) => (id === userId ? t('personalHome.me') : (people[id] ?? `#${id}`))
  const set = <K extends keyof IndependentIssueInput>(key: K, value: IndependentIssueInput[K]) =>
    setDraft(previous => ({ ...previous, [key]: value }))
  const findPeople = async () => {
    const current = ++searchGeneration.current
    setSearching(true)
    setSearchError('')
    try {
      const page = await api.searchUsers(search.trim())
      if (current !== searchGeneration.current) return
      setResults(page.users)
      setPeople(previous => ({
        ...previous,
        ...Object.fromEntries(page.users.map(user => [user.id, user.user_name])),
      }))
    } catch (error) {
      if (current === searchGeneration.current)
        setSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current === searchGeneration.current) setSearching(false)
    }
  }
  const invite = (id: number) =>
    setDraft(previous => ({
      ...previous,
      participants: [...new Set([...previous.participants, id])],
    }))
  const remove = (id: number) =>
    setDraft(previous => ({
      ...previous,
      participants: previous.participants.filter(value => value !== id),
      assignee_id: previous.assignee_id === id ? null : previous.assignee_id,
    }))
  const field = (label: string, children: React.ReactNode) => (
    <label className="grid gap-2 text-sm">
      <span>{label}</span>
      {children}
    </label>
  )
  return (
    <DialogForm
      className="grid gap-5"
      onSubmit={event => {
        event.preventDefault()
        void onSave(draft)
      }}
    >
      <fieldset disabled={busy} className="grid min-w-0 gap-5">
        {field(
          t('independentIssues.title'),
          <input
            autoFocus
            data-testid="independent-issue-title"
            required
            maxLength={255}
            value={draft.title}
            onChange={event => set('title', event.target.value)}
            className={control}
          />
        )}
        {field(
          t('independentIssues.description'),
          <textarea
            data-testid="independent-issue-description"
            value={draft.description}
            onChange={event => set('description', event.target.value)}
            rows={4}
            className={control}
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {field(
            t('independentIssues.status'),
            <select
              data-testid="independent-issue-status"
              value={draft.status}
              onChange={event => set('status', event.target.value as IndependentIssue['status'])}
              className={control}
            >
              {(['pending', 'in_progress', 'completed'] as const).map(status => (
                <option key={status} value={status}>
                  {t(`independentIssues.${status}`)}
                </option>
              ))}
            </select>
          )}
          {field(
            t('independentIssues.priority'),
            <select
              data-testid="independent-issue-priority"
              value={draft.priority}
              onChange={event =>
                set('priority', event.target.value as IndependentIssue['priority'])
              }
              className={control}
            >
              {(['low', 'medium', 'high', 'urgent'] as const).map(priority => (
                <option key={priority} value={priority}>
                  {t(`independentIssues.${priority}`)}
                </option>
              ))}
            </select>
          )}
          {field(
            t('independentIssues.assignee'),
            <select
              data-testid="independent-issue-assignee"
              value={draft.assignee_id ?? ''}
              onChange={event =>
                set('assignee_id', event.target.value ? Number(event.target.value) : null)
              }
              className={control}
            >
              <option value="">{t('independentIssues.unassigned')}</option>
              {[...new Set([owner, ...draft.participants])].map(id => (
                <option key={id} value={id}>
                  {name(id)}
                </option>
              ))}
            </select>
          )}
          {field(
            t('independentIssues.due'),
            <input
              type="date"
              data-testid="independent-issue-due"
              value={draft.due_at ?? ''}
              onChange={event => set('due_at', event.target.value || null)}
              className={control}
            />
          )}
        </div>
        <section aria-label={t('independentIssues.participants')} className="grid gap-3">
          <h3 className="text-sm font-medium">{t('independentIssues.participants')}</h3>
          <p className="text-sm text-text-secondary">{t('independentIssues.privateHint')}</p>
          <div className="flex flex-wrap gap-2">
            {draft.participants.map(id => (
              <span
                key={id}
                className="inline-flex items-center gap-2 rounded-md bg-muted px-3 text-sm"
              >
                {name(id)}
                {mayInvite ? (
                  <button
                    type="button"
                    data-testid={`independent-issue-remove-person-${id}`}
                    aria-label={t('independentIssues.removePerson', { name: name(id) })}
                    className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                    onClick={() => remove(id)}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
          </div>
          {mayInvite ? (
            <>
              <div className="flex gap-2">
                <input
                  aria-label={t('independentIssues.searchPeople')}
                  data-testid="independent-issue-search-people"
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !isImeComposingEvent(event)) {
                      event.preventDefault()
                      if (search.trim() && !searching) void findPeople()
                    }
                  }}
                  value={search}
                  onChange={event => {
                    searchGeneration.current++
                    setSearching(false)
                    setResults([])
                    setSearch(event.target.value)
                  }}
                  className={control}
                  placeholder={t('independentIssues.searchPeople')}
                />
                <button
                  type="button"
                  data-testid="independent-issue-search-submit"
                  disabled={searching || !search.trim()}
                  onClick={() => void findPeople()}
                  className="min-h-11 shrink-0 rounded-md border border-border px-3 md:min-h-8"
                >
                  {t('independentIssues.search')}
                </button>
              </div>
              {searchError ? (
                <p role="alert" className="text-sm text-error">
                  {searchError}
                </p>
              ) : null}
              <div className="grid gap-1">
                {results
                  .filter(user => user.id !== owner && !draft.participants.includes(user.id))
                  .map(user => (
                    <button
                      key={user.id}
                      type="button"
                      data-testid={`independent-issue-invite-${user.id}`}
                      onClick={() => invite(user.id)}
                      className="flex min-h-11 items-center justify-between rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
                    >
                      <span>{user.user_name}</span>
                      <span>{t('independentIssues.invite')}</span>
                    </button>
                  ))}
              </div>
            </>
          ) : null}
        </section>
      </fieldset>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          data-testid="independent-issue-editor-cancel"
          onClick={onCancel}
          className="min-h-11 rounded-md border border-border px-3 md:min-h-8"
        >
          {t('independentIssues.cancel')}
        </button>
        <button
          type="submit"
          disabled={busy || !draft.title.trim()}
          data-testid="independent-issue-save"
          className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
        >
          {t(busy ? 'independentIssues.saving' : 'independentIssues.save')}
        </button>
      </div>
    </DialogForm>
  )
}
