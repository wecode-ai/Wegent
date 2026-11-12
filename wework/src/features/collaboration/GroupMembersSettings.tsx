import { useEffect, useState } from 'react'
import type { CollaborationUser, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi, ChatGroupMember } from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export function GroupMembersSettings({
  group,
  members,
  groups,
  directory,
  shared,
  onChanged,
}: {
  group: ChatGroup
  members: ChatGroupMember[]
  groups: ChatGroupApi
  directory: SharedWorkspaceApi['members']
  shared: boolean
  onChanged(): void
}) {
  const { t } = useTranslation('collaboration')
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{
    query: string
    users: CollaborationUser[]
    error: string | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const manage =
    shared && group.status === 'active' && (group.role === 'Owner' || group.role === 'Maintainer')
  const search = query.trim()
  useEffect(() => {
    if (!manage || !search) return
    let active = true
    void directory
      .searchUsers(search)
      .then(users => {
        if (active) setResult({ query: search, users, error: null })
      })
      .catch(cause => {
        if (active) setResult({ query: search, users: [], error: String(cause) })
      })
    return () => {
      active = false
    }
  }, [directory, manage, search])
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await operation()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const memberIds = new Set(members.map(member => member.user_id))
  const matches = result?.query === search ? result : null
  return (
    <section className="space-y-4" data-testid="group-members-settings">
      <h2 className="text-sm font-medium text-text-primary">
        {t('members', { count: members.length })}
      </h2>
      <ul className="divide-y divide-border">
        {members.map(member => {
          const editable =
            manage &&
            member.role !== 'Owner' &&
            (group.role === 'Owner' || member.role !== 'Maintainer')
          return (
            <li
              key={member.user_id}
              className="flex flex-wrap items-center gap-3 py-3 text-sm text-text-primary"
            >
              <span className="min-w-0 flex-1 truncate">
                {member.user_id === 0 ? t('you') : member.name}
              </span>
              {editable ? (
                <>
                  <select
                    data-testid={`group-member-role-${member.user_id}`}
                    aria-label={member.name}
                    disabled={busy}
                    value={member.role}
                    onChange={event => {
                      const role = event.target.value as Exclude<ChatGroupMember['role'], 'Owner'>
                      void run(() => groups.addMember(group.id, member.user_id, role))
                    }}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                  >
                    {(group.role === 'Owner'
                      ? ['Maintainer', 'Developer', 'Viewer']
                      : ['Developer', 'Viewer']
                    ).map(role => (
                      <option key={role} value={role}>
                        {t(`role_${role}`)}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    data-testid={`group-member-remove-${member.user_id}`}
                    onClick={() => void run(() => groups.removeMember(group.id, member.user_id))}
                  >
                    {t('removeMember')}
                  </Button>
                </>
              ) : (
                <span className="text-xs text-text-muted">{t(`role_${member.role}`)}</span>
              )}
            </li>
          )
        })}
      </ul>
      {manage && (
        <div className="space-y-3">
          <label className="block space-y-2 text-sm text-text-primary">
            <span>{t('inviteMember')}</span>
            <input
              data-testid="group-member-search"
              placeholder={t('searchPeople')}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-focus"
              value={query}
              onChange={event => setQuery(event.target.value)}
              disabled={busy}
            />
          </label>
          {search &&
            (!matches ? (
              <p role="status" className="text-sm text-text-muted">
                {t('loading')}
              </p>
            ) : matches.error ? (
              <p role="alert" className="text-sm text-destructive">
                {matches.error}
              </p>
            ) : (
              <ul>
                {matches.users
                  .filter(user => !memberIds.has(user.id))
                  .map(user => (
                    <li
                      key={user.id}
                      className="flex items-center justify-between gap-3 py-2 text-sm text-text-primary"
                    >
                      <span>{user.user_name}</span>
                      <Button
                        type="button"
                        disabled={busy}
                        data-testid={`group-member-invite-${user.id}`}
                        onClick={() =>
                          void run(async () => {
                            await groups.addMember(group.id, user.id, 'Developer')
                            setQuery('')
                          })
                        }
                      >
                        {t('inviteMember')}
                      </Button>
                    </li>
                  ))}
                {matches.users.filter(user => !memberIds.has(user.id)).length === 0 && (
                  <li className="py-3 text-sm text-text-muted">{t('noPeople')}</li>
                )}
              </ul>
            ))}
          <p className="text-xs text-text-muted">{t('memberBoundary')}</p>
        </div>
      )}
      {!shared && <p className="text-xs text-text-muted">{t('localHint')}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
