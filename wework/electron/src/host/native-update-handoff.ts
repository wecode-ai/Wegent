import { type ChildProcess } from 'node:child_process'

/** Own the waiting updater until shutdown has completed or cancellation is confirmed. */
export class NativeUpdateHandoff {
  readonly ready: Promise<void>
  private readonly stopped: Promise<void>
  private exited = false
  private failure: Error | null = null

  constructor(private readonly child: ChildProcess) {
    let resolveStopped!: () => void
    this.stopped = new Promise(resolve => {
      resolveStopped = resolve
    })
    this.ready = new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.on('error', error => {
        this.failure = error
        reject(error)
        if (!child.pid) {
          this.exited = true
          resolveStopped()
        }
      })
      child.once('exit', (code, signal) => {
        this.exited = true
        this.failure ??= new Error(
          `Native updater exited before installation handoff (${signal ?? code ?? 'unknown'})`
        )
        reject(this.failure)
        resolveStopped()
      })
    })
  }

  assertAlive(): void {
    if (this.failure) throw this.failure
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error('Native updater exited before installation handoff')
    }
  }

  release(): void {
    this.assertAlive()
    this.child.unref()
  }

  async cancel(): Promise<void> {
    if (this.exited) return
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      await this.stopped
      return
    }
    if (!this.child.kill('SIGKILL')) {
      throw new Error('Cannot cancel the native updater; application must remain running')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.stopped,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native updater cancellation did not finish within 5 seconds')),
            5000
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
