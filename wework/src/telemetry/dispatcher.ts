import type { AnalyticsEvent } from './events'
import { ANALYTICS_EVENT_PROPERTY_KEYS } from './events'
import { sanitizeAnalyticsProperties } from './client'
import type {
  WeworkTelemetryContext,
  WeworkTelemetryEnvelope,
  WeworkTelemetryFact,
  WeworkTelemetrySink,
} from './facts'
import { telemetryContextProperties } from './identity'

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
  const properties = sanitizeAnalyticsProperties(
    fact.name,
    fact.properties as never
  ) as unknown as Record<string, unknown>
  const context = projectInternalContext(fact.context)
  for (const sink of sinks) {
    const envelope = {
      name: fact.name,
      properties,
      occurredAt: fact.occurredAt,
      ...(context ? { context } : {}),
      eventId: crypto.randomUUID(),
    } as unknown as WeworkTelemetryEnvelope
    try {
      void Promise.resolve(sink.accept(envelope)).catch(() => undefined)
    } catch {
      // Telemetry must not alter the user-facing result of a business operation.
    }
  }
}

const SMART_APP_POLICY_FIELDS = [
  'smart_app_key',
  'smart_app_name',
  'smart_app_version',
  'smart_app_source',
] as const

/**
 * Sinks receive the same collection policy as the public transport. Rebuild the
 * nested context from the projected fields so raw identities never cross the
 * receiver boundary, and omit objects that the policy only partially allows.
 */
function projectInternalContext(
  context?: WeworkTelemetryContext
): WeworkTelemetryContext | undefined {
  if (!context) return undefined
  const allowed = telemetryContextProperties(context)
  const projected: { pluginInvocation?: unknown; smartApp?: unknown } = {}

  if (context.pluginInvocation) {
    const pluginInvocation = {
      ...(typeof allowed.plugin_marketplace === 'string'
        ? { marketplace: allowed.plugin_marketplace }
        : {}),
      ...(typeof allowed.plugin_key === 'string' ? { pluginKey: allowed.plugin_key } : {}),
      ...(typeof allowed.plugin_version === 'string' ? { version: allowed.plugin_version } : {}),
      ...(typeof allowed.tool_name === 'string' ? { toolName: allowed.tool_name } : {}),
      ...(typeof allowed.tool_duration_ms === 'number'
        ? { durationMs: allowed.tool_duration_ms }
        : {}),
    }
    if (Object.keys(pluginInvocation).length > 0) projected.pluginInvocation = pluginInvocation
  }

  if (
    context.smartApp &&
    SMART_APP_POLICY_FIELDS.every(field => typeof allowed[field] === 'string')
  ) {
    projected.smartApp = {
      key: allowed.smart_app_key,
      name: allowed.smart_app_name,
      version: allowed.smart_app_version,
      source: allowed.smart_app_source,
    }
  }

  return Object.keys(projected).length > 0 ? (projected as WeworkTelemetryContext) : undefined
}
