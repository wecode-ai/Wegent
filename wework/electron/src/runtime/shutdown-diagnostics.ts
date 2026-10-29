import { recordReleaseDiagnostic } from './release-diagnostics.js'

/** Preserve the last shutdown phase even if Electron blocks in native teardown. */
export async function traceShutdownStep<T>(
  step: string,
  operation: () => T | Promise<T>
): Promise<T> {
  const started = Date.now()
  const record = (status: string, error?: unknown) =>
    recordReleaseDiagnostic(
      'shutdown-step',
      {
        step,
        status,
        pid: process.pid,
        elapsedMs: Date.now() - started,
        ...(error === undefined
          ? {}
          : { errorType: error instanceof Error ? error.name : typeof error }),
      },
      true
    )
  record('started')
  try {
    const result = await operation()
    record('completed')
    return result
  } catch (error) {
    record('failed', error)
    throw error
  }
}
