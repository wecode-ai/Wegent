const TELEMETRY_CONSENT_CHECKPOINTS = new Set([
  'telemetry-consent',
  'telemetry-identity',
  'harness-app-development',
  'harness-app-lifecycle',
  'native-window-startup',
  'plugin-marketplace-lifecycle',
  'plugin-lifecycle',
])

// Checkpoints that run the app with a distribution-installed policy fixture.
const IDENTIFIED_TELEMETRY_CHECKPOINTS = new Set(['telemetry-identity'])

function shouldAcceptInitialTelemetryConsent(selectedCheckpoint) {
  return !selectedCheckpoint || TELEMETRY_CONSENT_CHECKPOINTS.has(selectedCheckpoint)
}

function initialTelemetryPosture(selectedCheckpoint) {
  return IDENTIFIED_TELEMETRY_CHECKPOINTS.has(selectedCheckpoint) ? 'identified' : 'anonymous'
}

export { initialTelemetryPosture, shouldAcceptInitialTelemetryConsent }
