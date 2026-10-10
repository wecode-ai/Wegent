import type { TelemetryPolicy } from './telemetry-policy-contract'

/**
 * Public Wework keeps product analytics anonymous: no person profiles, no
 * client IP, and no account identity. Product distributions replace this
 * module at build time through the `@extensions` alias.
 */
export const telemetryPolicy: TelemetryPolicy = {
  personProfiles: 'never',
  sendClientIp: false,
  identityFor: () => null,
}
