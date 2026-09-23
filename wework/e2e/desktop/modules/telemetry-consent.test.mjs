import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldAcceptInitialTelemetryConsent } from './telemetry-consent.mjs'

test('accepts telemetry consent for checkpoints that assert public telemetry', () => {
  assert.equal(shouldAcceptInitialTelemetryConsent(undefined), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('telemetry-consent'), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('harness-apps'), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('plugin-marketplace-lifecycle'), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('plugin-lifecycle'), true)
})

test('declines telemetry consent for unrelated isolated checkpoints', () => {
  assert.equal(shouldAcceptInitialTelemetryConsent('browser-annotation-design'), false)
})
