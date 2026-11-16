import { appendFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { redactLog } from '../runtime/rotating-log.js'

export type E2EErrorLevel = 'error' | 'warning' | 'info'

/** A separate, non-rotating journal so assertions never depend on log tails. */
export class E2EErrorLog {
  private sequence = 0
  private failedWrites = 0
  private readonly instanceId = randomUUID()

  constructor(
    private readonly path: string | undefined,
    private readonly reportFailure: (message: string) => void = message => {
      process.stderr.write(message)
    }
  ) {
    if (path) this.record('collector', 'started', 'info', {})
  }

  record(
    source: string,
    type: string,
    level: E2EErrorLevel,
    details: Record<string, unknown>
  ): void {
    if (!this.path) return
    const entry = {
      instanceId: this.instanceId,
      pid: process.pid,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      source,
      type,
      level,
      details,
    }
    try {
      // Redact values before JSON encoding, preserving valid JSON even for quotes.
      const line = JSON.stringify(entry, (key, value: unknown) => {
        if (
          /^(authorization|access_token|auth_token|api_key|cookie|password|refresh_token|secret|token)$/i.test(
            key
          )
        )
          return '[REDACTED]'
        return typeof value === 'string' ? redactLog(value) : value
      })
      appendFileSync(this.path, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      this.failedWrites += 1
      // Never recurse through the console hook or prevent the app from opening.
      this.reportFailure('[desktop-e2e-collector-failed]\n')
    }
  }

  checkpoint() {
    this.record('collector', 'checkpoint', 'info', {})
    let byteLength = 0
    if (this.path) {
      try {
        byteLength = statSync(this.path).size
      } catch {
        this.failedWrites += 1
      }
    }
    return {
      enabled: Boolean(this.path),
      instanceId: this.instanceId,
      sequence: this.sequence,
      failedWrites: this.failedWrites,
      byteLength,
    }
  }
}

export function recordE2ERendererError(
  message: string,
  details: Record<string, unknown>,
  level: number
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
  e2eErrorLog.record('renderer', type, level === 3 ? 'error' : 'warning', {
    ...details,
    ...errorDetails,
  })
}

export const e2eErrorLog = new E2EErrorLog(
  process.env.VITE_WEWORK_E2E === 'true' && process.env.WEWORK_E2E_CONTROL_URL
    ? process.env.WEWORK_E2E_ERROR_LOG
    : undefined
)
