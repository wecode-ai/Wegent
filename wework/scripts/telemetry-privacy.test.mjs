import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyInitialTelemetryConsent } from '../e2e/desktop/modules/preferences-automation-flows.mjs'

function receiver(properties) {
  const event = {
    event: 'app_started',
    properties: {
      surface: 'main',
      platform: 'linux',
      os: 'linux',
      event_schema_version: 1,
      telemetry_source: 'wework',
      ...properties,
    },
  }
  let accepted = false
  return {
    telemetryRequests: [{ payload: event, rawBody: JSON.stringify(event) }],
    telemetryRequestCount: () => (accepted ? 1 : 0),
    command: async () => JSON.stringify({ testIds: [] }),
    awaitTelemetryEvent: async () => {
      accepted = true
    },
  }
}

test('consent verification accepts the defined common metadata', async () => {
  await verifyInitialTelemetryConsent(receiver({}), [])
})

test('consent verification still rejects unlisted account attributes', async () => {
  await assert.rejects(
    verifyInitialTelemetryConsent(receiver({ email: 'private@example.invalid' }), []),
    /privacy allowlist/
  )
})

test('consent verification rejects a platform inconsistent with the operating system', async () => {
  await assert.rejects(verifyInitialTelemetryConsent(receiver({ platform: 'mac' }), []))
})

test('consent verification rejects an unsupported event schema version', async () => {
  await assert.rejects(verifyInitialTelemetryConsent(receiver({ event_schema_version: 2 }), []))
})
