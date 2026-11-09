import type { DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useContext } from 'react'
import { StandInBindingContext } from './StandInBindingContext'

export function StandInDeviceSelect({
  value,
  currentDeviceId,
  devices,
  disabled,
  onChange,
}: {
  value: string
  currentDeviceId: string
  devices: DeviceInfo[]
  disabled: boolean
  onChange(value: string): void
}) {
  const { t } = useTranslation('common')
  const binding = useContext(StandInBindingContext)
  if (binding) {
    return (
      <span className="px-2 text-sm text-text-secondary">
        {devices.find(device => device.device_id === binding.deviceId)?.name ??
          (binding.deviceId === currentDeviceId ? t('standIn.current_device') : binding.deviceId)}
      </span>
    )
  }
  return (
    <select
      data-testid="stand-in-device"
      aria-label={t('standIn.device')}
      value={value}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      className="min-h-11 max-w-full bg-transparent px-2 md:min-h-8"
    >
      <option value={currentDeviceId}>{t('standIn.current_device')}</option>
      {devices
        .filter(
          device => device.device_id !== currentDeviceId && device.app_device_id !== currentDeviceId
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
