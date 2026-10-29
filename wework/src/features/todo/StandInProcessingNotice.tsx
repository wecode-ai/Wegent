import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'

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
  const { status, error } = useStandInProcessingStatus(api, userId, deviceId, true)
  const latest = status?.actions[0]
  const failure =
    error ??
    (status?.error ? getStandInErrorMessage(status.error) : undefined) ??
    (latest?.status === 'failed'
      ? latest.error
        ? getStandInErrorMessage(latest.error)
        : undefined
      : undefined)
  return (
    <div
      className="flex items-center gap-3 px-5 py-2 text-sm"
      data-testid="stand-in-processing-notice"
    >
      <span
        className={failure ? 'flex-1 text-error' : 'flex-1 text-text-muted'}
        role={failure ? 'alert' : 'status'}
      >
        {failure ??
          t(status?.running ? 'standIn.processing.running' : 'standIn.processing.pending', {
            count: status?.pendingCount ?? 0,
          })}
      </span>
      {status?.awaitingUser && status.taskId && onOpenTask && (
        <button
          type="button"
          data-testid="stand-in-processing-open-task"
          className="min-h-11 underline md:min-h-8"
          onClick={() => onOpenTask(status.taskId!)}
        >
          {t('standIn.processing.awaiting_user')}
        </button>
      )}
      <button
        type="button"
        data-testid="stand-in-processing-open-settings"
        className="min-h-11 underline md:min-h-8"
        onClick={onOpen}
      >
        {t('standIn.settings')}
      </button>
    </div>
  )
}
