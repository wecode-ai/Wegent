import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useState } from 'react'
import type { StandInProcessingSettings as ProcessingSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'

export function StandInProcessingSettings({
  value,
  onChange,
  disabled,
  savedSilent,
  api,
  userId,
  deviceId,
}: {
  value: ProcessingSettings
  onChange(value: ProcessingSettings): void
  disabled: boolean
  savedSilent: boolean
  api?: StandInExecutorApi
  userId: number
  deviceId: string
}) {
  const { t } = useTranslation('common')
  const { status, error, setStatus, setError } = useStandInProcessingStatus(
    api,
    userId,
    deviceId,
    savedSilent
  )
  const [checking, setChecking] = useState(false)
  return (
    <section
      className="mt-6 space-y-3 border-t border-border pt-5"
      data-testid="stand-in-processing"
    >
      <label className="grid gap-2">
        <span className="font-medium">{t('standIn.processing.title')}</span>
        <select
          data-testid="stand-in-processing-mode"
          className="min-h-11 rounded-md border border-border bg-background px-3 md:min-h-8"
          value={value.mode}
          disabled={disabled}
          onChange={event =>
            onChange({ ...value, mode: event.target.value as ProcessingSettings['mode'] })
          }
        >
          <option value="immediate">{t('standIn.processing.immediate')}</option>
          <option value="silent">{t('standIn.processing.silent')}</option>
        </select>
      </label>
      {value.mode === 'silent' && (
        <>
          <p className="text-xs text-text-muted">{t('standIn.processing.help')}</p>
          <label className="flex items-center gap-3">
            <span>{t('standIn.processing.interval')}</span>
            <input
              type="number"
              min={1}
              max={1440}
              data-testid="stand-in-processing-interval"
              className="min-h-11 w-24 rounded-md border border-border bg-transparent px-3 md:min-h-8"
              value={Number.isFinite(value.intervalMinutes) ? value.intervalMinutes : ''}
              disabled={disabled}
              onChange={event =>
                onChange({ ...value, intervalMinutes: event.target.valueAsNumber })
              }
            />
          </label>
          {!savedSilent && (
            <p className="text-xs text-text-muted">{t('standIn.processing.save_first')}</p>
          )}
        </>
      )}
      {savedSilent && api && (
        <div className="space-y-2 text-sm" data-testid="stand-in-processing-status">
          {status && (
            <>
              <p>
                {t(status.running ? 'standIn.processing.running' : 'standIn.processing.pending', {
                  count: status.pendingCount,
                })}
              </p>
              {status.nextCheckAt && (
                <p>
                  {t('standIn.processing.next', {
                    time: new Date(status.nextCheckAt).toLocaleString(),
                  })}
                </p>
              )}
              {status.lastCheckAt && (
                <p>
                  {t('standIn.processing.last', {
                    time: new Date(status.lastCheckAt).toLocaleString(),
                  })}
                </p>
              )}
            </>
          )}
          {(error || status?.error) && (
            <p role="alert" className="text-error">
              {error ?? (status?.error ? getStandInErrorMessage(status.error) : undefined)}
            </p>
          )}
          <button
            type="button"
            data-testid="stand-in-processing-check"
            disabled={disabled || checking || status?.running}
            className="min-h-11 rounded-md px-3 hover:bg-muted disabled:opacity-50 md:min-h-8"
            onClick={() => {
              setChecking(true)
              void api
                .checkProcessing(userId, deviceId)
                .then(result => {
                  setStatus(result)
                  setError(null)
                })
                .catch(cause => setError(getStandInErrorMessage(cause)))
                .finally(() => setChecking(false))
            }}
          >
            {t('standIn.processing.check')}
          </button>
          {!!status?.actions.length && (
            <details data-testid="stand-in-processing-history">
              <summary
                data-testid="stand-in-processing-history-toggle"
                className="min-h-11 cursor-pointer py-2 md:min-h-8 md:py-1"
              >
                {t('standIn.processing.history')}
              </summary>
              <ul className="mt-2 space-y-2">
                {status.actions.map(action => (
                  <li key={action.id}>
                    {t(`standIn.processing.action_${action.kind}`)} ·{' '}
                    {t(`standIn.processing.status_${action.status}`)}
                    {action.error && (
                      <p className="text-error">{getStandInErrorMessage(action.error)}</p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  )
}
