const MAX_EVENTS = 1024

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

export class DesktopHostEventBroker {
  private readonly events: DesktopHostEvent[] = []
  private sequence = 0

  publish(type: string, payload: Record<string, unknown>): void {
    this.events.push({
      sequence: ++this.sequence,
      type,
      payload,
    })
    if (this.events.length > MAX_EVENTS) this.events.shift()
  }

  read(after: number): DesktopHostEventBatch {
    const earliest = this.events[0]?.sequence ?? this.sequence + 1
    return {
      events: this.events.filter(event => event.sequence > after),
      latestSequence: this.sequence,
      historyLost: after > 0 && after < earliest - 1,
    }
  }
}
