/** Native activation must wait until stores, IPC, menus and close policy exist. */
export class DesktopHostReadiness {
  private state: 'initializing' | 'ready' | 'failed' = 'initializing'
  private failure: unknown
  private readonly waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []

  wait(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'failed') return Promise.reject(this.failure)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  complete(): void {
    if (this.state !== 'initializing') return
    this.state = 'ready'
    for (const waiter of this.waiters.splice(0)) waiter.resolve()
  }

  fail(error: unknown): void {
    if (this.state !== 'initializing') return
    this.failure = error
    this.state = 'failed'
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }
}
