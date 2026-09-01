import { ExternalLink, Loader2, MonitorCog } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getComputerUseStatus,
  openComputerUseScreenRecordingSettings,
  requestComputerUsePermissions,
  setComputerUseEnabled,
  type ComputerUseStatus,
} from '@/desktop/computerUse'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

export function ComputerUseSettingsPage() {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await getComputerUseStatus())
      setError(null)
    } catch (loadError) {
      console.error('[Wework] Failed to load computer use status:', loadError)
      setError(t('workbench.computer_use_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refresh])

  const setEnabled = async (enabled: boolean) => {
    setSaving(true)
    setError(null)
    try {
      setStatus(await setComputerUseEnabled(enabled))
    } catch (saveError) {
      console.error('[Wework] Failed to update computer use:', saveError)
      setError(t('workbench.computer_use_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const requestPermissions = async () => {
    setSaving(true)
    setError(null)
    try {
      setStatus(await requestComputerUsePermissions())
    } catch (permissionError) {
      console.error('[Wework] Failed to request computer use permissions:', permissionError)
      setError(t('workbench.computer_use_permission_failed'))
    } finally {
      setSaving(false)
    }
  }

  const permissionControl = (granted: boolean, kind: 'accessibility' | 'screen-recording') =>
    granted ? (
      <span className="text-xs font-medium text-primary">
        {t('workbench.computer_use_permission_granted')}
      </span>
    ) : (
      <button
        type="button"
        data-testid={`computer-use-open-${kind}-settings-button`}
        disabled={saving || !status?.supported}
        onClick={() =>
          void (kind === 'screen-recording'
            ? openComputerUseScreenRecordingSettings()
            : requestPermissions())
        }
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-text-primary hover:bg-muted disabled:opacity-50"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {t('workbench.computer_use_open_system_settings')}
      </button>
    )

  const stateLabel = loading
    ? t('common.loading', '加载中...')
    : status?.running
      ? t('workbench.computer_use_state_running')
      : status?.enabled
        ? t('workbench.computer_use_state_waiting_permissions')
        : t('workbench.computer_use_state_off')
  const stateDescription =
    status?.enabled && !status?.running
      ? t('workbench.computer_use_permissions_hint')
      : status?.currentTool
        ? t('workbench.computer_use_current_action', { action: status.currentTool })
        : t('workbench.computer_use_description')

  return (
    <SettingsPage width="narrow" data-testid="computer-use-settings-page">
      <SettingsPageHeader
        title={t('workbench.computer_use_title')}
        description={t('workbench.computer_use_subtitle')}
      />

      <div className="mb-4 flex items-start gap-3 rounded-2xl border border-border bg-surface/70 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <MonitorCog className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">{stateLabel}</div>
          <div className="mt-0.5 text-xs leading-4 text-text-secondary">{stateDescription}</div>
        </div>
      </div>

      {error || status?.error ? (
        <div data-testid="computer-use-settings-error" className="mb-4 text-sm text-red-500">
          {error ?? status?.error}
        </div>
      ) : null}

      <SettingsGroup>
        <SettingsRow
          label={t('workbench.computer_use_enable')}
          description={
            status?.supported
              ? t('workbench.computer_use_enable_description')
              : t('workbench.computer_use_macos_only')
          }
          control={
            loading || saving ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
            ) : (
              <SettingsSwitch
                data-testid="computer-use-enabled-toggle"
                checked={status?.enabled ?? false}
                disabled={!status?.supported}
                onCheckedChange={enabled => void setEnabled(enabled)}
                aria-label={t('workbench.computer_use_enable')}
              />
            )
          }
        />
        {status?.requiresPermissions ? (
          <>
            <SettingsRow
              label={t('workbench.computer_use_accessibility_permission')}
              description={t('workbench.computer_use_accessibility_permission_description')}
              control={permissionControl(status.accessibilityPermissionGranted, 'accessibility')}
            />
            <SettingsRow
              label={t('workbench.computer_use_screen_recording_permission')}
              description={t('workbench.computer_use_screen_recording_permission_description')}
              control={permissionControl(
                status.screenRecordingPermissionGranted,
                'screen-recording'
              )}
            />
          </>
        ) : null}
        <SettingsRow
          label={t('workbench.computer_use_approval')}
          description={t('workbench.computer_use_approval_description')}
          control={
            <span className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-text-secondary">
              {t('workbench.computer_use_approval_writes')}
            </span>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
