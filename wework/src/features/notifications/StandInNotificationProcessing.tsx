import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { StandInNotification, StandInNotificationState } from './standInNotifications'
import { standInOrigin, standInState, standInVersion } from './standInNotifications'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInIcon } from '@wegent/collaboration'
import { NotificationFeedRow, type NotificationFeedRowProps } from './NotificationFeedRow'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { Button } from '@/components/ui/button'
import { notificationTextFromMessages } from '@/features/workbench/runtimeTaskNotificationContent'
import { projectRuntimePaneTranscript } from '@/features/workbench/runtimeTaskLifecycle/projection'

/** Assignment execution remains here; human responses belong to the shared inbox. */
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
  const interactions = useRuntimeInteractions()
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<{
    state: StandInNotificationState
    notificationVersion: string | null
  } | null>(null)
  const notifiedState = notification.payload.standIn
  const notificationVersion = notifiedState ? standInVersion(notifiedState) : null
  if (started && notifiedState && notificationVersion !== started.notificationVersion)
    setStarted(null)
  const [summary, setSummary] = useState<{ version: string; text: string } | null>(null)
  const state =
    started && (!notifiedState || started.notificationVersion === notificationVersion)
      ? started.state
      : notifiedState
  const actorName = notification.payload.actorName?.trim()
  const projectId = notification.payload.projectId
  const issueId = notification.payload.itemId
  const canStart = !state && services?.standInApi && projectId && issueId && userId != null
  const completionVersion = JSON.stringify([
    state?.deviceId,
    state?.taskId,
    state?.status,
    state?.updatedAt,
  ])
  const completedDeviceId = state?.deviceId
  const completedTaskId = state?.taskId
  const completedStatus = state?.status
  useEffect(() => {
    if (
      !completedDeviceId ||
      !completedTaskId ||
      !completedStatus ||
      !['completed', 'failed', 'cancelled'].includes(completedStatus) ||
      !services?.runtimeWorkApi
    )
      return
    let active = true
    void services.runtimeWorkApi
      .getRuntimeTranscript({ deviceId: completedDeviceId, taskId: completedTaskId, limit: 20 })
      .then(response => {
        if (!active) return
        const transcript = projectRuntimePaneTranscript(response)
        const error = completedStatus === 'failed' ? transcript.turns.at(-1)?.error : undefined
        setSummary({
          version: completionVersion,
          text: error
            ? getStandInErrorMessage(error)
            : notificationTextFromMessages(response.messages)?.body || '',
        })
      })
      .catch(cause => {
        if (active) setError(getStandInErrorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [
    completionVersion,
    completedDeviceId,
    completedTaskId,
    completedStatus,
    services?.runtimeWorkApi,
  ])

  const start = async () => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
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
      const result = await services.standInApi.readTask(address.deviceId, address.taskId)
      if (!result.success || !result.task)
        throw Object.assign(new Error(result.error || t('notifications.stand_in_unavailable')), {
          code: result.code,
        })
      setStarted({ state: standInState({ address, task: result.task }), notificationVersion })
      await onChanged()
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <section data-testid={`notification-processing-${notification.id}`}>
      <NotificationFeedRow
        {...rowProps}
        kind="issue_dispatch_assignment"
        avatarLabel={actorName}
        title={actorName || rowProps.title}
        event={actorName ? t('notifications.stand_in_assignment') : undefined}
        body={actorName ? rowProps.title : ''}
        badge={
          state ? (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-text-secondary">
              <StandInIcon className="h-3 w-3" />
              {t('notifications.stand_in_handling')}
            </span>
          ) : undefined
        }
        processing={
          state || canStart || error ? (
            <div className="space-y-2">
              {state && (
                <span
                  data-testid={`notification-stand-in-status-${notification.id}`}
                  className="flex items-center gap-1.5 text-xs text-text-secondary"
                >
                  {t(`notifications.stand_in_${state.status}`)}
                  {state.status === 'running' && <LoaderCircle className="h-3 w-3 animate-spin" />}
                </span>
              )}
              {state?.summary && (
                <p className="line-clamp-2 text-sm text-text-secondary">
                  {getStandInErrorMessage(state.summary)}
                </p>
              )}
              {!state?.summary && summary?.version === completionVersion && summary.text && (
                <p className="line-clamp-2 text-sm text-text-secondary">{summary.text}</p>
              )}
              {(canStart || state?.status === 'failed') && (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid={`notification-stand-in-${canStart ? 'start' : 'retry'}-${notification.id}`}
                  disabled={busy}
                  onClick={() => void start()}
                >
                  <StandInIcon className="h-4 w-4" />
                  {t(canStart ? 'notifications.stand_in_delegate' : 'notifications.stand_in_retry')}
                </Button>
              )}
              {state?.status === 'waiting' && interactions && (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid={`notification-open-pending-${notification.id}`}
                  onClick={() =>
                    interactions.open(
                      interactions.pending.find(
                        item =>
                          item.task.address.deviceId === state.deviceId &&
                          item.task.address.taskId === state.taskId
                      )?.id
                    )
                  }
                >
                  {t('interactions.title')}
                </Button>
              )}
              {error && (
                <p role="alert" className="text-sm text-status-error">
                  {error}
                </p>
              )}
            </div>
          ) : undefined
        }
      />
    </section>
  )
}
