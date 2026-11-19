import assert from 'node:assert/strict'

const TELEMETRY_CONSENT_CHECKPOINTS = new Set([
  'harness-app-lifecycle',
  'core-dsh-ui-plugin-composition',
  'plugin-marketplace-lifecycle',
  'plugin-lifecycle',
])

function shouldAcceptInitialTelemetryConsent(selectedCheckpoint) {
  return !selectedCheckpoint || TELEMETRY_CONSENT_CHECKPOINTS.has(selectedCheckpoint)
}

export { shouldAcceptInitialTelemetryConsent }

export async function verifyStaleTelemetryOptInRejected(control) {
  const refusal = JSON.parse(await control.command('getAppPreferences', 'body'))
  assert.equal(refusal.telemetryEnabled, false)
  assert.ok(refusal.telemetryConsentRevision > 0)
  await assert.rejects(
    control.command('setTelemetryConsent', 'body', {
      value: JSON.stringify({
        enabled: true,
        expectedRevision: refusal.telemetryConsentRevision - 1,
      }),
    }),
    /changed in another window/
  )
  const afterStaleOptIn = JSON.parse(await control.command('getAppPreferences', 'body'))
  assert.equal(afterStaleOptIn.telemetryEnabled, false, 'A stale opt-in replaced the saved refusal')
  assert.equal(afterStaleOptIn.telemetryConsentRevision, refusal.telemetryConsentRevision)
}
