import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { redactLog, RotatingLog } from './rotating-log.js'

let log: RotatingLog | undefined

/** Keep isolated activation diagnostics after Electron's relaunch loses stdio. */
export function recordReleaseDiagnostic(
  event: string,
  details: Record<string, unknown>,
  synchronous = false
): void {
  const root = process.env.WEWORK_RELEASE_ROOT
  if (!root || !process.env.WEWORK_E2E_CONTROL_URL) return
  const path = join(root, 'activation-diagnostics.log')
  const message = JSON.stringify({
    event,
    releaseId: process.env.WEWORK_ACTIVE_RELEASE_ID,
    ...details,
  })
  if (synchronous) {
    // Electron's native quit can stop the event loop before an async write starts.
    try {
      appendFileSync(path, `${new Date().toISOString()} [stdout] ${redactLog(message)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    } catch (error) {
      reportDiagnosticError(error)
    }
    return
  }
  log ??= new RotatingLog({ path, maxEntryBytes: 8192 })
  void log.write('stdout', message).catch(reportDiagnosticError)
}

function reportDiagnosticError(error: unknown): void {
  console.error('[release-diagnostic] Failed to write activation diagnostics', {
    errorType: error instanceof Error ? error.name : typeof error,
  })
}
