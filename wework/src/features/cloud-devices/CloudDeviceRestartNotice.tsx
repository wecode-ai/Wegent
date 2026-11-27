import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { AlertCircle, Check, Loader2 } from 'lucide-react'
import type { DeviceLifecyclePhase } from './useDeviceOfflineLifecycleAction'

export function CloudDeviceRestartNotice({
  deviceId,
  error,
  upgrade,
  phase,
  compact = false,
  onRefresh,
  onRetry,
}: {
  deviceId: string
  error: string | null
  upgrade?: boolean
  phase: DeviceLifecyclePhase
  compact?: boolean
  onRefresh: () => void
  onRetry: () => void
}) {
  const { t } = useTranslation('common')
  if (phase === 'idle') return null

  const isError = phase === 'error'
  const isRecovered = phase === 'recovered'
  const isTimeout = phase === 'timeout'
  const keyPrefix = 'workbench.connection_restart'
  const message =
    phase === 'submitting'
      ? t(`${keyPrefix}_submitting`)
      : phase === 'waiting-offline'
        ? t(`${keyPrefix}_waiting_offline`)
        : phase === 'waiting-online'
          ? t(`${keyPrefix}_waiting_online`)
          : isRecovered
            ? t(`${keyPrefix}_recovered`)
            : isTimeout
              ? t(upgrade ? 'workbench.cloud_upgrade_timeout' : `${keyPrefix}_timeout`)
              : t(`${keyPrefix}_failed`, { error: error ?? '' })

  return (
    <div
      data-testid={`connection-device-restart-status-${deviceId}`}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={cn(
        'flex items-center justify-between rounded-md text-xs',
        compact ? 'gap-1 px-2 py-1' : 'mt-3 gap-3 px-3 py-2',
        isError
          ? 'bg-destructive/10 text-destructive wework:bg-red-500/10 wework:text-red-600 wework:dark:text-red-400'
          : isTimeout
            ? 'bg-warning/10 text-warning wework:bg-amber-500/10 wework:text-amber-700 wework:dark:text-amber-400'
            : isRecovered
              ? 'bg-primary/10 text-primary'
              : 'bg-muted text-text-secondary'
      )}
    >
      <span className="flex min-w-0 items-center gap-2" title={compact ? message : undefined}>
        {isRecovered ? (
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : isError || isTimeout ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        <span className={compact ? 'sr-only' : undefined}>{message}</span>
        {compact && !isError && !isTimeout && !isRecovered && (
          <span aria-hidden="true">{t('workbench.connection_status_restarting')}</span>
        )}
      </span>
      {isError || isTimeout ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={`connection-device-restart-${isError ? 'retry' : 'refresh'}-${deviceId}`}
          onClick={isError ? onRetry : onRefresh}
          className="min-h-11 min-w-11 shrink-0 rounded-md border border-current/30 px-2 py-1 font-medium hover:bg-background/50 md:min-h-0 md:min-w-0"
        >
          {isError ? t(`${keyPrefix}_retry`) : t(`${keyPrefix}_refresh`)}
        </ControlButton>
      ) : null}
    </div>
  )
}
