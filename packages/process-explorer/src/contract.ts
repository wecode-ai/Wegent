/**
 * Neutral process-explorer contract. Nothing in this file imports Electron,
 * Node, React, or application code so the same types describe a snapshot in the
 * main process and in any renderer.
 */

/**
 * Semantic process kind. The first block maps to Electron's reported process
 * types; the second block describes processes the host knows about but Electron
 * does not manage.
 */
export type ProcessKind =
  | 'application'
  | 'window'
  | 'gpu'
  | 'utility'
  | 'zygote'
  | 'sandbox-helper'
  | 'pepper'
  | 'host-service'
  | 'host-child'
  | 'system'

export type ProcessSource = 'electron' | 'host' | 'system'

/**
 * Product-level ownership. `id` is stable and used for grouping; `label` is the
 * host's fallback text; `key` lets an application localize a known owner.
 */
export interface ProcessOwnerRef {
  id: string
  label: string
  key?: string
}

export interface ProcessRecord {
  /**
   * Stable identity in the form `${pid}:${creationTime}`. Electron documents
   * that a pid can be reused, so a bare pid is never a safe target.
   */
  id: string
  pid: number
  parentPid: number | null
  kind: ProcessKind
  source: ProcessSource
  /** The WeWork object that owns this process, supplied by the host. */
  owner: ProcessOwnerRef
  /** Primary label, for example "Network Service" or an injected "Executor". */
  name: string
  /** Secondary metadata, usually launch details or a window label. */
  detail: string | null
  cpuPercent: number | null
  memoryBytes: number | null
  idleWakeupsPerSecond: number | null
  /** Process start time in epoch milliseconds, when the platform reports it. */
  startedAt: number | null
}

export interface ProcessDegradation {
  code:
    | 'system-process-table-unavailable'
    | 'system-process-table-failed'
    | 'renderer-labels-failed'
    | 'host-process-provider-failed'
  detail?: string
}

export interface ProcessSnapshot {
  capturedAt: number
  platform: string
  applicationPid: number
  processes: ProcessRecord[]
  /** Non-fatal collection gaps, for example a failed system process table. */
  degraded: ProcessDegradation[]
}

/**
 * A process the embedding host knows about but Electron does not report. The
 * descriptor supplies identity and presentation only.
 */
export interface HostProcessDescriptor {
  pid: number
  name: string
  kind: Extract<ProcessKind, 'host-service' | 'host-child'>
  owner: ProcessOwnerRef
  /** Stable host-supplied suffix for `ProcessRecord.id`, when available. */
  identity?: string
  /** Include the process tree below this pid, labelled as host children. */
  includeDescendants?: boolean
}

export type HostProcessProvider = () =>
  | readonly HostProcessDescriptor[]
  | Promise<readonly HostProcessDescriptor[]>

/** Transport-neutral client the view uses; the host supplies an implementation. */
export interface ProcessExplorerClient {
  snapshot: () => Promise<ProcessSnapshot>
}
