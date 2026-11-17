import { e2eErrorLog, type E2EErrorLog } from './e2e-error-log.js'

/** The native owner observes plugin outcomes even without a renderer subscriber. */
export function recordE2ERuntimeEvent(
  event: string,
  payload: Record<string, unknown>,
  journal: Pick<E2EErrorLog, 'record'> = e2eErrorLog
): void {
  if (event !== 'runtime.hooks.run_completed') return
  const run = payload.run
  const result =
    run && typeof run === 'object' && !Array.isArray(run) ? (run as Record<string, unknown>) : null
  const status = result?.status
  if (
    !result ||
    typeof result.runId !== 'string' ||
    !['succeeded', 'failed', 'timed_out', 'skipped_capacity'].includes(String(status))
  ) {
    journal.record('runtime', 'plugin-hook-protocol-error', 'error', { event, payload })
    return
  }
  const level =
    status === 'succeeded' ? 'info' : status === 'skipped_capacity' ? 'warning' : 'error'
  journal.record('runtime', 'plugin-hook-completed', level, { event, run: result })
}
