import { useMemo, useState } from 'react'
import type { DeviceInfo } from '@/types/api'

export function useStandaloneProjectDeviceSelection({
  open,
  devices,
  fixedDeviceId,
  preferredDeviceId,
}: {
  open: boolean
  devices: DeviceInfo[]
  fixedDeviceId?: string
  preferredDeviceId?: string | null
}) {
  const defaultDevice = useMemo(
    () =>
      fixedDeviceId
        ? (devices.find(device => device.device_id === fixedDeviceId) ?? null)
        : (devices.find(device => device.device_id === preferredDeviceId) ??
          devices.find(device => device.is_default) ??
          devices[0] ??
          null),
    [devices, fixedDeviceId, preferredDeviceId]
  )
  // Null means never selected. A removed selection must not silently retarget.
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(
    defaultDevice?.device_id ?? null
  )
  if (open && activeDeviceId === null && defaultDevice) setActiveDeviceId(defaultDevice.device_id)
  const activeDevice =
    activeDeviceId === null
      ? defaultDevice
      : (devices.find(device => device.device_id === activeDeviceId) ?? null)

  return { activeDevice, setActiveDeviceId }
}
