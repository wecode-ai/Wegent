import { E2EErrorLog } from './e2e-error-journal.mjs'
export { E2EErrorLog } from './e2e-error-journal.mjs'

export type E2EErrorLevel = 'error' | 'warning' | 'info'

export function recordE2ERendererError(
  message: string,
  details: Record<string, unknown>,
  level: number,
  log: E2EErrorLog = e2eErrorLog
): void {
  const prefix = '[wework-e2e-error] '
  let type = level === 3 ? 'renderer-error' : 'renderer-warning'
  let errorDetails: Record<string, unknown> = { message }
  if (message.startsWith(prefix)) {
    try {
      const report = JSON.parse(message.slice(prefix.length)) as Record<string, unknown>
      if (typeof report.type === 'string' && typeof report.message === 'string') {
        type = report.type
        errorDetails = {
          message: report.message,
          ...(report.diagnostics && typeof report.diagnostics === 'object'
            ? { diagnostics: report.diagnostics }
            : {}),
          ...(typeof report.stack === 'string' ? { stack: report.stack } : {}),
          ...Object.fromEntries(
            ['code', 'status', 'errorCode', 'retryable']
              .filter(key => ['string', 'number', 'boolean'].includes(typeof report[key]))
              .map(key => [key, report[key]])
          ),
        }
      }
    } catch {
      // Keep malformed reports as console errors so they remain assertable.
    }
  }
  log.record('renderer', type, level === 3 ? 'error' : 'warning', {
    ...details,
    ...errorDetails,
  })
}

export const e2eErrorLog = new E2EErrorLog(
  process.env.VITE_WEWORK_E2E === 'true' && process.env.WEWORK_E2E_CONTROL_URL
    ? process.env.WEWORK_E2E_ERROR_LOG
    : undefined
)
