import { appendFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { redactLog } from '../runtime/log-redaction.mjs'

/** A separate, non-rotating journal so assertions never depend on log tails. */
export class E2EErrorLog {
  sequence = 0
  failedWrites = 0
  instanceId = randomUUID()

  constructor(
    path,
    reportFailure = message => {
      process.stderr.write(message)
    }
  ) {
    this.path = path
    this.reportFailure = reportFailure
    if (path) this.record('collector', 'started', 'info', {})
  }

  record(source, type, level, details) {
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
      const line = JSON.stringify(entry, (key, value) => {
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
