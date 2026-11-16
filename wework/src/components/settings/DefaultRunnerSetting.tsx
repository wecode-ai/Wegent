import { useContext, useState } from 'react'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsRow } from './settings-ui'

export function DefaultRunnerSetting({
  compact = false,
  confirmChanges = false,
}: {
  compact?: boolean
  confirmChanges?: boolean
}) {
  const workbench = useContext(WorkbenchContext)
  const { t } = useTranslation('common')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  if (!workbench?.updateUserPreferences) return null
  const devices = (workbench.state.devices ?? []).filter(device => device.status === 'online')
  const selected = workbench.state.user?.preferences?.default_execution_target ?? ''
  const value = confirmChanges ? (pending ?? selected) : selected
  const unavailable = Boolean(selected) && !devices.some(device => device.device_id === selected)
  const save = async (deviceId: string) => {
    setSaving(true)
    setError(null)
    try {
      await workbench.updateUserPreferences({ default_execution_target: deviceId || null })
      setPending(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  const control = (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('workbench.runner_personal_default')}
          className="wework-native-select h-9 min-h-11 md:min-h-9 max-w-64 rounded-md border border-border bg-background px-2 text-sm"
          value={devices.some(device => device.device_id === value) ? value : ''}
          disabled={saving}
          onChange={event =>
            confirmChanges ? setPending(event.target.value) : void save(event.target.value)
          }
          data-testid="settings-default-runner"
        >
          <option value="">{t('workbench.runner_choose_environment')}</option>
          {devices.map(device => (
            <option key={device.device_id} value={device.device_id}>
              {device.name} ·{' '}
              {t(`workbench.runner_status_${device.status === 'online' ? 'online' : 'offline'}`)}
            </option>
          ))}
        </select>
        {confirmChanges && pending !== null && pending !== selected && (
          <button
            type="button"
            data-testid="settings-default-runner-save"
            disabled={saving}
            onClick={() => void save(pending)}
            className="min-h-11 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50 md:min-h-8"
          >
            {t(saving ? 'independentIssues.saving' : 'issue_creation.save_personal_runner')}
          </button>
        )}
      </div>
      {unavailable && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <span>{t('workbench.runner_default_unavailable')}</span>
          <button
            type="button"
            disabled={saving}
            data-testid="settings-default-runner-clear"
            className="min-h-11 min-w-11 text-text-primary underline md:min-h-8"
            onClick={() => (confirmChanges ? setPending('') : void save(''))}
          >
            {t('workbench.runner_clear_default')}
          </button>
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
  return compact ? (
    control
  ) : (
    <SettingsRow
      label={t('workbench.runner_personal_default')}
      description={t('workbench.runner_default_hint')}
      control={control}
    />
  )
}
