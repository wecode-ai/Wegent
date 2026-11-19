// Increment when the upgrade/rollback acceptance contract changes. Release proof
// from an older suite cannot authorize a new edge under the current contract.
export const UPGRADE_SUITE_VERSION = 25
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

/** Protected credentials must survive rollback and the next target activation. */
export function credentialsRequireReupgrade(credentials) {
  return credentials.some(entry => entry.format === 3 || entry.storageVersion === 3)
}

export function credentialRoundTripPassed(evidence) {
  if (!Array.isArray(evidence.credentials)) return false
  const reupgrade = credentialsRequireReupgrade(evidence.credentials)
  const expected = ['source', 'upgraded', 'rolled-back', ...(reupgrade ? ['re-upgraded'] : [])]
  const protection = evidence.rollbackProtection
  if (reupgrade ? evidence.reupgrade !== 'passed' : evidence.reupgrade !== 'not-run') return false
  if (
    !protection ||
    protection.version !== evidence.toVersion ||
    protection.packageSha256 !== evidence.target ||
    !['blocked', 'confirmation-required'].includes(protection.kind) ||
    protection.historyPreserved !== true ||
    protection.downloadPrevented !== true
  )
    return false
  if (
    reupgrade &&
    (protection.kind !== 'confirmation-required' || protection.retryConfirmed !== true)
  )
    return false
  const formats = { shared: 2, 'isolated-copy-once': 3 }
  return (
    evidence.credentials.length === expected.length &&
    evidence.credentials.every((entry, index) => {
      const mode = entry.storageMode ?? 'shared'
      if (!Object.hasOwn(formats, mode)) return false
      const isolated = mode === 'isolated-copy-once'
      if (
        entry.stage !== expected[index] ||
        ![2, 3].includes(entry.storageVersion) ||
        entry.format !== Math.max(formats[mode], entry.storageVersion) ||
        (isolated && entry.storageVersion !== 3) ||
        (isolated &&
          entry.stage === 'upgraded' &&
          (entry.legacyFilesPreserved !== true || entry.legacyModelBindingsPreserved !== true)) ||
        (isolated && entry.stage === 're-upgraded' && entry.newStoreIndependent !== true) ||
        (['upgraded', 'rolled-back'].includes(entry.stage) && entry.writeAuthenticated !== true) ||
        entry.modelAuthenticated !== true ||
        entry.cloudDeviceSignature !== true
      )
        return false
      formats[mode] = entry.format
      return true
    })
  )
}

/** Explicit immutable bridge pairs are diagnostics, never catalog promotion. */
export function isUpgradeSourceDiagnostic(checkpoint) {
  return checkpoint === UPGRADE_CHECKPOINT_GROUP || UPGRADE_SOURCE_DIAGNOSTICS.includes(checkpoint)
}

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
