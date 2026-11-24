import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useContext, useState } from 'react'
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
  const [pending, setPending] = useState<{ deviceId: string; name: string } | null>(null)
  if (!workbench?.updateUserPreferences) return null
  const allDevices = workbench.state.devices ?? []
  const devices = allDevices.filter(device => device.status === 'online')
  const selected = workbench.state.user?.preferences?.default_execution_target ?? ''
  const hasPendingChange = confirmChanges && pending !== null && pending.deviceId !== selected
  const value = confirmChanges ? (pending?.deviceId ?? selected) : selected
  const valueAvailable = devices.some(device => device.device_id === value)
  const pendingUnavailable = hasPendingChange && Boolean(value) && !valueAvailable
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
        <SelectRoot
          value={normalizeSelectValue(pendingUnavailable || valueAvailable ? value : '')}
          disabled={saving}
          onValueChange={selectedValue => {
            if (selectedValue === null) return
            const deviceId = selectedValue
            if (confirmChanges) {
              setPending({
                deviceId,
                name: devices.find(device => device.device_id === deviceId)?.name ?? '',
              })
            } else void save(deviceId)
          }}
        >
          <SelectTrigger
            aria-label={t('workbench.runner_personal_default')}
            className="max-w-64"
            data-testid="settings-default-runner"
          />
          <SelectContent>
            <SelectItem value="">{t('workbench.runner_choose_environment')}</SelectItem>
            {pendingUnavailable && pending && (
              <SelectItem
                value={String(pending.deviceId)}
                data-testid="settings-default-runner-pending-unavailable"
              >
                {t('issue_creation.unavailable_runner_option', {
                  name:
                    allDevices.find(device => device.device_id === pending.deviceId)?.name ??
                    pending.name,
                })}
              </SelectItem>
            )}
            {devices.map(device => (
              <SelectItem key={device.device_id} value={String(device.device_id)}>
                {device.name} ·{' '}
                {t(`workbench.runner_status_${device.status === 'online' ? 'online' : 'offline'}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        {hasPendingChange && (
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid="settings-default-runner-save"
            disabled={saving}
            onClick={() => void save(value)}
            className="min-h-11 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50 md:min-h-8"
          >
            {t(saving ? 'independentIssues.saving' : 'issue_creation.save_personal_runner')}
          </ControlButton>
        )}
      </div>
      {unavailable && !hasPendingChange && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <span>{t('workbench.runner_default_unavailable')}</span>
          <ControlButton
            variant="unstyled"
            type="button"
            disabled={saving}
            data-testid="settings-default-runner-clear"
            className="min-h-11 min-w-11 text-text-primary underline md:min-h-8"
            onClick={() =>
              confirmChanges ? setPending({ deviceId: '', name: '' }) : void save('')
            }
          >
            {t('workbench.runner_clear_default')}
          </ControlButton>
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {t('issue_creation.personal_runner_save_failed')}
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
      children={control}
    />
  )
}
