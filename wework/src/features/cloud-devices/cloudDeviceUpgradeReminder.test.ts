import { describe, expect, it } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { busyCloudSandboxIds, claimDailyCloudUpgradeReminder } from './cloudDeviceUpgradeReminder'

describe('cloud device upgrade reminder days', () => {
  it('deduplicates only the same device and account until local midnight', () => {
    const records = new Map<string, string>()
    const storage = {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, day: string) => records.set(key, day),
    }
    const beforeMidnight = new Date(2026, 10, 27, 23, 59)
    const afterMidnight = new Date(2026, 10, 28)
    expect(claimDailyCloudUpgradeReminder(storage, 'qa:device', beforeMidnight)).toBe(true)
    expect(claimDailyCloudUpgradeReminder(storage, 'qa:device', beforeMidnight)).toBe(false)
    expect(claimDailyCloudUpgradeReminder(storage, 'qa:other-device', beforeMidnight)).toBe(true)
    expect(claimDailyCloudUpgradeReminder(storage, 'other-account:device', beforeMidnight)).toBe(
      true
    )
    expect(claimDailyCloudUpgradeReminder(storage, 'qa:device', afterMidnight)).toBe(true)
  })
})

it('treats online cloud work in the same sandbox as a restart blocker', () => {
  const target: DeviceInfo = {
    id: 1,
    device_id: 'target',
    name: 'Target',
    status: 'online',
    device_type: 'cloud',
    is_default: false,
    cloud_config: { sandboxId: 'sandbox' },
  }
  const sibling = { ...target, id: 2, device_id: 'sibling', slot_used: 1 }
  expect(busyCloudSandboxIds([target, sibling]).has('sandbox')).toBe(true)
  expect(
    busyCloudSandboxIds([target, { ...sibling, cloud_config: { sandboxId: 'other' } }]).has(
      'sandbox'
    )
  ).toBe(false)
  expect(busyCloudSandboxIds([target, { ...sibling, status: 'offline' }]).has('sandbox')).toBe(
    false
  )
})
