import { join } from 'node:path'
import { RotatingLog } from './rotating-log.js'

let log: RotatingLog | undefined

/** Keep isolated activation diagnostics after Electron's relaunch loses stdio. */
export function recordReleaseDiagnostic(event: string, details: Record<string, unknown>): void {
  const root = process.env.WEWORK_RELEASE_ROOT
  if (!root || !process.env.WEWORK_E2E_CONTROL_URL) return
  log ??= new RotatingLog({ path: join(root, 'activation-diagnostics.log'), maxEntryBytes: 8192 })
  void log
    .write(
      'stdout',
      JSON.stringify({ event, releaseId: process.env.WEWORK_ACTIVE_RELEASE_ID, ...details })
    )
    .catch(error => {
      console.error('[release-diagnostic] Failed to write activation diagnostics', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
    })
}
