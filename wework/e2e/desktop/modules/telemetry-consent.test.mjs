import assert from 'node:assert/strict'
import test from 'node:test'

import {
  initialTelemetryPosture,
  shouldAcceptInitialTelemetryConsent,
} from './telemetry-consent.mjs'

test('accepts telemetry consent for checkpoints that assert public telemetry', () => {
  assert.equal(shouldAcceptInitialTelemetryConsent(undefined), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('telemetry-consent'), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('telemetry-identity'), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('harness-app-lifecycle'), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('native-window-startup'), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('plugin-marketplace-lifecycle'), true)
  assert.equal(shouldAcceptInitialTelemetryConsent('plugin-lifecycle'), true)
})

test('declines telemetry consent for unrelated isolated checkpoints', () => {
  assert.equal(shouldAcceptInitialTelemetryConsent('browser-annotation-design'), false)
})

test('runs the identified policy fixture only for the telemetry-identity checkpoint', () => {
  assert.equal(initialTelemetryPosture('telemetry-identity'), 'identified')
  assert.equal(initialTelemetryPosture('telemetry-consent'), 'anonymous')
  assert.equal(initialTelemetryPosture(undefined), 'anonymous')
  assert.equal(initialTelemetryPosture('core-task-flow'), 'anonymous')
})
