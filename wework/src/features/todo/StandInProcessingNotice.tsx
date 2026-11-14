import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'
import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RuntimeCommandRecoveryReview } from '@/components/common/RuntimeCommandRecoveryReview'
import type { RuntimeCommandTarget } from '@/api/runtimeTaskCommands'

export function StandInProcessingNotice({
  api,
  userId,
  deviceId,
  onOpen,
  onOpenTask,
  snapshot,
}: {
  api: StandInExecutorApi | undefined
  userId: number
  deviceId: string
  onOpen(): void
  onOpenTask?(taskId: string): void
  snapshot?: ReturnType<typeof useStandInProcessingStatus>
}) {
  const { t } = useTranslation('common')
  const local = useStandInProcessingStatus(api, userId, deviceId, !snapshot)
  const { status, error, setStatus, setError } = snapshot ?? local
  const [checking, setChecking] = useState(false)
  const scope = `${userId}:${deviceId}`
  const [reviewing, setReviewing] = useState<{
    scope: string
    target: RuntimeCommandTarget
  } | null>(null)
  const currentReview = reviewing?.scope === scope ? reviewing : null
  const recoveryButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!currentReview && restoreFocus.current) {
      restoreFocus.current = false
      recoveryButton.current?.focus()
    }
  }, [currentReview])
  const backgroundModelUnavailable = status?.error?.code === 'model_unavailable'
  const recovery = status?.error?.code === 'coordination_recovery_required'
  const review =
    recovery ||
    status?.error?.code === 'coordination_stopped' ||
    status?.error?.code === 'coordinator_failed'
  const check = async () => {
    if (!api || checking) return
    setChecking(true)
    try {
      setStatus(await api.checkProcessing(userId, deviceId))
      setError(null)
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setChecking(false)
    }
  }
  const failure =
    error ??
    (status?.error
      ? backgroundModelUnavailable
        ? t('standIn.processing.background_model_unavailable')
        : recovery
          ? t('runtimeCommandRecovery.notice')
          : getStandInErrorMessage(status.error)
      : undefined)
  if (!failure && !status?.awaitingUser && !currentReview) return null
  return (
    <div
      className="mx-5 my-2 space-y-2 rounded-lg border border-border bg-muted/60 px-3 py-2 text-sm"
      data-testid="stand-in-processing-notice"
    >
      <div className="flex items-start gap-2">
        {failure ? (
          <CircleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
        ) : (
          <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
        )}
        <span
          className="min-w-0 flex-1 leading-relaxed text-text-primary"
          role={failure ? 'alert' : 'status'}
        >
          {failure ??
            t(currentReview ? 'runtimeCommandRecovery.title' : 'standIn.processing.needs_input')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {recovery && api?.taskCommands && status?.error?.commandId && status.taskId && (
          <Button
            ref={recoveryButton}
            size="sm"
            className="min-h-11 md:min-h-8"
            data-testid="stand-in-processing-recover"
            disabled={!!currentReview}
            onClick={() =>
              setReviewing({
                scope,
                target: {
                  userId,
                  taskId: status.error?.taskId ?? status.taskId!,
                  commandId: status.error!.commandId!,
                },
              })
            }
          >
            {t('runtimeCommandRecovery.open')}
          </Button>
        )}
        {(status?.awaitingUser || review) && status?.taskId && onOpenTask && (
          <button
            type="button"
            data-testid="stand-in-processing-open-task"
            className="min-h-11 rounded-md px-3 hover:bg-background md:min-h-8"
            onClick={() => onOpenTask(status.taskId!)}
          >
            {t(review ? 'standIn.processing.review_execution' : 'standIn.processing.awaiting_user')}
          </button>
        )}
        {failure && !recovery && api && !status?.running && (
          <button
            type="button"
            data-testid="stand-in-processing-check"
            className="min-h-11 rounded-md border border-border bg-background px-3 hover:bg-muted disabled:opacity-45 md:min-h-8"
            disabled={checking}
            onClick={() => void check()}
          >
            {t('standIn.processing.check')}
          </button>
        )}
        {backgroundModelUnavailable && (
          <button
            type="button"
            data-testid="stand-in-processing-open-settings"
            className="min-h-11 rounded-md px-3 hover:bg-background md:min-h-8"
            onClick={onOpen}
          >
            {t('standIn.processing.configure_model')}
          </button>
        )}
      </div>
      {currentReview && api?.taskCommands && (
        <RuntimeCommandRecoveryReview
          key={`${scope}:${currentReview.target.taskId}:${currentReview.target.commandId}`}
          commands={api.taskCommands}
          deviceId={deviceId}
          target={currentReview.target}
          onCancel={() => {
            restoreFocus.current = true
            setReviewing(null)
          }}
          onContinue={async () => {
            const next = await api.checkProcessing(userId, deviceId)
            setStatus(next)
            setError(null)
            if (next.error) throw new Error('Subsequent processing is still blocked')
          }}
        />
      )}
    </div>
  )
}
