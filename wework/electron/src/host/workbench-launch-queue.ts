import { parseWorkbenchUrl } from './workbench-application-contract.js'

export async function openNativeScheme(
  url: string,
  queueScheme: (url: string) => boolean,
  openWorkbench: () => Promise<void>
): Promise<void> {
  if (!queueScheme(url)) await openWorkbench()
}

/** Routes native links without requiring the main workbench renderer. */
export class WorkbenchLaunchQueue {
  private readonly pending = new Set<string>()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private open: ((id: string) => Promise<unknown>) | null = null

  constructor(private readonly reportError: (error: unknown) => void) {}

  enqueue(url: string): boolean {
    const id = parseWorkbenchUrl(url)
    if (!id) return false
    if (this.open) this.dispatch(id)
    else this.pending.add(id)
    return true
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }

  async start(open: (id: string) => Promise<unknown>): Promise<void> {
    this.open = open
    for (const id of this.pending) this.dispatch(id)
    this.pending.clear()
    await Promise.all(this.inFlight.values())
  }

  private dispatch(id: string): void {
    if (this.inFlight.has(id)) return
    const operation = Promise.resolve()
      .then(() => this.open!(id))
      .catch(this.reportError)
      .finally(() => {
        this.inFlight.delete(id)
      })
    this.inFlight.set(id, operation)
  }
}
