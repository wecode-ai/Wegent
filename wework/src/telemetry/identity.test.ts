import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  setTelemetryUser,
  telemetryContextProperties,
  telemetryDeliveryScope,
  telemetryDistinctId,
} from './identity'

const alice = { id: 7, user_name: 'Alice', email: 'alice@example.invalid' }
beforeEach(() => {
  vi.unstubAllEnvs()
  setTelemetryUser(null)
})
afterEach(() => {
  vi.unstubAllEnvs()
  setTelemetryUser(null)
})

describe('telemetry collection policy', () => {
  test('collects no account or application identity by default', () => {
    setTelemetryUser(alice)
    expect(telemetryDistinctId('installation')).toBe('installation')
    expect(
      telemetryContextProperties({
        smartApp: { key: 'private', name: 'Secret', version: '1', source: 'linked' },
      })
    ).toEqual({})
  })
  test('never treats the synthetic local account as a logged-in identity', () => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', 'email_prefix')
    setTelemetryUser({ id: 0, email: 'local@wework.local' })
    expect(telemetryDistinctId('anonymous')).toBe('anonymous')
  })
  test('uses the email-prefix identifier without sending full email', () => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', 'email_prefix')
    setTelemetryUser(alice)
    expect(telemetryDistinctId('installation')).toBe('alice')
    setTelemetryUser({ ...alice, email: 'bob@example.invalid' })
    expect(telemetryDistinctId('installation')).toBe('bob')
    setTelemetryUser(null)
    expect(telemetryDistinctId('installation')).toBe('installation')
  })
  test('stops using the account identifier when configured back to anonymous', () => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', 'email_prefix')
    setTelemetryUser(alice)
    vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', 'anonymous')
    expect(telemetryDistinctId('installation')).toBe('installation')
  })
  test('selects application metadata and bounds untrusted context values', () => {
    vi.stubEnv(
      'VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS',
      '["smart_app_key","smart_app_source","tool_duration_ms"]'
    )
    expect(
      telemetryContextProperties({
        smartApp: { key: 'research', name: 'Secret', version: '1', source: 'market' },
        pluginInvocation: {
          marketplace: 'secret',
          pluginKey: 'secret',
          toolName: 'secret',
          version: '1',
          durationMs: Infinity,
        },
      })
    ).toEqual({ smart_app_key: 'research', smart_app_source: 'market' })
  })
  test('binds queued events to destination, project, and field policy', () => {
    const initial = telemetryDeliveryScope()
    vi.stubEnv('VITE_WEWORK_POSTHOG_HOST', 'https://another.invalid')
    expect(telemetryDeliveryScope()).not.toBe(initial)
    const destination = telemetryDeliveryScope()
    vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', 'email_prefix')
    expect(telemetryDeliveryScope()).not.toBe(destination)
  })
})
