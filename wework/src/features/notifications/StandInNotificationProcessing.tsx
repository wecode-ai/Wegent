import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle } from 'lucide-react'
import { isImeEnterEvent } from '@wegent/chat-core/ime'
import {
  isPendingRequestUserInputBlock,
  resolveAsyncRequestUserInputAnswers,
  requestUserInputResponseText,
} from '@wegent/chat-core/runtime-user-input'
import type { RequestUserInputPayload, RequestUserInputResponse } from '@wegent/chat-core/runtime'
import type { StandInNotification, StandInNotificationState } from './standInNotifications'
import { standInOrigin } from './standInNotifications'
import { notificationTextFromMessages } from '@/features/workbench/runtimeTaskNotificationContent'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { projectRuntimePaneTranscript } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { StandInIcon } from '@/features/todo/StandInIcon'
import { useTranslation } from '@/hooks/useTranslation'

const ACTION_CLASS =
  'inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-text-secondary hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:min-h-7'

export function StandInNotificationProcessing({
  notification,
  services,
  userId,
  onChanged,
}: {
  notification: StandInNotification
  services?: WorkbenchServices
  userId: number | null
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation('common')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<StandInNotificationState | null>(null)
  const [loaded, setLoaded] = useState<{
    signature: string
    question: RequestUserInputPayload | null
    summary: string
    error?: string
  } | null>(null)
  const [submittedVersion, setSubmittedVersion] = useState<string | null>(null)
  const state = notification.payload.standIn ?? started
  const runtimeApi = services?.runtimeWorkApi
  const projectId = notification.payload.projectId
  const issueId = notification.payload.itemId
  const signature = state ? `${state.deviceId}:${state.taskId}:${state.updatedAt}` : ''
  const question = loaded?.signature === signature ? loaded.question : null
  const summary = loaded?.signature === signature ? loaded.summary : ''
  const loadError = loaded?.signature === signature ? loaded.error : undefined
  const displayStatus = submittedVersion === signature ? 'running' : state?.status

  useEffect(() => {
    if (!state || state.status === 'running' || !runtimeApi) return
    let active = true
    void runtimeApi
      .getRuntimeTranscript({ deviceId: state.deviceId, taskId: state.taskId, limit: 20 })
      .then(response => {
        if (!active) return
        const transcript = projectRuntimePaneTranscript(response)
        const blocks = resolveAsyncRequestUserInputAnswers(transcript.messages).flatMap(
          message => message.blocks ?? []
        )
        const pending = blocks.filter(block => isPendingRequestUserInputBlock(block)).at(-1)
        setLoaded({
          signature,
          question: pending?.renderPayload ?? null,
          summary: notificationTextFromMessages(response.messages)?.body ?? '',
        })
      })
      .catch(cause => {
        if (active)
          setLoaded({
            signature,
            question: null,
            summary: '',
            error: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => {
      active = false
    }
  }, [signature, runtimeApi, state])

  const perform = async (action: () => Promise<void>): Promise<boolean> => {
    if (submitting.current) return false
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      await onChanged()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const send = (message: string, response?: RequestUserInputResponse) =>
    perform(async () => {
      if (!state || !runtimeApi) throw new Error(t('notifications.stand_in_unavailable'))
      const result = await runtimeApi.sendRuntimeMessage({
        address: { deviceId: state.deviceId, taskId: state.taskId },
        message,
        clientUserMessageId: crypto.randomUUID(),
        ...(response ? { requestUserInputResponse: response } : {}),
      })
      if (!result.accepted) throw new Error(result.error || t('notifications.failed'))
      setDraft('')
      setSubmittedVersion(signature)
    })

  const start = () =>
    perform(async () => {
      if (!services?.standInApi || !projectId || !issueId || userId == null)
        throw new Error(t('notifications.stand_in_unavailable'))
      const target =
        state?.deviceId || (await services.getLocalRuntimeSidebarIdentity?.())?.deviceId
      if (!target) throw new Error(t('notifications.stand_in_unavailable'))
      const origin = notification.runtimeItem ? standInOrigin(notification.runtimeItem) : null
      const address = await services.standInApi.run(
        projectId,
        issueId,
        userId,
        origin?.projectStore === 'local' ? 'local' : 'cloud',
        target,
        typeof origin?.standInId === 'string' ? origin.standInId : 'default'
      )
      setStarted({
        ...address,
        status: 'running',
        summary: '',
        updatedAt: new Date().toISOString(),
      })
      if (state) setSubmittedVersion(signature)
    })

  const canStart = !state && services?.standInApi && projectId && issueId && userId != null
  if (!state && !canStart) return null

  return (
    <section data-testid={`notification-processing-${notification.id}`} className="space-y-2">
      <div className="flex min-h-7 items-center gap-1.5 text-xs text-text-secondary">
        <StandInIcon className="h-4 w-4 shrink-0" />
        {state ? (
          <>
            <span>{t('notifications.stand_in_identity')}</span>
            <span aria-hidden="true">·</span>
            <span data-testid={`notification-stand-in-status-${notification.id}`}>
              {t(`notifications.stand_in_${displayStatus}`)}
            </span>
            {displayStatus === 'running' && (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            )}
          </>
        ) : (
          <button
            type="button"
            data-testid={`notification-stand-in-start-${notification.id}`}
            className={ACTION_CLASS}
            disabled={busy}
            onClick={() => void start()}
          >
            {t('standIn.use_for_task')}
          </button>
        )}
      </div>
      {(state?.summary || summary) && (
        <p className="line-clamp-2 text-xs text-text-secondary">{state?.summary || summary}</p>
      )}
      {displayStatus === 'failed' && services?.standInApi && (
        <button
          type="button"
          data-testid={`notification-stand-in-retry-${notification.id}`}
          className={ACTION_CLASS}
          disabled={busy}
          onClick={() => void start()}
        >
          {t('notifications.stand_in_retry')}
        </button>
      )}
      {question && runtimeApi && displayStatus !== 'running' ? (
        <RequestUserInputCard
          key={signature}
          payload={question}
          disabled={busy}
          onSubmit={response => send(requestUserInputResponseText(response), response)}
        />
      ) : state &&
        displayStatus !== 'running' &&
        runtimeApi &&
        (displayStatus !== 'waiting' || (loaded?.signature === signature && !loadError)) ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={event => {
            event.preventDefault()
            if (draft.trim()) void send(draft.trim())
          }}
        >
          <input
            data-testid={`notification-stand-in-reply-${notification.id}`}
            aria-label={t('notifications.stand_in_reply')}
            placeholder={t('notifications.stand_in_reply')}
            value={draft}
            disabled={busy}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (isImeEnterEvent(event.nativeEvent)) event.preventDefault()
            }}
            className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-xs placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus md:min-h-7"
          />
          <button
            type="submit"
            data-testid={`notification-stand-in-send-${notification.id}`}
            aria-label={t('notifications.stand_in_send')}
            disabled={busy || !draft.trim()}
            className={ACTION_CLASS}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </form>
      ) : null}
      {(error || loadError) && (
        <p role="alert" className="text-xs text-status-error">
          {error || loadError}
        </p>
      )}
    </section>
  )
}
