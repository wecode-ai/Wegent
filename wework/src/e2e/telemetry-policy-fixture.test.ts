import { describe, expect, test } from 'vitest'
import { resolveE2ETelemetryPolicy } from './telemetry-policy-fixture'

const account = { id: 42, user_name: 'jiaqi62', email: 'jiaqi62@example.com' }

describe('desktop E2E telemetry policy fixtures', () => {
  test('defaults to the anonymous posture when no fixture is requested', () => {
    for (const fixture of [undefined, 'anonymous'] as const) {
      const policy = resolveE2ETelemetryPolicy(fixture)
      expect(policy.personProfiles).toBe('never')
      expect(policy.sendClientIp).toBe(false)
      expect(policy.identityFor(account)).toBeNull()
    }
  })

  test('identifies accounts by username and keeps the client IP', () => {
    const policy = resolveE2ETelemetryPolicy('identified')

    expect(policy.personProfiles).toBe('identified_only')
    expect(policy.sendClientIp).toBe(true)
    expect(policy.identityFor(account)).toEqual({
      distinctId: 'jiaqi62',
      properties: { username: 'jiaqi62' },
    })
  })

  test('keeps the local placeholder user anonymous', () => {
    const policy = resolveE2ETelemetryPolicy('identified')

    expect(policy.identityFor(null)).toBeNull()
    expect(policy.identityFor({ ...account, id: 0, user_name: 'local' })).toBeNull()
  })
})
