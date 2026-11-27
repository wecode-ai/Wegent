import type { DeviceInfo } from '@/types/api'

export function cloudUpgradeReminder(device: DeviceInfo | null | undefined) {
  const reminder = device?.cloud_upgrade_reminder
  return device?.device_type === 'cloud' &&
    device.status !== 'offline' &&
    device.executor_version &&
    reminder &&
    reminder.versions_behind >= 3
    ? reminder
    : null
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
