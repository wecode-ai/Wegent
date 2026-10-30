const TELEMETRY_CONSENT_CHECKPOINTS = new Set([
  'telemetry-consent',
  'harness-app-development',
  'harness-app-lifecycle',
  'native-window-startup',
  'plugin-marketplace-lifecycle',
  'plugin-lifecycle',
])

function shouldAcceptInitialTelemetryConsent(selectedCheckpoint) {
  return !selectedCheckpoint || TELEMETRY_CONSENT_CHECKPOINTS.has(selectedCheckpoint)
}

function shouldPromptInitialTelemetryConsent(selectedCheckpoint, usesInternalTelemetry) {
  return !usesInternalTelemetry && shouldAcceptInitialTelemetryConsent(selectedCheckpoint)
}

export { shouldAcceptInitialTelemetryConsent, shouldPromptInitialTelemetryConsent }
