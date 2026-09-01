export class RuntimeWorkInvalidator {
  private pending = false
  private inFlight: Promise<void> | null = null

  constructor(private readonly refresh: () => Promise<void>) {}

  invalidate(): Promise<void> {
    this.pending = true
    if (this.inFlight) return this.inFlight

    const run = this.drain()
    this.inFlight = run
    const clear = () => {
      if (this.inFlight === run) this.inFlight = null
    }
    run.then(clear, clear)
    return run
  }

  private async drain(): Promise<void> {
    let lastError: unknown = null
    do {
      this.pending = false
      try {
        await this.refresh()
        lastError = null
      } catch (cause) {
        lastError = cause
      }
    } while (this.pending)

    if (lastError) throw lastError
  }
}
