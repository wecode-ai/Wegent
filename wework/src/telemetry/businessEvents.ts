import type { AnalyticsEvent, AnalyticsEventMap } from './events'
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

export function trackPluginEvent<Name extends PluginEventName>(
  name: Name,
  properties: AnalyticsEventMap[Name]
): void {
  for (const listener of listeners) {
    try {
      listener({ name, properties } as AnalyticsEvent)
    } catch {
      // Observers must not change the business result.
    }
  }
}

export function trackPluginInvocationEvent<
  Name extends 'plugin_invocation_succeeded' | 'plugin_invocation_failed',
>(
  name: Name,
  properties: AnalyticsEventMap[Name],
  pluginInvocation: PluginInvocationIdentityContext
): void {
  for (const listener of listeners) {
    try {
      listener({ name, properties, context: { pluginInvocation } } as BusinessTelemetryEvent)
    } catch {
      // Observers must not change the business result.
    }
  }
}

export function subscribeBusinessEvents(
  listener: (event: BusinessTelemetryEvent) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
