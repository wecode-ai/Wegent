import { describe, expect, test, vi } from 'vitest'
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

describe('desktop E2E policy fixture', () => {
  test('resolves after the desktop shell delivers the E2E configuration', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
    vi.resetModules()

    const { telemetryPolicy: policy } = await import('./telemetry-policy')
    expect(policy.personProfiles).toBe('never')

    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = { telemetryPolicy: 'identified' }

    expect(policy.personProfiles).toBe('identified_only')
    expect(policy.sendClientIp).toBe(true)
    expect(
      policy.identityFor({ id: 42, user_name: 'jiaqi62', email: 'jiaqi62@example.com' })
    ).toEqual({ distinctId: 'jiaqi62', properties: { username: 'jiaqi62' } })

    vi.unstubAllEnvs()
    delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
    vi.resetModules()
  })
})
