// Increment when the upgrade/rollback acceptance contract changes. Release proof
// from an older suite cannot authorize a new edge under the current contract.
export const UPGRADE_SUITE_VERSION = 3
export const UPGRADE_CHECKPOINTS = [
  'app-upgrade',
  'app-rollback',
  'app-rollback-recovery',
  'app-upgrade-recovery',
]
export const UPGRADE_PACKAGE_CHECKPOINTS = [...UPGRADE_CHECKPOINTS, 'app-update-full']
export const UPGRADE_CHECKPOINT_GROUP = 'upgrade-and-rollback'
