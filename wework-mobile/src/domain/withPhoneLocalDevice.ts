import type { DeviceInfo } from '@/types/runtime'

/** Local identity and availability come only from the current account's native runtime. */
export function withPhoneLocalDevice(
  inventory: readonly DeviceInfo[],
  localDevice: DeviceInfo | null | undefined
): DeviceInfo[] {
  return [
    ...(localDevice ? [localDevice] : []),
    ...inventory.filter(device => device.device_type !== 'local'),
  ]
}
