import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'

/**
 * Install provenance for a Smart app. A manifest capability request is only a
 * request; this module decides whether Wework actually grants it.
 */
export type SmartAppCapabilitySource = 'managed' | 'linked' | 'market'

export interface SmartAppCapabilityPolicyInput {
  manifest: WorkbenchAppManifest
  source: SmartAppCapabilitySource
  smartAppId: number | null
  environment: NodeJS.ProcessEnv
}

export const DECISION_MODEL_CAPABILITY = 'decisionModel'

/**
 * Decides whether an installation may use the Wework built-in decision router.
 *
 * A manifest that sets `capabilities.decisionModel` only requests the
 * capability. Wework grants it only when the install provenance is trusted:
 * a marketplace release whose id is on the build-time allowlist, or a linked
 * project while the explicit development switch is on. Because the allowlist
 * and the development switch are injected by trusted builds and platform
 * configuration, a package that merely declares the flag can never grant
 * itself the capability.
 */
export function decideDecisionModelGrant(input: SmartAppCapabilityPolicyInput): boolean {
  if (input.manifest.capabilities?.decisionModel !== true) return false
  if (input.source === 'market') {
    const smartAppId = input.smartAppId
    if (typeof smartAppId !== 'number' || !Number.isSafeInteger(smartAppId)) return false
    return grantedMarketSmartAppIds(input.environment).has(smartAppId)
  }
  if (input.source === 'linked') {
    return isEnabledFlag(input.environment.WEWORK_DECISION_PROXY_ALLOW_LINKED_APPS)
  }
  return false
}

/**
 * Parses the trusted marketplace allowlist. A malformed value grants nothing,
 * so a broken build configuration can only deny access, never widen it.
 */
export function grantedMarketSmartAppIds(environment: NodeJS.ProcessEnv): Set<number> {
  const raw = environment.WEWORK_DECISION_PROXY_GRANTED_SMART_APP_IDS_JSON
  if (typeof raw !== 'string' || !raw.trim()) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set()
  }
  if (!Array.isArray(parsed)) return new Set()
  const ids = new Set<number>()
  for (const value of parsed) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ids.add(value)
  }
  return ids
}

function isEnabledFlag(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true'
}
