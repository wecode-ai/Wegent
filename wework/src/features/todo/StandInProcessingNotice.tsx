import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'
import { useState } from 'react'
import { CircleAlert, Clock } from 'lucide-react'

export function StandInProcessingNotice({
  api,
  userId,
  deviceId,
  onOpen,
  onOpenTask,
}: {
  api: StandInExecutorApi | undefined
  userId: number
  deviceId: string
  onOpen(): void
  onOpenTask?(taskId: string): void
}) {
  const { t } = useTranslation('common')
  const { status, error, setStatus, setError } = useStandInProcessingStatus(
    api,
    userId,
    deviceId,
    true
  )
  const [checking, setChecking] = useState(false)
  const backgroundModelUnavailable = status?.error?.code === 'model_unavailable'
  const recovery = status?.error?.code === 'coordination_recovery_required'
  const review = recovery || status?.error?.code === 'coordination_stopped'
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
        : getStandInErrorMessage(status.error)
      : undefined)
  if (!failure && !status?.awaitingUser) return null
  return (
    <div
      className="mx-5 my-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/60 px-4 py-3 text-sm"
      data-testid="stand-in-processing-notice"
    >
      {failure ? (
        <CircleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
      ) : (
        <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
      )}
      <span
        className="min-w-0 flex-1 leading-relaxed text-text-primary"
        role={failure ? 'alert' : 'status'}
      >
        {failure ?? t('standIn.processing.needs_input')}
      </span>
      <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
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
    </div>
  )
}
