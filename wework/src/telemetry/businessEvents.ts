import type { AnalyticsEvent, AnalyticsEventMap, AnalyticsEventName } from './events'
import type { PluginInvocationIdentityContext, WeworkTelemetryContext } from './facts'

type PluginEventName =
  | 'plugin_center_opened'
  | 'plugin_installed'
  | 'plugin_uninstalled'
  | 'plugin_enabled_changed'
  | 'plugin_invocation_succeeded'
  | 'plugin_invocation_failed'
  | 'operation_failed'

type BusinessTelemetryEvent = AnalyticsEvent & { readonly context?: WeworkTelemetryContext }

const listeners = new Set<(event: BusinessTelemetryEvent) => void>()

export function trackBusinessEvent<Name extends AnalyticsEventName>(
  name: Name,
  properties: AnalyticsEventMap[Name],
  context?: WeworkTelemetryContext
): void {
  for (const listener of listeners) {
    try {
      listener(
        (context ? { name, properties, context } : { name, properties }) as BusinessTelemetryEvent
      )
    } catch {
      // Observers must not change the business result.
    }
  }
}

export function trackPluginEvent<Name extends PluginEventName>(
  name: Name,
  properties: AnalyticsEventMap[Name]
): void {
  trackBusinessEvent(name, properties)
}

export function trackPluginInvocationEvent<
  Name extends 'plugin_invocation_succeeded' | 'plugin_invocation_failed',
>(
  name: Name,
  properties: AnalyticsEventMap[Name],
  pluginInvocation: PluginInvocationIdentityContext
): void {
  trackBusinessEvent(name, properties, { pluginInvocation })
}

export function subscribeBusinessEvents(
  listener: (event: BusinessTelemetryEvent) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
