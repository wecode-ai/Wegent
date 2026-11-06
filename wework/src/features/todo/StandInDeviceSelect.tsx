import type { DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInDeviceSelect({
  value,
  currentDeviceId,
  devices,
  disabled,
  onChange,
  includeCurrent = true,
}: {
  value: string
  currentDeviceId: string
  devices: DeviceInfo[]
  disabled: boolean
  onChange(value: string): void
  includeCurrent?: boolean
}) {
  const { t } = useTranslation('common')
  return (
    <select
      data-testid="stand-in-device"
      aria-label={t('standIn.device')}
      value={value}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      className="min-h-8 max-w-full bg-transparent px-2"
    >
      {includeCurrent ? (
        <option value={currentDeviceId}>{t('standIn.current_device')}</option>
      ) : (
        <option value="" disabled>
          {t('standIn.select_device')}
        </option>
      )}
      {devices
        .filter(
          device =>
            !includeCurrent ||
            (device.device_id !== currentDeviceId && device.app_device_id !== currentDeviceId)
        )
        .map(device => (
          <option
            key={device.device_id}
            value={device.device_id}
            disabled={device.status === 'offline'}
          >
            {device.name}
          </option>
        ))}
    </select>
  )
}
