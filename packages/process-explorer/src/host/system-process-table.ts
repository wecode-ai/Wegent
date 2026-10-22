import type { ProcessDegradation } from '../contract.js'
import type { SystemProcessInfo } from '../core/build-snapshot.js'

export interface SystemProcessTableResult {
  processes: SystemProcessInfo[]
  /** Non-fatal gaps, surfaced in `ProcessSnapshot.degraded`. */
  degraded: ProcessDegradation[]
}

export interface SystemProcessTable {
  read: () => Promise<SystemProcessTableResult>
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
