// Increment when the upgrade/rollback acceptance contract changes. Release proof
// from an older suite cannot authorize a new edge under the current contract.
export const UPGRADE_SUITE_VERSION = 18
export { RELEASE_PREPARATION_PHASE_TIMEOUT_MS as UPGRADE_PREPARATION_PHASE_TIMEOUT_MS } from '../../electron/src/runtime/release-preparation-progress.mjs'
export const UPGRADE_CHECKPOINTS = ['app-rollback', 'app-rollback-recovery', 'app-upgrade-recovery']
export const UPGRADE_PACKAGE_CHECKPOINTS = UPGRADE_CHECKPOINTS
// Additional package diagnostics cannot certify an upgrade edge by themselves.
export const UPGRADE_SOURCE_DIAGNOSTICS = ['app-update-refresh', 'app-update-retry']
export const UPGRADE_DIAGNOSTIC_CHECKPOINTS = [
  ...UPGRADE_PACKAGE_CHECKPOINTS,
  ...UPGRADE_SOURCE_DIAGNOSTICS,
]
export const UPGRADE_CHECKPOINT_GROUP = 'upgrade-and-rollback'

/** Windows certifies the core round trip; macOS also exercises fault recovery. */
export function upgradeVerificationCheckpoint(platform) {
  return upgradeIncludesFaultRecovery(platform) ? UPGRADE_CHECKPOINT_GROUP : 'app-rollback'
}

export function upgradeIncludesFaultRecovery(platform) {
  if (platform === 'windows') return false
  if (platform === 'macos') return true
  throw new Error(`Unsupported upgrade verification platform: ${platform}`)
}

export function rejectFailedReleaseCheckpoint(checkpoint, result) {
  if (
    (checkpoint === UPGRADE_CHECKPOINT_GROUP ||
      UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(checkpoint)) &&
    result.code !== 0
  )
    throw new Error(`Release package checkpoint failed: ${checkpoint}`)
}
