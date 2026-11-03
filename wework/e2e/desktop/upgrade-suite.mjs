// Increment when the upgrade/rollback acceptance contract changes. Release proof
// from an older suite cannot authorize a new edge under the current contract.
export const UPGRADE_SUITE_VERSION = 12
export { RELEASE_PREPARATION_PHASE_TIMEOUT_MS as UPGRADE_PREPARATION_PHASE_TIMEOUT_MS } from '../../electron/src/runtime/release-preparation-progress.mjs'
export const UPGRADE_CHECKPOINTS = [
  'app-upgrade',
  'app-rollback',
  'app-rollback-recovery',
  'app-upgrade-recovery',
]
export const UPGRADE_PACKAGE_CHECKPOINTS = [...UPGRADE_CHECKPOINTS, 'app-update-full']
// Additional package diagnostics cannot certify an upgrade edge by themselves.
export const UPGRADE_DIAGNOSTIC_CHECKPOINTS = [...UPGRADE_PACKAGE_CHECKPOINTS, 'app-update-refresh']
export const UPGRADE_CHECKPOINT_GROUP = 'upgrade-and-rollback'

export function rejectFailedReleaseCheckpoint(checkpoint, result) {
  if (UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(checkpoint) && result.code !== 0) {
    throw new Error(`Release package checkpoint failed: ${checkpoint}`)
  }
}
