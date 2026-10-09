const TELEMETRY_CONSENT_CHECKPOINTS = new Set([
  'telemetry-consent',
  'harness-apps',
  'native-window-startup',
  'plugin-marketplace-lifecycle',
  'plugin-lifecycle',
])

function shouldAcceptInitialTelemetryConsent(selectedCheckpoint) {
  return !selectedCheckpoint || TELEMETRY_CONSENT_CHECKPOINTS.has(selectedCheckpoint)
}

export { shouldAcceptInitialTelemetryConsent }
