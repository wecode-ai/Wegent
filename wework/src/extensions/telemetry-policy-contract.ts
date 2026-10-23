import type { User } from '@/types/api'

export type TelemetryPersonProfiles = 'never' | 'identified_only' | 'always'

export interface TelemetryIdentity {
  /** Stable distinct id PostHog reports for this account. */
  readonly distinctId: string
  /** Person properties stored on the account profile. */
  readonly properties: Readonly<Record<string, string>>
}

/**
 * Distribution policy for product analytics. The public Wework implementation
 * in `telemetry-policy.ts` is fully anonymous; a product distribution replaces
 * that module with the policy its deployment requires.
 */
export interface TelemetryPolicy {
  /** PostHog person profile mode; `never` keeps every event anonymous. */
  readonly personProfiles: TelemetryPersonProfiles
  /** Send the client IP so PostHog can keep it and geo-enrich events. */
  readonly sendClientIp: boolean
  /** Account identity for the signed-in user; `null` keeps events anonymous. */
  readonly identityFor: (user: User | null) => TelemetryIdentity | null
}
