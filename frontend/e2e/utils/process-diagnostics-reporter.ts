import { execFileSync } from 'node:child_process'
import type { FullResult, Reporter } from '@playwright/test/reporter'

/** Report resources that keep a completed CI test process alive. */
export default class ProcessDiagnosticsReporter implements Reporter {
  onEnd(result: FullResult) {
    console.log(`[e2e-process] Tests ended: status=${result.status}, pid=${process.pid}`)
    const timer = setInterval(() => {
      console.log('[e2e-process] Waiting for exit:', process.getActiveResourcesInfo())
      try {
        console.log(
          execFileSync('ps', ['-eo', 'pid,ppid,stat,etime,comm'], {
            encoding: 'utf8',
            timeout: 5_000,
            maxBuffer: 256 * 1024,
          })
        )
      } catch (error) {
        console.log('[e2e-process] Process snapshot failed:', (error as Error).name)
      }
    }, 30_000)
    timer.unref()
  }

  onExit(): Promise<void> {
    console.log(`[e2e-process] Reporter exit: pid=${process.pid}`, process.getActiveResourcesInfo())
    return Promise.resolve()
  }
}
