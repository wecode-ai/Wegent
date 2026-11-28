import { useTranslation } from '@/hooks/useTranslation'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import type { DeviceInfo } from '@/types/api'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'

export function StandInDeviceSelect({
  value,
  currentDeviceId,
  devices,
  disabled,
  onChange,
  testId = 'stand-in-device',
  ariaLabel,
  readOnly = false,
}: {
  value: string
  currentDeviceId: string
  devices: DeviceInfo[]
  disabled: boolean
  onChange(value: string): void
  testId?: string
  ariaLabel?: string
  readOnly?: boolean
}) {
  const { t } = useTranslation('common')
  const selectedDevice = findWorkbenchDevice(devices, value)
  if (readOnly) {
    return (
      <span className="px-2 text-sm text-text-secondary">
        {selectedDevice?.name ?? (value === currentDeviceId ? t('standIn.current_device') : value)}
      </span>
    )
  }
  return (
    <SelectRoot
      value={normalizeSelectValue(
        value === currentDeviceId ? value : (selectedDevice?.device_id ?? value)
      )}
      disabled={disabled}
      onValueChange={selectedValue => {
        if (selectedValue !== null) return onChange(selectedValue)
      }}
    >
      <SelectTrigger
        density="compact"
        appearance="plain"
        data-testid={testId}
        aria-label={ariaLabel ?? t('standIn.device')}
        className="max-w-full"
      />
      <SelectContent>
        <SelectItem value={String(currentDeviceId)}>{t('standIn.current_device')}</SelectItem>
        {devices
          .filter(
            device =>
              device.device_id !== currentDeviceId && device.app_device_id !== currentDeviceId
          )
          .map(device => (
            <SelectItem
              key={device.device_id}
              value={String(device.device_id)}
              disabled={device.status === 'offline'}
            >
              {device.name}
            </SelectItem>
          ))}
      </SelectContent>
    </SelectRoot>
  )
}
