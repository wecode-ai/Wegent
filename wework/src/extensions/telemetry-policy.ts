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
 * Resolves the policy the app reports with. Desktop E2E builds may point at a
 * distribution fixture; the build flag is static, so production bundles compile
 * that branch away and always resolve the anonymous policy above.
 *
 * The fixture is read on every access instead of once at module evaluation: the
 * E2E runtime configuration is delivered by the desktop shell and can arrive
 * after this module is imported, which is also why `posthogHost` is read when
 * the client initializes rather than at import time.
 */
function resolveTelemetryPolicy(): TelemetryPolicy {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return anonymousTelemetryPolicy
  return resolveE2ETelemetryPolicy(getDesktopE2ERuntimeConfig().telemetryPolicy)
}

export const telemetryPolicy: TelemetryPolicy = {
  get personProfiles() {
    return resolveTelemetryPolicy().personProfiles
  },
  get sendClientIp() {
    return resolveTelemetryPolicy().sendClientIp
  },
  identityFor: user => resolveTelemetryPolicy().identityFor(user),
}
