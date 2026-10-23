import { describe, expect, test } from 'vitest'
import { telemetryPolicy } from './telemetry-policy'

describe('public telemetry policy', () => {
  test('keeps product analytics anonymous', () => {
    expect(telemetryPolicy.personProfiles).toBe('never')
    expect(telemetryPolicy.sendClientIp).toBe(false)
    expect(
      telemetryPolicy.identityFor({ id: 42, user_name: 'jiaqi62', email: 'jiaqi62@example.com' })
    ).toBeNull()
  })
})
