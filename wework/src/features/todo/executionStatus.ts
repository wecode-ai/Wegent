// Shared execution-status vocabulary for board task runs, comments and
// scheduled automations. Every surface must derive its status from this
// module so the same execution never renders different states in different
// places.

export type ExecutionDisplayStatus = 'running' | 'completed'

// Non-terminal states. `pending_approval` is still in flight (it waits for a
// human decision before the run can finish).
const EXECUTION_RUNNING_STATUSES = new Set([
  'assigned',
  'claimed',
  'in_progress',
  'pending',
  'pending_approval',
  'queued',
  'running',
  'streaming',
  'waiting_device',
])

// Terminal states, including non-success outcomes (failed/cancelled/skipped).
// The outcome itself stays visible through the error or note text.
const EXECUTION_COMPLETED_STATUSES = new Set([
  'canceled',
  'cancelled',
  'completed',
  'done',
  'error',
  'failed',
  'failure',
  'idle',
  'interrupted',
  'skipped',
  'stalled',
  'success',
  'succeeded',
])

// Terminal non-success outcomes, used only by recovery actions (rerun, stop)
// and never rendered as a standalone status.
export const EXECUTION_FAILED_STATUSES = new Set([
  'canceled',
  'cancelled',
  'error',
  'failed',
  'failure',
  'interrupted',
  'stalled',
])

export function executionDisplayStatus(
  status: string | null | undefined
): ExecutionDisplayStatus | null {
  if (status == null || status === '') return null
  const normalized = status.toLowerCase()
  if (EXECUTION_COMPLETED_STATUSES.has(normalized)) return 'completed'
  if (EXECUTION_RUNNING_STATUSES.has(normalized)) return 'running'
  // Unknown states default to running so an execution is never mistaken for
  // finished while its outcome is unclear.
  return 'running'
}

export function isExecutionRunning(status: string | null | undefined): boolean {
  return executionDisplayStatus(status) === 'running'
}

export function isExecutionFailed(status: string | null | undefined): boolean {
  if (status == null || status === '') return false
  return EXECUTION_FAILED_STATUSES.has(status.toLowerCase())
}
