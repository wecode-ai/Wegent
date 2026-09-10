const TELEMETRY_CONSENT_CHECKPOINTS = new Set(['telemetry-consent', 'harness-apps'])

function shouldAcceptInitialTelemetryConsent(selectedCheckpoint) {
  return !selectedCheckpoint || TELEMETRY_CONSENT_CHECKPOINTS.has(selectedCheckpoint)
}

export { shouldAcceptInitialTelemetryConsent }
