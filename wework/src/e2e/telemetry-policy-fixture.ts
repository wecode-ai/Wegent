import type { TelemetryPolicy } from '@/extensions/telemetry-policy-contract'

/**
 * Desktop E2E fixtures for the telemetry policy seam. A distribution installs
 * its own `@extensions/telemetry-policy` module; the E2E build selects these
 * fixtures at runtime so one bundle can verify both postures the seam allows.
 */
const ANONYMOUS_POLICY: TelemetryPolicy = {
  personProfiles: 'never',
  sendClientIp: false,
  identityFor: () => null,
}

const IDENTIFIED_POLICY: TelemetryPolicy = {
  personProfiles: 'identified_only',
  sendClientIp: true,
  identityFor: user =>
    user && user.id > 0
      ? { distinctId: user.user_name, properties: { username: user.user_name } }
      : null,
}

/**
 * Resolves the policy an E2E app instance reports with. Anything other than an
 * explicit `identified` request stays on the public anonymous posture, so a
 * missing or misspelled fixture can never identify a test session.
 */
export function resolveE2ETelemetryPolicy(
  fixture: 'anonymous' | 'identified' | undefined
): TelemetryPolicy {
  return fixture === 'identified' ? IDENTIFIED_POLICY : ANONYMOUS_POLICY
}
