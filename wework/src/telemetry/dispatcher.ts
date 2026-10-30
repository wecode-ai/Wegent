import type { AnalyticsEvent } from './events'
import { ANALYTICS_EVENT_PROPERTY_KEYS } from './events'
import type { WeworkTelemetryFact } from './facts'

export function createTelemetryDispatcher(
  accept: (event: AnalyticsEvent & Pick<WeworkTelemetryFact, 'context'>) => void | Promise<void>
) {
  return {
    publish(fact: WeworkTelemetryFact): void {
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
    },
  }
}
