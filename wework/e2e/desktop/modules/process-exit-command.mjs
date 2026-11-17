import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { processIsAlive } from '../process-lifecycle.mjs'

/** A closing renderer cannot reliably acknowledge its own process termination. */
export async function completeCommandOnProcessExit(result, processId, timeoutMs) {
  console.log('[desktop-e2e-exit] waiting', { processId, timeoutMs })
  let cancelled = false
  const exited = (async () => {
    const deadline = Date.now() + timeoutMs
    while (processIsAlive(processId)) {
      if (Date.now() >= deadline) {
        if (process.platform === 'darwin') {
          try {
            const state = execFileSync(
              '/bin/ps',
              ['-p', String(processId), '-o', 'pid=,ppid=,stat=,etime=,comm='],
              { encoding: 'utf8', timeout: 1000 }
            )
            console.error('[desktop-e2e-exit] timeout state', state.trim())
          } catch (error) {
            console.error('[desktop-e2e-exit] state query failed', error.code)
          }
        }
        assert.fail(`The upgraded host ${processId} did not quit before restart`)
      }
      await delay(25)
      if (cancelled) return
    }
    console.log('[desktop-e2e-exit] exited', { processId })
    return 'exited'
  })()
  try {
    // An explicit command error still fails; a response alone cannot prove exit.
    return await Promise.race([exited, result.then(() => exited)])
  } finally {
    cancelled = true
  }
}
