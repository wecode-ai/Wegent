import type { AnalyticsEvent } from './events'
import { ANALYTICS_EVENT_PROPERTY_KEYS } from './events'
import type { WeworkTelemetryEnvelope, WeworkTelemetryFact, WeworkTelemetrySink } from './facts'

const MAX_QUEUED_INTERNAL_FACTS = 100

interface TelemetryDispatcherOptions {
  readonly internalSinks: () => readonly WeworkTelemetrySink[]
  readonly isInternalDeliveryEnabled: () => boolean
}

export interface TelemetryDispatcher {
  flushInternalSinks(): void
  publish(fact: WeworkTelemetryFact): void
}

export function createTelemetryDispatcher(
  accept: (event: AnalyticsEvent & Pick<WeworkTelemetryFact, 'context'>) => void | Promise<void>,
  options?: TelemetryDispatcherOptions
): TelemetryDispatcher {
  let queuedInternalFacts: readonly WeworkTelemetryFact[] = []

  const publish = (fact: WeworkTelemetryFact): void => {
    acceptPublic(accept, fact)
    if (!options?.isInternalDeliveryEnabled()) return
    const sinks = options.internalSinks()
    if (sinks.length === 0) {
      queuedInternalFacts = [...queuedInternalFacts.slice(-(MAX_QUEUED_INTERNAL_FACTS - 1)), fact]
      return
    }
    acceptInternal(sinks, fact)
  }

  const flushInternalSinks = (): void => {
    if (!options?.isInternalDeliveryEnabled() || queuedInternalFacts.length === 0) return
    const sinks = options.internalSinks()
    if (sinks.length === 0) return
    const facts = queuedInternalFacts
    queuedInternalFacts = []
    for (const fact of facts) acceptInternal(sinks, fact)
  }

  return { flushInternalSinks, publish }
}

function acceptPublic(
  accept: (event: AnalyticsEvent & Pick<WeworkTelemetryFact, 'context'>) => void | Promise<void>,
  fact: WeworkTelemetryFact
): void {
  const properties: Record<string, unknown> = {}
  for (const key of ANALYTICS_EVENT_PROPERTY_KEYS[fact.name]) {
    const value = (fact.properties as Record<string, unknown>)[key]
    if (value !== undefined) properties[key] = value
  }
  try {
    void Promise.resolve(
      accept({
        name: fact.name,
        properties,
        ...(fact.context ? { context: fact.context } : {}),
      } as AnalyticsEvent & Pick<WeworkTelemetryFact, 'context'>)
    ).catch(() => undefined)
  } catch {
    // Telemetry must not alter the user-facing result of a business operation.
  }
}

function acceptInternal(sinks: readonly WeworkTelemetrySink[], fact: WeworkTelemetryFact): void {
  for (const sink of sinks) {
    const envelope: WeworkTelemetryEnvelope = { ...fact, eventId: crypto.randomUUID() }
    try {
      void Promise.resolve(sink.accept(envelope)).catch(() => undefined)
    } catch {
      // Telemetry must not alter the user-facing result of a business operation.
    }
  }
}
