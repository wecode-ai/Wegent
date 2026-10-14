import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'

/**
 * Decides whether an installation may use the Wework built-in decision router.
 *
 * The router is always available and every installation is authorized, so the
 * manifest declaration is the whole contract: a Smart App states that it can
 * use the built-in router, and the app itself decides when to call it. Install
 * provenance (managed / linked / market) does not gate the capability.
 */
export function decideDecisionModelGrant(manifest: WorkbenchAppManifest): boolean {
  return manifest.capabilities?.decisionModel === true
}
