import { useEffect, useState } from 'react'
import type { StandInExecutorApi, StandInInboxMessage, StandInInboxWork } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInWorkMessages({
  api,
  userId,
  deviceId,
  work,
  siblings,
  onRefresh,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  work: StandInInboxWork
  siblings: StandInInboxWork[]
  onRefresh(): void
}) {
  const { t } = useTranslation('common')
  const [messages, setMessages] = useState<StandInInboxMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    void api
      .workMessages(userId, deviceId, work.id)
      .then(value => {
        if (active) setMessages(value.messages)
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [api, userId, deviceId, work.id, work.messageCount, revision])
  return (
    <details className="mt-5 border-t border-border pt-3" data-testid="stand-in-work-messages">
      <summary className="cursor-pointer text-sm" data-testid="stand-in-work-messages-toggle">
        {t('standIn.workspace.related_messages', { count: work.messageCount })}
      </summary>
      <p className="mt-2 text-xs text-text-muted">{t('standIn.workspace.adjust_help')}</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      )}
      {messages.map(message => (
        <div key={message.recordId} className="space-y-2 border-b border-border py-3">
          <p className="text-xs text-text-muted">
            {message.source.name} · {new Date(message.at).toLocaleString()}
          </p>
          <p className="whitespace-pre-wrap text-sm">{message.text}</p>
          <select
            aria-label={t('standIn.workspace.adjust_message')}
            data-testid={`stand-in-message-move-${message.id}`}
            value=""
            disabled={busy}
            className="min-h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            onChange={async event => {
              const target = event.target.value
              if (!target) return
              setBusy(true)
              setError(null)
              try {
                await api.adjustMessage(
                  userId,
                  deviceId,
                  work.id,
                  message.recordId,
                  target === '__split' ? undefined : target
                )
                onRefresh()
                setRevision(value => value + 1)
              } catch (cause) {
                setError(String(cause))
              } finally {
                setBusy(false)
              }
            }}
          >
            <option value="">{t('standIn.workspace.adjust_message')}</option>
            <option value="__split">{t('standIn.workspace.split_message')}</option>
            {siblings
              .filter(value => value.id !== work.id && value.roleId === work.roleId)
              .map(value => (
                <option key={value.id} value={value.id}>
                  {value.title}
                </option>
              ))}
          </select>
        </div>
      ))}
    </details>
  )
}
