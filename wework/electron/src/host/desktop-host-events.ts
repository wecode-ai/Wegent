const MAX_EVENTS = 1024
const MAX_WAIT_MS = 30_000

export interface DesktopHostEvent {
  sequence: number
  type: string
  payload: Record<string, unknown>
}

export interface DesktopHostEventBatch {
  events: DesktopHostEvent[]
  latestSequence: number
  historyLost: boolean
}

interface Waiter {
  after: number
  resolve: (batch: DesktopHostEventBatch) => void
  timer: NodeJS.Timeout
}

export class DesktopHostEventBroker {
  private readonly events: DesktopHostEvent[] = []
  private readonly waiters = new Set<Waiter>()
  private sequence = 0

  publish(type: string, payload: Record<string, unknown>): void {
    this.events.push({
      sequence: ++this.sequence,
      type,
      payload,
    })
    if (this.events.length > MAX_EVENTS) this.events.shift()
    this.flushWaiters()
  }

  read(after: number): DesktopHostEventBatch {
    const earliest = this.events[0]?.sequence ?? this.sequence + 1
    return {
      events: this.events.filter(event => event.sequence > after),
      latestSequence: this.sequence,
      historyLost: after > 0 && after < earliest - 1,
    }
  }

  wait(after: number, timeoutMs = MAX_WAIT_MS): Promise<DesktopHostEventBatch> {
    const current = this.read(after)
    if (current.events.length > 0 || current.historyLost) return Promise.resolve(current)

    return new Promise(resolve => {
      const waiter: Waiter = {
        after,
        resolve,
        timer: setTimeout(
          () => {
            this.waiters.delete(waiter)
            resolve(this.read(after))
          },
          Math.min(Math.max(0, timeoutMs), MAX_WAIT_MS)
        ),
      }
      this.waiters.add(waiter)
    })
  }

  private flushWaiters(): void {
    for (const waiter of this.waiters) {
      const batch = this.read(waiter.after)
      if (batch.events.length === 0 && !batch.historyLost) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve(batch)
    }
  }
}
