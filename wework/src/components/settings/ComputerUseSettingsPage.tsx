import { ExternalLink, Loader2, MonitorCog } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getComputerUseStatus,
  openComputerUseScreenRecordingSettings,
  requestComputerUsePermissions,
  setComputerUseEnabled,
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
  const [resource] = useState(() =>
    createAsyncResource('computer-use/status', getComputerUseStatus, {
      refreshIntervalMs: 2_000,
      refreshIntervalMode: 'after-settle',
    })
  )
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const status = snapshot.data
  const loading = !snapshot.settled
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const [failure, setFailure] = useState<'save' | 'permission' | null>(null)
  const error = failure
    ? t(`workbench.computer_use_${failure}_failed`)
    : snapshot.status === 'error'
      ? t('workbench.computer_use_load_failed')
      : null

  const mutate = async (action: { kind: 'save'; enabled: boolean } | { kind: 'permission' }) => {
    if (pending.current) return
    pending.current = true
    setSaving(true)
    setFailure(null)
    try {
      const receipt = await (action.kind === 'save'
        ? setComputerUseEnabled(action.enabled)
        : requestComputerUsePermissions())
      resource.update(() => receipt)
    } catch (cause) {
      console.error('[Wework] Failed to update computer use:', cause)
      setFailure(action.kind)
    } finally {
      pending.current = false
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
            : mutate({ kind: 'permission' }))
        }
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-text-primary hover:bg-muted disabled:opacity-50"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {t('workbench.computer_use_open_system_settings')}
      </button>
    )

  const stateLabel = loading
    ? t('common.loading', '加载中...')
    : !status
      ? t('workbench.computer_use_load_failed')
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
        <div
          data-testid="computer-use-settings-error"
          className="mb-4 text-sm text-destructive wework:text-red-500"
        >
          {error ?? status?.error}
        </div>
      ) : null}

      <SettingsGroup>
        <SettingsRow
          label={t('workbench.computer_use_enable')}
          description={
            !status || status.supported
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
                onCheckedChange={enabled => void mutate({ kind: 'save', enabled })}
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
