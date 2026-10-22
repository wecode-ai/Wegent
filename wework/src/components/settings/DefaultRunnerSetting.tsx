import { useContext, useState } from 'react'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsRow } from './settings-ui'

export function DefaultRunnerSetting() {
  const workbench = useContext(WorkbenchContext)
  const { t } = useTranslation('common')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!workbench?.updateUserPreferences) return null
  const devices = workbench.state.devices ?? []
  const selected = workbench.state.user?.preferences?.default_execution_target ?? ''
  const save = async (deviceId: string) => {
    setSaving(true)
    setError(null)
    try {
      await workbench.updateUserPreferences({ default_execution_target: deviceId || null })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <SettingsRow
      label={t('workbench.runner_personal_default')}
      description={t('workbench.runner_default_hint')}
    >
      <div className="space-y-1">
        <select
          className="wework-native-select h-9 max-w-64 rounded-md border border-border bg-background px-2 text-sm"
          value={selected}
          disabled={saving}
          onChange={event => void save(event.target.value)}
          data-testid="settings-default-runner"
        >
          <option value="">{t('workbench.runner_choose_environment')}</option>
          {selected && !devices.some(device => device.device_id === selected) && (
            <option value={selected}>
              {selected} · {t('workbench.runner_status_offline')}
            </option>
          )}
          {devices.map(device => (
            <option key={device.device_id} value={device.device_id}>
              {device.name} ·{' '}
              {t(`workbench.runner_status_${device.status === 'online' ? 'online' : 'offline'}`)}
            </option>
          ))}
        </select>
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </SettingsRow>
  )
}
