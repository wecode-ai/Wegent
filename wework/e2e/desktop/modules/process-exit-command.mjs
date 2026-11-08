import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { processIsAlive } from '../process-lifecycle.mjs'

/** A closing renderer cannot reliably acknowledge its own process termination. */
export async function completeCommandOnProcessExit(result, processId, timeoutMs) {
  let cancelled = false
  const exited = (async () => {
    const deadline = Date.now() + timeoutMs
    while (processIsAlive(processId)) {
      assert.ok(Date.now() < deadline, `The upgraded host ${processId} did not quit before restart`)
      await delay(25)
      if (cancelled) return
    }
    return 'exited'
  })()
  try {
    // An explicit command error still fails; a response alone cannot prove exit.
    return await Promise.race([exited, result.then(() => exited)])
  } finally {
    cancelled = true
  }
}
