import { useState } from 'react'
import type {
  ChatGroup,
  ChatGroupApi,
  ChatGroupMember,
  ThreadParticipation,
} from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export function ThreadParticipants({
  group,
  threadId,
  members,
  participation,
  api,
  onChanged,
  onNavigationChanged,
}: {
  group: ChatGroup
  threadId: string
  members: ChatGroupMember[]
  participation: ThreadParticipation | null
  api: ChatGroupApi
  onChanged(value: ThreadParticipation): void
  onNavigationChanged(): void
}) {
  const { t } = useTranslation('collaboration')
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const self = participation?.participants.find(
    member => member.user_id === participation.current_user_id
  )
  const joined = new Set(participation?.participants.map(member => member.user_id) ?? [])
  const candidates = members.filter(member => !joined.has(member.user_id))
  const canInvite =
    group.status === 'active' &&
    group.role !== 'Viewer' &&
    (participation?.joined || group.role === 'Owner' || group.role === 'Maintainer')
  const run = async (operation: () => Promise<ThreadParticipation>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      onChanged(await operation())
      onNavigationChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4" data-testid="thread-participants">
      <h2 className="text-sm font-medium text-text-primary">
        {t('participants', { count: participation?.participants.length ?? 0 })}
      </h2>
      {!participation ? (
        <p role="status" className="text-sm text-text-muted">
          {t('loading')}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {participation.participants.map(member => (
              <li
                key={member.user_id}
                className="flex items-center justify-between gap-3 py-2 text-sm text-text-primary"
              >
                <span>{member.user_id === 0 ? t('you') : member.name}</span>
                {member.notifications === 'muted' &&
                  member.user_id === participation.current_user_id && (
                    <span className="text-xs text-text-muted">{t('muted')}</span>
                  )}
              </li>
            ))}
          </ul>
          {group.status === 'active' && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                data-testid="thread-participants-toggle-self"
                onClick={() =>
                  void run(() =>
                    api.setParticipation(threadId, {
                      joined: !participation.joined,
                      notifications: self?.notifications ?? 'all',
                    })
                  )
                }
              >
                {t(participation.joined ? 'leave' : 'join')}
              </Button>
              {participation.joined && (
                <label className="flex items-center gap-2 text-sm text-text-muted">
                  <span>{t('notifications')}</span>
                  <select
                    data-testid="thread-notification-preference"
                    aria-label={t('notifications')}
                    disabled={busy}
                    value={self?.notifications ?? 'all'}
                    onChange={event => {
                      const notifications = event.target.value as 'all' | 'muted'
                      void run(() =>
                        api.setParticipation(threadId, { joined: true, notifications })
                      )
                    }}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-text-primary"
                  >
                    <option value="all">{t('unmute')}</option>
                    <option value="muted">{t('mute')}</option>
                  </select>
                </label>
              )}
            </div>
          )}
          {canInvite && candidates.length > 0 && (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={event => {
                event.preventDefault()
                if (!selected) return
                void run(async () => {
                  const result = await api.inviteParticipants(threadId, [Number(selected)])
                  setSelected('')
                  return result
                })
              }}
            >
              <select
                data-testid="thread-invite-member"
                aria-label={t('inviteParticipant')}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary"
                value={selected}
                onChange={event => setSelected(event.target.value)}
                disabled={busy}
              >
                <option value="">{t('chooseGroupMember')}</option>
                {candidates.map(member => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.name}
                  </option>
                ))}
              </select>
              <Button type="submit" disabled={busy || !selected} data-testid="thread-invite-submit">
                {t('inviteParticipant')}
              </Button>
            </form>
          )}
          <p className="text-xs text-text-muted">{t('participantBoundary')}</p>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
