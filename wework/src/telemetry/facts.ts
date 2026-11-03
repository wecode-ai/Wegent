import type { AnalyticsEvent } from './events'
import type { DomainGeneratedEventMap } from './domainRegistry'
import type { SmartAppGeneratedEventMap } from './generated/smartAppEvents'

export type SmartAppTelemetryEvent = {
  [Name in keyof SmartAppGeneratedEventMap]: {
    readonly name: Name
    readonly properties: SmartAppGeneratedEventMap[Name]
  }
}[keyof SmartAppGeneratedEventMap]

export type DomainTelemetryEvent = {
  [Name in keyof DomainGeneratedEventMap]: {
    readonly name: Name
    readonly properties: DomainGeneratedEventMap[Name]
  }
}[keyof DomainGeneratedEventMap]

export const SMART_APP_SOURCES = ['managed', 'linked', 'market'] as const

export type SmartAppSource = (typeof SMART_APP_SOURCES)[number]

export function parseSmartAppSource(value: unknown): SmartAppSource | undefined {
  return SMART_APP_SOURCES.find(source => source === value)
}

export interface SmartAppIdentityContext {
  readonly key: string
  readonly name: string
  readonly source: SmartAppSource
  readonly version: string
}

export interface PluginInvocationIdentityContext {
  readonly durationMs?: number
  readonly marketplace: string
  readonly pluginKey: string
  readonly toolName: string
  readonly version: string
}

export interface WeworkTelemetryContext {
  readonly pluginInvocation?: PluginInvocationIdentityContext
  readonly smartApp?: SmartAppIdentityContext
}

export type WeworkTelemetryFact = AnalyticsEvent & {
  readonly context?: WeworkTelemetryContext
  readonly occurredAt: string
}

/** Context delivered to sinks after the collection policy projects each field. */
export type WeworkTelemetrySinkContext = {
  readonly pluginInvocation?: Partial<PluginInvocationIdentityContext>
  readonly smartApp?: Partial<SmartAppIdentityContext>
}

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown
  ? Omit<Value, Key>
  : never

export type WeworkTelemetryEnvelope = DistributiveOmit<WeworkTelemetryFact, 'context'> & {
  readonly context?: WeworkTelemetrySinkContext
  readonly eventId: string
}

export const TELEMETRY_SINK_PROTOCOL = 'telemetry-sink/v1' as const

export interface WeworkTelemetrySink {
  readonly id: string
  readonly protocol: typeof TELEMETRY_SINK_PROTOCOL
  accept(fact: WeworkTelemetryEnvelope): void | Promise<void>
}
