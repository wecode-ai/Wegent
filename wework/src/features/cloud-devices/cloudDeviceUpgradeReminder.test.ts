import { describe, expect, it } from 'vitest'
import { claimDailyCloudUpgradeReminder } from './cloudDeviceUpgradeReminder'

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
