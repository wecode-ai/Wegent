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
    const events = coalesceStateEvents(this.events.filter(event => event.sequence > after))
    return {
      events,
      latestSequence: this.sequence,
      historyLost: after < earliest - 1,
    }
  }
}

function coalesceStateEvents(events: DesktopHostEvent[]): DesktopHostEvent[] {
  const latestAnnotationSequenceByLabel = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'browser.annotation-state') continue
    const label = event.payload.label
    if (typeof label === 'string') latestAnnotationSequenceByLabel.set(label, event.sequence)
  }
  if (latestAnnotationSequenceByLabel.size === 0) return events
  return events.filter(event => {
    if (event.type !== 'browser.annotation-state') return true
    const label = event.payload.label
    return (
      typeof label !== 'string' || latestAnnotationSequenceByLabel.get(label) === event.sequence
    )
  })
}
