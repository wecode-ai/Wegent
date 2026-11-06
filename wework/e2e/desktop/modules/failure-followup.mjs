import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_FAILURE_FOLLOWUP_DELAY_MS = 3_000
// One hard budget covers the observation delay and both capture commands.
// The control server separately allows up to 30 seconds for command delivery
// when a client stops polling, so a per-command timeoutMs alone cannot bound
// the follow-up; Promise.race over the whole capture keeps the worst case at
// this deadline regardless of the server's internal timeouts.
const DEFAULT_FAILURE_FOLLOWUP_BUDGET_MS = 10_000

/**
 * A disabled or missing control at step-timeout time can be either a slow
 * asynchronous update or a stuck state. Resolve the environment override to a
 * bounded observation delay; 0 disables the follow-up capture entirely.
 */
export function failureFollowupDelayMs(rawValue = process.env.WEWORK_E2E_FAILURE_FOLLOWUP_MS) {
  if (rawValue === undefined || rawValue === '') return DEFAULT_FAILURE_FOLLOWUP_DELAY_MS
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, 5_000)
    : DEFAULT_FAILURE_FOLLOWUP_DELAY_MS
}

function withDeadline(promise, deadlineAt, label) {
  let timeout
  const deadline = new Promise((resolvePromise, reject) => {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) {
      reject(new Error(`The failure follow-up ${label} exceeded its overall deadline`))
      return
    }
    timeout = setTimeout(() => {
      reject(new Error(`The failure follow-up ${label} exceeded its overall deadline`))
    }, remaining)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout))
}

/**
 * Re-capture UI and workbench state after a bounded delay once a checkpoint
 * step has already failed. The follow-up never weakens the original assertion:
 * it only records whether the observed state settled after the timeout, which
 * separates runner slowness from a product defect when analyzing evidence.
 */
export async function captureFailureFollowup(
  control,
  resultDir,
  delayMs = failureFollowupDelayMs()
) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return null
  delayMs = Math.min(delayMs, 5_000)
  const deadlineAt = Date.now() + DEFAULT_FAILURE_FOLLOWUP_BUDGET_MS
  await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
  const [snapshot, workbenchDebug] = await withDeadline(
    Promise.all([
      control.command('snapshot', 'body', { timeoutMs: 5_000 }),
      control.command('getWorkbenchDebugSnapshot', 'body', {
        timeoutMs: 5_000,
      }),
    ]),
    deadlineAt,
    'capture'
  )
  const followup = {
    capturedAt: new Date().toISOString(),
    delayMs,
    budgetMs: DEFAULT_FAILURE_FOLLOWUP_BUDGET_MS,
    uiSnapshot: JSON.parse(snapshot),
    workbenchDebug: JSON.parse(workbenchDebug),
  }
  await writeFile(
    join(resultDir, 'failure-followup.json'),
    `${JSON.stringify(followup, null, 2)}\n`,
    'utf8'
  )
  return followup
}
