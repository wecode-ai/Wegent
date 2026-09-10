import type { AnalyticsEvent } from './events'
import { SMART_APP_EVENT_PROPERTY_KEYS } from './generated/smartAppEvents'
import type { WeworkTelemetryFact, WeworkTelemetrySink } from './facts'

const MAX_STARTUP_EVENTS = 100

export type TelemetryDistribution = 'public' | 'internal'

interface PublicTelemetrySink {
  readonly id: string
  accept(event: AnalyticsEvent): void | Promise<void>
}

interface TelemetryDispatcherOptions {
  readonly distribution: TelemetryDistribution
  readonly internalSinks: () => readonly WeworkTelemetrySink[]
  readonly publicSink: PublicTelemetrySink | null
}

export interface TelemetryDispatcher {
  flushInternalSinks(): void
  publish(fact: WeworkTelemetryFact): void
}

export function createTelemetryDispatcher(
  options: TelemetryDispatcherOptions
): TelemetryDispatcher {
  let queuedInternalFacts: readonly WeworkTelemetryFact[] = []

  const publish = (fact: WeworkTelemetryFact): void => {
    if (options.distribution === 'public') {
      if (options.publicSink) acceptPublic(options.publicSink, fact)
      return
    }

    const sinks = options.internalSinks()
    if (sinks.length === 0) {
      queuedInternalFacts = [...queuedInternalFacts.slice(-(MAX_STARTUP_EVENTS - 1)), fact]
      return
    }
    acceptInternal(sinks, fact)
  }

  const flushInternalSinks = (): void => {
    if (options.distribution !== 'internal' || queuedInternalFacts.length === 0) return
    const sinks = options.internalSinks()
    if (sinks.length === 0) return
    const queued = queuedInternalFacts
    queuedInternalFacts = []
    for (const fact of queued) acceptInternal(sinks, fact)
  }

  return { flushInternalSinks, publish }
}

function acceptPublic(sink: PublicTelemetrySink, fact: WeworkTelemetryFact): void {
  try {
    void Promise.resolve(sink.accept(publicProjection(fact))).catch(() => undefined)
  } catch {
    // Telemetry must not alter the user-facing result of a business operation.
  }
}

function acceptInternal(sinks: readonly WeworkTelemetrySink[], fact: WeworkTelemetryFact): void {
  for (const sink of sinks) {
    const envelope = { ...fact, eventId: crypto.randomUUID() }
    try {
      void Promise.resolve(sink.accept(envelope)).catch(() => undefined)
    } catch {
      // A single extension must not prevent delivery to another registered sink.
    }
  }
}

function publicProjection(fact: WeworkTelemetryFact): AnalyticsEvent {
  const properties: Record<string, unknown> = {}
  for (const key of SMART_APP_EVENT_PROPERTY_KEYS[fact.name]) {
    const value = (fact.properties as Record<string, unknown>)[key]
    if (value !== undefined) properties[key] = value
  }
  return { name: fact.name, properties } as AnalyticsEvent
}
