import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { isDeviceRunningTask } from '@/lib/device-capabilities'
import type { DeviceInfo } from '@/types/api'

export function CloudDeviceRestartDialog({
  devices,
  upgrade = false,
  sandboxBusy = false,
  overlayClassName,
  onCancel,
  onConfirm,
}: {
  devices: DeviceInfo[]
  upgrade?: boolean
  sandboxBusy?: boolean
  overlayClassName?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('common')
  const first = devices[0]
  if (!first) return null

  const deviceNames = devices.map(device => device.name?.trim() || device.device_id).join(', ')
  const busy = isDeviceRunningTask(first) || sandboxBusy
  const description = t(
    upgrade
      ? busy
        ? 'workbench.cloud_upgrade_busy'
        : 'workbench.cloud_upgrade_description'
      : devices.length > 1
        ? 'workbench.connection_restart_multiple_description'
        : busy
          ? 'workbench.connection_restart_confirm_busy_description'
          : 'workbench.connection_restart_confirm_description',
    { device: deviceNames, count: first.cloud_upgrade_reminder?.versions_behind ?? 0 }
  )
  const latest = upgrade ? first.cloud_upgrade_reminder?.target_version : first.latest_version
  const versionDetails =
    devices.length === 1 && (upgrade || first.update_available) && first.executor_version && latest
      ? t('workbench.connection_restart_version_details', {
          current: first.executor_version.replace(/^v/i, ''),
          latest: latest.replace(/^v/i, ''),
        })
      : ''

  return (
    <ConfirmDialog
      open
      focusCancel
      title={t(
        upgrade
          ? 'workbench.cloud_upgrade_title'
          : devices.length === 1
            ? 'workbench.connection_restart_confirm_title'
            : 'workbench.connection_restart_multiple_title'
      )}
      description={[description, versionDetails].filter(Boolean).join(' ')}
      cancelLabel={t(upgrade ? 'workbench.cloud_upgrade_later' : 'common.cancel')}
      confirmLabel={t(
        upgrade ? 'workbench.cloud_upgrade_action' : 'workbench.connection_restart_confirm_action'
      )}
      confirmDisabled={upgrade && (busy || first.status === 'offline')}
      confirmTestId="confirm-restart-device-button"
      dialogTestId={upgrade ? 'cloud-device-upgrade-reminder' : 'confirm-restart-device-dialog'}
      cancelTestId="cancel-restart-device-button"
      overlayClassName={overlayClassName}
      onClose={onCancel}
      onConfirm={onConfirm}
    />
  )
}
