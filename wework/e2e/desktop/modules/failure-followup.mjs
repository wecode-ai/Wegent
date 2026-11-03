import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_FAILURE_FOLLOWUP_DELAY_MS = 3_000
const FOLLOWUP_COMMAND_TIMEOUT_MS = 5_000

/**
 * A disabled or missing control at step-timeout time can be either a slow
 * asynchronous update or a stuck state. Resolve the environment override to a
 * bounded observation delay; 0 disables the follow-up capture entirely.
 */
export function failureFollowupDelayMs(rawValue = process.env.WEWORK_E2E_FAILURE_FOLLOWUP_MS) {
  if (rawValue === undefined || rawValue === '') return DEFAULT_FAILURE_FOLLOWUP_DELAY_MS
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FAILURE_FOLLOWUP_DELAY_MS
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
  await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
  const [snapshot, workbenchDebug] = await Promise.all([
    control.command('snapshot', 'body', { timeoutMs: FOLLOWUP_COMMAND_TIMEOUT_MS }),
    control.command('getWorkbenchDebugSnapshot', 'body', {
      timeoutMs: FOLLOWUP_COMMAND_TIMEOUT_MS,
    }),
  ])
  const followup = {
    capturedAt: new Date().toISOString(),
    delayMs,
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
