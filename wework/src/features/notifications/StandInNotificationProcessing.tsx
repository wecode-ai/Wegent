import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, MessageSquare } from 'lucide-react'
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
import { useTranslation } from '@/hooks/useTranslation'
import { StandInIcon } from '@wegent/collaboration'
import { NotificationFeedRow, type NotificationFeedRowProps } from './NotificationFeedRow'

const ACTION_CLASS =
  'inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-muted/80 px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:opacity-50 md:min-h-7'

export function StandInNotificationProcessing({
  notification,
  rowProps,
  services,
  userId,
  onChanged,
}: {
  notification: StandInNotification
  rowProps: NotificationFeedRowProps
  services?: WorkbenchServices
  userId: number | null
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation('common')
  const [draft, setDraft] = useState('')
  const [replyOpen, setReplyOpen] = useState(false)
  const replyInput = useRef<HTMLInputElement>(null)
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
  const actorName = notification.payload.actorName?.trim()
  const runtimeApi = services?.runtimeWorkApi
  const projectId = notification.payload.projectId
  const issueId = notification.payload.itemId
  const signature = state ? `${state.deviceId}:${state.taskId}:${state.updatedAt}` : ''
  const deviceId = state?.deviceId
  const taskId = state?.taskId
  const status = state?.status
  const question = loaded?.signature === signature ? loaded.question : null
  const summary = loaded?.signature === signature ? loaded.summary : ''
  const loadError = loaded?.signature === signature ? loaded.error : undefined
  const displayStatus = submittedVersion === signature ? 'running' : state?.status

  useEffect(() => {
    if (replyOpen) replyInput.current?.focus()
  }, [replyOpen])

  useEffect(() => {
    if (!deviceId || !taskId || status === 'running' || !runtimeApi) return
    let active = true
    void runtimeApi
      .getRuntimeTranscript({ deviceId, taskId, limit: 20 })
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
          summary:
            (status === 'failed' && transcript.turns.at(-1)?.error
              ? getStandInErrorMessage(transcript.turns.at(-1)?.error)
              : '') ||
            notificationTextFromMessages(response.messages)?.body ||
            '',
        })
      })
      .catch(cause => {
        if (active)
          setLoaded({
            signature,
            question: null,
            summary: '',
            error: getStandInErrorMessage(cause),
          })
      })
    return () => {
      active = false
    }
  }, [signature, runtimeApi, deviceId, taskId, status])

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
      setError(getStandInErrorMessage(cause))
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
      setReplyOpen(false)
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
        typeof origin?.standInId === 'string' ? origin.standInId : undefined
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
  const canReply = Boolean(
    state &&
    displayStatus !== 'running' &&
    runtimeApi &&
    !question &&
    (displayStatus !== 'waiting' || (loaded?.signature === signature && !loadError))
  )
  const showReplyEditor = canReply && (replyOpen || displayStatus === 'waiting')
  const showReplyAction = canReply && !showReplyEditor
  const showProcessing = canStart || state || error || loadError

  return (
    <section data-testid={`notification-processing-${notification.id}`}>
      <NotificationFeedRow
        {...rowProps}
        kind="issue_dispatch_assignment"
        avatarLabel={actorName}
        title={actorName || rowProps.title}
        badge={
          state ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-text-secondary">
              <StandInIcon className="h-3 w-3" aria-hidden="true" />
              {t('notifications.stand_in_handling')}
            </span>
          ) : undefined
        }
        event={actorName ? t('notifications.stand_in_assignment') : undefined}
        body={actorName ? rowProps.title : ''}
        processing={
          showProcessing ? (
            <div className="space-y-2">
              {state && (
                <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <span data-testid={`notification-stand-in-status-${notification.id}`}>
                    {t(`notifications.stand_in_${displayStatus}`)}
                  </span>
                  {displayStatus === 'running' && (
                    <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                  )}
                </span>
              )}
              {(state?.summary || summary) && (
                <p className="line-clamp-2 rounded-lg bg-muted/70 px-3 py-2 text-sm text-text-secondary">
                  {state?.summary || summary}
                </p>
              )}
              {(canStart ||
                (displayStatus === 'failed' && services?.standInApi) ||
                showReplyAction) && (
                <div className="flex items-center gap-2">
                  {canStart && (
                    <button
                      type="button"
                      data-testid={`notification-stand-in-start-${notification.id}`}
                      className={ACTION_CLASS}
                      disabled={busy}
                      onClick={() => void start()}
                    >
                      <StandInIcon className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">
                        {t('notifications.stand_in_delegate')}
                      </span>
                      {busy && (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      )}
                    </button>
                  )}
                  {displayStatus === 'failed' && services?.standInApi && (
                    <button
                      type="button"
                      data-testid={`notification-stand-in-retry-${notification.id}`}
                      className={ACTION_CLASS}
                      disabled={busy}
                      onClick={() => void start()}
                    >
                      <span className="text-xs font-medium">
                        {t('notifications.stand_in_retry')}
                      </span>
                    </button>
                  )}
                  {showReplyAction && (
                    <button
                      type="button"
                      data-testid={`notification-stand-in-reply-open-${notification.id}`}
                      className={ACTION_CLASS}
                      disabled={busy}
                      onClick={() => setReplyOpen(true)}
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">
                        {t('notifications.stand_in_reply_action')}
                      </span>
                    </button>
                  )}
                </div>
              )}
              {question && runtimeApi && displayStatus !== 'running' ? (
                <RequestUserInputCard
                  key={signature}
                  compact
                  payload={question}
                  disabled={busy}
                  onSubmit={response => send(requestUserInputResponseText(response), response)}
                />
              ) : showReplyEditor ? (
                <form
                  className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/20 p-1 keyboard:focus-within:ring-1 keyboard:focus-within:ring-focus"
                  onSubmit={event => {
                    event.preventDefault()
                    if (draft.trim()) void send(draft.trim())
                  }}
                >
                  <input
                    ref={replyInput}
                    data-testid={`notification-stand-in-reply-${notification.id}`}
                    aria-label={t('notifications.stand_in_reply')}
                    placeholder={t('notifications.stand_in_reply')}
                    value={draft}
                    disabled={busy}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={event => {
                      if (isImeEnterEvent(event.nativeEvent)) event.preventDefault()
                    }}
                    className="min-h-11 min-w-0 flex-1 bg-transparent px-1 text-xs placeholder:text-text-muted focus-visible:outline-none md:min-h-7"
                  />
                  <button
                    type="submit"
                    data-testid={`notification-stand-in-send-${notification.id}`}
                    aria-label={t('notifications.stand_in_send')}
                    disabled={busy || !draft.trim()}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-text-primary text-background hover:bg-text-primary/90 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:opacity-30 md:h-7 md:w-7"
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
            </div>
          ) : undefined
        }
      />
    </section>
  )
}
