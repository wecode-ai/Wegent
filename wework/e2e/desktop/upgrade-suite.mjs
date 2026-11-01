// Increment when the upgrade/rollback acceptance contract changes. Release proof
// from an older suite cannot authorize a new edge under the current contract.
export const UPGRADE_SUITE_VERSION = 7
export const UPGRADE_FIXTURE_UPDATE_BASE_URL = 'http://127.0.0.1:48191'
export const UPGRADE_PREPARATION_PHASE_TIMEOUT_MS = 300_000
export const UPGRADE_CHECKPOINTS = [
  'app-upgrade',
  'app-rollback',
  'app-rollback-recovery',
  'app-upgrade-recovery',
]
export const UPGRADE_PACKAGE_CHECKPOINTS = [...UPGRADE_CHECKPOINTS, 'app-update-full']
export const UPGRADE_CHECKPOINT_GROUP = 'upgrade-and-rollback'
