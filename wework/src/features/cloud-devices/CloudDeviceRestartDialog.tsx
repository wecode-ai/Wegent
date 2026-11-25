import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { isDeviceRunningTask } from '@/lib/device-capabilities'
import type { DeviceInfo } from '@/types/api'

export function CloudDeviceRestartDialog({
  devices,
  overlayClassName,
  onCancel,
  onConfirm,
}: {
  devices: DeviceInfo[]
  overlayClassName?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('common')
  const first = devices[0]
  if (!first) return null

  const deviceNames = devices.map(device => device.name?.trim() || device.device_id).join(', ')
  const description = t(
    devices.length > 1
      ? 'workbench.connection_restart_multiple_description'
      : isDeviceRunningTask(first)
        ? 'workbench.connection_restart_confirm_busy_description'
        : 'workbench.connection_restart_confirm_description',
    { device: deviceNames }
  )
  const versionDetails =
    devices.length === 1 && first.update_available && first.executor_version && first.latest_version
      ? t('workbench.connection_restart_version_details', {
          current: first.executor_version.replace(/^v/i, ''),
          latest: first.latest_version.replace(/^v/i, ''),
        })
      : ''

  return (
    <ConfirmDialog
      open
      focusCancel
      title={t(
        devices.length === 1
          ? 'workbench.connection_restart_confirm_title'
          : 'workbench.connection_restart_multiple_title'
      )}
      description={[description, versionDetails].filter(Boolean).join(' ')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('workbench.connection_restart_confirm_action')}
      confirmTestId="confirm-restart-device-button"
      dialogTestId="confirm-restart-device-dialog"
      cancelTestId="cancel-restart-device-button"
      overlayClassName={overlayClassName}
      onClose={onCancel}
      onConfirm={onConfirm}
    />
  )
}
