import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
import { resolveE2ETelemetryPolicy } from '@/e2e/telemetry-policy-fixture'
import type { TelemetryPolicy } from './telemetry-policy-contract'

/**
 * Public Wework keeps product analytics anonymous: no person profiles, no
 * client IP, and no account identity. Product distributions replace this
 * module at build time through the `@extensions` alias.
 */
const anonymousTelemetryPolicy: TelemetryPolicy = {
  personProfiles: 'never',
  sendClientIp: false,
  identityFor: () => null,
}

/**
 * Desktop E2E builds must be able to exercise a distribution-installed policy,
 * otherwise the identified path can never run end to end. The build flag is
 * static, so production bundles compile the fixture branch away and always
 * export the anonymous policy above.
 */
export const telemetryPolicy: TelemetryPolicy =
  import.meta.env.VITE_WEWORK_E2E === 'true'
    ? resolveE2ETelemetryPolicy(getDesktopE2ERuntimeConfig().telemetryPolicy)
    : anonymousTelemetryPolicy
