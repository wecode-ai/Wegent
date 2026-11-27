import type { DeviceInfo } from '@/types/api'
import { isDeviceRunningTask } from '@/lib/device-capabilities'

export function cloudUpgradeReminder(device: DeviceInfo | null | undefined) {
  return device?.device_type === 'cloud' && device.status !== 'offline' && device.executor_version
    ? (device.cloud_upgrade_reminder ?? null)
    : null
}

export function busyCloudSandboxIds(devices: DeviceInfo[]) {
  const busySandboxes = new Set<string>()
  for (const device of devices) {
    const sandboxId = device.cloud_config?.sandboxId
    if (
      sandboxId &&
      device.device_type === 'cloud' &&
      device.status !== 'offline' &&
      isDeviceRunningTask(device)
    )
      busySandboxes.add(sandboxId)
  }
  return busySandboxes
}

export function claimDailyCloudUpgradeReminder(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  key: string,
  now = new Date()
) {
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  if (storage.getItem(key) === day) return false
  storage.setItem(key, day)
  return true
}
