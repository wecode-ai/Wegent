import { afterEach, describe, expect, test, vi } from 'vitest'
import { getTelemetryConfig } from './config'

afterEach(() => {
  vi.unstubAllEnvs()
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
})

describe('telemetry configuration', () => {
  test('defaults to anonymous collection without identity or context fields', () => {
    expect(getTelemetryConfig()).toMatchObject({
      contextFields: [],
      identity: 'anonymous',
    })
  })
  test('validates identity supplied by the desktop verification environment', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = { telemetryIdentity: 'email_prefix' }
    expect(getTelemetryConfig().identity).toBe('email_prefix')
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = { telemetryIdentity: 'invalid' }
    expect(() => getTelemetryConfig()).toThrow(/distinct ID/)
  })
  test('selects the receiver and explicit field policies through configuration', () => {
    vi.stubEnv('VITE_WEWORK_POSTHOG_HOST', 'https://collector.example.invalid')
    vi.stubEnv('VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS', '["smart_app_key"]')
    vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', 'email_prefix')
    expect(getTelemetryConfig()).toMatchObject({
      posthogHost: 'https://collector.example.invalid',
      contextFields: ['smart_app_key'],
      identity: 'email_prefix',
    })
  })
  test.each(['["password"]', 'true', '{}', 'not-json'])('rejects an invalid policy: %s', value => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS', value)
    expect(() => getTelemetryConfig()).toThrow()
  })
  test.each(['["email_prefix"]', '["email","user_id"]', 'email', 'user_id', '{}'])(
    'rejects an identity list or unsupported identity: %s',
    value => {
      vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', value)
      expect(() => getTelemetryConfig()).toThrow(/identity|distinct ID/i)
    }
  )
  test('rejects unsupported context fields and identity sources', () => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS', '["prompt"]')
    expect(() => getTelemetryConfig()).toThrow()
    vi.stubEnv('VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS', '[]')
    vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', 'email')
    expect(() => getTelemetryConfig()).toThrow()
  })
})
