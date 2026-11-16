import { rejectFailedReleaseCheckpoint } from '../../e2e/desktop/upgrade-suite.mjs'

/** A completed rejection is not proof of compatibility; interruptions are not results. */
export function upgradeCheckpointPassed(checkpoint, { code, signal }, diagnostic = false) {
  if (signal) throw new Error(`Upgrade verification interrupted by ${signal}`)
  if (!Number.isInteger(code) || code < 0)
    throw new Error('Upgrade verification did not produce an exit status')
  if (diagnostic) rejectFailedReleaseCheckpoint(checkpoint, { code })
  return code === 0
}
