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

export interface SmartAppIdentityContext {
  readonly key: string
  readonly name: string
  readonly source: 'managed' | 'linked' | 'market'
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

export type WeworkTelemetryEnvelope = WeworkTelemetryFact & {
  readonly eventId: string
}

export const TELEMETRY_SINK_PROTOCOL = 'telemetry-sink/v1' as const

export interface WeworkTelemetrySink {
  readonly id: string
  readonly protocol: typeof TELEMETRY_SINK_PROTOCOL
  accept(fact: WeworkTelemetryEnvelope): void | Promise<void>
}
