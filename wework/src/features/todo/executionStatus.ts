// Shared execution-status vocabulary for board task runs, comments and
// scheduled automations. Every surface must derive its status from this
// module so the same execution never renders different states in different
// places.

export type ExecutionDisplayStatus =
  | 'waiting_approval'
  | 'queued'
  | 'starting'
  | 'waiting_runtime'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'unknown'

const STATUS_ALIASES: Readonly<Record<string, ExecutionDisplayStatus>> = {
  assigned: 'queued',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  cancel_requested: 'cancelling',
  cancelling: 'cancelling',
  claimed: 'starting',
  completed: 'succeeded',
  done: 'succeeded',
  error: 'failed',
  failed: 'failed',
  failure: 'failed',
  in_progress: 'running',
  interrupted: 'failed',
  pending: 'queued',
  pending_approval: 'waiting_approval',
  queued: 'queued',
  running: 'running',
  skipped: 'skipped',
  stalled: 'failed',
  starting: 'starting',
  streaming: 'running',
  success: 'succeeded',
  succeeded: 'succeeded',
  unknown: 'unknown',
  waiting_device: 'waiting_runtime',
  waiting_approval: 'waiting_approval',
  waiting_runtime: 'waiting_runtime',
}

const ACTIVE_DISPLAY_STATUSES = new Set<ExecutionDisplayStatus>([
  'waiting_approval',
  'queued',
  'starting',
  'waiting_runtime',
  'running',
  'cancelling',
  'unknown',
])

const TERMINAL_DISPLAY_STATUSES = new Set<ExecutionDisplayStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
])

export function executionDisplayStatus(
  status: string | null | undefined
): ExecutionDisplayStatus | null {
  if (status == null || status === '') return null
  const normalized = status.toLowerCase()
  return STATUS_ALIASES[normalized] ?? 'unknown'
}

export function isExecutionActive(status: string | null | undefined): boolean {
  const display = executionDisplayStatus(status)
  return display !== null && ACTIVE_DISPLAY_STATUSES.has(display)
}

export function isExecutionTerminal(status: string | null | undefined): boolean {
  const display = executionDisplayStatus(status)
  return display !== null && TERMINAL_DISPLAY_STATUSES.has(display)
}

export function isExecutionCancellable(status: string | null | undefined): boolean {
  const display = executionDisplayStatus(status)
  return display !== null && ACTIVE_DISPLAY_STATUSES.has(display) && display !== 'cancelling'
}

export function isExecutionFailed(status: string | null | undefined): boolean {
  return executionDisplayStatus(status) === 'failed'
}
