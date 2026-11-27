import { describe, expect, it } from 'vitest'
import {
  mobileTelemetryAvailable,
  parseMobileTelemetryBuildConfig,
  parseTelemetrySampleRate,
  resolveMobileTelemetryBuildConfig,
} from '../../telemetryBuildConfig'
import { telemetrySampleBucket } from './sampling'

describe('mobile telemetry build configuration', () => {
  it('reads the same WEWORK variables as the desktop build and prefers explicit values', () => {
    const config = resolveMobileTelemetryBuildConfig({
      WEWORK_POSTHOG_HOST: 'https://posthog.example',
      WEWORK_POSTHOG_KEY: 'phc_release',
      WEWORK_TELEMETRY_SAMPLE_RATE: '0.25',
      WEWORK_RELEASE_CHANNEL: 'stable',
      EXPO_PUBLIC_WEWORK_POSTHOG_KEY: 'phc_public',
      NODE_ENV: 'development',
    })
    expect(config).toMatchObject({
      posthogHost: 'https://posthog.example',
      posthogKey: 'phc_release',
      sampleRate: 0.25,
      environment: 'production',
      releaseChannel: 'stable',
      source: 'wework-mobile',
    })
    expect(mobileTelemetryAvailable(config)).toBe(true)
  })

  it('accepts EXPO_PUBLIC variables for local Expo builds', () => {
    const config = resolveMobileTelemetryBuildConfig({
      EXPO_PUBLIC_WEWORK_POSTHOG_KEY: 'phc_local',
      EXPO_PUBLIC_WEWORK_TELEMETRY_SAMPLE_RATE: '0.5',
    })
    expect(config.posthogKey).toBe('phc_local')
    expect(config.sampleRate).toBe(0.5)
  })

  it('falls back to the public Expo key when the desktop variable is blank', () => {
    const config = resolveMobileTelemetryBuildConfig({
      WEWORK_POSTHOG_KEY: '   ',
      EXPO_PUBLIC_WEWORK_POSTHOG_KEY: 'phc_local',
    })
    expect(config.posthogKey).toBe('phc_local')
  })

  it('rejects an invalid PostHog host during build configuration', () => {
    expect(() =>
      resolveMobileTelemetryBuildConfig({
        WEWORK_POSTHOG_HOST: 'htps://posthog.example',
        WEWORK_POSTHOG_KEY: 'phc_release',
      })
    ).toThrow('Invalid PostHog host')
  })

  it('rejects invalid sample rates instead of silently changing collection volume', () => {
    expect(() => parseTelemetrySampleRate('1.5')).toThrow('between 0 and 1')
    expect(() => parseTelemetrySampleRate('abc')).toThrow('between 0 and 1')
  })

  it('keeps telemetry unavailable without a project key or with a disabled sample rate', () => {
    expect(mobileTelemetryAvailable(parseMobileTelemetryBuildConfig({ posthogKey: '' }))).toBe(
      false
    )
    expect(
      mobileTelemetryAvailable(
        parseMobileTelemetryBuildConfig({ posthogKey: 'phc_key', sampleRate: 0 })
      )
    ).toBe(false)
  })

  it('assigns a stable installation sample bucket', () => {
    const first = telemetrySampleBucket('installation_a')
    expect(telemetrySampleBucket('installation_a')).toBe(first)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(1)
  })
})
