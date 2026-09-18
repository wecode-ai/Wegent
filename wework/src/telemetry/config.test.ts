import { afterEach, describe, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

describe('telemetry configuration', () => {
  test('defaults to the public telemetry distribution', async () => {
    const { getTelemetryConfig } = await import('./config')

    expect(getTelemetryConfig().distribution).toBe('public')
  })

  test('selects internal distribution from the build environment', async () => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_DISTRIBUTION', 'internal')
    const { getTelemetryConfig } = await import('./config')

    expect(getTelemetryConfig().distribution).toBe('internal')
  })

  test('rejects an unsupported distribution value', async () => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_DISTRIBUTION', 'private-ish')
    const { getTelemetryConfig } = await import('./config')

    expect(() => getTelemetryConfig()).toThrow(/telemetry distribution/i)
  })
})
